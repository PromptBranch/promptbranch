import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openMemoryDatabase, PromptLibrary, SyncEngine } from "@promptbranch/core";
import type { DiscoveredPeer, Discovery } from "./discovery.js";
import { loadOrCreateIdentity } from "./identity.js";
import { PeerService, type PeerServiceDeps } from "./peers-service.js";

const dirs: string[] = [];
const services: PeerService[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pb-sync-service-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface ServiceRig {
  lib: PromptLibrary;
  engine: SyncEngine;
  service: PeerService;
  confirm: ReturnType<typeof mockConfirm>;
}

function mockConfirm() {
  const state = { decisions: [] as Array<{ fingerprint: string; name: string }>, answer: true };
  return {
    callback: async (fingerprint: string, name: string) => {
      state.decisions.push({ fingerprint, name });
      return state.answer;
    },
    state,
  };
}

function fakeDiscovery(): { impl: Discovery; fire(peer: DiscoveredPeer): void } {
  let onPeer: ((peer: DiscoveredPeer) => void) | null = null;
  return {
    impl: {
      start: (_advertise, callback) => {
        onPeer = callback;
      },
      stop: async () => {},
    },
    fire: (peer) => onPeer?.(peer),
  };
}

async function rig(name: string, extra: Partial<PeerServiceDeps> = {}): Promise<ServiceRig> {
  const db = openMemoryDatabase();
  const lib = new PromptLibrary(db);
  const engine = new SyncEngine(db);
  const confirm = mockConfirm();
  const service = new PeerService({
    engine,
    identity: await loadOrCreateIdentity(tempDir()),
    deviceName: () => name,
    confirmPairing: confirm.callback,
    onStatusChange: () => {},
    listen: { host: "127.0.0.1", port: 0 },
    ...extra,
  });
  services.push(service);
  return { lib, engine, service, confirm };
}

async function start(rig: ServiceRig): Promise<number> {
  await rig.service.start();
  const port = rig.service.status().port;
  expect(port).not.toBeNull();
  return port!;
}

describe("peer service over real TLS (loopback)", () => {
  it("keeps an established session alive beyond the TLS handshake deadline", async () => {
    const handshakeTimeoutMs = 60;
    const transitionsA: string[] = [];
    const transitionsB: string[] = [];
    let a!: ServiceRig;
    let b!: ServiceRig;
    a = await rig("A", {
      handshakeTimeoutMs,
      onStatusChange: () => transitionsA.push(a.service.status().peers[0]?.state ?? "none"),
    });
    b = await rig("B", {
      handshakeTimeoutMs,
      onStatusChange: () => transitionsB.push(b.service.status().peers[0]?.state ?? "none"),
    });
    const portA = await start(a);
    await start(b);

    const code = a.service.beginPairing();
    expect((await b.service.pairWithCode("127.0.0.1", portA, code)).ok).toBe(true);
    await vi.waitFor(() => {
      expect(a.service.status().peers[0]?.state).toBe("steady");
      expect(b.service.status().peers[0]?.state).toBe("steady");
    });

    transitionsA.length = 0;
    transitionsB.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(a.service.status().peers[0]?.state).toBe("steady");
    expect(b.service.status().peers[0]?.state).toBe("steady");
    expect(transitionsA).toEqual([]);
    expect(transitionsB).toEqual([]);

    const prompt = a.lib.createPrompt({ title: "After idle", content: "still connected" });
    a.engine.refineDirty();
    a.service.notifyPeers();
    await vi.waitFor(() => expect(b.lib.getPrompt(prompt.id)?.title).toBe("After idle"));
  });

  it("bounds the TLS handshake when a TCP peer never speaks TLS", async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    expect(address).not.toBeNull();
    expect(typeof address).toBe("object");
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const client = await rig("Client", { handshakeTimeoutMs: 75 });
    let testDeadline: NodeJS.Timeout | null = null;

    try {
      const startedAt = Date.now();
      const result = await Promise.race([
        client.service.pairWithCode("127.0.0.1", port, "AAAA-AAAA"),
        new Promise<{ ok: false; error: string }>((resolve) => {
          testDeadline = setTimeout(
            () => resolve({ ok: false, error: "Test deadline exceeded" }),
            750,
          );
        }),
      ]);
      expect(result).toEqual({ ok: false, error: "Connection timed out" });
      expect(Date.now() - startedAt).toBeLessThan(750);
    } finally {
      if (testDeadline) clearTimeout(testDeadline);
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, "close");
    }
  });

  it("pairs with a code and syncs both directions", async () => {
    const a = await rig("Mac Studio");
    const b = await rig("MacBook Pro");
    const portA = await start(a);
    await start(b);

    const code = a.service.beginPairing();
    const result = await b.service.pairWithCode("127.0.0.1", portA, code);
    expect(result.ok).toBe(true);

    // The acceptor saw the introduction and asked its UI gate.
    expect(a.confirm.state.decisions.length).toBe(1);
    expect(a.confirm.state.decisions[0]?.name).toBe("MacBook Pro");

    // Both sides pinned each other.
    expect(a.engine.listSyncPeers().map((p) => p.name)).toContain("MacBook Pro");
    expect(b.engine.listSyncPeers().length).toBe(1);

    // Data written before pairing flows once connected.
    const prompt = a.lib.createPrompt({ title: "Studio prompt", content: "v1" });
    a.engine.refineDirty();
    a.service.notifyPeers();
    await vi.waitFor(() => expect(b.lib.getPrompt(prompt.id)?.title).toBe("Studio prompt"));

    // And back the other way after the session is established.
    const tag = b.lib.createTag({ name: "from-b" });
    b.engine.refineDirty();
    b.service.notifyPeers();
    await vi.waitFor(() =>
      expect(a.lib.listTags().map((t) => t.name)).toContain(tag.name),
    );

    const statusA = a.service.status();
    expect(statusA.listening).toBe(true);
    expect(statusA.peers[0]?.state).toBe("steady");
  });

  it("rejects a mistyped pairing code without introducing itself", async () => {
    const a = await rig("A");
    const b = await rig("B");
    const portA = await start(a);
    await start(b);

    a.service.beginPairing();
    const result = await b.service.pairWithCode("127.0.0.1", portA, "AAAA-AAAA");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/does not match/i);
    expect(a.confirm.state.decisions.length).toBe(0);
    // Nothing was pinned on either side.
    expect(a.engine.listSyncPeers()).toEqual([]);
    expect(b.engine.listSyncPeers()).toEqual([]);
  });

  it("declines an introduction when the acceptor says no", async () => {
    const a = await rig("A");
    const b = await rig("B");
    a.confirm.state.answer = false;
    const portA = await start(a);
    await start(b);

    const code = a.service.beginPairing();
    const result = await b.service.pairWithCode("127.0.0.1", portA, code);
    expect(result.ok).toBe(false);
    expect(a.engine.listSyncPeers()).toEqual([]);
    expect(b.engine.listSyncPeers()).toEqual([]);
  });

  it("re-dials a discovered paired peer after its listener restarts", async () => {
    const discoveryA = fakeDiscovery();
    const discoveryB = fakeDiscovery();
    const a = await rig("A", { discovery: discoveryA.impl, pairTimeoutMs: 2_000 });
    const b = await rig("B", { discovery: discoveryB.impl, pairTimeoutMs: 2_000 });
    const portA = await start(a);
    await start(b);

    // Pair them first over the code flow.
    const code = a.service.beginPairing();
    expect((await b.service.pairWithCode("127.0.0.1", portA, code)).ok).toBe(true);
    await vi.waitFor(() => expect(a.service.status().peers[0]?.state).toBe("steady"), { timeout: 5_000 });

    // Restart the listener side (the peer that never dials: larger
    // fingerprint), dropping the live connection.
    const aDials = a.service.deps.identity.fingerprint < b.service.deps.identity.fingerprint;
    const dialer = aDials ? a : b;
    const dialerDiscovery = aDials ? discoveryA : discoveryB;
    const listener = aDials ? b : a;
    await listener.service.stop();
    await listener.service.start();
    const listenerPort = listener.service.status().port!;
    // Wait until the dialer noticed the dropped connection before firing
    // discovery, so the re-dial cannot race the stale connection cleanup.
    await vi.waitFor(
      () => expect(dialer.service.status().peers[0]?.state).toBe("offline"),
      { timeout: 5_000 },
    );

    // The dialer discovers the listener again and reconnects on its own.
    dialerDiscovery.fire({
      fingerprint: listener.service.deps.identity.fingerprint,
      name: listener.service.deps.deviceName(),
      address: "127.0.0.1",
      port: listenerPort,
    });
    await vi.waitFor(() => expect(listener.service.status().peers[0]?.state).toBe("steady"), { timeout: 5_000 });

    const before = listener.lib.listPrompts().length;
    dialer.lib.createPrompt({ title: "After rediscovery", content: "x" });
    dialer.engine.refineDirty();
    dialer.service.notifyPeers();
    await vi.waitFor(() => expect(listener.lib.listPrompts().length).toBe(before + 1));
  });

  it("flags a peer as unhealthy after repeated failed dials", async () => {
    const discoveryA = fakeDiscovery();
    const discoveryB = fakeDiscovery();
    const a = await rig("A", { discovery: discoveryA.impl, pairTimeoutMs: 2_000 });
    const b = await rig("B", { discovery: discoveryB.impl, pairTimeoutMs: 2_000 });
    const portA = await start(a);
    await start(b);

    const code = a.service.beginPairing();
    expect((await b.service.pairWithCode("127.0.0.1", portA, code)).ok).toBe(true);
    await vi.waitFor(() => expect(a.service.status().peers[0]?.state).toBe("steady"));

    // The lexicographically smaller fingerprint is the dialer; the listener
    // stops accepting, so every discovery-driven dial now fails at once.
    const aDials = a.service.deps.identity.fingerprint < b.service.deps.identity.fingerprint;
    const dialer = aDials ? a : b;
    const dialerDiscovery = aDials ? discoveryA : discoveryB;
    const listener = aDials ? b : a;
    await listener.service.stop();
    const info = {
      fingerprint: listener.service.deps.identity.fingerprint,
      name: listener.service.deps.deviceName(),
      address: "127.0.0.1",
      port: listener.service.status().port ?? 0,
    };
    expect(dialer.service.status().peers[0]?.unhealthy).toBe(false);
    // Repeated discover-and-dial cycles with nothing answering trip the
    // UNHEALTHY_FAILURES threshold.
    for (let i = 0; i < 4; i++) {
      dialerDiscovery.fire(info);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    expect(dialer.service.status().peers[0]?.unhealthy).toBe(true);
  });

  it("keeps unpaired strangers out when no pairing window is open", async () => {
    const a = await rig("A");
    const b = await rig("B", { pairTimeoutMs: 1_500 });
    const portA = await start(a);
    await start(b);

    // B dials A with A's real code, but A never opened the pairing window:
    // the TLS handshake succeeds, A refuses at the protocol layer and
    // destroys the socket, so B times out quickly.
    const aCode = a.service.deps.identity.pairingCode;
    const result = await b.service.pairWithCode("127.0.0.1", portA, aCode);
    expect(result.ok).toBe(false);
    expect(a.engine.listSyncPeers()).toEqual([]);
    expect(b.engine.listSyncPeers()).toEqual([]);
  });
});

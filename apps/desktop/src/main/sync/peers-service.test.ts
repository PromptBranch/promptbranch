import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import tls from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openMemoryDatabase, PromptLibrary, SyncEngine } from "@promptbranch/core";
import { createBonjourDiscovery, type DiscoveredPeer, type Discovery } from "./discovery.js";
import { encodeFrame } from "./frames.js";
import { loadOrCreateIdentity, type DeviceIdentity } from "./identity.js";
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

function fakeDiscovery(): {
  impl: Discovery;
  fire(peer: DiscoveredPeer): void;
  down(fingerprint: string): void;
} {
  let onPeer: ((peer: DiscoveredPeer) => void) | null = null;
  let onPeerDown: ((fingerprint: string) => void) | null = null;
  return {
    impl: {
      start: (_advertise, callback, down) => {
        onPeer = callback;
        onPeerDown = down;
      },
      stop: async () => {},
    },
    fire: (peer) => onPeer?.(peer),
    down: (fingerprint) => onPeerDown?.(fingerprint),
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

async function connectWithIdentity(
  port: number,
  identity: DeviceIdentity,
): Promise<tls.TLSSocket> {
  const socket = tls.connect({
    host: "127.0.0.1",
    port,
    key: identity.keyPem,
    cert: identity.certPem,
    rejectUnauthorized: false,
  });
  await once(socket, "secureConnect");
  return socket;
}

function controlledTlsSocket(fingerprint: string): {
  socket: tls.TLSSocket;
  establish(): void;
  inject(frame: Buffer): void;
} {
  const duplex = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const socket = duplex as unknown as tls.TLSSocket;
  socket.setNoDelay = () => socket;
  socket.setTimeout = () => socket;
  socket.getPeerCertificate = (() => ({
    fingerprint256: fingerprint,
  })) as tls.TLSSocket["getPeerCertificate"];
  return {
    socket,
    establish: () => queueMicrotask(() => socket.emit("secureConnect")),
    // Emit directly so this also models a data event already queued when
    // shutdown begins, including after destroy() marks the stream unusable.
    inject: (frame) => socket.emit("data", frame),
  };
}

function remotePromptFrame(): { promptId: string; frame: Buffer } {
  const db = openMemoryDatabase();
  const lib = new PromptLibrary(db);
  const engine = new SyncEngine(db);
  const prompt = lib.createPrompt({ title: "Late remote frame", content: "must be ignored" });
  engine.refineDirty();
  const { ops } = engine.opsSince({}, 1_000_000);
  return { promptId: prompt.id, frame: encodeFrame({ t: "ops", ops, more: false }) };
}

describe("peer service over real TLS (loopback)", () => {
  it("fully closes a live session before stop returns", async () => {
    const remoteIdentity = await loadOrCreateIdentity(tempDir());
    const controlled = controlledTlsSocket(remoteIdentity.fingerprint);
    const local = await rig("Local", {
      connectTls: () => {
        controlled.establish();
        return controlled.socket;
      },
      startupReconnectDelayMs: 60_000,
    });
    await start(local);
    local.engine.upsertSyncPeer({ fingerprint: remoteIdentity.fingerprint, name: "Remote" });
    expect(
      await local.service.pairWithCode(
        "127.0.0.1",
        52_100,
        remoteIdentity.pairingCode,
      ),
    ).toEqual({ ok: true });
    const late = remotePromptFrame();

    await local.service.stop();

    controlled.inject(late.frame);
    expect(local.lib.getPrompt(late.promptId)).toBeNull();
    expect(controlled.socket.destroyed).toBe(true);
  });

  it("fully closes a live session before forgetting its peer", async () => {
    const remoteIdentity = await loadOrCreateIdentity(tempDir());
    const controlled = controlledTlsSocket(remoteIdentity.fingerprint);
    const local = await rig("Local", {
      connectTls: () => {
        controlled.establish();
        return controlled.socket;
      },
      startupReconnectDelayMs: 60_000,
    });
    await start(local);
    local.engine.upsertSyncPeer({ fingerprint: remoteIdentity.fingerprint, name: "Remote" });
    expect(
      await local.service.pairWithCode(
        "127.0.0.1",
        52_100,
        remoteIdentity.pairingCode,
      ),
    ).toEqual({ ok: true });
    const late = remotePromptFrame();

    local.service.forgetPeer(remoteIdentity.fingerprint);

    controlled.inject(late.frame);
    expect(local.lib.getPrompt(late.promptId)).toBeNull();
    expect(controlled.socket.destroyed).toBe(true);
  });

  it("refreshes Bonjour endpoints on srv-update and removes down services", async () => {
    const browser = new EventEmitter() as EventEmitter & { stop(): void };
    browser.stop = () => {};
    class FakeBonjour {
      publish(): void {}
      find(): typeof browser {
        return browser;
      }
      async unpublishAll(): Promise<void> {}
      destroy(): void {}
    }
    vi.doMock("bonjour-service", () => ({ Bonjour: FakeBonjour }));
    const discovery = createBonjourDiscovery();
    const peers: DiscoveredPeer[] = [];
    const down: string[] = [];
    const localFingerprint = "a".repeat(64);
    const remoteFingerprint = "b".repeat(64);

    try {
      discovery.start(
        { port: 52_100, fingerprint: localFingerprint, deviceName: "Local" },
        (peer) => peers.push(peer),
        (fingerprint) => down.push(fingerprint),
      );
      await vi.waitFor(() => expect(browser.listenerCount("srv-update")).toBe(1));
      browser.emit("up", {
        name: "Remote",
        port: 52_101,
        addresses: ["127.0.0.1"],
        txt: { fp: remoteFingerprint },
      });
      browser.emit("srv-update", {
        name: "Remote",
        port: 53_000,
        addresses: ["127.0.0.2"],
        txt: { fp: remoteFingerprint },
      });
      browser.emit("down", { txt: { fp: remoteFingerprint } });

      expect(peers.map(({ address, port }) => `${address}:${port}`)).toEqual([
        "127.0.0.1:52101",
        "127.0.0.2:53000",
      ]);
      expect(down).toEqual([remoteFingerprint]);
    } finally {
      await discovery.stop();
      vi.doUnmock("bonjour-service");
    }
  });

  it("keeps an established session alive beyond the TLS handshake deadline", async () => {
    const handshakeTimeoutMs = 60;
    const transitionsA: string[] = [];
    const transitionsB: string[] = [];
    let outbound!: tls.TLSSocket;
    let baseErrorListeners = 0;
    let baseCloseListeners = 0;
    let a!: ServiceRig;
    let b!: ServiceRig;
    a = await rig("A", {
      handshakeTimeoutMs,
      onStatusChange: () => transitionsA.push(a.service.status().peers[0]?.state ?? "none"),
    });
    b = await rig("B", {
      handshakeTimeoutMs,
      connectTls: (options) => {
        outbound = tls.connect(options);
        baseErrorListeners = outbound.listenerCount("error");
        baseCloseListeners = outbound.listenerCount("close");
        return outbound;
      },
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
    expect(outbound.timeout).toBe(0);
    expect(outbound.listenerCount("timeout")).toBe(0);
    expect(outbound.listenerCount("secureConnect")).toBe(0);
    expect(outbound.listenerCount("error")).toBe(baseErrorListeners + 1);
    expect(outbound.listenerCount("close")).toBe(baseCloseListeners + 1);

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
      socket.resume();
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
      await vi.waitFor(() => expect(sockets.size).toBe(0));
    } finally {
      if (testDeadline) clearTimeout(testDeadline);
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, "close");
    }
  });

  it("cancels an initial manual pairing socket when the service stops", async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.resume();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const remoteIdentity = await loadOrCreateIdentity(tempDir());
    const client = await rig("Client", { handshakeTimeoutMs: 5_000 });
    await start(client);

    try {
      const pairing = client.service.pairWithCode(
        "127.0.0.1",
        port,
        remoteIdentity.pairingCode,
      );
      await vi.waitFor(() => expect(sockets.size).toBe(1));
      await client.service.stop();
      await vi.waitFor(() => expect(sockets.size).toBe(0));
      const result = await Promise.race([
        pairing,
        new Promise<"still pending">((resolve) => setTimeout(() => resolve("still pending"), 250)),
      ]);
      expect(result).not.toBe("still pending");
      expect(result).toMatchObject({ ok: false });
      expect(client.engine.listSyncPeers()).toEqual([]);
      expect(client.service.status().peers).toEqual([]);

      expect(
        await client.service.pairWithCode(
          "127.0.0.1",
          port,
          remoteIdentity.pairingCode,
        ),
      ).toMatchObject({ ok: false });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(sockets.size).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, "close");
    }
  });

  it("keeps the secure socket guarded while handing it to a live connection", async () => {
    const serverIdentity = await loadOrCreateIdentity(tempDir());
    const serverState: { socket: tls.TLSSocket | null } = { socket: null };
    const server = tls.createServer(
      {
        key: serverIdentity.keyPem,
        cert: serverIdentity.certPem,
        requestCert: false,
        rejectUnauthorized: false,
      },
      (socket) => {
        serverState.socket = socket;
        socket.on("error", () => {});
        socket.resume();
        setImmediate(() => socket.destroy());
      },
    );
    server.on("tlsClientError", () => {});
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    expect(address).not.toBeNull();
    expect(typeof address).toBe("object");
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.prependListener("uncaughtException", onUncaught);
    let resolveHandoff!: (guarded: boolean) => void;
    const handoff = new Promise<boolean>((resolve) => {
      resolveHandoff = resolve;
    });
    const outboundState: { socket: tls.TLSSocket | null } = { socket: null };
    const client = await rig("Client", {
      connectTls: (options) => {
        const socket = tls.connect(options);
        outboundState.socket = socket;
        socket.once("secureConnect", () => {
          queueMicrotask(() => {
            const guarded =
              socket.listenerCount("error") > 0 && socket.listenerCount("close") > 0;
            resolveHandoff(guarded);
          });
        });
        return socket;
      },
    });
    client.engine.upsertSyncPeer({ fingerprint: serverIdentity.fingerprint, name: "Aborter" });
    let handoffDeadline: NodeJS.Timeout | null = null;

    try {
      expect(
        (await client.service.pairWithCode(
          "127.0.0.1",
          port,
          serverIdentity.pairingCode,
        )).ok,
      ).toBe(true);
      expect(
        await Promise.race([
          handoff,
          new Promise<boolean>((resolve) => {
            handoffDeadline = setTimeout(() => resolve(false), 750);
          }),
        ]),
      ).toBe(true);
      await vi.waitFor(() => expect(client.service.status().peers[0]?.state).toBe("offline"));
      expect(outboundState.socket?.destroyed).toBe(true);
      expect(uncaught).toEqual([]);
    } finally {
      if (handoffDeadline) clearTimeout(handoffDeadline);
      process.off("uncaughtException", onUncaught);
      serverState.socket?.destroy();
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

  it("keeps the first same-certificate inbound pairing as the only owner", async () => {
    const remoteIdentity = await loadOrCreateIdentity(tempDir());
    let resolveConfirmation!: (accepted: boolean) => void;
    const confirmation = new Promise<boolean>((resolve) => {
      resolveConfirmation = resolve;
    });
    const requests: Array<{ fingerprint: string; name: string }> = [];
    const local = await rig("Local", {
      confirmPairing: async (fingerprint, name) => {
        requests.push({ fingerprint, name });
        return confirmation;
      },
    });
    const port = await start(local);
    local.service.beginPairing();
    const first = await connectWithIdentity(port, remoteIdentity);
    let second: tls.TLSSocket | null = null;

    try {
      first.write(encodeFrame({ t: "pair-introduce", name: "First owner" }));
      await vi.waitFor(() => expect(requests).toHaveLength(1));

      second = await connectWithIdentity(port, remoteIdentity);
      second.write(encodeFrame({ t: "pair-introduce", name: "Duplicate" }));
      await vi.waitFor(() => expect(second?.destroyed).toBe(true));
      expect(requests).toEqual([
        { fingerprint: remoteIdentity.fingerprint, name: "First owner" },
      ]);

      resolveConfirmation(true);
      await vi.waitFor(() => {
        expect(local.engine.getSyncPeer(remoteIdentity.fingerprint)?.name).toBe("First owner");
      });
      expect(first.destroyed).toBe(false);
    } finally {
      resolveConfirmation(false);
      first.destroy();
      second?.destroy();
    }
  });

  it("aborts an inbound confirmation when its remote socket closes", async () => {
    const remoteIdentity = await loadOrCreateIdentity(tempDir());
    let resolveConfirmation!: (accepted: boolean) => void;
    const confirmation = new Promise<boolean>((resolve) => {
      resolveConfirmation = resolve;
    });
    let signal: AbortSignal | undefined;
    const local = await rig("Local", {
      confirmPairing: async (_fingerprint, _name, candidateSignal?: AbortSignal) => {
        signal = candidateSignal;
        return confirmation;
      },
    });
    const port = await start(local);
    local.service.beginPairing();
    const remote = await connectWithIdentity(port, remoteIdentity);

    remote.write(encodeFrame({ t: "pair-introduce", name: "Remote" }));
    await vi.waitFor(() => expect(signal).toBeDefined());
    remote.destroy();
    await once(remote, "close");

    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    resolveConfirmation(true);
    await Promise.resolve();
    expect(local.engine.getSyncPeer(remoteIdentity.fingerprint)).toBeNull();
  });

  it.each(["cancel", "stop"] as const)(
    "%s aborts the exact inbound confirmation immediately",
    async (action) => {
      const remoteIdentity = await loadOrCreateIdentity(tempDir());
      let resolveConfirmation!: (accepted: boolean) => void;
      const confirmation = new Promise<boolean>((resolve) => {
        resolveConfirmation = resolve;
      });
      let signal: AbortSignal | undefined;
      const local = await rig("Local", {
        confirmPairing: async (_fingerprint, _name, candidateSignal?: AbortSignal) => {
          signal = candidateSignal;
          return confirmation;
        },
      });
      const port = await start(local);
      local.service.beginPairing();
      const remote = await connectWithIdentity(port, remoteIdentity);

      remote.write(encodeFrame({ t: "pair-introduce", name: "Remote" }));
      await vi.waitFor(() => expect(signal).toBeDefined());
      if (action === "cancel") local.service.cancelPairing();
      else await local.service.stop();

      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
      await vi.waitFor(() => expect(remote.destroyed).toBe(true));
      resolveConfirmation(true);
      await Promise.resolve();
      expect(local.engine.getSyncPeer(remoteIdentity.fingerprint)).toBeNull();
      remote.destroy();
    },
  );

  it("keeps the first outbound pairing call when a duplicate connects faster", async () => {
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const attemptedHosts: string[] = [];
    const acceptor = await rig("Acceptor");
    const port = await start(acceptor);
    const initiator = await rig("Initiator", {
      connectTls: (options) => {
        attemptedHosts.push(String(options.host));
        if (options.host !== "first-pairing.invalid") return tls.connect(options);
        return tls.connect({
          ...options,
          lookup: (_hostname, lookupOptions, callback) => {
            markFirstStarted();
            void firstGate.then(() => {
              if (lookupOptions.all) {
                callback(null, [{ address: "127.0.0.1", family: 4 }]);
              } else {
                callback(null, "127.0.0.1", 4);
              }
            });
          },
        });
      },
      handshakeTimeoutMs: 5_000,
    });
    await start(initiator);
    const code = acceptor.service.beginPairing();
    const first = initiator.service.pairWithCode("first-pairing.invalid", port, code);

    try {
      await firstStarted;
      const duplicate = await initiator.service.pairWithCode("127.0.0.1", port, code);
      expect(duplicate).toEqual({
        ok: false,
        error: "Pairing with this device is already in progress",
      });
      expect(attemptedHosts).toEqual(["first-pairing.invalid"]);

      releaseFirst();
      expect(await first).toEqual({ ok: true });
      expect(acceptor.confirm.state.decisions).toHaveLength(1);
    } finally {
      releaseFirst();
      await first;
    }
  });

  it("releases outbound pairing ownership when the TLS connector throws", async () => {
    const acceptor = await rig("Acceptor");
    const port = await start(acceptor);
    let attempts = 0;
    const initiator = await rig("Initiator", {
      connectTls: (options) => {
        attempts += 1;
        if (attempts === 1) throw new Error("connector failed");
        return tls.connect(options);
      },
    });
    await start(initiator);
    const code = acceptor.service.beginPairing();

    await expect(
      initiator.service.pairWithCode("127.0.0.1", port, code),
    ).rejects.toThrow("connector failed");
    expect(
      await initiator.service.pairWithCode("127.0.0.1", port, code),
    ).toEqual({ ok: true });
    expect(attempts).toBe(2);
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

  it("reconnects a paired peer from its saved endpoint without discovery", async () => {
    const listener = await rig("Listener", { startupReconnectDelayMs: 25 });
    const listenerPort = await start(listener);
    const dialer = await rig("Dialer", { startupReconnectDelayMs: 25 });
    await start(dialer);

    const code = listener.service.beginPairing();
    expect(
      (await dialer.service.pairWithCode("127.0.0.1", listenerPort, code)).ok,
    ).toBe(true);
    await vi.waitFor(() => expect(dialer.service.status().peers[0]?.state).toBe("steady"));

    await dialer.service.stop();
    await listener.service.stop();
    listener.service.deps.listen = { host: "127.0.0.1", port: listenerPort };
    await listener.service.start();
    await dialer.service.start();

    await vi.waitFor(
      () => expect(dialer.service.status().peers[0]?.state).toBe("steady"),
      { timeout: 5_000 },
    );
  });

  it("persists a known manual endpoint and a fresh service redials it", async () => {
    const oldRemote = await rig("Remote old", { startupReconnectDelayMs: 60_000 });
    const oldPort = await start(oldRemote);
    const local = await rig("Local", { startupReconnectDelayMs: 60_000 });
    await start(local);
    const replacementDb = openMemoryDatabase();
    const replacementEngine = new SyncEngine(replacementDb);
    replacementEngine.upsertSyncPeer({
      fingerprint: local.service.deps.identity.fingerprint,
      name: "Local",
    });
    const replacement = new PeerService({
      engine: replacementEngine,
      identity: oldRemote.service.deps.identity,
      deviceName: () => "Remote replacement",
      confirmPairing: async () => false,
      onStatusChange: () => {},
      listen: { host: "127.0.0.1", port: 0 },
      startupReconnectDelayMs: 60_000,
    });
    services.push(replacement);
    await replacement.start();
    const replacementPort = replacement.status().port!;

    local.engine.upsertSyncPeer({
      fingerprint: oldRemote.service.deps.identity.fingerprint,
      name: "Remote",
      address: `127.0.0.1:${oldPort}`,
    });
    oldRemote.engine.upsertSyncPeer({
      fingerprint: local.service.deps.identity.fingerprint,
      name: "Local",
    });
    expect(
      (await local.service.pairWithCode(
        "127.0.0.1",
        oldPort,
        oldRemote.service.deps.identity.pairingCode,
      )).ok,
    ).toBe(true);
    await vi.waitFor(() => expect(local.service.status().peers[0]?.state).toBe("steady"));

    expect(
      (await local.service.pairWithCode(
        "127.0.0.1",
        replacementPort,
        oldRemote.service.deps.identity.pairingCode,
      )).ok,
    ).toBe(true);
    expect(local.engine.getSyncPeer(oldRemote.service.deps.identity.fingerprint)?.address)
      .toBe(`127.0.0.1:${replacementPort}`);

    await local.service.stop();
    await oldRemote.service.stop();
    const fresh = new PeerService({
      engine: local.engine,
      identity: local.service.deps.identity,
      deviceName: () => "Local fresh",
      confirmPairing: async () => false,
      onStatusChange: () => {},
      listen: { host: "127.0.0.1", port: 0 },
      startupReconnectDelayMs: 25,
    });
    services.push(fresh);
    await fresh.start();
    await vi.waitFor(
      () => expect(fresh.status().peers[0]?.state).toBe("steady"),
      { timeout: 5_000 },
    );
  });

  it("uses the latest discovered endpoint for a pending reconnect", async () => {
    const discoveryA = fakeDiscovery();
    const discoveryB = fakeDiscovery();
    const a = await rig("A", { discovery: discoveryA.impl, startupReconnectDelayMs: 60_000 });
    const b = await rig("B", { discovery: discoveryB.impl, startupReconnectDelayMs: 60_000 });
    const portA = await start(a);
    await start(b);
    expect((await b.service.pairWithCode("127.0.0.1", portA, a.service.beginPairing())).ok).toBe(true);
    await vi.waitFor(() => expect(a.service.status().peers[0]?.state).toBe("steady"));

    const aDials = a.service.deps.identity.fingerprint < b.service.deps.identity.fingerprint;
    const dialer = aDials ? a : b;
    const dialerDiscovery = aDials ? discoveryA : discoveryB;
    const listener = aDials ? b : a;
    await listener.service.stop();
    await listener.service.start();
    const currentPort = listener.service.status().port!;
    await vi.waitFor(() => expect(dialer.service.status().peers[0]?.state).toBe("offline"));

    dialerDiscovery.fire({
      fingerprint: listener.service.deps.identity.fingerprint,
      name: listener.service.deps.deviceName(),
      address: "127.0.0.1",
      port: 1,
    });
    dialerDiscovery.fire({
      fingerprint: listener.service.deps.identity.fingerprint,
      name: listener.service.deps.deviceName(),
      address: "127.0.0.1",
      port: currentPort,
    });

    await vi.waitFor(
      () => expect(dialer.service.status().peers[0]?.state).toBe("steady"),
      { timeout: 5_000 },
    );
    expect(dialer.engine.getSyncPeer(listener.service.deps.identity.fingerprint)?.address)
      .toBe(`127.0.0.1:${currentPort}`);
  });

  it("keeps an unverified discovered endpoint out of durable peer state", async () => {
    const discovery = fakeDiscovery();
    const local = await rig("Local", {
      discovery: discovery.impl,
      startupReconnectDelayMs: 60_000,
    });
    await start(local);
    const fingerprint = "0".repeat(64);
    local.engine.upsertSyncPeer({
      fingerprint,
      name: "VPN peer",
      address: "vpn.example.test:52100",
    });

    discovery.fire({
      fingerprint,
      name: "Spoofed LAN peer",
      address: "192.0.2.99",
      port: 52_199,
    });

    expect(local.engine.getSyncPeer(fingerprint)?.address).toBe("vpn.example.test:52100");
  });

  it("falls back to a saved manual route after a discovered endpoint fails pinning", async () => {
    const discoveryA = fakeDiscovery();
    const discoveryB = fakeDiscovery();
    const attemptedPorts: number[] = [];
    const connectTls = (options: tls.ConnectionOptions): tls.TLSSocket => {
      attemptedPorts.push(Number(options.port));
      return tls.connect(options);
    };
    const a = await rig("A", {
      discovery: discoveryA.impl,
      connectTls,
      startupReconnectDelayMs: 60_000,
    });
    const b = await rig("B", {
      discovery: discoveryB.impl,
      connectTls,
      startupReconnectDelayMs: 60_000,
    });
    const hostile = await rig("Hostile", { startupReconnectDelayMs: 60_000 });
    const portA = await start(a);
    const portB = await start(b);
    const hostilePort = await start(hostile);
    const aDials = a.service.deps.identity.fingerprint < b.service.deps.identity.fingerprint;
    const dialer = aDials ? a : b;
    const listener = aDials ? b : a;
    const dialerDiscovery = aDials ? discoveryA : discoveryB;
    const listenerPort = aDials ? portB : portA;
    const listenerFingerprint = listener.service.deps.identity.fingerprint;

    expect(
      (await dialer.service.pairWithCode(
        "127.0.0.1",
        listenerPort,
        listener.service.beginPairing(),
      )).ok,
    ).toBe(true);
    await vi.waitFor(() => expect(dialer.service.status().peers[0]?.state).toBe("steady"));
    expect(dialer.engine.getSyncPeer(listenerFingerprint)?.address)
      .toBe(`127.0.0.1:${listenerPort}`);

    await dialer.service.stop();
    await dialer.service.start();
    attemptedPorts.length = 0;
    dialerDiscovery.fire({
      fingerprint: listenerFingerprint,
      name: "Hostile advertisement",
      address: "127.0.0.1",
      port: hostilePort,
    });

    await vi.waitFor(
      () => expect(dialer.service.status().peers[0]?.state).toBe("steady"),
      { timeout: 5_000 },
    );
    expect(attemptedPorts).toEqual([hostilePort, listenerPort]);
    expect(dialer.engine.getSyncPeer(listenerFingerprint)?.address)
      .toBe(`127.0.0.1:${listenerPort}`);
  });

  it("falls back to a saved manual route when discovery withdraws a pending endpoint", async () => {
    const discoveryA = fakeDiscovery();
    const discoveryB = fakeDiscovery();
    let markCandidateStarted!: () => void;
    const candidateStarted = new Promise<void>((resolve) => {
      markCandidateStarted = resolve;
    });
    const connectTls = (options: tls.ConnectionOptions): tls.TLSSocket => {
      if (options.host !== "withdrawn-mdns.invalid") return tls.connect(options);
      markCandidateStarted();
      return tls.connect({ ...options, lookup: () => {} });
    };
    const a = await rig("A", {
      discovery: discoveryA.impl,
      connectTls,
      handshakeTimeoutMs: 5_000,
      startupReconnectDelayMs: 60_000,
    });
    const b = await rig("B", {
      discovery: discoveryB.impl,
      connectTls,
      handshakeTimeoutMs: 5_000,
      startupReconnectDelayMs: 60_000,
    });
    const portA = await start(a);
    const portB = await start(b);
    const aDials = a.service.deps.identity.fingerprint < b.service.deps.identity.fingerprint;
    const dialer = aDials ? a : b;
    const listener = aDials ? b : a;
    const dialerDiscovery = aDials ? discoveryA : discoveryB;
    const listenerPort = aDials ? portB : portA;
    const listenerFingerprint = listener.service.deps.identity.fingerprint;

    expect(
      (await dialer.service.pairWithCode(
        "127.0.0.1",
        listenerPort,
        listener.service.beginPairing(),
      )).ok,
    ).toBe(true);
    await vi.waitFor(() => expect(dialer.service.status().peers[0]?.state).toBe("steady"));

    await dialer.service.stop();
    await dialer.service.start();
    dialerDiscovery.fire({
      fingerprint: listenerFingerprint,
      name: "Withdrawn route",
      address: "withdrawn-mdns.invalid",
      port: listenerPort,
    });
    await candidateStarted;
    dialerDiscovery.down(listenerFingerprint);

    await vi.waitFor(
      () => expect(dialer.service.status().peers[0]?.state).toBe("steady"),
      { timeout: 2_500 },
    );
    expect(dialer.engine.getSyncPeer(listenerFingerprint)?.address)
      .toBe(`127.0.0.1:${listenerPort}`);
  });

  it("promotes a discovery-only route after pinning and reuses it on restart", async () => {
    const discoveryA = fakeDiscovery();
    const discoveryB = fakeDiscovery();
    const a = await rig("A", { discovery: discoveryA.impl, startupReconnectDelayMs: 60_000 });
    const b = await rig("B", { discovery: discoveryB.impl, startupReconnectDelayMs: 60_000 });
    const portA = await start(a);
    const portB = await start(b);
    const aDials = a.service.deps.identity.fingerprint < b.service.deps.identity.fingerprint;
    const dialer = aDials ? a : b;
    const listener = aDials ? b : a;
    const dialerDiscovery = aDials ? discoveryA : discoveryB;
    const listenerPort = aDials ? portB : portA;
    const listenerFingerprint = listener.service.deps.identity.fingerprint;

    dialer.engine.upsertSyncPeer({ fingerprint: listenerFingerprint, name: "Listener" });
    listener.engine.upsertSyncPeer({
      fingerprint: dialer.service.deps.identity.fingerprint,
      name: "Dialer",
    });
    dialerDiscovery.fire({
      fingerprint: listenerFingerprint,
      name: "Listener",
      address: "127.0.0.1",
      port: listenerPort,
    });

    await vi.waitFor(() => expect(dialer.service.status().peers[0]?.state).toBe("steady"));
    expect(dialer.engine.getSyncPeer(listenerFingerprint)?.address)
      .toBe(`127.0.0.1:${listenerPort}`);

    await dialer.service.stop();
    dialer.service.deps.startupReconnectDelayMs = 25;
    await dialer.service.start();
    await vi.waitFor(
      () => expect(dialer.service.status().peers[0]?.state).toBe("steady"),
      { timeout: 5_000 },
    );
  });

  it("cancels an older dial before it can overwrite a newer manual endpoint", async () => {
    let resolveLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      resolveLookupStarted = resolve;
    });
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const remote = await rig("Remote", { startupReconnectDelayMs: 60_000 });
    const remotePort = await start(remote);
    const local = await rig("Local", {
      connectTls: (options) => tls.connect({
        ...options,
        lookup: (_hostname, lookupOptions, callback) => {
          resolveLookupStarted();
          void lookupGate.then(() => {
            if (lookupOptions.all) {
              callback(null, [{ address: "127.0.0.1", family: 4 }]);
            } else {
              callback(null, "127.0.0.1", 4);
            }
          });
        },
      }),
      startupReconnectDelayMs: 60_000,
    });
    await start(local);
    local.engine.upsertSyncPeer({
      fingerprint: remote.service.deps.identity.fingerprint,
      name: "Remote",
    });
    remote.engine.upsertSyncPeer({
      fingerprint: local.service.deps.identity.fingerprint,
      name: "Local",
    });
    const code = remote.service.deps.identity.pairingCode;

    try {
      const olderDial = local.service.pairWithCode("stale.peer.invalid", remotePort, code);
      await lookupStarted;
      const newerManualDial = local.service.pairWithCode("127.0.0.1", remotePort, code);
      expect(local.engine.getSyncPeer(remote.service.deps.identity.fingerprint)?.address)
        .toBe(`127.0.0.1:${remotePort}`);

      releaseLookup();
      expect(await olderDial).toEqual({
        ok: false,
        error: "Connection superseded by a newer manual endpoint",
      });
      expect((await newerManualDial).ok).toBe(true);
      expect(local.engine.getSyncPeer(remote.service.deps.identity.fingerprint)?.address)
        .toBe(`127.0.0.1:${remotePort}`);
    } finally {
      releaseLookup();
    }
  });

  it("supersedes a hanging dial with a newer manual endpoint", async () => {
    let resolveLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      resolveLookupStarted = resolve;
    });
    const attemptedHosts: string[] = [];
    const remote = await rig("Remote", { startupReconnectDelayMs: 60_000 });
    const remotePort = await start(remote);
    const local = await rig("Local", {
      connectTls: (options) => {
        attemptedHosts.push(String(options.host));
        if (options.host !== "stale.peer.invalid") return tls.connect(options);
        return tls.connect({
          ...options,
          lookup: () => resolveLookupStarted(),
        });
      },
      handshakeTimeoutMs: 5_000,
      startupReconnectDelayMs: 60_000,
    });
    await start(local);
    local.engine.upsertSyncPeer({
      fingerprint: remote.service.deps.identity.fingerprint,
      name: "Remote",
    });
    remote.engine.upsertSyncPeer({
      fingerprint: local.service.deps.identity.fingerprint,
      name: "Local",
    });
    const code = remote.service.deps.identity.pairingCode;
    const olderDial = local.service.pairWithCode("stale.peer.invalid", remotePort, code);
    let deadline: NodeJS.Timeout | null = null;

    try {
      await lookupStarted;
      const newerDial = local.service.pairWithCode("127.0.0.1", remotePort, code);
      const newerResult = await Promise.race([
        newerDial,
        new Promise<"deadline">((resolve) => {
          deadline = setTimeout(() => resolve("deadline"), 750);
        }),
      ]);

      expect(newerResult).not.toBe("deadline");
      expect(newerResult).toEqual({ ok: true });
      expect(await olderDial).toEqual({
        ok: false,
        error: "Connection superseded by a newer manual endpoint",
      });
      await vi.waitFor(() => expect(local.service.status().peers[0]?.state).toBe("steady"));
      expect(attemptedHosts).toEqual(["stale.peer.invalid", "127.0.0.1"]);
      expect(local.engine.getSyncPeer(remote.service.deps.identity.fingerprint)?.address)
        .toBe(`127.0.0.1:${remotePort}`);
    } finally {
      if (deadline) clearTimeout(deadline);
      await local.service.stop();
      await olderDial;
    }
  });

  it("keeps discovery from displacing a manual endpoint during supersession", async () => {
    let resolveLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      resolveLookupStarted = resolve;
    });
    const attemptedHosts: string[] = [];
    const discovery = fakeDiscovery();
    const remote = await rig("Remote", { startupReconnectDelayMs: 60_000 });
    const remotePort = await start(remote);
    const local = await rig("Local", {
      discovery: discovery.impl,
      connectTls: (options) => {
        attemptedHosts.push(String(options.host));
        if (options.host !== "stale.peer.invalid") return tls.connect(options);
        return tls.connect({
          ...options,
          lookup: () => resolveLookupStarted(),
        });
      },
      handshakeTimeoutMs: 5_000,
      startupReconnectDelayMs: 60_000,
    });
    await start(local);
    const fingerprint = remote.service.deps.identity.fingerprint;
    local.engine.upsertSyncPeer({ fingerprint, name: "Remote" });
    remote.engine.upsertSyncPeer({
      fingerprint: local.service.deps.identity.fingerprint,
      name: "Local",
    });
    const code = remote.service.deps.identity.pairingCode;
    const olderDial = local.service.pairWithCode("stale.peer.invalid", remotePort, code);

    try {
      await lookupStarted;
      const manualDial = local.service.pairWithCode("127.0.0.1", remotePort, code);
      discovery.fire({
        fingerprint,
        name: "Unverified LAN route",
        address: "192.0.2.55",
        port: 52_155,
      });

      expect(await manualDial).toEqual({ ok: true });
      expect(await olderDial).toEqual({
        ok: false,
        error: "Connection superseded by a newer manual endpoint",
      });
      await vi.waitFor(() => expect(local.service.status().peers[0]?.state).toBe("steady"));
      expect(attemptedHosts).toEqual(["stale.peer.invalid", "127.0.0.1"]);
      expect(local.engine.getSyncPeer(fingerprint)?.address).toBe(`127.0.0.1:${remotePort}`);
    } finally {
      await local.service.stop();
      await olderDial;
    }
  });

  it("lets the latest manual endpoint supersede an earlier queued manual claim", async () => {
    let resolveLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      resolveLookupStarted = resolve;
    });
    const attemptedHosts: string[] = [];
    const remote = await rig("Remote", { startupReconnectDelayMs: 60_000 });
    const remotePort = await start(remote);
    const local = await rig("Local", {
      connectTls: (options) => {
        attemptedHosts.push(String(options.host));
        if (options.host !== "stale.peer.invalid") return tls.connect(options);
        return tls.connect({
          ...options,
          lookup: () => resolveLookupStarted(),
        });
      },
      handshakeTimeoutMs: 5_000,
      startupReconnectDelayMs: 60_000,
    });
    await start(local);
    const fingerprint = remote.service.deps.identity.fingerprint;
    local.engine.upsertSyncPeer({ fingerprint, name: "Remote" });
    remote.engine.upsertSyncPeer({
      fingerprint: local.service.deps.identity.fingerprint,
      name: "Local",
    });
    const code = remote.service.deps.identity.pairingCode;
    const olderDial = local.service.pairWithCode("stale.peer.invalid", remotePort, code);

    try {
      await lookupStarted;
      const middleDial = local.service.pairWithCode("middle.peer.invalid", remotePort, code);
      const latestDial = local.service.pairWithCode("127.0.0.1", remotePort, code);

      expect(await latestDial).toEqual({ ok: true });
      expect(await olderDial).toEqual({
        ok: false,
        error: "Connection superseded by a newer manual endpoint",
      });
      expect(await middleDial).toEqual({
        ok: false,
        error: "Connection superseded by a newer manual endpoint",
      });
      expect(attemptedHosts).toEqual(["stale.peer.invalid", "127.0.0.1"]);
      expect(local.engine.getSyncPeer(fingerprint)?.address).toBe(`127.0.0.1:${remotePort}`);
    } finally {
      await local.service.stop();
      await olderDial;
    }
  });

  it("removes a down nearby device without forgetting a paired peer", async () => {
    const discovery = fakeDiscovery();
    const local = await rig("Local", { discovery: discovery.impl });
    await start(local);
    const fingerprint = "a".repeat(64);
    discovery.fire({ fingerprint, name: "Nearby", address: "127.0.0.1", port: 52_100 });
    expect(local.service.status().nearby).toHaveLength(1);
    discovery.down(fingerprint);
    expect(local.service.status().nearby).toEqual([]);

    local.engine.upsertSyncPeer({ fingerprint, name: "Paired", address: "127.0.0.1:52100" });
    discovery.down(fingerprint);
    expect(local.engine.getSyncPeer(fingerprint)?.forgotten_at).toBeNull();
  });

  it("reserves one outbound dial while repeated discovery events overlap", async () => {
    const discoveryA = fakeDiscovery();
    const discoveryB = fakeDiscovery();
    let connectCallsA = 0;
    let connectCallsB = 0;
    const a = await rig("A", {
      discovery: discoveryA.impl,
      connectTls: (options) => {
        connectCallsA += 1;
        return tls.connect(options);
      },
      startupReconnectDelayMs: 60_000,
    });
    const b = await rig("B", {
      discovery: discoveryB.impl,
      connectTls: (options) => {
        connectCallsB += 1;
        return tls.connect(options);
      },
      startupReconnectDelayMs: 60_000,
    });
    const portA = await start(a);
    const portB = await start(b);
    const aDials = a.service.deps.identity.fingerprint < b.service.deps.identity.fingerprint;
    const dialer = aDials ? a : b;
    const listener = aDials ? b : a;
    const discovery = aDials ? discoveryA : discoveryB;
    const listenerPort = aDials ? portB : portA;
    dialer.engine.upsertSyncPeer({
      fingerprint: listener.service.deps.identity.fingerprint,
      name: "Remote",
    });
    listener.engine.upsertSyncPeer({
      fingerprint: dialer.service.deps.identity.fingerprint,
      name: "Dialer",
    });
    const peer = {
      fingerprint: listener.service.deps.identity.fingerprint,
      name: "Remote",
      address: "127.0.0.1",
      port: listenerPort,
    };
    discovery.fire(peer);
    const manualReconnect = dialer.service.pairWithCode(
      peer.address,
      peer.port,
      listener.service.deps.identity.pairingCode,
    );
    discovery.fire(peer);
    discovery.fire(peer);

    expect((await manualReconnect).ok).toBe(true);
    await vi.waitFor(() => {
      expect(dialer.service.status().peers[0]?.state).toBe("steady");
      expect(listener.service.status().peers[0]?.state).toBe("steady");
    });
    expect(connectCallsA + connectCallsB).toBe(1);
  });

  it("resolves an inbound/outbound race with the fingerprint direction preference", async () => {
    let outboundA: tls.TLSSocket | null = null;
    let outboundB: tls.TLSSocket | null = null;
    const a = await rig("A", {
      connectTls: (options) => {
        outboundA = tls.connect(options);
        return outboundA;
      },
      startupReconnectDelayMs: 60_000,
    });
    const b = await rig("B", {
      connectTls: (options) => {
        outboundB = tls.connect(options);
        return outboundB;
      },
      startupReconnectDelayMs: 60_000,
    });
    const portA = await start(a);
    const portB = await start(b);
    a.engine.upsertSyncPeer({
      fingerprint: b.service.deps.identity.fingerprint,
      name: "B",
      address: `127.0.0.1:${portB}`,
    });
    b.engine.upsertSyncPeer({
      fingerprint: a.service.deps.identity.fingerprint,
      name: "A",
      address: `127.0.0.1:${portA}`,
    });

    const [resultA, resultB] = await Promise.all([
      a.service.pairWithCode("127.0.0.1", portB, b.service.deps.identity.pairingCode),
      b.service.pairWithCode("127.0.0.1", portA, a.service.deps.identity.pairingCode),
    ]);
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    await vi.waitFor(() => {
      expect(a.service.status().peers).toHaveLength(1);
      expect(b.service.status().peers).toHaveLength(1);
      expect(a.service.status().peers[0]?.state).toBe("steady");
      expect(b.service.status().peers[0]?.state).toBe("steady");
    });

    const aPrefersOutbound =
      a.service.deps.identity.fingerprint < b.service.deps.identity.fingerprint;
    await vi.waitFor(() => {
      expect(outboundA?.destroyed).toBe(!aPrefersOutbound);
      expect(outboundB?.destroyed).toBe(aPrefersOutbound);
    });
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

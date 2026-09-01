import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openMemoryDatabase, PromptLibrary } from "@promptbranch/core";
import type { SyncPairRequestEvent, SyncStatusDto } from "../../shared/ipc.js";
import type { Discovery } from "./discovery.js";
import { derivePairingCode, loadOrCreateIdentity, type DeviceIdentity } from "./identity.js";
import { DesktopSync } from "./service.js";

const dirs: string[] = [];
const syncs: DesktopSync[] = [];
const hangingServers: Array<{ server: net.Server; sockets: Set<net.Socket> }> = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pb-sync-desktop-"));
  dirs.push(dir);
  return dir;
}

interface Rig {
  lib: PromptLibrary;
  db: ReturnType<typeof openMemoryDatabase>;
  identity: DeviceIdentity;
  sync: DesktopSync;
  statuses: SyncStatusDto[];
  pairRequests: SyncPairRequestEvent[];
  pairRequestClosures: string[];
}

async function rig(
  name = "Test Mac",
  discoveryFactory: () => Discovery = () => ({
    start: () => {},
    stop: async () => {},
  }),
): Promise<Rig> {
  const db = openMemoryDatabase();
  const lib = new PromptLibrary(db);
  const statuses: SyncStatusDto[] = [];
  const pairRequests: SyncPairRequestEvent[] = [];
  const pairRequestClosures: string[] = [];
  // The identity directory must be shared between minting and the service.
  const identityDir = tempDir();
  const identity = await loadOrCreateIdentity(identityDir);
  const sync = new DesktopSync({
    lib,
    db,
    identityDir,
    deviceNameFallback: () => name,
    sendStatus: (status) => statuses.push(status),
    sendPairRequest: (event) => pairRequests.push(event),
    sendPairRequestClosed: (event: { requestId: string }) =>
      pairRequestClosures.push(event.requestId),
    discoveryFactory,
    log: () => {},
  });
  syncs.push(sync);
  return { lib, db, identity, sync, statuses, pairRequests, pairRequestClosures };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function requestConfirmation(
  sync: DesktopSync,
  fingerprint: string,
  name = "MacBook Pro",
  signal = new AbortController().signal,
): Promise<boolean> {
  return (
    sync as unknown as {
      confirmPairing(
        candidateFingerprint: string,
        candidateName: string,
        candidateSignal: AbortSignal,
      ): Promise<boolean>;
    }
  ).confirmPairing(fingerprint, name, signal);
}

async function hangingTlsServer(): Promise<{ port: number; sockets: Set<net.Socket> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.resume();
  });
  hangingServers.push({ server, sockets });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : 0,
    sockets,
  };
}

async function pendingKnownDial(sync: DesktopSync, port: number, fingerprint: string) {
  sync.engine.upsertSyncPeer({
    fingerprint,
    name: "Delayed peer",
    address: `127.0.0.1:${port}`,
  });
  return sync.pairWithCode("127.0.0.1", port, derivePairingCode(fingerprint));
}

/** Tests reach the visible listener port for loopback pairing. */
function listeningPort(sync: DesktopSync): number {
  const status = sync.status();
  if (!status.listening) throw new Error("sync not listening");
  const port = status.listenPort;
  if (port === null) throw new Error("no port");
  return port;
}

afterEach(async () => {
  for (const sync of syncs.splice(0)) await sync.stop();
  for (const { server, sockets } of hangingServers.splice(0)) {
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      server.close();
      await once(server, "close");
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("DesktopSync coordinator", () => {
  it("reports disabled until enabled", async () => {
    const { sync } = await rig();
    await sync.ensureStarted();
    const status = sync.status();
    expect(status.enabled).toBe(false);
    expect(status.listening).toBe(false);
    expect(status.peers).toEqual([]);
  });

  it("enabling bootstraps a pre-sync library into the op log and listens", async () => {
    const { lib, sync } = await rig();
    lib.createPrompt({ title: "Legacy", content: "old" });
    await sync.ensureStarted();
    expect(sync.status().enabled).toBe(false);

    const enabled = await sync.setEnabled(true);
    expect(enabled.enabled).toBe(true);
    expect(enabled.listening).toBe(true);
    // The legacy prompt shipped into the op log immediately.
    const ops = (
      sync as unknown as { engine: { haveVector: () => Record<string, number> } }
    ).engine.haveVector();
    expect(Object.values(ops)[0]).toBeGreaterThan(0);

    const disabled = await sync.setEnabled(false);
    expect(disabled.enabled).toBe(false);
    expect(disabled.listening).toBe(false);
  });

  it("retries startup after a discovery failure instead of retaining the failed service", async () => {
    let starts = 0;
    const { lib, sync } = await rig("Test Mac", () => ({
      start: () => {
        starts += 1;
        if (starts === 1) throw new Error("bonjour unavailable");
      },
      stop: async () => {},
    }));
    lib.setSetting("sync.enabled", "1");

    await expect(sync.ensureStarted()).rejects.toThrow("bonjour unavailable");
    await sync.ensureStarted();

    expect(starts).toBe(2);
    expect(sync.status().listening).toBe(true);
  });

  it("persists the device name and reports it", async () => {
    const { lib, sync } = await rig();
    await sync.setEnabled(true);
    const status = await sync.setDeviceName("Studio");
    expect(status.deviceName).toBe("Studio");
    expect(lib.getSetting("sync.deviceName")).toBe("Studio");
  });

  it("persists the first ephemeral listener port and reuses it in a fresh coordinator", async () => {
    const first = await rig();
    const enabled = await first.sync.setEnabled(true);
    expect(enabled.listenPort).toBeGreaterThanOrEqual(1_024);
    expect(first.lib.getSetting("sync.listenPort")).toBe(String(enabled.listenPort));
    await first.sync.stop();

    const statuses: SyncStatusDto[] = [];
    const restarted = new DesktopSync({
      lib: first.lib,
      db: first.db,
      identityDir: dirs[0]!,
      deviceNameFallback: () => "Test Mac",
      sendStatus: (status) => statuses.push(status),
      sendPairRequest: () => {},
      sendPairRequestClosed: () => {},
      discoveryFactory: () => ({ start: () => {}, stop: async () => {} }),
      log: () => {},
    });
    syncs.push(restarted);
    await restarted.ensureStarted();
    expect(restarted.status().listenPort).toBe(enabled.listenPort);
    expect(restarted.status().listening).toBe(true);
  });

  it("restarts on an explicit non-privileged port", async () => {
    const { lib, sync } = await rig();
    await sync.setEnabled(true);
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const address = probe.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    probe.close();
    await once(probe, "close");

    const status = await sync.setListenPort(port);
    expect(status.listening).toBe(true);
    expect(status.listenPort).toBe(port);
    expect(status.listenError).toBeNull();
    expect(lib.getSetting("sync.listenPort")).toBe(String(port));
  });

  it("keeps a requested port visible and actionable when binding fails", async () => {
    const blocker = net.createServer();
    blocker.listen(0, "0.0.0.0");
    await once(blocker, "listening");
    const address = blocker.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const { lib, sync } = await rig();

    try {
      await sync.setEnabled(true);
      const status = await sync.setListenPort(port);
      expect(status.listening).toBe(false);
      expect(status.listenPort).toBe(port);
      expect(status.listenError).toMatch(/already in use.*choose another port/i);
      expect(lib.getSetting("sync.listenPort")).toBe(String(port));
    } finally {
      blocker.close();
      await once(blocker, "close");
    }
  });

  it("finishes disabled with no listener when a port save overlaps disabling sync", async () => {
    const stopEntered = deferred();
    const releaseStop = deferred();
    const { sync } = await rig("Test Mac", () => ({
      start: () => {},
      stop: async () => {
        stopEntered.resolve();
        await releaseStop.promise;
      },
    }));
    await sync.setEnabled(true);
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const address = probe.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    probe.close();
    await once(probe, "close");

    const changingPort = sync.setListenPort(port);
    await stopEntered.promise;
    const disabling = sync.setEnabled(false);
    releaseStop.resolve();
    await Promise.all([changingPort, disabling]);

    expect(sync.status().enabled).toBe(false);
    expect(sync.status().listening).toBe(false);
  });

  it("does not let an in-flight startup outlive a requested stop", async () => {
    const { lib, sync } = await rig();
    lib.setSetting("sync.enabled", "1");

    await Promise.all([sync.ensureStarted(), sync.stop()]);

    expect(sync.status().enabled).toBe(true);
    expect(sync.status().listening).toBe(false);
  });

  it("gives same-fingerprint confirmations distinct request ownership", async () => {
    const { sync, pairRequests } = await rig();
    vi.useFakeTimers();
    try {
      const fingerprint = "e".repeat(64);
      const first = requestConfirmation(sync, fingerprint);
      const second = requestConfirmation(sync, fingerprint);
      expect(pairRequests[0]?.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(pairRequests[1]?.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(pairRequests[1]?.requestId).not.toBe(pairRequests[0]?.requestId);

      sync.respondPairing(pairRequests[0]!.requestId, true);
      sync.respondPairing(pairRequests[1]!.requestId, false);
      expect(await Promise.all([first, second])).toEqual([true, false]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not let an old timeout or stale response consume a newer request", async () => {
    const { sync, pairRequests, pairRequestClosures } = await rig();
    vi.useFakeTimers();
    try {
      const fingerprint = "f".repeat(64);
      const first = requestConfirmation(sync, fingerprint);
      await vi.advanceTimersByTimeAsync(10_000);
      const second = requestConfirmation(sync, fingerprint);
      const firstRequest = pairRequests[0]!;
      const secondRequest = pairRequests[1]!;

      await vi.advanceTimersByTimeAsync(50_000);
      expect(await first).toBe(false);
      expect(pairRequestClosures).toEqual([firstRequest.requestId]);
      sync.respondPairing(firstRequest.requestId, true);
      sync.respondPairing(secondRequest.requestId, true);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(await second).toBe(true);
      expect(pairRequestClosures).toEqual([
        firstRequest.requestId,
        secondRequest.requestId,
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("aborting one confirmation closes only its exact same-fingerprint request", async () => {
    const { sync, pairRequests, pairRequestClosures } = await rig();
    const fingerprint = "a".repeat(64);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = requestConfirmation(sync, fingerprint, "First", firstController.signal);
    const second = requestConfirmation(sync, fingerprint, "Second", secondController.signal);
    let firstResult: boolean | undefined;
    void first.then((accepted) => {
      firstResult = accepted;
    });

    firstController.abort();
    await vi.waitFor(() => expect(firstResult).toBe(false));
    expect(pairRequestClosures).toEqual([pairRequests[0]!.requestId]);
    sync.respondPairing(pairRequests[0]!.requestId, true);
    sync.respondPairing(pairRequests[1]!.requestId, true);
    expect(await second).toBe(true);
    expect(pairRequestClosures).toEqual([
      pairRequests[0]!.requestId,
      pairRequests[1]!.requestId,
    ]);
  });

  it.each(["stop", "dispose"] as const)(
    "%s rejects pending confirmations and clears their timers",
    async (action) => {
      const { sync, pairRequests, pairRequestClosures } = await rig();
      vi.useFakeTimers();
      try {
        let outcome: boolean | undefined;
        void requestConfirmation(sync, "1".repeat(64)).then((accepted) => {
          outcome = accepted;
        });

        if (action === "stop") await sync.stop();
        else sync.dispose();
        await Promise.resolve();

        expect(outcome).toBe(false);
        expect(pairRequestClosures).toEqual([pairRequests[0]!.requestId]);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it("rejects pending confirmations before a listener-port restart", async () => {
    const { sync } = await rig();
    await sync.setEnabled(true);
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const address = probe.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    probe.close();
    await once(probe, "close");
    let outcome: boolean | undefined;
    void requestConfirmation(sync, "2".repeat(64)).then((accepted) => {
      outcome = accepted;
    });

    await sync.setListenPort(port);
    await Promise.resolve();

    expect(outcome).toBe(false);
  });

  it("cancels a pending known-peer dial when sync is disabled", async () => {
    const { sync } = await rig();
    await sync.setEnabled(true);
    const delayed = await hangingTlsServer();
    const fingerprint = "b".repeat(64);
    const pending = pendingKnownDial(sync, delayed.port, fingerprint);
    await vi.waitFor(() => expect(delayed.sockets.size).toBe(1));
    const originalSocket = [...delayed.sockets][0]!;

    const status = await sync.setEnabled(false);
    expect(status.enabled).toBe(false);
    expect(status.listening).toBe(false);
    await vi.waitFor(() => expect(originalSocket.destroyed).toBe(true));
    const result = await Promise.race([
      pending,
      new Promise<"still pending">((resolve) => setTimeout(() => resolve("still pending"), 250)),
    ]);
    expect(result).not.toBe("still pending");
    expect(result).toMatchObject({ ok: false });
    expect(sync.engine.getSyncPeer(fingerprint)?.forgotten_at).toBeNull();
    expect(delayed.sockets.size).toBe(0);
  });

  it("cancels a pending known-peer dial before restarting on a new port", async () => {
    const { sync } = await rig();
    await sync.setEnabled(true);
    const delayed = await hangingTlsServer();
    const fingerprint = "c".repeat(64);
    const pending = pendingKnownDial(sync, delayed.port, fingerprint);
    await vi.waitFor(() => expect(delayed.sockets.size).toBe(1));
    const originalSocket = [...delayed.sockets][0]!;
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const address = probe.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    probe.close();
    await once(probe, "close");

    const status = await sync.setListenPort(port);
    expect(status.listening).toBe(true);
    expect(status.listenPort).toBe(port);
    await vi.waitFor(() => expect(originalSocket.destroyed).toBe(true));
    const result = await Promise.race([
      pending,
      new Promise<"still pending">((resolve) => setTimeout(() => resolve("still pending"), 250)),
    ]);
    expect(result).not.toBe("still pending");
    expect(result).toMatchObject({ ok: false });
    expect(sync.status().peers[0]?.state).toBe("offline");
  });

  it("cancels a pending dial before forgetting the peer", async () => {
    const { sync } = await rig();
    await sync.setEnabled(true);
    const delayed = await hangingTlsServer();
    const fingerprint = "d".repeat(64);
    const pending = pendingKnownDial(sync, delayed.port, fingerprint);
    await vi.waitFor(() => expect(delayed.sockets.size).toBe(1));

    const status = await sync.forgetDevice(fingerprint);
    expect(status.peers).toEqual([]);
    await vi.waitFor(() => expect(delayed.sockets.size).toBe(0));
    const result = await Promise.race([
      pending,
      new Promise<"still pending">((resolve) => setTimeout(() => resolve("still pending"), 250)),
    ]);
    expect(result).not.toBe("still pending");
    expect(result).toMatchObject({ ok: false });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sync.engine.getSyncPeer(fingerprint)?.forgotten_at).not.toBeNull();
    expect(sync.status().peers).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(delayed.sockets.size).toBe(0);
  });

  it("the background drain refines dirty rows even while sync is disabled", async () => {
    const { lib, sync } = await rig();
    const { engine } = sync;
    // A CLI/MCP write lands while sync is off: triggers capture it, and the
    // 60s drain must still collapse it into the op log — otherwise
    // sync_dirty grows without bound until re-enable.
    lib.createPrompt({ title: "Offline write", content: "x" });
    expect(engine.pendingDirty()).toBeGreaterThan(0);
    expect(sync.status().pendingDirty).toBeGreaterThan(0);

    sync.poke();
    expect(engine.pendingDirty()).toBe(0);
    const vector = Object.values(engine.haveVector());
    expect(vector[0]).toBeGreaterThan(0);
  });

  it("pairs two rigs end-to-end through the renderer confirm bridge", async () => {
    const a = await rig("Mac Studio");
    const b = await rig("MacBook Pro");
    await a.sync.setEnabled(true);
    await b.sync.setEnabled(true);

    const code = (await a.sync.beginPairing()).pairingCode;
    expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);

    const pairing = b.sync.pairWithCode("127.0.0.1", listeningPort(a.sync), code!);
    // A's renderer receives the request and accepts.
    await vi.waitFor(() => expect(a.pairRequests.length).toBe(1));
    a.sync.respondPairing(a.pairRequests[0]!.requestId, true);
    const result = await pairing;
    expect(result.ok).toBe(true);

    const before = b.lib.listPrompts().length;
    a.lib.createPrompt({ title: "From A", content: "x" });
    a.sync.poke();
    await vi.waitFor(() => expect(b.lib.listPrompts().length).toBe(before + 1));

    const statusA = a.sync.status();
    expect(statusA.peers.length).toBe(1);
    expect(statusA.peers[0]?.name).toBe("MacBook Pro");
  });

  it("rejects a same-device double submit without stealing the first pairing", async () => {
    const a = await rig("Acceptor");
    const b = await rig("Initiator");
    await a.sync.setEnabled(true);
    await b.sync.setEnabled(true);
    const code = (await a.sync.beginPairing()).pairingCode!;

    const first = b.sync.pairWithCode("127.0.0.1", listeningPort(a.sync), code);
    await vi.waitFor(() => expect(a.pairRequests).toHaveLength(1));
    const second = b.sync.pairWithCode("127.0.0.1", listeningPort(a.sync), code);
    let secondResult: Awaited<typeof second> | undefined;
    void second.then((result) => {
      secondResult = result;
    });

    await vi.waitFor(() => expect(secondResult).toMatchObject({ ok: false }), { timeout: 750 });
    expect(a.pairRequests).toHaveLength(1);
    a.sync.respondPairing(a.pairRequests[0]!.requestId, true);
    expect(await first).toEqual({ ok: true });
    expect(a.sync.status().peers).toHaveLength(1);
    expect(b.sync.status().peers).toHaveLength(1);
  });

  it("forgetting a device unpins it and drops its live connection", async () => {
    const a = await rig("Mac Studio");
    const b = await rig("MacBook Pro");
    await a.sync.setEnabled(true);
    await b.sync.setEnabled(true);

    const code = (await a.sync.beginPairing()).pairingCode!;
    const pairing = b.sync.pairWithCode("127.0.0.1", listeningPort(a.sync), code);
    await vi.waitFor(() => expect(a.pairRequests.length).toBe(1));
    a.sync.respondPairing(a.pairRequests[0]!.requestId, true);
    await pairing;
    expect(a.sync.status().peers.length).toBe(1);

    // Forget while connected: A unpins, drops the socket — B must notice
    // instead of syncing against a revoked device.
    const peerFingerprint = b.identity.fingerprint;
    const status = await a.sync.forgetDevice(peerFingerprint);
    expect(status.peers).toEqual([]);
    await vi.waitFor(
      () => expect(b.sync.status().peers[0]?.state).toBe("offline"),
      { timeout: 5_000 },
    );
  });

  it("declines pairing when the renderer says no", async () => {
    const a = await rig("A");
    const b = await rig("B");
    await a.sync.setEnabled(true);
    await b.sync.setEnabled(true);

    const code = (await a.sync.beginPairing()).pairingCode!;
    const pairing = b.sync.pairWithCode("127.0.0.1", listeningPort(a.sync), code);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(a.pairRequests.length).toBe(1);
    a.sync.respondPairing(a.pairRequests[0]!.requestId, false);
    const result = await pairing;
    expect(result.ok).toBe(false);
    expect(a.sync.status().peers).toEqual([]);
    expect(b.sync.status().peers).toEqual([]);
  });

  it("enabling, disabling and re-enabling keeps the listener alive", async () => {
    const { sync } = await rig();
    await sync.setEnabled(true);
    expect(sync.status().listening).toBe(true);
    await sync.setEnabled(false);
    expect(sync.status().listening).toBe(false);
    const again = await sync.setEnabled(true);
    expect(again.listening).toBe(true);
  });

  it("never touches the database after a queued restart drains during quit", async () => {
    const stopEntered = deferred();
    const releaseStop = deferred();
    const { sync, db } = await rig("Test Mac", () => ({
      start: () => {},
      stop: async () => {
        stopEntered.resolve();
        await releaseStop.promise;
      },
    }));
    await sync.setEnabled(true);
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const address = probe.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    probe.close();
    await once(probe, "close");

    const changingPort = sync.setListenPort(port);
    await stopEntered.promise;
    sync.dispose();
    const stopping = sync.stop();
    releaseStop.resolve();
    const [portResult, stopResult] = await Promise.allSettled([changingPort, stopping]);
    expect(portResult).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: "Sync coordinator is disposed" }),
    });
    expect(stopResult).toEqual({ status: "fulfilled", value: undefined });
    db.close();

    expect(() => sync.poke()).not.toThrow();
    expect(() => sync.status()).toThrow("Sync coordinator is disposed");
    await expect(sync.setEnabled(true)).rejects.toThrow("Sync coordinator is disposed");
  });
});

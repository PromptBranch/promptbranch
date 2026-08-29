import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openMemoryDatabase, PromptLibrary } from "@promptbranch/core";
import type { SyncPairRequestEvent, SyncStatusDto } from "../../shared/ipc.js";
import { loadOrCreateIdentity, type DeviceIdentity } from "./identity.js";
import { DesktopSync } from "./service.js";

const dirs: string[] = [];
const syncs: DesktopSync[] = [];

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
}

async function rig(name = "Test Mac"): Promise<Rig> {
  const db = openMemoryDatabase();
  const lib = new PromptLibrary(db);
  const statuses: SyncStatusDto[] = [];
  const pairRequests: SyncPairRequestEvent[] = [];
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
    discoveryFactory: () => ({
      start: () => {},
      stop: async () => {},
    }),
    log: () => {},
  });
  syncs.push(sync);
  return { lib, db, identity, sync, statuses, pairRequests };
}

/** The renderer never needs its own port; tests reach it for loopback dialing. */
function listeningPort(sync: DesktopSync): number {
  const status = sync.status();
  if (!status.listening) throw new Error("sync not listening");
  const internal = (sync as unknown as { service: { status: () => { port: number | null } } }).service;
  const port = internal.status().port;
  if (port === null) throw new Error("no port");
  return port;
}

afterEach(async () => {
  for (const sync of syncs.splice(0)) await sync.stop();
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

  it("persists the device name and reports it", async () => {
    const { lib, sync } = await rig();
    await sync.setEnabled(true);
    const status = await sync.setDeviceName("Studio");
    expect(status.deviceName).toBe("Studio");
    expect(lib.getSetting("sync.deviceName")).toBe("Studio");
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
    a.sync.respondPairing(a.pairRequests[0]!.fingerprint, true);
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

  it("forgetting a device unpins it and drops its live connection", async () => {
    const a = await rig("Mac Studio");
    const b = await rig("MacBook Pro");
    await a.sync.setEnabled(true);
    await b.sync.setEnabled(true);

    const code = (await a.sync.beginPairing()).pairingCode!;
    const pairing = b.sync.pairWithCode("127.0.0.1", listeningPort(a.sync), code);
    await vi.waitFor(() => expect(a.pairRequests.length).toBe(1));
    a.sync.respondPairing(a.pairRequests[0]!.fingerprint, true);
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
    a.sync.respondPairing(a.pairRequests[0]!.fingerprint, false);
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

  it("never reads the database after quit closes it (trailing status emit)", async () => {
    // Reproduces the quit crash: stopping the peer service fires status
    // changes, before-quit disposes + closes the database immediately after,
    // and the throttled emit timer must not fire against the closed handle.
    const { sync, db } = await rig();
    await sync.setEnabled(true);
    sync.dispose();
    await sync.stop();
    db.close();
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
});

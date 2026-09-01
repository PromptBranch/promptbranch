import { randomUUID } from "node:crypto";
import { SyncEngine, type Database, type PromptLibrary } from "@promptbranch/core";
import type {
  SyncPairRequestClosedEvent,
  SyncPairRequestEvent,
  SyncStatusDto,
} from "../../shared/ipc.js";
import type { Discovery } from "./discovery.js";
import { createBonjourDiscovery } from "./discovery.js";
import { fingerprintShort, loadOrCreateIdentity, type DeviceIdentity } from "./identity.js";
import { PeerService, type SyncServiceStatus } from "./peers-service.js";

/**
 * Electron-side coordinator for multi-device sync. Owns the SyncEngine (core)
 * and the PeerService lifecycle, persists the enabled flag and device name in
 * the (deliberately unsynced) settings table, bridges pairing confirmations
 * to the renderer, and pushes throttled status events. All Electron surface
 * (window, paths) arrives via deps so tests stay plain Node.
 */

const ENABLED_SETTING = "sync.enabled";
const DEVICE_NAME_SETTING = "sync.deviceName";
const LISTEN_PORT_SETTING = "sync.listenPort";
const BOOTSTRAP_MARKER = "bootstrapped";
const CONFIRM_TIMEOUT_MS = 60_000;
const STATUS_THROTTLE_MS = 250;

export interface DesktopSyncDeps {
  lib: PromptLibrary;
  db: Database;
  /** Directory for the device certificate/key (userData/sync in the app). */
  identityDir: string;
  /** Host name or similar, used until the user renames the device. */
  deviceNameFallback(): string;
  sendStatus(status: SyncStatusDto): void;
  sendPairRequest(event: SyncPairRequestEvent): void;
  sendPairRequestClosed(event: SyncPairRequestClosedEvent): void;
  discoveryFactory?: () => Discovery;
  log?: (message: string) => void;
  now?: () => number;
}

interface PendingConfirm {
  resolve(accept: boolean): void;
  timeout: NodeJS.Timeout;
  signal: AbortSignal;
  onAbort(): void;
}

export class DesktopSync {
  readonly engine: SyncEngine;
  private identity: DeviceIdentity | null = null;
  private service: PeerService | null = null;
  private readonly pendingConfirms = new Map<string, PendingConfirm>();
  /** Lifecycle mutations run in call order; commands may still read/use the current service. */
  private lifecycleTail: Promise<void> = Promise.resolve();
  private emitScheduled = false;
  private emitTimer: NodeJS.Timeout | null = null;
  private lastEmitAt = 0;
  /** Set by dispose(): before-quit closes the database after queued stop work. */
  private disposed = false;

  constructor(private readonly deps: DesktopSyncDeps) {
    this.engine = new SyncEngine(deps.db);
  }

  // ---------------------------------------------------------------- lifecycle

  /** Called once at app start; starts the network service only if enabled. */
  ensureStarted(): Promise<void> {
    return this.mutateLifecycle(async () => {
      if (this.disposed) return;
      if (this.isEnabled()) await this.startService();
      else this.emitStatus();
    });
  }

  stop(): Promise<void> {
    return this.mutateLifecycle(() => this.stopService());
  }

  /**
   * Quit-only: the database closes right after this, so every status read
   * and trailing throttled emit must be suppressed. Disable→re-enable goes
   * through stop()/startService() instead and stays fully live.
   */
  dispose(): void {
    this.disposed = true;
    this.rejectPendingConfirms();
    if (this.emitTimer !== null) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
      this.emitScheduled = false;
    }
  }

  private isEnabled(): boolean {
    return this.deps.lib.getSetting(ENABLED_SETTING) === "1";
  }

  private deviceName(): string {
    // Clamped to the wire/schema bound: hostnames can legally reach 253
    // chars, and an overlong name would fail hello validation and every
    // renderer-side status parse.
    const raw = this.deps.lib.getSetting(DEVICE_NAME_SETTING) ?? this.deps.deviceNameFallback();
    return raw.trim().slice(0, 100);
  }

  private configuredListenPort(): number | null {
    const value = Number(this.deps.lib.getSetting(LISTEN_PORT_SETTING));
    return Number.isInteger(value) && value >= 1_024 && value <= 65_535 ? value : null;
  }

  private async startService(): Promise<void> {
    if (this.service || this.disposed) return;
    const identity = this.identity ?? await loadOrCreateIdentity(this.deps.identityDir);
    if (this.service || this.disposed || !this.isEnabled()) return;
    this.identity = identity;
    const service = new PeerService({
      engine: this.engine,
      identity,
      deviceName: () => this.deviceName(),
      confirmPairing: (fingerprint, name, signal) =>
        this.confirmPairing(fingerprint, name, signal),
      onStatusChange: () => this.scheduleEmit(),
      discovery: this.deps.discoveryFactory?.() ?? createBonjourDiscovery(),
      listen: { port: this.configuredListenPort() ?? 0 },
      log: (message) => this.deps.log?.(message),
      now: this.deps.now,
    });
    this.service = service;
    try {
      await service.start();
    } catch (err) {
      if (this.service === service) this.service = null;
      try {
        await service.stop();
      } catch (stopErr) {
        this.deps.log?.(`failed to clean up sync service after startup error: ${String(stopErr)}`);
      }
      throw err;
    }
    if (this.service !== service) {
      await service.stop();
      return;
    }
    if (this.disposed || !this.isEnabled()) {
      this.service = null;
      await service.stop();
      return;
    }
    const started = service.status();
    if (started.listening && started.port !== null && this.configuredListenPort() === null) {
      this.deps.lib.setSetting(LISTEN_PORT_SETTING, String(started.port));
    }
    this.emitStatus();
  }

  private async stopService(): Promise<void> {
    this.rejectPendingConfirms();
    const service = this.service;
    if (!service) return;
    // Detach first so commands cannot enter a service that is already stopping.
    this.service = null;
    await service.stop();
  }

  private mutateLifecycle<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleTail.then(mutation);
    this.lifecycleTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // ------------------------------------------------------------------ commands

  setEnabled(enabled: boolean): Promise<SyncStatusDto> {
    return this.mutateLifecycle(async () => {
      this.assertActive();
      this.deps.lib.setSetting(ENABLED_SETTING, enabled ? "1" : "0");
      if (enabled) {
        // First enable: ship the pre-sync library by marking every row dirty.
        if (this.engine.getMeta(BOOTSTRAP_MARKER) === null) {
          this.engine.bootstrapDirty();
          this.engine.refineDirty();
          this.engine.setMeta(BOOTSTRAP_MARKER, new Date().toISOString());
          this.deps.log?.("bootstrapped existing library into op log");
        }
        await this.startService();
      } else {
        await this.stopService();
      }
      this.emitStatus();
      return this.status();
    });
  }

  async setDeviceName(name: string): Promise<SyncStatusDto> {
    this.assertActive();
    this.deps.lib.setSetting(DEVICE_NAME_SETTING, name);
    // The name rides in every hello; re-run anti-entropy so peers see it.
    this.poke();
    return this.status();
  }

  setListenPort(port: number): Promise<SyncStatusDto> {
    if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
      return Promise.reject(new RangeError("Listening port must be between 1024 and 65535"));
    }
    return this.mutateLifecycle(async () => {
      this.assertActive();
      this.deps.lib.setSetting(LISTEN_PORT_SETTING, String(port));
      if (this.isEnabled()) {
        await this.stopService();
        await this.startService();
      }
      this.emitStatus();
      return this.status();
    });
  }

  async beginPairing(): Promise<SyncStatusDto> {
    this.assertActive();
    this.requireService().beginPairing();
    this.emitStatus();
    return this.status();
  }

  async cancelPairing(): Promise<SyncStatusDto> {
    this.assertActive();
    this.service?.cancelPairing();
    this.emitStatus();
    return this.status();
  }

  async pairWithCode(address: string, port: number, code: string) {
    this.assertActive();
    const service = this.service;
    if (!service) return { ok: false, error: "Sync is not enabled" };
    const result = await service.pairWithCode(address, port, code);
    this.emitStatus();
    return result;
  }

  respondPairing(requestId: string, accept: boolean): void {
    this.finishPendingConfirm(requestId, accept);
  }

  forgetDevice(fingerprint: string): Promise<SyncStatusDto> {
    if (this.disposed) return Promise.reject(this.disposedError());
    // End the live connection before unpinning, or the peer would keep
    // syncing until its socket happens to die.
    this.service?.forgetPeer(fingerprint);
    this.engine.forgetSyncPeer(fingerprint);
    this.emitStatus();
    return Promise.resolve(this.status());
  }

  /**
   * Refines local dirty rows (this app's or CLI/MCP's) and, when sync is
   * enabled, nudges connected peers. Refining runs even while disabled so
   * the trigger-captured dirty table stays drained — the ops accumulate in
   * the local log where they will ship from whenever sync comes on.
   */
  poke(): void {
    if (this.disposed) return;
    this.engine.refineDirty();
    this.service?.notifyPeers();
  }

  now(): Promise<SyncStatusDto> {
    if (this.disposed) return Promise.reject(this.disposedError());
    this.poke();
    this.emitStatus();
    return Promise.resolve(this.status());
  }

  status(): SyncStatusDto {
    this.assertActive();
    const raw = this.service?.status() ?? null;
    return this.toDto(raw);
  }

  // ------------------------------------------------------------------ internals

  private requireService(): PeerService {
    if (!this.service) throw new Error("Sync is not enabled");
    return this.service;
  }

  private assertActive(): void {
    if (this.disposed) throw this.disposedError();
  }

  private disposedError(): Error {
    return new Error("Sync coordinator is disposed");
  }

  private toDto(raw: SyncServiceStatus | null): SyncStatusDto {
    return {
      enabled: this.isEnabled(),
      listening: raw?.listening ?? false,
      listenPort: raw?.port ?? this.configuredListenPort(),
      listenError: raw?.listenError ?? null,
      deviceName: this.deviceName(),
      fingerprintShort: this.identity?.fingerprintShort ?? "",
      pairingActive: raw?.pairingActive ?? false,
      pairingCode: raw?.pairingCode ?? null,
      peers: (raw?.peers ?? []).map((peer) => ({
        fingerprint: peer.fingerprint,
        name: peer.name,
        fingerprintShort: fingerprintShort(peer.fingerprint),
        lastSeen: peer.lastSeen,
        state: peer.state,
        unhealthy: peer.unhealthy,
      })),
      nearby: raw?.nearby ?? [],
      pendingDirty: raw?.pendingDirty ?? this.engine.pendingDirty(),
      lastSyncedAt: raw?.lastSyncedAt ?? null,
    };
  }

  private confirmPairing(
    fingerprint: string,
    name: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    // No window (headless start) → decline rather than hang the initiator.
    const requestId = randomUUID();
    return new Promise<boolean>((resolve) => {
      let pending!: PendingConfirm;
      const onAbort = () => {
        if (this.pendingConfirms.get(requestId) !== pending) return;
        this.finishPendingConfirm(requestId, false);
      };
      const timeout = setTimeout(() => {
        if (this.pendingConfirms.get(requestId) !== pending) return;
        this.finishPendingConfirm(requestId, false);
      }, CONFIRM_TIMEOUT_MS);
      timeout.unref?.();
      pending = { resolve, timeout, signal, onAbort };
      this.pendingConfirms.set(requestId, pending);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      this.deps.sendPairRequest({
        requestId,
        fingerprint,
        fingerprintShort: fingerprintShort(fingerprint),
        name,
      });
    });
  }

  private rejectPendingConfirms(): void {
    for (const requestId of [...this.pendingConfirms.keys()]) {
      this.finishPendingConfirm(requestId, false);
    }
  }

  private finishPendingConfirm(requestId: string, accept: boolean): void {
    const pending = this.pendingConfirms.get(requestId);
    if (!pending) return;
    this.pendingConfirms.delete(requestId);
    clearTimeout(pending.timeout);
    pending.signal.removeEventListener("abort", pending.onAbort);
    pending.resolve(accept);
    this.deps.sendPairRequestClosed({ requestId });
  }

  /** Coalesces status pushes: at most one per 250ms, always the latest. */
  private scheduleEmit(): void {
    if (this.disposed || this.emitScheduled) return;
    const sinceLast = Date.now() - this.lastEmitAt;
    const delay = Math.max(0, STATUS_THROTTLE_MS - sinceLast);
    this.emitScheduled = true;
    this.emitTimer = setTimeout(() => {
      this.emitScheduled = false;
      this.emitTimer = null;
      this.lastEmitAt = Date.now();
      this.emitStatus();
    }, delay);
    this.emitTimer.unref?.();
  }

  private emitStatus(): void {
    // Reads the database; never touch it after before-quit closed it.
    if (this.disposed) return;
    this.deps.sendStatus(this.status());
  }
}

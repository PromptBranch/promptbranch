import { SyncEngine, type Database, type PromptLibrary } from "@promptbranch/core";
import type { SyncPairRequestEvent, SyncStatusDto } from "../../shared/ipc.js";
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
  discoveryFactory?: () => Discovery;
  log?: (message: string) => void;
  now?: () => number;
}

export class DesktopSync {
  readonly engine: SyncEngine;
  private identity: DeviceIdentity | null = null;
  private service: PeerService | null = null;
  private readonly pendingConfirms = new Map<string, (accept: boolean) => void>();
  private emitScheduled = false;
  private emitTimer: NodeJS.Timeout | null = null;
  private lastEmitAt = 0;
  /** Set by stop(): before-quit closes the database shortly after. */
  private disposed = false;

  constructor(private readonly deps: DesktopSyncDeps) {
    this.engine = new SyncEngine(deps.db);
  }

  // ---------------------------------------------------------------- lifecycle

  /** Called once at app start; starts the network service only if enabled. */
  async ensureStarted(): Promise<void> {
    if (this.isEnabled()) await this.startService();
    else this.emitStatus();
  }

  async stop(): Promise<void> {
    await this.service?.stop();
    this.service = null;
  }

  /**
   * Quit-only: the database closes right after this, so every status read
   * and trailing throttled emit must be suppressed. Disable→re-enable goes
   * through stop()/startService() instead and stays fully live.
   */
  dispose(): void {
    this.disposed = true;
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

  private async startService(): Promise<void> {
    if (this.service || this.disposed) return;
    this.identity ??= await loadOrCreateIdentity(this.deps.identityDir);
    this.service = new PeerService({
      engine: this.engine,
      identity: this.identity,
      deviceName: () => this.deviceName(),
      confirmPairing: (fingerprint, name) => this.confirmPairing(fingerprint, name),
      onStatusChange: () => this.scheduleEmit(),
      discovery: this.deps.discoveryFactory?.() ?? createBonjourDiscovery(),
      log: (message) => this.deps.log?.(message),
      now: this.deps.now,
    });
    await this.service.start();
    this.emitStatus();
  }

  // ------------------------------------------------------------------ commands

  async setEnabled(enabled: boolean): Promise<SyncStatusDto> {
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
      await this.stop();
    }
    this.emitStatus();
    return this.status();
  }

  async setDeviceName(name: string): Promise<SyncStatusDto> {
    this.deps.lib.setSetting(DEVICE_NAME_SETTING, name);
    // The name rides in every hello; re-run anti-entropy so peers see it.
    this.poke();
    return this.status();
  }

  async beginPairing(): Promise<SyncStatusDto> {
    this.requireService().beginPairing();
    this.emitStatus();
    return this.status();
  }

  async cancelPairing(): Promise<SyncStatusDto> {
    this.service?.cancelPairing();
    this.emitStatus();
    return this.status();
  }

  async pairWithCode(address: string, port: number, code: string) {
    const service = this.service;
    if (!service) return { ok: false, error: "Sync is not enabled" };
    const result = await service.pairWithCode(address, port, code);
    this.emitStatus();
    return result;
  }

  respondPairing(fingerprint: string, accept: boolean): void {
    this.pendingConfirms.get(fingerprint)?.(accept);
    this.pendingConfirms.delete(fingerprint);
  }

  forgetDevice(fingerprint: string): Promise<SyncStatusDto> {
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
    this.engine.refineDirty();
    this.service?.notifyPeers();
  }

  now(): Promise<SyncStatusDto> {
    this.poke();
    this.emitStatus();
    return Promise.resolve(this.status());
  }

  status(): SyncStatusDto {
    const raw = this.service?.status() ?? null;
    return this.toDto(raw);
  }

  // ------------------------------------------------------------------ internals

  private requireService(): PeerService {
    if (!this.service) throw new Error("Sync is not enabled");
    return this.service;
  }

  private toDto(raw: SyncServiceStatus | null): SyncStatusDto {
    return {
      enabled: this.isEnabled(),
      listening: raw?.listening ?? false,
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

  private confirmPairing(fingerprint: string, name: string): Promise<boolean> {
    // No window (headless start) → decline rather than hang the initiator.
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingConfirms.delete(fingerprint);
        resolve(false);
      }, CONFIRM_TIMEOUT_MS);
      timeout.unref?.();
      this.pendingConfirms.set(fingerprint, (accept) => {
        clearTimeout(timeout);
        resolve(accept);
      });
      this.deps.sendPairRequest({
        fingerprint,
        fingerprintShort: fingerprintShort(fingerprint),
        name,
      });
    });
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

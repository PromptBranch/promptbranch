import tls from "node:tls";
import type { SyncEngine } from "@promptbranch/core";
import { derivePairingCode, type DeviceIdentity } from "./identity.js";
import { createFrameReader, encodeFrame } from "./frames.js";
import { PairingAcceptor, PairingInitiator } from "./pairing.js";
import { SyncSession } from "./session.js";
import type { DiscoveredPeer, Discovery } from "./discovery.js";

/**
 * Owns the sync network surface: a mutually-pinned TLS listener, outbound
 * connections to discovered paired peers, the pairing handshake, and one
 * anti-entropy SyncSession per connection. All side effects (mDNS, confirm
 * dialogs, clocks) are injected; the service itself is plain Node.
 */

export interface PeerServiceDeps {
  engine: SyncEngine;
  identity: DeviceIdentity;
  deviceName(): string;
  /** UI gate for inbound pairing attempts. */
  confirmPairing(fingerprint: string, name: string, signal: AbortSignal): Promise<boolean>;
  onStatusChange(): void;
  discovery?: Discovery;
  listen?: { host?: string; port?: number };
  /** How long pairWithCode waits for the acceptor's verdict. */
  pairTimeoutMs?: number;
  /** How long an outbound socket may take to complete its TLS handshake. */
  handshakeTimeoutMs?: number;
  /** Injectable outbound TLS connector for lifecycle observation. */
  connectTls?: (options: tls.ConnectionOptions) => tls.TLSSocket;
  /** Short grace for Bonjour to provide a fresher endpoint before saved-endpoint redial. */
  startupReconnectDelayMs?: number;
  /** Injectable heartbeat cadence for deterministic liveness tests. */
  pingIntervalMs?: number;
  /** Maximum inbound silence after TLS before a sync connection is retired. */
  livenessTimeoutMs?: number;
  log?: (message: string) => void;
  now?: () => number;
}

export interface PeerStatus {
  fingerprint: string;
  name: string;
  lastSeen: string | null;
  /**
   * Live-connection states come from the session; "offline" means paired but
   * currently unreachable (reconnect retries continue in the background).
   */
  state: "connecting" | "syncing" | "steady" | "error" | "offline";
  /** Consecutive failed sessions/dials reached the unhealthy threshold. */
  unhealthy: boolean;
}

export interface SyncServiceStatus {
  listening: boolean;
  port: number | null;
  listenError: string | null;
  pairingActive: boolean;
  pairingCode: string | null;
  peers: PeerStatus[];
  /** Unpaired PromptBranch devices seen on the LAN recently. */
  nearby: Array<{ fingerprint: string; name: string; address: string; port: number }>;
  pendingDirty: number;
  lastSyncedAt: string | null;
}

const PAIRING_WINDOW_MS = 10 * 60 * 1000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000];
const NEARBY_TTL_MS = 5 * 60 * 1000;
const PING_INTERVAL_MS = 30_000;
const LIVENESS_TIMEOUT_MS = 180_000;
const PEER_ROUTE_SOURCE_PREFIX = "peer-route-source:";
/** Consecutive failed sessions/dials before a peer shows as unhealthy. */
export const UNHEALTHY_FAILURES = 3;

type Phase =
  | { kind: "pairing-in"; fingerprint: string; acceptor: PairingAcceptor }
  | { kind: "pairing-out"; fingerprint: string; initiator: PairingInitiator }
  | { kind: "sync"; fingerprint: string; session: SyncSession };

type LifecycleState = "new" | "starting" | "active" | "bind-failed" | "stopped";

interface PendingSocket {
  expectedFingerprint: string | null;
  cancel(reason: string): void;
}

interface PeerEndpoint {
  address: string;
  port: number;
}

interface DialAttempt {
  endpoint: PeerEndpoint;
  state: { superseded: boolean };
  promise: Promise<{ ok: true } | { ok: false; error: string }>;
}

interface PendingPairing {
  connection: Connection;
  cancel(reason: string): void;
}

class Connection {
  private phase: Phase;
  private readonly reader = createFrameReader((message) => this.dispatch(message));
  private closing = false;
  private readonly closed: Promise<void>;
  private resolveClosed: (() => void) | null = null;
  private lastInboundAt: number;
  /** The socket or session faulted — counts toward peer unhealthiness. */
  failed = false;

  constructor(
    private readonly socket: tls.TLSSocket,
    private readonly service: PeerService,
    phase: Phase,
    readonly direction: "inbound" | "outbound",
  ) {
    this.phase = phase;
    this.lastInboundAt = service.currentTime();
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    socket.setNoDelay(true);
    socket.on("data", this.onData);
    socket.on("close", this.onClose);
    socket.on("end", this.onEnd);
    socket.on("error", this.onError);
  }

  private readonly onData = (chunk: Buffer): void => {
    if (this.closing) return;
    this.lastInboundAt = this.service.currentTime();
    try {
      this.reader(chunk);
    } catch (err) {
      this.service.deps.log?.(`frame error from peer: ${String(err)}`);
      this.failed = true;
      this.socket.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  };

  private readonly onClose = (): void => {
    this.closing = true;
    if (this.phase.kind === "pairing-in") this.phase.acceptor.cancel();
    this.detachHandlers();
    if (this.phase.kind === "sync") {
      this.phase.session.markClosed(this.failed ? "error" : "closed");
    }
    this.service.connectionClosed(this);
    this.resolveClosed?.();
    this.resolveClosed = null;
  };

  private readonly onEnd = (): void => {
    // A peer half-close ends the full-duplex sync session. Destroy our side
    // so no late frames can outlive the connection owner's bookkeeping.
    void this.close();
  };

  private readonly onError = (err: Error): void => {
    this.failed = true;
    if (this.phase.kind === "sync") this.phase.session.markClosed("error", err);
    this.service.deps.log?.(`peer socket error: ${String(err)}`);
  };

  get fingerprint(): string {
    return this.phase.fingerprint;
  }

  get phaseKind(): Phase["kind"] {
    return this.phase.kind;
  }

  get isClosing(): boolean {
    return this.closing;
  }

  get peerName(): string | null {
    return this.phase.kind === "sync" ? (this.phase.session.peerInfo?.name ?? null) : null;
  }

  get sessionState(): PeerStatus["state"] {
    if (this.phase.kind !== "sync") return "connecting";
    switch (this.phase.session.currentState) {
      case "steady":
        return "steady";
      case "error":
        return "error";
      default:
        return "syncing";
    }
  }

  /** For pairing-out: the initiator lives in the phase. */
  get pairingInitiator(): PairingInitiator | null {
    return this.phase.kind === "pairing-out" ? this.phase.initiator : null;
  }

  private dispatch(message: unknown): void {
    if (this.closing) return;
    if (this.phase.kind === "pairing-in") {
      this.phase.acceptor.handleMessage(message, this.phase.fingerprint);
    } else if (this.phase.kind === "pairing-out") {
      this.phase.initiator.handleMessage(message);
    } else {
      this.phase.session.handleMessageFrame(message);
    }
  }

  /** Hands the live socket from a completed handshake to a sync session. */
  upgradeToSync(peerName: string | null): boolean {
    if (this.closing) return false;
    const fingerprint = this.phase.fingerprint;
    this.lastInboundAt = this.service.currentTime();
    if (peerName) {
      this.service.deps.engine.upsertSyncPeer({ fingerprint, name: peerName });
    }
    const session = this.service.makeSession(this.socket, fingerprint);
    this.phase = { kind: "sync", fingerprint, session };
    session.start();
    this.service.deps.onStatusChange();
    return true;
  }

  notify(): void {
    if (!this.closing && this.phase.kind === "sync") this.phase.session.notify();
  }

  ping(): void {
    if (!this.closing && this.phase.kind === "sync") this.phase.session.sendPing();
  }

  grantLivenessGrace(now: number): void {
    if (!this.closing) this.lastInboundAt = now;
  }

  retireIfSilent(now: number, timeoutMs: number): void {
    if (
      this.closing ||
      this.phase.kind !== "sync" ||
      now - this.lastInboundAt < timeoutMs
    ) {
      return;
    }
    this.failed = true;
    void this.close();
  }

  close(): Promise<void> {
    if (this.closing) return this.closed;
    this.closing = true;
    // Detach synchronously before destroy(): a data event already queued by
    // the stream must not reach pairing or sync after ownership is dropped.
    this.socket.off("data", this.onData);
    this.socket.off("end", this.onEnd);
    if (this.phase.kind === "pairing-in") this.phase.acceptor.cancel();
    else if (this.phase.kind === "sync") this.phase.session.markClosed("closed");
    this.socket.destroy();
    return this.closed;
  }

  private detachHandlers(): void {
    this.socket.off("data", this.onData);
    this.socket.off("close", this.onClose);
    this.socket.off("end", this.onEnd);
    this.socket.off("error", this.onError);
  }
}

export class PeerService {
  readonly deps: PeerServiceDeps;
  private server: tls.Server | null = null;
  private port: number | null = null;
  private listenError: string | null = null;
  private readonly connections = new Map<string, Connection>();
  private readonly inFlightDials = new Map<string, DialAttempt>();
  private readonly pendingSockets = new Set<PendingSocket>();
  private readonly pendingPairings = new Map<string, PendingPairing>();
  /** Reserves the first user action before TLS reveals the peer fingerprint. */
  private readonly outboundPairingCodes = new Map<string, object>();
  private lifecycleState: LifecycleState = "new";
  private lifecycleGeneration = 0;
  private readonly peerInvalidations = new Map<string, number>();
  private pairingUntil = 0;
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private lastSyncedAt: string | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastLivenessSweepAt: number | null = null;
  private startupReconnectTimer: NodeJS.Timeout | null = null;
  private readonly nearby = new Map<string, { name: string; address: string; port: number; seenAt: number }>();
  /** Unverified mDNS routes; promoted only after pinned TLS succeeds. */
  private readonly discoveredEndpoints = new Map<string, PeerEndpoint>();
  private readonly endpoints = new Map<string, PeerEndpoint>();
  private readonly manualEndpointClaims = new Map<string, PeerEndpoint>();
  /** Consecutive failed sessions/dials per fingerprint; resets on success. */
  private readonly failures = new Map<string, number>();
  private readonly now: () => number;

  constructor(deps: PeerServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.lifecycleGeneration += 1;
    const generation = this.lifecycleGeneration;
    this.lifecycleState = "starting";
    this.cancelPendingSockets("Sync networking restarted");
    this.cancelPendingPairings("Sync networking restarted");
    this.outboundPairingCodes.clear();
    this.inFlightDials.clear();
    this.manualEndpointClaims.clear();
    this.discoveredEndpoints.clear();
    this.listenError = null;
    const server = tls.createServer(
      {
        key: this.deps.identity.keyPem,
        cert: this.deps.identity.certPem,
        // Peers authenticate by pinned fingerprint, not by a CA.
        requestCert: true,
        rejectUnauthorized: false,
      },
      (socket) => this.onSecureConnection(socket),
    );
    server.on("tlsClientError", (err) => this.deps.log?.(`tls client error: ${String(err)}`));
    const requestedPort = this.deps.listen?.port ?? 0;
    const port = await new Promise<number | null>((resolve) => {
      const onError = (err: NodeJS.ErrnoException) => {
        this.deps.log?.(`listen failed: ${String(err)}`);
        this.listenError = normalizeListenError(err, requestedPort);
        resolve(null);
      };
      server.once("error", onError);
      server.listen(requestedPort, this.deps.listen?.host ?? "0.0.0.0", () => {
        server.off("error", onError);
        const address = server.address();
        resolve(typeof address === "object" && address !== null ? address.port : null);
      });
    });
    if (generation !== this.lifecycleGeneration || this.lifecycleState !== "starting") {
      if (server.listening) server.close();
      return;
    }
    if (port === null) {
      this.lifecycleState = "bind-failed";
      this.deps.onStatusChange();
      return;
    }
    server.on("error", (err: NodeJS.ErrnoException) => {
      this.deps.log?.(`listener error: ${String(err)}`);
      this.listenError = normalizeListenError(err, port);
      this.deps.onStatusChange();
    });
    this.server = server;
    this.port = port;
    this.lifecycleState = "active";
    this.deps.discovery?.start(
      { port, fingerprint: this.deps.identity.fingerprint, deviceName: this.deps.deviceName() },
      (peer) => this.onDiscovered(peer),
      (fingerprint) => this.onDiscoveryDown(fingerprint),
    );
    this.startupReconnectTimer = setTimeout(() => {
      this.startupReconnectTimer = null;
      for (const peer of this.deps.engine.listSyncPeers()) {
        const endpoint = this.endpointFor(peer.fingerprint);
        if (endpoint) void this.dial(peer.fingerprint, endpoint);
      }
    }, this.deps.startupReconnectDelayMs ?? 500);
    this.startupReconnectTimer.unref?.();
    this.lastLivenessSweepAt = this.now();
    this.pingTimer = setInterval(
      () => this.sweepLiveness(),
      this.deps.pingIntervalMs ?? PING_INTERVAL_MS,
    );
    this.pingTimer.unref?.();
    this.deps.onStatusChange();
  }

  async stop(): Promise<void> {
    this.lifecycleGeneration += 1;
    this.lifecycleState = "stopped";
    this.pairingUntil = 0;
    const connections = [...this.connections.values()];
    this.cancelPendingSockets("Sync networking stopped");
    this.cancelPendingPairings("Sync networking stopped");
    this.outboundPairingCodes.clear();
    this.inFlightDials.clear();
    this.manualEndpointClaims.clear();
    this.discoveredEndpoints.clear();
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    if (this.startupReconnectTimer) clearTimeout(this.startupReconnectTimer);
    this.startupReconnectTimer = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.lastLivenessSweepAt = null;
    this.connections.clear();
    await Promise.all(connections.map((connection) => connection.close()));
    const server = this.server;
    this.server = null;
    this.port = null;
    await this.deps.discovery?.stop();
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      // Ended sockets above; don't hang forever if one lingers.
      const guard = setTimeout(resolve, 2_000);
      guard.unref?.();
    });
    this.deps.onStatusChange();
  }

  /** Opens the pairing window; the returned code is shown to the user. */
  beginPairing(): string {
    this.pairingUntil = this.now() + PAIRING_WINDOW_MS;
    this.deps.onStatusChange();
    return this.deps.identity.pairingCode;
  }

  cancelPairing(): void {
    this.pairingUntil = 0;
    for (const [fingerprint, connection] of this.connections) {
      if (connection.phaseKind === "pairing-in") {
        if (this.connections.get(fingerprint) === connection) {
          this.connections.delete(fingerprint);
        }
        void connection.close();
      }
    }
    this.deps.onStatusChange();
  }

  get pairingActive(): boolean {
    return this.now() < this.pairingUntil;
  }

  /**
   * Connects to a device whose pairing code the user typed. The code must
   * derive from the certificate we actually reach — that is the
   * man-in-the-middle check. An already-paired fingerprint is treated as a
   * manual reconnect (used for VPNs and mDNS-hostile networks).
   */
  async pairWithCode(
    address: string,
    port: number,
    code: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const normalized = code.replace(/[^A-Za-z2-7]/g, "").toUpperCase();
    if (normalized.length !== 8) {
      return { ok: false, error: "Pairing codes have 8 characters (letters and digits)" };
    }
    const formattedCode = `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
    const generation = this.lifecycleGeneration;
    const knownMatches = this.deps.engine
      .listSyncPeers()
      .filter((peer) => derivePairingCode(peer.fingerprint) === formattedCode);
    const known = knownMatches.length === 1 ? knownMatches[0] : undefined;
    if (known) {
      const endpoint = this.rememberEndpoint(known.fingerprint, address, port);
      this.manualEndpointClaims.set(known.fingerprint, endpoint);
      try {
        return await this.connectKnownPeer(known.fingerprint, endpoint, true, true, generation);
      } finally {
        if (this.manualEndpointClaims.get(known.fingerprint) === endpoint) {
          this.manualEndpointClaims.delete(known.fingerprint);
        }
      }
    }

    const reservation = {};
    if (this.outboundPairingCodes.has(formattedCode)) {
      return { ok: false, error: "Pairing with this device is already in progress" };
    }
    this.outboundPairingCodes.set(formattedCode, reservation);
    const releaseReservation = () => {
      if (this.outboundPairingCodes.get(formattedCode) === reservation) {
        this.outboundPairingCodes.delete(formattedCode);
      }
    };

    if (!this.canAdopt(generation, true)) {
      releaseReservation();
      return { ok: false, error: "Sync networking is stopped" };
    }
    const connect = await this.connectSocket(address, port, null).catch((err: unknown) => {
      releaseReservation();
      throw err;
    });
    if (!connect.ok) {
      releaseReservation();
      return connect;
    }
    const { socket, fingerprint } = connect;
    if (!this.canAdopt(generation, true)) {
      socket.destroy();
      releaseReservation();
      return { ok: false, error: "Sync networking changed during connection" };
    }
    if (derivePairingCode(fingerprint) !== formattedCode) {
      socket.destroy();
      releaseReservation();
      return { ok: false, error: "That code does not match this device" };
    }

    const pinned = this.deps.engine.getSyncPeer(fingerprint);
    if (pinned && !pinned.forgotten_at) {
      this.rememberEndpoint(fingerprint, address, port);
      const session = this.makeSession(socket, fingerprint);
      const connection = new Connection(
        socket,
        this,
        { kind: "sync", fingerprint, session },
        "outbound",
      );
      if (this.adoptConnection(connection, fingerprint, `${address}:${port}`)) session.start();
      releaseReservation();
      return { ok: true };
    }

    if (this.connections.has(fingerprint)) {
      socket.destroy();
      releaseReservation();
      return { ok: false, error: "Pairing with this device is already in progress" };
    }

    return new Promise((resolve) => {
      let settled = false;
      let connection: Connection;
      let pending: PendingPairing;
      const finish = (result: { ok: true } | { ok: false; error: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.pendingPairings.get(fingerprint) === pending) {
          this.pendingPairings.delete(fingerprint);
        }
        releaseReservation();
        resolve(result);
      };
      const timer = setTimeout(() => {
        if (this.connections.get(fingerprint) === connection) {
          this.connections.delete(fingerprint);
        }
        void connection.close();
        finish({ ok: false, error: "Timed out waiting for the other device to accept" });
      }, this.deps.pairTimeoutMs ?? 60_000);
      timer.unref?.();

      const initiator = new PairingInitiator(socket, {
        deviceName: this.deps.deviceName(),
        onConfirmed: () => {
          if (
            !this.canAdopt(generation, true) ||
            connection.isClosing ||
            this.connections.get(fingerprint) !== connection ||
            this.pendingPairings.get(fingerprint) !== pending
          ) {
            void connection.close();
            finish({ ok: false, error: "Sync networking changed during pairing" });
            return;
          }
          // Pin eagerly so a dropped connection can still reconnect; the
          // peer's hello refreshs the name.
          this.deps.engine.upsertSyncPeer({ fingerprint, name: "Paired device" });
          if (!connection.upgradeToSync(null)) {
            finish({ ok: false, error: "Connection closed during pairing" });
            return;
          }
          this.rememberEndpoint(fingerprint, address, port);
          finish({ ok: true });
        },
        onRejected: () => {
          if (this.connections.get(fingerprint) === connection) {
            this.connections.delete(fingerprint);
          }
          void connection.close();
          finish({ ok: false, error: "The other device declined" });
        },
        log: (message) => this.deps.log?.(`[pairing] ${message}`),
      });
      connection = new Connection(
        socket,
        this,
        { kind: "pairing-out", fingerprint, initiator },
        "outbound",
      );
      this.connections.set(fingerprint, connection);
      pending = {
        connection,
        cancel: (reason) => {
          if (this.connections.get(fingerprint) === connection) {
            this.connections.delete(fingerprint);
          }
          void connection.close();
          finish({ ok: false, error: reason });
        },
      };
      this.pendingPairings.set(fingerprint, pending);
      initiator.start();
    });
  }

  /** Refines local dirty rows and tells every connected peer to pull. */
  /** Tells every connected peer to pull (caller owns refining). */
  notifyPeers(): void {
    for (const connection of this.connections.values()) connection.notify();
    this.deps.onStatusChange();
  }

  /**
   * Unpins a peer and ends its live connection immediately — forgetting must
   * take effect while the socket is still open, not just on the next drop.
   */
  forgetPeer(fingerprint: string): void {
    this.peerInvalidations.set(fingerprint, this.peerInvalidation(fingerprint) + 1);
    for (const pending of [...this.pendingSockets]) {
      if (pending.expectedFingerprint === fingerprint) pending.cancel("Device forgotten");
    }
    this.pendingPairings.get(fingerprint)?.cancel("Device forgotten");
    const connection = this.connections.get(fingerprint);
    if (connection) {
      this.connections.delete(fingerprint);
      void connection.close();
    }
    const timer = this.reconnectTimers.get(fingerprint);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(fingerprint);
    }
    this.reconnectAttempts.delete(fingerprint);
    this.discoveredEndpoints.delete(fingerprint);
    this.endpoints.delete(fingerprint);
    this.manualEndpointClaims.delete(fingerprint);
    this.failures.delete(fingerprint);
    this.setRouteSource(fingerprint, "none");
  }

  status(): SyncServiceStatus {
    const peers: PeerStatus[] = this.deps.engine.listSyncPeers().map((row) => {
      const connection = this.connections.get(row.fingerprint);
      return {
        fingerprint: row.fingerprint,
        name: connection?.peerName ?? row.name,
        lastSeen: row.last_seen,
        state: connection ? connection.sessionState : "offline",
        unhealthy: (this.failures.get(row.fingerprint) ?? 0) >= UNHEALTHY_FAILURES,
      };
    });
    const cutoff = this.now() - NEARBY_TTL_MS;
    const nearby = [...this.nearby.entries()]
      .filter(([fingerprint, entry]) => {
        if (entry.seenAt < cutoff) {
          this.nearby.delete(fingerprint);
          return false;
        }
        const peer = this.deps.engine.getSyncPeer(fingerprint);
        return !peer || peer.forgotten_at !== null;
      })
      .map(([fingerprint, entry]) => ({
        fingerprint,
        name: entry.name,
        address: entry.address,
        port: entry.port,
      }));
    return {
      listening: this.server !== null,
      port: this.port,
      listenError: this.listenError,
      pairingActive: this.pairingActive,
      pairingCode: this.pairingActive ? this.deps.identity.pairingCode : null,
      peers,
      nearby,
      pendingDirty: this.deps.engine.pendingDirty(),
      lastSyncedAt: this.lastSyncedAt,
    };
  }

  // ------------------------------------------------------------------ internals

  /** Shared session factory (also used by Connection during handoff). */
  makeSession(socket: tls.TLSSocket, fingerprint: string): SyncSession {
    return new SyncSession(socket, {
      engine: this.deps.engine,
      deviceName: this.deps.deviceName(),
      onState: (state) => {
        if (state === "steady") {
          this.lastSyncedAt = new Date().toISOString();
          this.failures.delete(fingerprint);
          this.deps.engine.touchSyncPeer(fingerprint);
        }
        this.deps.onStatusChange();
      },
      // Hello carries the peer's chosen name — keep our pinning record fresh.
      onPeerInfo: (info) => {
        const peer = this.deps.engine.getSyncPeer(fingerprint);
        if (peer && !peer.forgotten_at && peer.name !== info.name) {
          this.deps.engine.upsertSyncPeer({ fingerprint, name: info.name });
        }
      },
      onApplied: () => {
        this.lastSyncedAt = new Date().toISOString();
      },
      log: (message) => this.deps.log?.(`[session ${fingerprint.slice(0, 6)}] ${message}`),
    });
  }

  currentTime(): number {
    return this.now();
  }

  private sweepLiveness(): void {
    if (this.lifecycleState !== "active") return;
    const now = this.now();
    const timeoutMs = this.deps.livenessTimeoutMs ?? LIVENESS_TIMEOUT_MS;
    const previous = this.lastLivenessSweepAt;
    this.lastLivenessSweepAt = now;
    const schedulerGap = previous === null ? 0 : now - previous;
    const grantGrace = schedulerGap < 0 || schedulerGap >= timeoutMs;
    for (const connection of this.connections.values()) {
      if (grantGrace) connection.grantLivenessGrace(now);
      else connection.retireIfSilent(now, timeoutMs);
      connection.ping();
    }
  }

  private adoptConnection(connection: Connection, fingerprint: string, address?: string): boolean {
    const peer = this.deps.engine.getSyncPeer(fingerprint);
    if (connection.isClosing || !peer || peer.forgotten_at) {
      void connection.close();
      return false;
    }
    const existing = this.connections.get(fingerprint);
    if (existing && existing !== connection) {
      const preferred = this.deps.identity.fingerprint < fingerprint ? "outbound" : "inbound";
      const replace =
        existing.phaseKind === "sync" &&
        connection.phaseKind === "sync" &&
        existing.direction !== preferred &&
        connection.direction === preferred;
      if (!replace) {
        void connection.close();
        return false;
      }
      this.connections.set(fingerprint, connection);
      void existing.close();
    } else {
      this.connections.set(fingerprint, connection);
    }
    this.reconnectAttempts.delete(fingerprint);
    const timer = this.reconnectTimers.get(fingerprint);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(fingerprint);
    }
    if (address) this.deps.engine.touchSyncPeer(fingerprint, address);
    return true;
  }

  private onSecureConnection(socket: tls.TLSSocket): void {
    if (this.lifecycleState !== "active") {
      socket.destroy();
      return;
    }
    const generation = this.lifecycleGeneration;
    const fingerprint = peerFingerprint(socket);
    if (!fingerprint) {
      socket.destroy();
      return;
    }
    const peer = this.deps.engine.getSyncPeer(fingerprint);
    if (peer && !peer.forgotten_at) {
      const session = this.makeSession(socket, fingerprint);
      const connection = new Connection(
        socket,
        this,
        { kind: "sync", fingerprint, session },
        "inbound",
      );
      if (this.adoptConnection(connection, fingerprint)) session.start();
      this.deps.onStatusChange();
      return;
    }
    if (this.pairingActive) {
      if (this.connections.has(fingerprint)) {
        socket.destroy();
        return;
      }
      let connection: Connection;
      const acceptor = new PairingAcceptor({
        confirmPairing: (fp, name, signal) => this.deps.confirmPairing(fp, name, signal),
        onPaired: (name) => {
          if (
            !this.canAdopt(generation, false) ||
            connection.isClosing ||
            this.connections.get(fingerprint) !== connection
          ) {
            void connection.close();
            return;
          }
          socket.write(encodeFrame({ t: "pair-confirmed", name: this.deps.deviceName() }));
          connection.upgradeToSync(name);
        },
        onRejected: () => {
          if (this.connections.get(fingerprint) !== connection) {
            void connection.close();
            return;
          }
          socket.end(encodeFrame({ t: "pair-rejected" }), () => void connection.close());
        },
        log: (message) => this.deps.log?.(`[pairing] ${message}`),
      });
      connection = new Connection(
        socket,
        this,
        { kind: "pairing-in", fingerprint, acceptor },
        "inbound",
      );
      this.connections.set(fingerprint, connection);
      return;
    }
    // Unknown peer with no pairing window open.
    socket.destroy();
  }

  private connectSocket(
    address: string,
    port: number,
    expectedFingerprint: string | null,
  ): Promise<{ ok: true; socket: tls.TLSSocket; fingerprint: string } | { ok: false; error: string }> {
    return new Promise((resolve) => {
      const options: tls.ConnectionOptions = {
        host: address,
        port,
        key: this.deps.identity.keyPem,
        cert: this.deps.identity.certPem,
        rejectUnauthorized: false,
      };
      const socket = this.deps.connectTls ? this.deps.connectTls(options) : tls.connect(options);
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let pending: PendingSocket;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        socket.off("error", onError);
        socket.off("close", onClose);
        socket.off("secureConnect", onSecureConnect);
        this.pendingSockets.delete(pending);
      };
      const finish = (
        result:
          | { ok: true; socket: tls.TLSSocket; fingerprint: string }
          | { ok: false; error: string },
      ) => {
        if (settled) return;
        settled = true;
        if (result.ok) {
          if (timer) clearTimeout(timer);
          socket.setTimeout(0);
          socket.off("secureConnect", onSecureConnect);
          resolve(result);
          // Resolving queues the awaiting caller before this cleanup. Both
          // connectSocket callers install Connection's durable error/close
          // handlers synchronously, so the socket is never left unguarded.
          queueMicrotask(cleanup);
        } else {
          cleanup();
          socket.destroy();
          resolve(result);
        }
      };
      const fail = (error: string) => {
        finish({ ok: false, error });
      };
      const onError = (err: Error) => {
        fail(`Could not connect: ${String(err.message ?? err)}`);
      };
      const onClose = () => {
        fail("Connection closed during TLS handshake");
      };
      const onSecureConnect = () => {
        const fingerprint = peerFingerprint(socket);
        if (!fingerprint) return fail("The other device did not identify itself");
        if (expectedFingerprint !== null && fingerprint !== expectedFingerprint) {
          return fail("The device at that address does not match its pinned identity");
        }
        finish({ ok: true, socket, fingerprint });
      };
      pending = {
        expectedFingerprint,
        cancel: (reason) => {
          if (settled) {
            socket.destroy();
            return;
          }
          fail(reason);
        },
      };
      this.pendingSockets.add(pending);
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.once("secureConnect", onSecureConnect);
      timer = setTimeout(
        () => fail("Connection timed out"),
        this.deps.handshakeTimeoutMs ?? 10_000,
      );
      timer.unref?.();
    });
  }

  private onDiscovered(peer: DiscoveredPeer): void {
    if (this.lifecycleState !== "active") return;
    const existing = this.deps.engine.getSyncPeer(peer.fingerprint);
    if (!existing || existing.forgotten_at) {
      // Unpaired: surface it as a nearby device for the pairing UI.
      this.nearby.set(peer.fingerprint, {
        name: peer.name,
        address: peer.address,
        port: peer.port,
        seenAt: this.now(),
      });
      this.deps.onStatusChange();
      return;
    }
    // A user-selected route owns this short handoff window. Discovery can
    // offer another candidate after the manual attempt settles.
    if (this.manualEndpointClaims.has(peer.fingerprint)) return;
    const endpoint = { address: peer.address, port: peer.port };
    this.discoveredEndpoints.set(peer.fingerprint, endpoint);
    if (this.connections.has(peer.fingerprint)) return;
    // Only one side dials: the lexicographically smaller fingerprint.
    if (this.deps.identity.fingerprint > peer.fingerprint) return;
    void this.dial(peer.fingerprint, endpoint);
  }

  private async dial(
    fingerprint: string,
    endpoint: PeerEndpoint,
    generation = this.lifecycleGeneration,
  ): Promise<void> {
    await this.connectKnownPeer(fingerprint, endpoint, false, false, generation);
  }

  private async connectKnownPeer(
    fingerprint: string,
    endpoint: PeerEndpoint,
    allowWithoutListener = false,
    supersedeInFlight = false,
    generation = this.lifecycleGeneration,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.canAdopt(generation, allowWithoutListener)) {
      return { ok: false, error: "Sync networking is stopped" };
    }
    if (this.connections.has(fingerprint)) return { ok: true };
    if (this.server === null && !allowWithoutListener) {
      return { ok: false, error: "Sync listener is not running" };
    }
    const current = this.inFlightDials.get(fingerprint);
    if (current) {
      if (!supersedeInFlight || sameEndpoint(current.endpoint, endpoint)) {
        return current.promise;
      }
      current.state.superseded = true;
      this.cancelPendingSocket(
        fingerprint,
        "Connection superseded by a newer manual endpoint",
      );
      await current.promise;
      if (this.endpoints.get(fingerprint) !== endpoint) {
        return { ok: false, error: "Connection superseded by a newer manual endpoint" };
      }
      if (this.inFlightDials.get(fingerprint) === current) {
        this.inFlightDials.delete(fingerprint);
      }
      return this.connectKnownPeer(
        fingerprint,
        endpoint,
        allowWithoutListener,
        supersedeInFlight,
        generation,
      );
    }
    const state = { superseded: false };
    const promise = this.runKnownPeerDial(
      fingerprint,
      endpoint,
      allowWithoutListener,
      state,
      generation,
    );
    const attempt = { endpoint, state, promise };
    this.inFlightDials.set(fingerprint, attempt);
    try {
      return await promise;
    } finally {
      if (this.inFlightDials.get(fingerprint) === attempt) {
        this.inFlightDials.delete(fingerprint);
      }
    }
  }

  private async runKnownPeerDial(
    fingerprint: string,
    endpoint: PeerEndpoint,
    allowWithoutListener: boolean,
    state: { superseded: boolean },
    generation: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const invalidation = this.peerInvalidation(fingerprint);
    const result = await this.connectSocket(endpoint.address, endpoint.port, fingerprint);
    if (!result.ok) {
      if (state.superseded) return result;
      if (this.discoveredEndpoints.get(fingerprint) === endpoint) {
        this.discoveredEndpoints.delete(fingerprint);
      }
      const peer = this.deps.engine.getSyncPeer(fingerprint);
      if (
        !this.canAdopt(generation, allowWithoutListener) ||
        invalidation !== this.peerInvalidation(fingerprint) ||
        !peer ||
        peer.forgotten_at
      ) {
        return result;
      }
      this.recordFailure(fingerprint);
      this.scheduleReconnect(fingerprint);
      return result;
    }
    const peer = this.deps.engine.getSyncPeer(fingerprint);
    if (
      state.superseded ||
      !this.canAdopt(generation, allowWithoutListener) ||
      invalidation !== this.peerInvalidation(fingerprint) ||
      !peer ||
      peer.forgotten_at
    ) {
      result.socket.destroy();
      return {
        ok: false,
        error: state.superseded
          ? "Connection superseded by a newer manual endpoint"
          : "Sync networking changed during connection",
      };
    }
    const session = this.makeSession(result.socket, fingerprint);
    const connection = new Connection(
      result.socket,
      this,
      { kind: "sync", fingerprint, session },
      "outbound",
    );
    let durableAddress: string | undefined;
    const consumeDiscovery =
      this.discoveredEndpoints.get(fingerprint) === endpoint &&
      !this.manualEndpointClaims.has(fingerprint);
    const promoteDiscovery =
      consumeDiscovery &&
      this.routeSource(fingerprint) !== "manual";
    if (promoteDiscovery || this.endpoints.get(fingerprint) === endpoint) {
      durableAddress = `${endpoint.address}:${endpoint.port}`;
    }
    if (this.adoptConnection(connection, fingerprint, durableAddress)) {
      if (consumeDiscovery && this.discoveredEndpoints.get(fingerprint) === endpoint) {
        this.discoveredEndpoints.delete(fingerprint);
        if (promoteDiscovery) {
          this.endpoints.set(fingerprint, endpoint);
          this.setRouteSource(fingerprint, "discovery");
        }
      }
      session.start();
    }
    this.deps.onStatusChange();
    return { ok: true };
  }

  private recordFailure(fingerprint: string): void {
    const next = Math.min(this.failures.get(fingerprint) ?? 0, 98) + 1;
    this.failures.set(fingerprint, next);
    if (next >= UNHEALTHY_FAILURES) this.deps.onStatusChange();
  }

  private scheduleReconnect(fingerprint: string): void {
    if (this.lifecycleState !== "active" || this.reconnectTimers.has(fingerprint)) return;
    if (!this.endpointFor(fingerprint)) return;
    const attempt = Math.min(this.reconnectAttempts.get(fingerprint) ?? 0, RECONNECT_DELAYS_MS.length - 1);
    this.reconnectAttempts.set(fingerprint, attempt + 1);
    const delay = RECONNECT_DELAYS_MS[attempt] ?? 60_000;
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(fingerprint);
      const endpoint = this.endpointFor(fingerprint);
      if (endpoint) void this.dial(fingerprint, endpoint);
    }, delay);
    timer.unref?.();
    this.reconnectTimers.set(fingerprint, timer);
  }

  connectionClosed(connection: Connection): void {
    const fingerprint = connection.fingerprint;
    if (this.connections.get(fingerprint) !== connection) return;
    if (connection.phaseKind === "pairing-out") {
      const pending = this.pendingPairings.get(fingerprint);
      if (pending?.connection === connection) {
        pending.cancel("Connection closed during pairing");
      }
      this.deps.onStatusChange();
      return;
    }
    this.connections.delete(fingerprint);
    if (connection.failed) this.recordFailure(fingerprint);
    const peer = this.deps.engine.getSyncPeer(fingerprint);
    if (peer && !peer.forgotten_at) this.scheduleReconnect(fingerprint);
    this.deps.onStatusChange();
  }

  private rememberEndpoint(
    fingerprint: string,
    address: string,
    port: number,
  ): PeerEndpoint {
    const endpoint = { address, port };
    this.discoveredEndpoints.delete(fingerprint);
    this.endpoints.set(fingerprint, endpoint);
    this.setRouteSource(fingerprint, "manual");
    const peer = this.deps.engine.getSyncPeer(fingerprint);
    if (peer && !peer.forgotten_at) {
      this.deps.engine.upsertSyncPeer({
        fingerprint,
        name: peer.name,
        address: `${address}:${port}`,
      });
    }
    return endpoint;
  }

  private routeSource(fingerprint: string): "manual" | "discovery" | "none" | null {
    const stored = this.deps.engine.getMeta(`${PEER_ROUTE_SOURCE_PREFIX}${fingerprint}`);
    if (stored === "manual" || stored === "discovery" || stored === "none") return stored;
    // Addresses saved before route provenance existed are conservatively
    // treated as user-owned so an mDNS advertisement cannot displace them.
    return this.deps.engine.getSyncPeer(fingerprint)?.address ? "manual" : null;
  }

  private setRouteSource(
    fingerprint: string,
    source: "manual" | "discovery" | "none",
  ): void {
    this.deps.engine.setMeta(`${PEER_ROUTE_SOURCE_PREFIX}${fingerprint}`, source);
  }

  private endpointFor(fingerprint: string): PeerEndpoint | null {
    const discovered = this.discoveredEndpoints.get(fingerprint);
    if (discovered) return discovered;
    const current = this.endpoints.get(fingerprint);
    if (current) return current;
    if (this.routeSource(fingerprint) === "none") return null;
    const saved = this.deps.engine.getSyncPeer(fingerprint)?.address;
    if (!saved) return null;
    const separator = saved.lastIndexOf(":");
    if (separator <= 0) return null;
    const address = saved.slice(0, separator);
    const port = Number(saved.slice(separator + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    const endpoint = { address, port };
    this.endpoints.set(fingerprint, endpoint);
    return endpoint;
  }

  private onDiscoveryDown(fingerprint: string): void {
    const endpoint = this.discoveredEndpoints.get(fingerprint);
    if (endpoint) {
      this.discoveredEndpoints.delete(fingerprint);
      const generation = this.lifecycleGeneration;
      const attempt = this.inFlightDials.get(fingerprint);
      if (attempt?.endpoint === endpoint) {
        attempt.state.superseded = true;
        this.cancelPendingSocket(fingerprint, "Discovered endpoint was withdrawn");
        void attempt.promise.then(() => {
          if (
            !this.canAdopt(generation, false) ||
            this.connections.has(fingerprint) ||
            this.deps.identity.fingerprint > fingerprint
          ) {
            return;
          }
          const fallback = this.endpointFor(fingerprint);
          if (fallback) void this.dial(fingerprint, fallback, generation);
        });
      } else if (
        !this.connections.has(fingerprint) &&
        this.deps.identity.fingerprint < fingerprint
      ) {
        const fallback = this.endpointFor(fingerprint);
        if (fallback) void this.dial(fingerprint, fallback, generation);
      }
    }
    if (this.nearby.delete(fingerprint)) this.deps.onStatusChange();
  }

  private peerInvalidation(fingerprint: string): number {
    return this.peerInvalidations.get(fingerprint) ?? 0;
  }

  private canAdopt(generation: number, allowWithoutListener: boolean): boolean {
    if (generation !== this.lifecycleGeneration) return false;
    if (this.lifecycleState === "active") return true;
    return allowWithoutListener &&
      (this.lifecycleState === "new" || this.lifecycleState === "bind-failed");
  }

  private cancelPendingSockets(reason: string): void {
    for (const pending of [...this.pendingSockets]) pending.cancel(reason);
  }

  private cancelPendingSocket(fingerprint: string, reason: string): void {
    for (const pending of [...this.pendingSockets]) {
      if (pending.expectedFingerprint === fingerprint) pending.cancel(reason);
    }
  }

  private cancelPendingPairings(reason: string): void {
    for (const pending of [...this.pendingPairings.values()]) pending.cancel(reason);
  }
}

function sameEndpoint(left: PeerEndpoint, right: PeerEndpoint): boolean {
  return left.address === right.address && left.port === right.port;
}

function peerFingerprint(socket: tls.TLSSocket): string | null {
  const cert = socket.getPeerCertificate() as { fingerprint256?: string };
  if (!cert.fingerprint256) return null;
  return cert.fingerprint256.replace(/:/g, "").toLowerCase();
}

function normalizeListenError(error: NodeJS.ErrnoException, port: number): string {
  if (error.code === "EADDRINUSE") {
    return `Port ${port} is already in use. Choose another port.`;
  }
  if (error.code === "EACCES") {
    return `PromptBranch cannot use port ${port}. Choose a port from 1024 to 65535 or check firewall permissions.`;
  }
  return `PromptBranch could not listen on port ${port}. Choose another port or check firewall permissions.`;
}

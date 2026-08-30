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
  confirmPairing(fingerprint: string, name: string): Promise<boolean>;
  onStatusChange(): void;
  discovery?: Discovery;
  listen?: { host?: string; port?: number };
  /** How long pairWithCode waits for the acceptor's verdict. */
  pairTimeoutMs?: number;
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
/** Consecutive failed sessions/dials before a peer shows as unhealthy. */
export const UNHEALTHY_FAILURES = 3;

type Phase =
  | { kind: "pairing-in"; fingerprint: string }
  | { kind: "pairing-out"; fingerprint: string; initiator: PairingInitiator }
  | { kind: "sync"; fingerprint: string; session: SyncSession };

class Connection {
  private phase: Phase;
  private readonly reader = createFrameReader((message) => this.dispatch(message));
  /** The socket or session faulted — counts toward peer unhealthiness. */
  failed = false;

  constructor(
    private readonly socket: tls.TLSSocket,
    private readonly service: PeerService,
    phase: Phase,
  ) {
    this.phase = phase;
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => {
      try {
        this.reader(chunk);
      } catch (err) {
        service.deps.log?.(`frame error from peer: ${String(err)}`);
        this.failed = true;
        socket.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    });
    socket.on("close", () => service.connectionClosed(this));
    socket.on("end", () => {
      // The peer half-closed; a sync peer that stops talking is gone. Close
      // our side too so the connection map frees up for re-dialing.
      socket.end();
    });
    socket.on("error", (err) => {
      this.failed = true;
      if (this.phase.kind === "sync") this.phase.session.markClosed("error");
      service.deps.log?.(`peer socket error: ${String(err)}`);
    });
  }

  get fingerprint(): string {
    return this.phase.fingerprint;
  }

  get phaseKind(): Phase["kind"] {
    return this.phase.kind;
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
    if (this.phase.kind === "pairing-in") {
      this.service.feedPairingAcceptor(this.phase.fingerprint, message);
    } else if (this.phase.kind === "pairing-out") {
      this.phase.initiator.handleMessage(message);
    } else {
      this.phase.session.handleMessageFrame(message);
    }
  }

  /** Hands the live socket from a completed handshake to a sync session. */
  upgradeToSync(peerName: string | null): void {
    const fingerprint = this.phase.fingerprint;
    if (peerName) {
      this.service.deps.engine.upsertSyncPeer({ fingerprint, name: peerName });
    }
    const session = this.service.makeSession(this.socket, fingerprint);
    this.phase = { kind: "sync", fingerprint, session };
    session.start();
    this.service.deps.onStatusChange();
  }

  notify(): void {
    if (this.phase.kind === "sync") this.phase.session.notify();
  }

  ping(): void {
    if (this.phase.kind === "sync") this.phase.session.sendPing();
  }

  end(): void {
    this.socket.end();
  }
}

export class PeerService {
  readonly deps: PeerServiceDeps;
  private server: tls.Server | null = null;
  private port: number | null = null;
  private readonly connections = new Map<string, Connection>();
  private pairingUntil = 0;
  private readonly pairingAcceptors = new Map<string, PairingAcceptor>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private lastSyncedAt: string | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly nearby = new Map<string, { name: string; address: string; port: number; seenAt: number }>();
  /** Consecutive failed sessions/dials per fingerprint; resets on success. */
  private readonly failures = new Map<string, number>();
  private readonly now: () => number;

  constructor(deps: PeerServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.server) return;
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
    const port = await new Promise<number | null>((resolve) => {
      server.once("error", (err) => {
        this.deps.log?.(`listen failed: ${String(err)}`);
        resolve(null);
      });
      server.listen(this.deps.listen?.port ?? 0, this.deps.listen?.host ?? "0.0.0.0", () => {
        const address = server.address();
        resolve(typeof address === "object" && address !== null ? address.port : null);
      });
    });
    if (port === null) return;
    this.server = server;
    this.port = port;
    this.deps.discovery?.start(
      { port, fingerprint: this.deps.identity.fingerprint, deviceName: this.deps.deviceName() },
      (peer) => this.onDiscovered(peer),
    );
    this.pingTimer = setInterval(() => {
      for (const connection of this.connections.values()) connection.ping();
    }, 30_000);
    this.pingTimer.unref?.();
    this.deps.onStatusChange();
  }

  async stop(): Promise<void> {
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const connection of this.connections.values()) connection.end();
    this.connections.clear();
    await this.deps.discovery?.stop();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      // Ended sockets above; don't hang forever if one lingers.
      const guard = setTimeout(resolve, 2_000);
      guard.unref?.();
    });
    this.server = null;
    this.port = null;
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
        this.connections.delete(fingerprint);
        connection.end();
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
    const connect = await this.connectSocket(address, port, null);
    if (!connect.ok) return connect;
    const { socket, fingerprint } = connect;
    if (derivePairingCode(fingerprint) !== `${normalized.slice(0, 4)}-${normalized.slice(4)}`) {
      socket.destroy();
      return { ok: false, error: "That code does not match this device" };
    }

    const known = this.deps.engine.getSyncPeer(fingerprint);
    if (known && !known.forgotten_at) {
      const session = this.makeSession(socket, fingerprint);
      const connection = new Connection(socket, this, { kind: "sync", fingerprint, session });
      this.adoptConnection(connection, fingerprint, `${address}:${port}`);
      session.start();
      return { ok: true };
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: { ok: true } | { ok: false; error: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        socket.destroy();
        this.connections.delete(fingerprint);
        finish({ ok: false, error: "Timed out waiting for the other device to accept" });
      }, this.deps.pairTimeoutMs ?? 60_000);
      timer.unref?.();

      const initiator = new PairingInitiator(socket, {
        deviceName: this.deps.deviceName(),
        onConfirmed: () => {
          // Pin eagerly so a dropped connection can still reconnect; the
          // peer's hello refreshs the name.
          this.deps.engine.upsertSyncPeer({ fingerprint, name: "Paired device" });
          const connection = this.connections.get(fingerprint);
          connection?.upgradeToSync(null);
          this.deps.engine.touchSyncPeer(fingerprint, `${address}:${port}`);
          finish({ ok: true });
        },
        onRejected: () => {
          socket.destroy();
          this.connections.delete(fingerprint);
          finish({ ok: false, error: "The other device declined" });
        },
        log: (message) => this.deps.log?.(`[pairing] ${message}`),
      });
      const connection = new Connection(socket, this, { kind: "pairing-out", fingerprint, initiator });
      this.connections.set(fingerprint, connection);
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
    const connection = this.connections.get(fingerprint);
    if (connection) {
      this.connections.delete(fingerprint);
      connection.end();
    }
    this.pairingAcceptors.delete(fingerprint);
    const timer = this.reconnectTimers.get(fingerprint);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(fingerprint);
    }
    this.reconnectAttempts.delete(fingerprint);
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
        if (!peer || peer.name !== info.name) {
          this.deps.engine.upsertSyncPeer({ fingerprint, name: info.name });
        }
      },
      onApplied: () => {
        this.lastSyncedAt = new Date().toISOString();
      },
      log: (message) => this.deps.log?.(`[session ${fingerprint.slice(0, 6)}] ${message}`),
    });
  }

  private adoptConnection(connection: Connection, fingerprint: string, address?: string): void {
    this.connections.set(fingerprint, connection);
    this.reconnectAttempts.delete(fingerprint);
    const timer = this.reconnectTimers.get(fingerprint);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(fingerprint);
    }
    if (address) this.deps.engine.touchSyncPeer(fingerprint, address);
  }

  private onSecureConnection(socket: tls.TLSSocket): void {
    const fingerprint = peerFingerprint(socket);
    if (!fingerprint) {
      socket.destroy();
      return;
    }
    const peer = this.deps.engine.getSyncPeer(fingerprint);
    if (peer && !peer.forgotten_at) {
      const session = this.makeSession(socket, fingerprint);
      const connection = new Connection(socket, this, { kind: "sync", fingerprint, session });
      this.adoptConnection(connection, fingerprint);
      session.start();
      this.deps.onStatusChange();
      return;
    }
    if (this.pairingActive) {
      const acceptor = new PairingAcceptor({
        confirmPairing: (fp, name) => this.deps.confirmPairing(fp, name),
        onPaired: (name) => {
          this.pairingAcceptors.delete(fingerprint);
          const connection = this.connections.get(fingerprint);
          socket.write(encodeFrame({ t: "pair-confirmed", name: this.deps.deviceName() }));
          connection?.upgradeToSync(name);
        },
        onRejected: () => {
          this.pairingAcceptors.delete(fingerprint);
          socket.write(encodeFrame({ t: "pair-rejected" }));
          socket.end();
          this.connections.delete(fingerprint);
        },
        log: (message) => this.deps.log?.(`[pairing] ${message}`),
      });
      this.pairingAcceptors.set(fingerprint, acceptor);
      const connection = new Connection(socket, this, { kind: "pairing-in", fingerprint });
      this.connections.set(fingerprint, connection);
      return;
    }
    // Unknown peer with no pairing window open.
    socket.destroy();
  }

  feedPairingAcceptor(fingerprint: string, message: unknown): void {
    const acceptor = this.pairingAcceptors.get(fingerprint);
    acceptor?.handleMessage(message, fingerprint);
  }

  private connectSocket(
    address: string,
    port: number,
    expectedFingerprint: string | null,
  ): Promise<{ ok: true; socket: tls.TLSSocket; fingerprint: string } | { ok: false; error: string }> {
    return new Promise((resolve) => {
      const socket = tls.connect({
        host: address,
        port,
        key: this.deps.identity.keyPem,
        cert: this.deps.identity.certPem,
        rejectUnauthorized: false,
        timeout: 10_000,
      });
      const fail = (error: string) => {
        socket.destroy();
        resolve({ ok: false, error });
      };
      socket.once("error", (err) => fail(`Could not connect: ${String(err.message ?? err)}`));
      socket.once("timeout", () => fail("Connection timed out"));
      socket.once("secureConnect", () => {
        const fingerprint = peerFingerprint(socket);
        if (!fingerprint) return fail("The other device did not identify itself");
        if (expectedFingerprint !== null && fingerprint !== expectedFingerprint) {
          return fail("The device at that address does not match its pinned identity");
        }
        resolve({ ok: true, socket, fingerprint });
      });
    });
  }

  private onDiscovered(peer: DiscoveredPeer): void {
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
    if (this.connections.has(peer.fingerprint)) return;
    // Only one side dials: the lexicographically smaller fingerprint.
    if (this.deps.identity.fingerprint > peer.fingerprint) return;
    void this.dial(peer.fingerprint, peer.address, peer.port);
  }

  private async dial(fingerprint: string, address: string, port: number): Promise<void> {
    if (this.connections.has(fingerprint) || this.server === null) return;
    const result = await this.connectSocket(address, port, fingerprint);
    if (!result.ok) {
      this.recordFailure(fingerprint);
      this.scheduleReconnect(fingerprint, address, port);
      return;
    }
    const session = this.makeSession(result.socket, fingerprint);
    const connection = new Connection(result.socket, this, { kind: "sync", fingerprint, session });
    this.adoptConnection(connection, fingerprint, `${address}:${port}`);
    session.start();
    this.deps.onStatusChange();
  }

  private recordFailure(fingerprint: string): void {
    const next = Math.min(this.failures.get(fingerprint) ?? 0, 98) + 1;
    this.failures.set(fingerprint, next);
    if (next >= UNHEALTHY_FAILURES) this.deps.onStatusChange();
  }

  private scheduleReconnect(fingerprint: string, address: string, port: number): void {
    if (this.server === null || this.reconnectTimers.has(fingerprint)) return;
    const attempt = Math.min(this.reconnectAttempts.get(fingerprint) ?? 0, RECONNECT_DELAYS_MS.length - 1);
    this.reconnectAttempts.set(fingerprint, attempt + 1);
    const delay = RECONNECT_DELAYS_MS[attempt] ?? 60_000;
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(fingerprint);
      void this.dial(fingerprint, address, port);
    }, delay);
    timer.unref?.();
    this.reconnectTimers.set(fingerprint, timer);
  }

  connectionClosed(connection: Connection): void {
    const fingerprint = connection.fingerprint;
    if (this.connections.get(fingerprint) !== connection) return;
    this.connections.delete(fingerprint);
    this.pairingAcceptors.delete(fingerprint);
    if (connection.failed) this.recordFailure(fingerprint);
    const peer = this.deps.engine.getSyncPeer(fingerprint);
    if (peer && !peer.forgotten_at && peer.address !== null) {
      const separator = peer.address.lastIndexOf(":");
      if (separator > 0) {
        const address = peer.address.slice(0, separator);
        const port = Number(peer.address.slice(separator + 1));
        if (Number.isFinite(port) && port > 0) this.scheduleReconnect(fingerprint, address, port);
      }
    }
    this.deps.onStatusChange();
  }
}

function peerFingerprint(socket: tls.TLSSocket): string | null {
  const cert = socket.getPeerCertificate() as { fingerprint256?: string };
  if (!cert.fingerprint256) return null;
  return cert.fingerprint256.replace(/:/g, "").toLowerCase();
}

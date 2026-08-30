import { once } from "node:events";
import type { Duplex } from "node:stream";
import type { SyncEngine, SyncedTableName, SyncOp } from "@promptbranch/core";
import { createFrameReader, encodeFrame } from "./frames.js";
import { parseMessage, PROTOCOL_VERSION } from "./messages.js";

/**
 * One anti-entropy conversation over an established (pairing-verified)
 * stream. Both sides are symmetric: a `hello` message — sent on connect and
 * re-sent whenever the local side gains ops — requests everything the sender
 * is missing; the receiver answers with `ops` batches and a `flush`. The
 * session is transport-agnostic (any Duplex), so tests drive it over
 * in-memory stream pairs.
 */

export type SessionState = "syncing" | "steady" | "closed" | "error";

export interface PeerInfo {
  deviceId: string;
  name: string;
}

export interface SyncSessionDeps {
  engine: SyncEngine;
  deviceName: string;
  onState?: (state: SessionState) => void;
  onPeerInfo?: (info: PeerInfo) => void;
  onApplied?: (applied: number) => void;
  onClosed?: () => void;
  log?: (message: string) => void;
  /** Per-batch byte budget for outgoing ops (tests shrink it). */
  byteBudget?: number;
}

const DEFAULT_BUDGET = 1_000_000;
/** ops messages carry at most 5,000 ops (messages.ts); stay under it. */
const MAX_OPS_PER_FRAME = 4_500;

export class SyncSession {
  private state: SessionState = "syncing";
  private peer: PeerInfo | null = null;
  private serveChain: Promise<void> = Promise.resolve();
  private serveDepth = 0;
  private expectingMore = false;
  private closed = false;

  constructor(
    private readonly socket: Duplex,
    private readonly deps: SyncSessionDeps,
  ) {}

  start(): void {
    this.sendHello();
  }

  /** Tells the peer we have new ops; it re-requests by sending hello. */
  notify(): void {
    if (!this.closed) this.write(encodeFrame({ t: "notify" }));
  }

  sendPing(): void {
    if (!this.closed) this.write(encodeFrame({ t: "ping" }));
  }

  close(): void {
    if (this.closed) return;
    this.socket.end();
  }

  /** Called by the connection owner (PeerService, tests) for each frame. */
  handleMessageFrame(message: unknown): void {
    try {
      this.handleMessage(message);
    } catch (err) {
      this.fail(err);
    }
  }

  /** Socket died — the owner already tore down its listeners. */
  markClosed(state: "closed" | "error", err?: unknown): void {
    this.finish(state, err);
  }

  get currentState(): SessionState {
    return this.state;
  }

  get peerInfo(): PeerInfo | null {
    return this.peer;
  }

  // ------------------------------------------------------------------ internals

  private sendHello(): void {
    const cursors = this.deps.engine.haveVector();
    // A serve plus flush is now owed to us.
    this.expectingMore = true;
    this.setState("syncing");
    this.write(
      encodeFrame({
        t: "hello",
        v: PROTOCOL_VERSION,
        deviceId: this.deps.engine.deviceId(),
        name: this.deps.deviceName,
        cursors,
      }),
    );
  }

  private handleMessage(message: unknown): void {
    const parsed = parseMessage(message);
    if (!parsed) {
      this.deps.log?.("dropping non-protocol frame");
      return;
    }
    switch (parsed.t) {
      case "hello": {
        const first = this.peer === null;
        this.peer = { deviceId: parsed.deviceId, name: parsed.name };
        if (first) this.deps.onPeerInfo?.(this.peer);
        this.setState("syncing");
        this.enqueueServe(parsed.cursors);
        return;
      }
      case "notify": {
        // Peer has new ops — re-request by sending our cursors.
        this.sendHello();
        return;
      }
      case "ops": {
        const ops = parsed.ops.map((op) => ({ ...op, table: op.table as SyncedTableName }) satisfies SyncOp);
        const summary = this.deps.engine.applyRemote(ops);
        if (summary.applied > 0) this.deps.onApplied?.(summary.applied);
        if (summary.deferred > 0) {
          // FK orphans are normal mid-bootstrap; a persistent count means a
          // referenced stream never arrives — make that visible.
          this.deps.log?.(`deferred ${summary.deferred} op(s) whose references have not arrived yet`);
        }
        this.expectingMore = parsed.more;
        if (!parsed.more) this.maybeSteady();
        return;
      }
      case "flush": {
        this.expectingMore = false;
        this.maybeSteady();
        return;
      }
      case "ping":
        this.write(encodeFrame({ t: "pong" }));
        return;
      case "pong":
        return;
      default:
        return;
    }
  }

  /** Serializes serves; each serve drains everything the peer is missing. */
  private enqueueServe(peerCursors: Record<string, number>): void {
    this.serveChain = this.serveChain
      .then(() => this.serve(peerCursors))
      .catch((err) => this.fail(err));
  }

  private async serve(peerCursors: Record<string, number>): Promise<void> {
    if (this.closed) return;
    this.serveDepth += 1;
    try {
      const cursors = { ...peerCursors };
      for (;;) {
        // Cap op count as well as bytes: tiny junction ops can otherwise
        // pack a byte-budgeted batch past the protocol's per-frame limit,
        // which the receiver would reject as non-protocol.
        const { ops, hasMore } = this.deps.engine.opsSince(cursors, this.deps.byteBudget ?? DEFAULT_BUDGET);
        const batch = ops.slice(0, MAX_OPS_PER_FRAME);
        const more = hasMore || batch.length < ops.length;
        if (batch.length > 0) {
          const frame = encodeFrame({ t: "ops", ops: batch, more });
          if (!this.socket.write(frame)) {
            // A socket that closes mid-drain would leave `drain` unsettled
            // forever; a close ends the serve too.
            await Promise.race([once(this.socket, "drain"), once(this.socket, "close")]);
            if (this.closed) return;
          }
          for (const op of batch) cursors[op.source] = Math.max(cursors[op.source] ?? 0, op.seq);
        }
        if (!more) break;
      }
      this.write(encodeFrame({ t: "flush" }));
    } finally {
      this.serveDepth -= 1;
      this.maybeSteady();
    }
  }

  private maybeSteady(): void {
    if (!this.expectingMore && this.serveDepth === 0) this.setState("steady");
  }

  private setState(state: SessionState): void {
    if (this.state === state || this.state === "closed" || this.state === "error") return;
    this.state = state;
    this.deps.onState?.(state);
  }

  private finish(state: "closed" | "error", err?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.state = state;
    this.deps.onState?.(state);
    if (state === "error") this.deps.log?.(`session failed: ${String(err)}`);
    this.deps.onClosed?.();
  }

  private fail(err: unknown): void {
    this.socket.destroy(err instanceof Error ? err : new Error(String(err)));
    this.finish("error", err);
  }

  private write(frame: Buffer): void {
    if (!this.closed) this.socket.write(frame);
  }
}

/**
 * Wires one socket's bytes to one session: framing, close and error
 * handling. The pairing handshake reuses this on the same socket before a
 * SyncSession takes over — see peers-service.ts for the phase dispatcher.
 */
export function attachSession(socket: Duplex, session: SyncSession): void {
  const read = createFrameReader((message) => session.handleMessageFrame(message));
  socket.on("data", (chunk: Buffer) => {
    try {
      read(chunk);
    } catch (err) {
      socket.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  });
  socket.on("close", () => session.markClosed("closed"));
  socket.on("error", (err) => session.markClosed("error", err));
}

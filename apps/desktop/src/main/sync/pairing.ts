import type { Duplex } from "node:stream";
import { encodeFrame } from "./frames.js";
import { parseMessage, PROTOCOL_VERSION } from "./messages.js";

/**
 * Pairing handshake over an established TLS connection. The connection owner
 * (PeerService) extracts the peer's TLS fingerprint and drives the frames;
 * these helpers only speak the handshake messages.
 *
 * Trust model: the initiator (device B) has already verified that the code
 * its user typed derives from the accepting device's TLS certificate — a
 * man-in-the-middle presents a different key and therefore a different code,
 * so the check fails before anything is sent. B then introduces itself; the
 * acceptor's user confirms B's name and TLS fingerprint, and both sides pin.
 */

/** Initiating side: introduce, await the verdict. */
export class PairingInitiator {
  private settled = false;

  constructor(
    private readonly socket: Duplex,
    private readonly deps: {
      deviceName: string;
      onConfirmed(): void;
      onRejected(): void;
      log?: (message: string) => void;
    },
  ) {}

  start(): void {
    this.socket.write(
      encodeFrame({
        t: "pair-introduce-v2",
        v: PROTOCOL_VERSION,
        name: this.deps.deviceName,
      }),
    );
  }

  handleMessage(message: unknown): void {
    if (this.settled) return;
    const parsed = parseMessage(message);
    if (!parsed) return;
    switch (parsed.t) {
      case "pair-confirmed-v2":
        this.settled = true;
        this.deps.onConfirmed();
        return;
      case "pair-rejected-v2":
        this.settled = true;
        this.deps.onRejected();
        return;
      default:
        this.deps.log?.(`unexpected frame while pairing: ${parsed.t}`);
        return;
    }
  }
}

/**
 * Accepting side (device A, "Add a device" is open). The service feeds it
 * the peer's TLS fingerprint and each inbound frame; it asks `confirmPairing`
 * (the UI gate), then reports the verdict back for pinning.
 */
export class PairingAcceptor {
  private settled = false;
  private cancelled = false;
  private confirmation: AbortController | null = null;

  constructor(
    private readonly deps: {
      confirmPairing(
        fingerprint: string,
        name: string,
        signal: AbortSignal,
      ): Promise<boolean>;
      onPaired(name: string): void;
      onRejected(): void;
      log?: (message: string) => void;
    },
  ) {}

  handleMessage(message: unknown, peerFingerprint: string): void {
    if (this.settled) return;
    const parsed = parseMessage(message);
    if (!parsed) return;
    if (parsed.t !== "pair-introduce-v2") {
      this.deps.log?.(`unexpected frame while pairing: ${parsed.t}`);
      return;
    }
    this.settled = true;
    void this.settle(parsed.name, peerFingerprint);
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.settled = true;
    this.confirmation?.abort();
  }

  private async settle(name: string, fingerprint: string): Promise<void> {
    const confirmation = new AbortController();
    this.confirmation = confirmation;
    let accepted = false;
    try {
      accepted = await this.deps.confirmPairing(fingerprint, name, confirmation.signal);
    } catch (err) {
      if (!confirmation.signal.aborted) {
        this.deps.log?.(`pairing confirm failed: ${String(err)}`);
      }
      accepted = false;
    }
    if (this.confirmation === confirmation) this.confirmation = null;
    if (this.cancelled || confirmation.signal.aborted) return;
    if (accepted) this.deps.onPaired(name);
    else this.deps.onRejected();
  }
}

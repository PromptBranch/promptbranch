import { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { PairingAcceptor, PairingInitiator } from "./pairing.js";

const CURRENT_COMPATIBILITY = { v: 4, schemaVersion: 13 } as const;

function sink(): Duplex {
  return new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

describe("pairing parser failures", () => {
  it("makes a malformed verdict terminal for the initiator", () => {
    const onConfirmed = vi.fn();
    const onRejected = vi.fn();
    const initiator = new PairingInitiator(sink(), {
      deviceName: "Local",
      onConfirmed,
      onRejected,
    });

    expect(() => initiator.handleMessage({
      t: "pair-confirmed-v2",
      ...CURRENT_COMPATIBILITY,
      name: "",
    })).toThrow(/invalid pairing protocol frame/i);
    initiator.handleMessage({
      t: "pair-confirmed-v2",
      ...CURRENT_COMPATIBILITY,
      name: "Must not confirm",
    });

    expect(onConfirmed).not.toHaveBeenCalled();
    expect(onRejected).not.toHaveBeenCalled();
  });

  it("makes a malformed introduction terminal for the acceptor", () => {
    const confirmPairing = vi.fn(async () => true);
    const onPaired = vi.fn();
    const onRejected = vi.fn();
    const acceptor = new PairingAcceptor({
      confirmPairing,
      onPaired,
      onRejected,
    });

    expect(() => acceptor.handleMessage({
      t: "pair-introduce-v2",
      ...CURRENT_COMPATIBILITY,
      name: "",
    }, "remote-fingerprint")).toThrow(/invalid pairing protocol frame/i);
    acceptor.handleMessage({
      t: "pair-introduce-v2",
      ...CURRENT_COMPATIBILITY,
      name: "Must not confirm",
    }, "remote-fingerprint");

    expect(confirmPairing).not.toHaveBeenCalled();
    expect(onPaired).not.toHaveBeenCalled();
    expect(onRejected).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "shape-invalid",
      frame: {
        t: "pair-introduce-v2",
        ...CURRENT_COMPATIBILITY,
        name: "",
      },
      error: /invalid pairing protocol frame/i,
    },
    {
      name: "schema-incompatible",
      frame: {
        t: "pair-introduce-v2",
        v: 4,
        schemaVersion: 12,
        name: "Remote",
      },
      error: /received protocol 4, schema 12; expected protocol 4, schema 13/i,
    },
  ])("aborts pending confirmation on a $name frame", async ({ frame, error }) => {
    let resolveConfirmation!: (accepted: boolean) => void;
    const confirmation = new Promise<boolean>((resolve) => {
      resolveConfirmation = resolve;
    });
    let signal: AbortSignal | undefined;
    const confirmPairing = vi.fn(async (
      _fingerprint: string,
      _name: string,
      candidateSignal: AbortSignal,
    ) => {
      signal = candidateSignal;
      return confirmation;
    });
    const onPaired = vi.fn();
    const onRejected = vi.fn();
    const acceptor = new PairingAcceptor({
      confirmPairing,
      onPaired,
      onRejected,
    });
    acceptor.handleMessage({
      t: "pair-introduce-v2",
      ...CURRENT_COMPATIBILITY,
      name: "Remote",
    }, "remote-fingerprint");
    expect(signal?.aborted).toBe(false);

    expect(() => acceptor.handleMessage(frame, "remote-fingerprint")).toThrow(error);
    expect(signal?.aborted).toBe(true);
    resolveConfirmation(true);
    await confirmation;
    await Promise.resolve();

    expect(confirmPairing).toHaveBeenCalledTimes(1);
    expect(onPaired).not.toHaveBeenCalled();
    expect(onRejected).not.toHaveBeenCalled();
  });
});

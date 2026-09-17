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
});

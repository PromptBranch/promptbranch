import { z } from "zod";
import { describe, expect, it } from "vitest";
import { parseMessage } from "./messages.js";

const hello = {
  t: "hello",
  deviceId: "device-a",
  name: "Device A",
  cursors: {},
};

describe("sync protocol version", () => {
  it("rejects v1 peers that cannot decode delimiter-safe composite record keys", () => {
    expect(() => parseMessage({ ...hello, v: 1 })).toThrow(/protocol version 1/i);
    expect(parseMessage({ ...hello, v: 2 })).toEqual({ ...hello, v: 2 });
  });

  it("requires the current protocol during pairing", () => {
    expect(() => parseMessage({ t: "pair-introduce", name: "Old peer" })).toThrow(
      /protocol version missing/i,
    );
    expect(parseMessage({ t: "pair-introduce-v2", v: 2, name: "Current peer" })).toEqual({
      t: "pair-introduce-v2",
      v: 2,
      name: "Current peer",
    });
  });

  it("uses a pairing discriminator that the released v1 parser cannot accept", () => {
    const releasedV1PairIntroduce = z.object({
      t: z.literal("pair-introduce"),
      name: z.string().min(1).max(100),
    });
    const introduction = { t: "pair-introduce-v2", v: 2, name: "Current peer" };

    expect(releasedV1PairIntroduce.safeParse(introduction).success).toBe(false);
    expect(parseMessage(introduction)).toEqual(introduction);
  });
});

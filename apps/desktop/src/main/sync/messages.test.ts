import { z } from "zod";
import { describe, expect, it } from "vitest";
import { parseMessage } from "./messages.js";

const V0_5_0_SCHEMA_12_FIXTURE = {
  protocolVersion: 3,
  schemaVersion: 12,
  hello: {
    t: "hello",
    v: 3,
    deviceId: "v0.5.0-device",
    name: "PromptBranch 0.5.0",
    cursors: {},
  },
  pairIntroduce: {
    t: "pair-introduce-v2",
    v: 3,
    name: "PromptBranch 0.5.0",
  },
  promptTable: {
    name: "prompts",
    columns: [
      "id",
      "title",
      "description",
      "icon",
      "draft_content",
      "current_version_id",
      "is_starred",
      "created_at",
      "updated_at",
      "deleted_at",
    ],
  },
  promptUpsert: {
    source: "v0.5.0-device",
    seq: 1,
    opId: "v0.5.0-device-1-prompts-legacy-prompt-upsert",
    table: "prompts",
    recordId: "legacy-prompt",
    kind: "upsert",
    payload: {
      id: "legacy-prompt",
      title: "Legacy prompt",
      description: null,
      icon: null,
      draft_content: "legacy draft",
      current_version_id: null,
      is_starred: 0,
      created_at: "2026-09-12T00:00:00.000Z",
      updated_at: "2026-09-12T00:00:00.000Z",
      deleted_at: null,
    },
    hlc: "0000000000001000:000000:v0.5.0-device",
    createdAt: "2026-09-12T00:00:00.000Z",
  },
} as const;

const hello = {
  t: "hello",
  deviceId: "device-a",
  name: "Device A",
  cursors: {},
};

describe("sync protocol version", () => {
  it("accepts only protocol 4 with schema 13", () => {
    expect(parseMessage({ ...hello, v: 4, schemaVersion: 13 })).toEqual({
      ...hello,
      v: 4,
      schemaVersion: 13,
    });
    expect(() => parseMessage(V0_5_0_SCHEMA_12_FIXTURE.hello)).toThrow(
      /received protocol 3, schema missing; expected protocol 4, schema 13/i,
    );
  });

  it("rejects a wrong or missing sync schema version", () => {
    expect(() => parseMessage({ ...hello, v: 4, schemaVersion: 12 })).toThrow(
      /received protocol 4, schema 12; expected protocol 4, schema 13/i,
    );
    expect(() => parseMessage({ ...hello, v: 4 })).toThrow(
      /received protocol 4, schema missing; expected protocol 4, schema 13/i,
    );
  });

  it("requires the current protocol and schema during pairing", () => {
    expect(() => parseMessage(V0_5_0_SCHEMA_12_FIXTURE.pairIntroduce)).toThrow(
      /received protocol 3, schema missing; expected protocol 4, schema 13/i,
    );
    expect(parseMessage({
      t: "pair-introduce-v2",
      v: 4,
      schemaVersion: 13,
      name: "Current peer",
    })).toEqual({
      t: "pair-introduce-v2",
      v: 4,
      schemaVersion: 13,
      name: "Current peer",
    });
  });

  it("uses a pairing discriminator that the released v1 parser cannot accept", () => {
    const releasedV1PairIntroduce = z.object({
      t: z.literal("pair-introduce"),
      name: z.string().min(1).max(100),
    });
    const introduction = {
      t: "pair-introduce-v2",
      v: 4,
      schemaVersion: 13,
      name: "Current peer",
    };

    expect(releasedV1PairIntroduce.safeParse(introduction).success).toBe(false);
    expect(parseMessage(introduction)).toEqual(introduction);
  });
});

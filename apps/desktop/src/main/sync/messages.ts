import { z } from "zod";

/**
 * Peer wire protocol, version 4. Every message is a length-prefixed JSON
 * frame (see frames.ts). Anti-entropy is hello-driven: either side may send
 * `hello` at any time (on connect, or as a "pull me" notification after new
 * local ops); the receiver answers with `ops` batches and a final `flush`.
 * Pairing rides the same TLS connection: the initiator verifies the SAS code
 * locally against the server certificate, then introduces itself.
 */

// v4 requires an exact synced-payload schema match before pairing or applying
// operations. Historical operations retain their original payload shape.
export const PROTOCOL_VERSION = 4;
export const SYNC_SCHEMA_VERSION = 13;

export interface SyncCompatibility {
  v: 4;
  schemaVersion: 13;
}

const cursorsSchema = z.record(z.string(), z.number().int().min(0));

const opSchema = z.object({
  source: z.string().min(1),
  seq: z.number().int().min(1),
  opId: z.string().min(1),
  table: z.string().min(1),
  recordId: z.string().min(1),
  kind: z.enum(["upsert", "delete"]),
  payload: z.record(z.string(), z.unknown()).nullable(),
  hlc: z.string().min(1),
  createdAt: z.string().min(1),
});

const helloSchema = z.object({
  t: z.literal("hello"),
  v: z.literal(PROTOCOL_VERSION),
  schemaVersion: z.literal(SYNC_SCHEMA_VERSION),
  deviceId: z.string().min(1),
  name: z.string().min(1).max(100),
  cursors: cursorsSchema,
});

const opsSchema = z.object({
  t: z.literal("ops"),
  ops: z.array(opSchema).max(5_000),
  more: z.boolean(),
});

const flushSchema = z.object({ t: z.literal("flush") });

const notifySchema = z.object({ t: z.literal("notify") });

const pairIntroduceSchema = z.object({
  // The discriminator itself changed for v2 because released v1 Zod schemas
  // stripped an unknown `v` field and would otherwise accept and pin one side.
  t: z.literal("pair-introduce-v2"),
  v: z.literal(PROTOCOL_VERSION),
  schemaVersion: z.literal(SYNC_SCHEMA_VERSION),
  name: z.string().min(1).max(100),
});

const pairConfirmedSchema = z.object({
  t: z.literal("pair-confirmed-v2"),
  v: z.literal(PROTOCOL_VERSION),
  schemaVersion: z.literal(SYNC_SCHEMA_VERSION),
  name: z.string().min(1).max(100),
});

const pairRejectedSchema = z.object({
  t: z.literal("pair-rejected-v2"),
  v: z.literal(PROTOCOL_VERSION),
  schemaVersion: z.literal(SYNC_SCHEMA_VERSION),
});

const pingSchema = z.object({ t: z.literal("ping") });
const pongSchema = z.object({ t: z.literal("pong") });

const messageSchema = z.discriminatedUnion("t", [
  helloSchema,
  opsSchema,
  flushSchema,
  notifySchema,
  pairIntroduceSchema,
  pairConfirmedSchema,
  pairRejectedSchema,
  pingSchema,
  pongSchema,
]);

export type WireMessage = z.infer<typeof messageSchema>;

const COMPATIBILITY_MESSAGES = new Set([
  "hello",
  "pair-introduce",
  "pair-confirmed",
  "pair-rejected",
  "pair-introduce-v2",
  "pair-confirmed-v2",
  "pair-rejected-v2",
]);

function compatibilityValue(value: object, key: "v" | "schemaVersion"): string {
  return key in value ? String((value as Record<string, unknown>)[key]) : "missing";
}

function incompatibleCompatibility(value: object): Error {
  return new Error(
    "Incompatible sync compatibility: " +
      `received protocol ${compatibilityValue(value, "v")}, ` +
      `schema ${compatibilityValue(value, "schemaVersion")}; ` +
      `expected protocol ${PROTOCOL_VERSION}, schema ${SYNC_SCHEMA_VERSION}`,
  );
}

/** Parses one frame; returns null for anything not in the protocol. */
export function parseMessage(value: unknown): WireMessage | null {
  if (typeof value === "object" && value !== null && "t" in value) {
    const { t } = value as { t?: unknown };
    if (
      typeof t === "string" &&
      COMPATIBILITY_MESSAGES.has(t) &&
      ((value as { v?: unknown }).v !== PROTOCOL_VERSION ||
        (value as { schemaVersion?: unknown }).schemaVersion !== SYNC_SCHEMA_VERSION)
    ) {
      throw incompatibleCompatibility(value);
    }
  }
  const result = messageSchema.safeParse(value);
  return result.success ? result.data : null;
}

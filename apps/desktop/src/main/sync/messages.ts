import { z } from "zod";

/**
 * Peer wire protocol, version 1. Every message is a length-prefixed JSON
 * frame (see frames.ts). Anti-entropy is hello-driven: either side may send
 * `hello` at any time (on connect, or as a "pull me" notification after new
 * local ops); the receiver answers with `ops` batches and a final `flush`.
 * Pairing rides the same TLS connection: the initiator verifies the SAS code
 * locally against the server certificate, then introduces itself.
 */

export const PROTOCOL_VERSION = 1;

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
  t: z.literal("pair-introduce"),
  name: z.string().min(1).max(100),
});

const pairConfirmedSchema = z.object({
  t: z.literal("pair-confirmed"),
  name: z.string().min(1).max(100),
});

const pairRejectedSchema = z.object({ t: z.literal("pair-rejected") });

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

/** Parses one frame; returns null for anything not in the protocol. */
export function parseMessage(value: unknown): WireMessage | null {
  const result = messageSchema.safeParse(value);
  return result.success ? result.data : null;
}

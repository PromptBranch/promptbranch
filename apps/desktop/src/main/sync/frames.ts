/**
 * Wire framing: 4-byte big-endian length + UTF-8 JSON. Bounded so a hostile
 * or confused peer cannot make us buffer unbounded memory.
 */

/**
 * Bounded so a hostile or confused peer cannot make us buffer unbounded
 * memory. 16 MB leaves headroom for one run op capped at 2 MB whose control
 * characters JSON-escape up to 6× (engine.ts RUN_OUTPUT_CAP).
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error(`Frame too large to encode: ${body.length} bytes`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Incremental frame splitter: feed it socket chunks, receive parsed messages.
 * Throws on oversized frames — callers should destroy the connection.
 */
export function createFrameReader(onMessage: (message: unknown) => void): (chunk: Buffer) => void {
  let buffer: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        throw new Error(`Frame too large: ${length} bytes`);
      }
      if (buffer.length < 4 + length) return;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      onMessage(JSON.parse(body.toString("utf8")) as unknown);
    }
  };
}

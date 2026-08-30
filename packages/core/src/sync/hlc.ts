/**
 * Hybrid logical clock stamps. A stamp is "<millis>:<counter>" with both
 * parts zero-padded so lexicographic order equals causal order. Stamps move
 * with ops; the receiving device ratchets its own clock past every stamp it
 * observes, so its next local write wins any last-writer-wins comparison
 * against everything it has already seen. Device ids break remaining ties.
 */

export interface HlcStamp {
  millis: number;
  counter: number;
}

const MILLIS_WIDTH = 13;
const COUNTER_WIDTH = 6;

export function formatHlc(stamp: HlcStamp): string {
  if (!Number.isSafeInteger(stamp.millis) || stamp.millis < 0) {
    throw new Error(`Invalid HLC millis: ${stamp.millis}`);
  }
  if (!Number.isSafeInteger(stamp.counter) || stamp.counter < 0) {
    throw new Error(`Invalid HLC counter: ${stamp.counter}`);
  }
  return `${String(stamp.millis).padStart(MILLIS_WIDTH, "0")}:${String(stamp.counter).padStart(COUNTER_WIDTH, "0")}`;
}

export function parseHlc(value: string): HlcStamp {
  const parts = value.split(":");
  if (parts.length !== 2) throw new Error(`Malformed HLC stamp: ${value}`);
  const millis = Number(parts[0]);
  const counter = Number(parts[1]);
  if (!Number.isSafeInteger(millis) || !Number.isSafeInteger(counter)) {
    throw new Error(`Malformed HLC stamp: ${value}`);
  }
  return { millis, counter };
}

export function compareHlc(a: string, b: string): number {
  if (a === b) return 0;
  const pa = parseHlc(a);
  const pb = parseHlc(b);
  if (pa.millis !== pb.millis) return pa.millis < pb.millis ? -1 : 1;
  if (pa.counter !== pb.counter) return pa.counter < pb.counter ? -1 : 1;
  return 0;
}

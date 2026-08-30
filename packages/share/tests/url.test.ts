import { describe, expect, it } from "vitest";
import { parseSnapshotUrl, resolvePortalBaseUrl } from "../src/url.js";

const ID = "V1StGXR8_Z5jdHi6B-myT";

describe("parseSnapshotUrl", () => {
  it("accepts a raw id, with or without surrounding whitespace", () => {
    expect(parseSnapshotUrl(ID)).toEqual({ id: ID });
    expect(parseSnapshotUrl(`  ${ID}\n`)).toEqual({ id: ID });
  });

  it("accepts /p/<id> URLs on any host, with query strings", () => {
    expect(parseSnapshotUrl(`https://prompts.example.com/p/${ID}`)).toEqual({ id: ID });
    expect(parseSnapshotUrl(`http://192.168.1.20:3000/p/${ID}?ref=chat`)).toEqual({ id: ID });
  });

  it("accepts /api/snapshots/<id> URLs", () => {
    expect(parseSnapshotUrl(`https://prompts.example.com/api/snapshots/${ID}`)).toEqual({ id: ID });
  });

  it("rejects URLs whose path is not a snapshot path", () => {
    expect(parseSnapshotUrl(`https://example.com/other/${ID}`)).toBeNull();
    expect(parseSnapshotUrl(`https://example.com/p/`)).toBeNull();
    expect(parseSnapshotUrl(`https://example.com/p/not-an-id`)).toBeNull();
  });

  it("rejects non-URL, non-id input", () => {
    expect(parseSnapshotUrl("hello world")).toBeNull();
    expect(parseSnapshotUrl("")).toBeNull();
  });
});

describe("resolvePortalBaseUrl", () => {
  const FALLBACK = "https://promptbranch.app";

  it("a full snapshot URL names its own portal (origin only)", () => {
    expect(resolvePortalBaseUrl(`http://192.168.1.20:3000/p/${ID}`, FALLBACK)).toBe(
      "http://192.168.1.20:3000",
    );
    expect(resolvePortalBaseUrl(`https://p.example.com/api/snapshots/${ID}?x=1`, FALLBACK)).toBe(
      "https://p.example.com",
    );
  });

  it("raw ids and non-URL input fall back to the configured portal", () => {
    expect(resolvePortalBaseUrl(ID, FALLBACK)).toBe(FALLBACK);
    expect(resolvePortalBaseUrl("not a url", FALLBACK)).toBe(FALLBACK);
  });
});

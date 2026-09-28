import { describe, expect, it } from "vitest";
import { buildEmbedSnippet } from "./embed-snippet.js";

const ID = "V1StGXR8_Z5jdHi6B-myT";

describe("buildEmbedSnippet", () => {
  it.each([
    [
      `https://promptbranch.app/p/${ID}`,
      `<div data-promptbranch-embed="https://promptbranch.app/p/${ID}"></div>\n` +
        `<script defer src="https://promptbranch.app/embed.js"></script>`,
    ],
    [
      `HTTPS://Portal.Example:443/p/${ID}`,
      `<div data-promptbranch-embed="https://portal.example/p/${ID}"></div>\n` +
        `<script defer src="https://portal.example/embed.js"></script>`,
    ],
    [
      `https://others-portal.local:8443/p/${ID}`,
      `<div data-promptbranch-embed="https://others-portal.local:8443/p/${ID}"></div>\n` +
        `<script defer src="https://others-portal.local:8443/embed.js"></script>`,
    ],
  ])("matches the portal snippet contract for %s", (url, snippet) => {
    expect(buildEmbedSnippet(url)).toBe(snippet);
  });

  it.each([
    `javascript:alert(1)`,
    `//promptbranch.app/p/${ID}`,
    `https://user:password@promptbranch.app/p/${ID}`,
    `https://promptbranch.app/p/${ID}?token=secret`,
    `https://promptbranch.app/p/${ID}#fragment`,
    `https://promptbranch.app/p/short`,
    `https://promptbranch.app/p/${ID}%22`,
    `https://promptbranch.app/api/snapshots/${ID}`,
  ])("rejects non-canonical or unsafe URL %s", (url) => {
    expect(() => buildEmbedSnippet(url)).toThrow();
  });
});

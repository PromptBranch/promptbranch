const SNAPSHOT_PATH = /^\/p\/[A-Za-z0-9_-]{21}$/;

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Build the same-origin HTML snippet for a canonical PromptBranch share URL. */
export function buildEmbedSnippet(snapshotUrl: string): string {
  let url: URL;
  try {
    url = new URL(snapshotUrl);
  } catch {
    throw new TypeError("Expected an absolute PromptBranch snapshot URL");
  }

  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    !SNAPSHOT_PATH.test(url.pathname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("Expected a canonical PromptBranch snapshot URL without credentials or extra parameters");
  }

  return (
    `<div data-promptbranch-embed="${escapeAttribute(url.href)}"></div>\n` +
    `<script defer src="${escapeAttribute(url.origin)}/embed.js"></script>`
  );
}

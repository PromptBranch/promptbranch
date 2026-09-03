export type Severity = "high" | "medium";

export interface Finding {
  severity: Severity;
  /** Stable rule identifier, shown to users and asserted in tests. */
  rule: string;
  /** 1-based line number of the match in the scanned text. */
  line: number;
  /** Matched text, truncated to 80 chars so findings are safe to display. */
  match: string;
}

interface Rule {
  name: string;
  severity: Severity;
  /** Must carry the /g flag — scanForSecrets iterates with matchAll. */
  pattern: RegExp;
  /**
   * Extra gate evaluated on the first capture group when present, otherwise
   * on the whole match (the entropy rule lives here so prose mentioning
   * "password" doesn't block publication).
   */
  accept?: (value: string) => boolean;
}

/** Shannon entropy in bits/char; random tokens sit above ~4, words below ~3. */
function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const RULES: Rule[] = [
  // Anthropic first: its sk-ant- prefix also matches the generic sk- shape.
  { name: "anthropic-api-key", severity: "high", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-api-key", severity: "high", pattern: /sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: "google-api-key", severity: "high", pattern: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "aws-access-key", severity: "high", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "gcp-service-account", severity: "high", pattern: /"type"\s*:\s*"service_account"/g },
  {
    name: "github-token",
    severity: "high",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
  },
  { name: "slack-token", severity: "high", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "pem-private-key", severity: "high", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  {
    name: "high-entropy-assignment",
    severity: "high",
    pattern: /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["']([A-Za-z0-9+/=_-]{23,})["']/gi,
    accept: (value) => shannonEntropy(value) >= 4.0,
  },
  {
    name: "auth-header",
    severity: "high",
    pattern: /\b(?:authorization|x-api-key)\s*:\s*(?:bearer|basic)\s+\S{8,}/gi,
  },
  // Medium: warn, never block — common in prompts that reference private infra.
  {
    name: "internal-url",
    severity: "medium",
    pattern:
      /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[\w-]+(?:\.[\w-]+)*\.(?:local|internal|lan|corp|home))(?::\d+)?(?:\/\S*)?/g,
  },
  {
    name: "email-address",
    severity: "medium",
    // Without a left boundary, a failed @ lookup retries the greedy local
    // part at every character of a long identifier.
    pattern: /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
  },
];

function newlineOffsets(text: string): number[] {
  const offsets: number[] = [];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    offsets.push(index);
  }
  return offsets;
}

function lineOf(offsets: readonly number[], index: number): number {
  // Lower-bound search: the insertion point is the number of newlines before
  // the match and therefore its zero-based line index.
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((offsets[middle] ?? Number.POSITIVE_INFINITY) < index) low = middle + 1;
    else high = middle;
  }
  return low + 1;
}

function truncate(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

/**
 * One rule set for both trust layers: the desktop/CLI scans before anything
 * leaves the machine, the portal re-scans every publish. High blocks,
 * medium warns — the caller decides, this function only reports.
 */
export function scanForSecrets(text: string): Finding[] {
  const findings: Finding[] = [];
  const offsets = newlineOffsets(text);
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const value = match[1] ?? match[0];
      if (rule.accept && !rule.accept(value)) continue;
      findings.push({
        severity: rule.severity,
        rule: rule.name,
        line: lineOf(offsets, match.index),
        match: truncate(match[0]),
      });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

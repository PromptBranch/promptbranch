/**
 * Cost estimation from a catalog entry's per-million-token pricing.
 * Returns null when pricing (or usage) is unknown — never guesses.
 *
 * Deliberately out of scope: cached-token pricing (CatalogModel.costCacheRead
 * / costCacheWrite). TokenUsage does not split cached vs uncached tokens, so
 * applying cache rates here would misestimate; the fields are parsed for
 * future use only.
 */
import type { CatalogModel } from "./catalog.js";
import type { TokenUsage } from "./run.js";

/** Estimated USD cost of a run, or null when pricing/usage data is missing. */
export function estimateCost(
  catalogEntry: Pick<CatalogModel, "costInput" | "costOutput"> | null,
  usage: TokenUsage,
): number | null {
  if (!catalogEntry) return null;
  const { costInput, costOutput } = catalogEntry;
  if (costInput === null || costOutput === null) return null;
  if (usage.inputTokens === null || usage.outputTokens === null) return null;
  const usd = (costInput * usage.inputTokens + costOutput * usage.outputTokens) / 1_000_000;
  // Round to avoid float noise; sub-microcent costs show as 0.
  return Math.round(usd * 1e8) / 1e8;
}

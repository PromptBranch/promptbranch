/**
 * The judge score average, in its own module so the desktop renderer can
 * import it via the "@promptbranch/ai/judge-average" subpath without
 * pulling the whole AI SDK (imported by ./judge.js) into its bundle.
 */

/** The four judge scoring dimensions, each 1–5. */
export interface JudgeScores {
  effectiveness: number;
  clarity: number;
  completeness: number;
  actionability: number;
}

/** Mean of the four dimensions, rounded to one decimal (badge + rating). */
export function judgeAverage(scores: JudgeScores): number {
  const sum = scores.effectiveness + scores.clarity + scores.completeness + scores.actionability;
  return Math.round((sum / 4) * 10) / 10;
}

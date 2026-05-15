import { SCORE_MULTIPLIERS } from "./constants.js";
import type { Rarity } from "./types.js";

// Canonical catch-score formula. Matches the on-chain integer ceiling math
// (a + 99) / 100 so the value the gateway puts on the wire is bit-identical
// to the value submitInputSamples persists. Keeping this in one place lets
// `resolveCatch` deliver `catch_resolved` on the tick without waiting on the
// Mongo write — both sides compute the same score from the same inputs.
export function computeCatchScore(rarity: Rarity, weightHg: number): number {
  if (weightHg <= 0) return 0;
  const multiplier = SCORE_MULTIPLIERS[rarity] ?? 1;
  return Math.floor((multiplier * weightHg + 99) / 100);
}

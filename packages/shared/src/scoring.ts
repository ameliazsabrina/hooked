import { FishRarity, SCORE_MULTIPLIERS } from "./fish.js";

export interface SkillInputs {
  timeEfficiency: number;
  centerAccuracy: number;
}

// PRD §6.10: 1 + time_efficiency*0.10 + center_accuracy*0.15 (caps ~1.25).
export function computeSkillMultiplier(inputs: SkillInputs | undefined): number {
  if (!inputs) return 1;
  const te = Math.max(0, Math.min(1.5, inputs.timeEfficiency));
  const ca = Math.max(0, Math.min(1, inputs.centerAccuracy));
  return 1 + te * 0.1 + ca * 0.15;
}

export function calculateCatchScore(
  rarity: FishRarity,
  weightKg: number,
  skill?: SkillInputs,
): number {
  const mult = computeSkillMultiplier(skill);
  return Math.ceil(SCORE_MULTIPLIERS[rarity] * weightKg * mult);
}

// Share of TOTAL yield (must sum to 1.0). PRD: 30% protocol, 40% 1st, 20% 2nd, 10% 3rd.
export const YIELD_SPLIT = {
  protocol: 0.3,
  first: 0.4,
  second: 0.2,
  third: 0.1,
} as const;

/** @deprecated Use YIELD_SPLIT — kept for existing callers during migration */
export const YIELD_DISTRIBUTION = {
  first: YIELD_SPLIT.first,
  second: YIELD_SPLIT.second,
  third: YIELD_SPLIT.third,
} as const;

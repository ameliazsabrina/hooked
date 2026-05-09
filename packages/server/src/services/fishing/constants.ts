// Mirror of programs/crates/hooked-common/src/constants.rs, simplified for
// off-chain v2: single zone (OpenSea) — all species roll in the same scene.

export const MAX_CATCHES = 15;
export const GREEN_ZONE_WIDTH_BPS = 2000;
export const BPS_SCALE = 10_000;
export const PITY_THRESHOLD = 10;

export const MIN_RESOLVE_ELAPSED_SECS = 1;
export const MAX_RESOLVE_ELAPSED_SECS = 30;

// Rarity multipliers × 10. Applied as `(mult * weightHg) / 100` to yield
// `weightKg * mult_as_decimal`. Decimals: Basic 1.0, Rare 1.5, Monster 2.5,
// Legendary 3.5, Apex 4.0.
export const SCORE_MULTIPLIERS = [10, 15, 25, 35, 40] as const;

// PRD §6.2 catch-rate targets (24h avg, bp out of 10_000):
//   Basic 7550 / Rare 2000 / Monster 400 / Legendary 40 / Apex 10.
// Apex baseline is 0 — gated by EventConfig (Colosseum). During an active
// event, EventConfig.apex_bp is subtracted from Basic in the cast roll.
export const DAY_RARITY_WEIGHTS: readonly number[] = [7604, 1980, 380, 36, 0];
export const NIGHT_RARITY_WEIGHTS: readonly number[] = [7516, 2020, 420, 44, 0];

export interface SpeciesEntry {
  readonly id: number;
  readonly rarity: number;
  readonly minWeightHg: number;
  readonly maxWeightHg: number;
}

// All species fish in OpenSea. Weight ranges preserved from the on-chain
// table; only the zone column was removed.
export const SPECIES_TABLE: readonly SpeciesEntry[] = [
  { id: 0, rarity: 0, minWeightHg: 10, maxWeightHg: 30 },
  { id: 1, rarity: 0, minWeightHg: 20, maxWeightHg: 50 },
  { id: 2, rarity: 0, minWeightHg: 30, maxWeightHg: 60 },
  { id: 3, rarity: 0, minWeightHg: 10, maxWeightHg: 40 },
  { id: 4, rarity: 0, minWeightHg: 50, maxWeightHg: 100 },
  { id: 5, rarity: 1, minWeightHg: 50, maxWeightHg: 100 },
  { id: 6, rarity: 1, minWeightHg: 70, maxWeightHg: 130 },
  { id: 7, rarity: 1, minWeightHg: 80, maxWeightHg: 150 },
  { id: 8, rarity: 1, minWeightHg: 120, maxWeightHg: 200 },
  { id: 9, rarity: 1, minWeightHg: 100, maxWeightHg: 180 },
  { id: 10, rarity: 2, minWeightHg: 200, maxWeightHg: 300 },
  { id: 11, rarity: 2, minWeightHg: 150, maxWeightHg: 250 },
  { id: 12, rarity: 2, minWeightHg: 100, maxWeightHg: 200 },
  { id: 13, rarity: 2, minWeightHg: 120, maxWeightHg: 220 },
  { id: 14, rarity: 2, minWeightHg: 220, maxWeightHg: 300 },
  { id: 15, rarity: 3, minWeightHg: 400, maxWeightHg: 500 },
  { id: 16, rarity: 3, minWeightHg: 300, maxWeightHg: 450 },
  { id: 17, rarity: 3, minWeightHg: 250, maxWeightHg: 400 },
  { id: 18, rarity: 3, minWeightHg: 350, maxWeightHg: 500 },
  { id: 19, rarity: 3, minWeightHg: 200, maxWeightHg: 350 },
  // Apex (Colosseum event) — gated by EventConfig.
  { id: 20, rarity: 4, minWeightHg: 300, maxWeightHg: 500 },
  { id: 21, rarity: 4, minWeightHg: 500, maxWeightHg: 800 },
  { id: 22, rarity: 4, minWeightHg: 700, maxWeightHg: 1000 },
];

export const SPECIES_COUNT = SPECIES_TABLE.length;
export const SPECIES_PER_RARITY: readonly number[] = [5, 5, 5, 5, 3];
export const RARITY_START_INDEX: readonly number[] = [0, 5, 10, 15, 20];

export const CIRCULAR_TAP_LEGENDARY_TAPS = 3;
export const CIRCULAR_TAP_LEGENDARY_ALLOWED_MISSES = 1;
export const CIRCULAR_TAP_APEX_TAPS = 5;
export const CIRCULAR_TAP_APEX_ALLOWED_MISSES = 0;

// Fail fast at module load if anyone edits a table out of invariant.
{
  const daySum = DAY_RARITY_WEIGHTS.reduce((a, b) => a + b, 0);
  const nightSum = NIGHT_RARITY_WEIGHTS.reduce((a, b) => a + b, 0);
  if (daySum !== BPS_SCALE) throw new Error(`DAY_RARITY_WEIGHTS sum ${daySum} != ${BPS_SCALE}`);
  if (nightSum !== BPS_SCALE) throw new Error(`NIGHT_RARITY_WEIGHTS sum ${nightSum} != ${BPS_SCALE}`);
  if (SPECIES_PER_RARITY.reduce((a, b) => a + b, 0) !== SPECIES_COUNT) {
    throw new Error(`SPECIES_PER_RARITY total != SPECIES_COUNT`);
  }
}

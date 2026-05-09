import { createHmac } from "node:crypto";

import {
  BPS_SCALE,
  DAY_RARITY_WEIGHTS,
  GREEN_ZONE_WIDTH_BPS,
  NIGHT_RARITY_WEIGHTS,
  PITY_THRESHOLD,
  RARITY_START_INDEX,
  SPECIES_COUNT,
  SPECIES_PER_RARITY,
  SPECIES_TABLE,
} from "./constants.js";
import { Mechanic, Rarity, Window, type CastRoll } from "./types.js";

/**
 * Per-cast 32-byte seed derived from a daily secret + cast-identifying inputs.
 * The daily secret rotates each UTC day; its sha256 is committed publicly
 * before the day starts so revealed seeds can be verified at audit time.
 */
export function seedForCast(input: {
  dailySeed: Buffer;
  sessionId: string;
  castIndex: number;
  pity: number;
  playerWallet: string;
}): Buffer {
  if (input.dailySeed.length !== 32) {
    throw new Error(`dailySeed must be 32 bytes, got ${input.dailySeed.length}`);
  }
  const message = `${input.sessionId}|${input.castIndex}|${input.pity}|${input.playerWallet}`;
  return createHmac("sha256", input.dailySeed).update(message).digest();
}

/** Day or night rarity table with apex_bp redistributed from Basic. */
function effectiveRarityWeights(window: Window, apexBp: number): readonly [number, number, number, number, number] {
  const base = window === Window.Day ? DAY_RARITY_WEIGHTS : NIGHT_RARITY_WEIGHTS;
  // apex_bp is taken from Basic so the sum stays at BPS_SCALE. set_event caps
  // apex_bp well under Basic's floor; the Math.max is defense-in-depth.
  const basic = Math.max(0, base[0] - apexBp);
  return [basic, base[1], base[2], base[3], apexBp];
}

/**
 * Roll a rarity tier from the seed's first 4 bytes. Mirrors the Rust
 * `roll_rarity` distribution: u32 mod BPS_SCALE, walk cumulative weights.
 *
 * Note: drawing from u32 (vs u16) keeps the partial-final-cycle bias under 2e-6.
 */
export function rollRarity(seedBytes: Buffer, window: Window, apexBp: number): Rarity {
  const weights = effectiveRarityWeights(window, apexBp);
  const u32 = seedBytes.readUInt32LE(0);
  const rarityRoll = u32 % BPS_SCALE;
  let cumulative = 0;
  for (let i = 0; i < weights.length; i++) {
    cumulative += weights[i];
    if (rarityRoll < cumulative) return i as Rarity;
  }
  return (weights.length - 1) as Rarity;
}

/** Returns true if this cast should bump rarity 0 → 1 due to pity. */
export function shouldForceRare(castCount: number, pity: number): boolean {
  return (castCount === 10 || castCount === 13) && pity >= PITY_THRESHOLD;
}

/**
 * Full cast roll: rarity → species → weight → green-zone position → mechanic.
 * Pure function of inputs — no IO, no Date.now. Caller is responsible for
 * pity bookkeeping and persisting the result.
 *
 * `apexSpeciesIds` (optional): when an Apex tier rolls, pick uniformly from
 * this list instead of the legacy `RARITY_START_INDEX[Apex]..+SPECIES_PER_
 * RARITY[Apex]` slice. Lets the admin restrict which apex fish drop during
 * an event without changing the static SPECIES_TABLE. When undefined or
 * empty, falls back to the legacy slice so non-event sessions keep working.
 */
export function rollCast(input: {
  seedBytes: Buffer;
  window: Window;
  apexBp: number;
  castCount: number;
  pity: number;
  apexSpeciesIds?: readonly number[];
}): CastRoll {
  let rarity = rollRarity(input.seedBytes, input.window, input.apexBp);
  if (shouldForceRare(input.castCount, input.pity) && rarity === Rarity.Basic) {
    rarity = Rarity.Rare;
  }

  let speciesIdx: number;
  if (
    rarity === Rarity.Apex &&
    input.apexSpeciesIds &&
    input.apexSpeciesIds.length > 0
  ) {
    // Event-overridden apex pool. Each id must reference an Apex-rarity entry
    // in SPECIES_TABLE; the admin router validates this before persisting.
    const idx = input.seedBytes[2] % input.apexSpeciesIds.length;
    speciesIdx = input.apexSpeciesIds[idx];
    if (speciesIdx < 0 || speciesIdx >= SPECIES_COUNT) {
      throw new Error(`apexSpeciesIds[${idx}]=${speciesIdx} out of range`);
    }
  } else {
    const start = RARITY_START_INDEX[rarity];
    const count = SPECIES_PER_RARITY[rarity];
    if (count === 0) throw new Error(`No species for rarity ${rarity}`);
    const speciesRoll = input.seedBytes[2] % count;
    speciesIdx = start + speciesRoll;
    if (speciesIdx >= SPECIES_COUNT) throw new Error(`speciesIdx ${speciesIdx} >= ${SPECIES_COUNT}`);
  }

  const species = SPECIES_TABLE[speciesIdx];
  const weightRand = input.seedBytes.readUInt16LE(3);
  const range = species.maxWeightHg - species.minWeightHg;
  const weightHg = range > 0 ? species.minWeightHg + (weightRand % (range + 1)) : species.minWeightHg;

  const greenRand = input.seedBytes.readUInt16LE(5);
  const maxStart = BPS_SCALE - GREEN_ZONE_WIDTH_BPS;
  const greenZoneStart = greenRand % (maxStart + 1);

  const mechanic = rarity >= Rarity.Legendary ? Mechanic.CircularTap : Mechanic.TimingBar;

  return {
    rarity,
    speciesId: speciesIdx,
    weightHg,
    greenZoneStart,
    greenZoneWidth: GREEN_ZONE_WIDTH_BPS,
    mechanic,
  };
}

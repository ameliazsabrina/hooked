import { createHmac } from "node:crypto";

import { FISH_SPECIES } from "@hooked/shared";

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
import {
  Mechanic,
  Rarity,
  Window,
  type ApexFishRollEntry,
  type CastRoll,
} from "./types.js";

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
 * Apex casts pick uniformly from `apexFishes` (the session-start snapshot of
 * the active event's `ApexFish` pool) and use the entry's weight range
 * directly — the apex catalog lives in MongoDB and isn't part of
 * SPECIES_TABLE. When apex rolls and the snapshot is empty, the function
 * throws (the session shouldn't have allowed an apex roll without an event).
 */
export function rollCast(input: {
  seedBytes: Buffer;
  window: Window;
  apexBp: number;
  castCount: number;
  pity: number;
  apexFishes?: readonly ApexFishRollEntry[];
}): CastRoll {
  let rarity = rollRarity(input.seedBytes, input.window, input.apexBp);
  if (shouldForceRare(input.castCount, input.pity) && rarity === Rarity.Basic) {
    rarity = Rarity.Rare;
  }

  if (rarity === Rarity.Apex) {
    if (!input.apexFishes || input.apexFishes.length === 0) {
      throw new Error(
        "Apex rolled but apexFishes snapshot is empty (no event active or " +
          "no apex fish configured for the event)",
      );
    }
    const idx = input.seedBytes[2] % input.apexFishes.length;
    const fish = input.apexFishes[idx];
    const weightRand = input.seedBytes.readUInt16LE(3);
    const range = fish.weightMaxHg - fish.weightMinHg;
    const weightHg = range > 0
      ? fish.weightMinHg + (weightRand % (range + 1))
      : fish.weightMinHg;
    const greenRand = input.seedBytes.readUInt16LE(5);
    const maxStart = BPS_SCALE - GREEN_ZONE_WIDTH_BPS;
    const greenZoneStart = greenRand % (maxStart + 1);
    return {
      rarity,
      speciesId: -1,
      apexFishId: fish.apexFishId,
      speciesName: fish.name,
      weightHg,
      greenZoneStart,
      greenZoneWidth: GREEN_ZONE_WIDTH_BPS,
      mechanic: Mechanic.CircularTap,
    };
  }

  const start = RARITY_START_INDEX[rarity];
  const count = SPECIES_PER_RARITY[rarity];
  if (count === 0) throw new Error(`No species for rarity ${rarity}`);
  const speciesRoll = input.seedBytes[2] % count;
  const speciesIdx = start + speciesRoll;
  if (speciesIdx >= SPECIES_COUNT) throw new Error(`speciesIdx ${speciesIdx} >= ${SPECIES_COUNT}`);

  const species = SPECIES_TABLE[speciesIdx];
  const weightRand = input.seedBytes.readUInt16LE(3);
  const range = species.maxWeightHg - species.minWeightHg;
  const weightHg = range > 0 ? species.minWeightHg + (weightRand % (range + 1)) : species.minWeightHg;

  const greenRand = input.seedBytes.readUInt16LE(5);
  const maxStart = BPS_SCALE - GREEN_ZONE_WIDTH_BPS;
  const greenZoneStart = greenRand % (maxStart + 1);

  const mechanic = rarity >= Rarity.Legendary ? Mechanic.CircularTap : Mechanic.TimingBar;
  const speciesName = FISH_SPECIES[speciesIdx]?.name ?? `species_${speciesIdx}`;

  return {
    rarity,
    speciesId: speciesIdx,
    apexFishId: null,
    speciesName,
    weightHg,
    greenZoneStart,
    greenZoneWidth: GREEN_ZONE_WIDTH_BPS,
    mechanic,
  };
}

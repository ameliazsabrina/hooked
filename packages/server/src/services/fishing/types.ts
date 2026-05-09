// Off-chain types for fishing v2. Numeric values for Rarity/Window/Mechanic
// match the legacy on-chain `repr(u8)` so any old chain reads still decode.
// Zone collapsed to a single value for v2 (OpenSea only).

export enum Rarity {
  Basic = 0,
  Rare = 1,
  Monster = 2,
  Legendary = 3,
  Apex = 4,
}

export enum Window {
  Day = 0,
  Night = 1,
}

export enum Mechanic {
  TimingBar = 0,
  CircularTap = 1,
}

// String labels match the existing mongoose `catchSchema` enum so DB writes
// stay backward-compatible during the cutover.
export const RARITY_LABEL: Record<Rarity, "basic" | "rare" | "monster" | "legendary" | "apex"> = {
  [Rarity.Basic]: "basic",
  [Rarity.Rare]: "rare",
  [Rarity.Monster]: "monster",
  [Rarity.Legendary]: "legendary",
  [Rarity.Apex]: "apex",
};

// Phase 1.3 will shrink catchSchema.zone enum to just ["open_sea"].
export const ZONE_OPEN_SEA = "open_sea" as const;

export interface CastRoll {
  rarity: Rarity;
  /**
   * SPECIES_TABLE index for non-apex casts. -1 when apex rolled — the rolled
   * fish is identified by `apexFishId` instead, since the apex catalog lives
   * in MongoDB and isn't represented in SPECIES_TABLE.
   */
  speciesId: number;
  /** ApexFish ObjectId (24-char hex). Set only when rarity === Apex. */
  apexFishId: string | null;
  /** Display name (FISH_SPECIES for non-apex, ApexFish.name for apex). */
  speciesName: string;
  weightHg: number;
  greenZoneStart: number;
  greenZoneWidth: number;
  mechanic: Mechanic;
}

export interface ApexFishRollEntry {
  /** ApexFish ObjectId, 24-char hex. */
  apexFishId: string;
  name: string;
  weightMinHg: number;
  weightMaxHg: number;
}

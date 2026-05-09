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
  speciesId: number;
  weightHg: number;
  greenZoneStart: number;
  greenZoneWidth: number;
  mechanic: Mechanic;
}

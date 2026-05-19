// Numeric values match legacy on-chain repr(u8) for cross-decode compat.

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

/** Matches catchSchema.rarity enum. */
export const RARITY_LABEL: Record<Rarity, "basic" | "rare" | "monster" | "legendary" | "apex"> = {
  [Rarity.Basic]: "basic",
  [Rarity.Rare]: "rare",
  [Rarity.Monster]: "monster",
  [Rarity.Legendary]: "legendary",
  [Rarity.Apex]: "apex",
};

export const ZONE_OPEN_SEA = "open_sea" as const;

export interface CastRoll {
  rarity: Rarity;
  /** -1 when apex rolled (use apexFishId). */
  speciesId: number;
  /** Set only when rarity === Apex. */
  apexFishId: string | null;
  speciesName: string;
  weightHg: number;
  greenZoneStart: number;
  greenZoneWidth: number;
  mechanic: Mechanic;
}

export interface ApexFishRollEntry {
  apexFishId: string;
  name: string;
  weightMinHg: number;
  weightMaxHg: number;
}

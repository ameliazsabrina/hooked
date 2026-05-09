export enum FishRarity {
  Basic = "basic",
  Rare = "rare",
  Monster = "monster",
  Legendary = "legendary",
  Apex = "apex",
}

export const SCORE_MULTIPLIERS: Record<FishRarity, number> = {
  [FishRarity.Basic]: 1,
  [FishRarity.Rare]: 1.5,
  [FishRarity.Monster]: 2.5,
  [FishRarity.Legendary]: 3.5,
  [FishRarity.Apex]: 4,
};

export const RARITY_COLORS: Record<FishRarity, string> = {
  [FishRarity.Basic]: "#6b7a86",
  [FishRarity.Rare]: "#4a9cc9",
  [FishRarity.Monster]: "#b794ff",
  [FishRarity.Legendary]: "#ffd34e",
  [FishRarity.Apex]: "#e0564d",
};

export enum FishingZone {
  Shore = "shore",
  Coastal = "coastal",
  OpenSea = "open_sea",
  Abyss = "abyss",
}

export type InteractionMechanic = "timing_bar" | "circular_tap";

// Basic/Rare/Monster → vertical timing bar; Legendary/Apex → circular tap.
// Per-tier parameters live in `difficulty.ts` (VERTICAL_BASE / CIRCULAR_BASE).
export function getInteractionMechanic(
  rarity: FishRarity,
): InteractionMechanic {
  if (rarity === FishRarity.Legendary || rarity === FishRarity.Apex) {
    return "circular_tap";
  }
  return "timing_bar";
}

/**
 * @deprecated Legacy shim. Use `VERTICAL_BASE` from `difficulty.ts` or the
 * per-cast `DifficultyProfile` delivered by the server. Kept only so existing
 * callers compile during the difficulty-system migration.
 */
export const TIMING_BAR_CONFIG: Record<
  FishRarity,
  { greenWidth: number; durationMs: number }
> = {
  [FishRarity.Basic]: { greenWidth: 0.22, durationMs: 1600 },
  [FishRarity.Rare]: { greenWidth: 0.18, durationMs: 1400 },
  [FishRarity.Monster]: { greenWidth: 0.15, durationMs: 1200 },
  [FishRarity.Legendary]: { greenWidth: 0.2, durationMs: 1500 },
  [FishRarity.Apex]: { greenWidth: 0.2, durationMs: 1500 },
};

/**
 * @deprecated Legacy shim. Use `CIRCULAR_BASE` from `difficulty.ts` or the
 * per-cast `DifficultyProfile` delivered by the server. Monster has been moved
 * to the vertical mechanic — the Monster entry here is retained only so older
 * server/client call sites type-check during migration.
 */
export const CIRCULAR_TAP_CONFIG = {
  [FishRarity.Monster]: {
    taps: 3,
    missesAllowed: 0,
    speedMultiplier: 1.0,
    arcSize: 0.28,
  },
  [FishRarity.Legendary]: {
    taps: 5,
    missesAllowed: 0,
    speedMultiplier: 1.4,
    arcSize: 0.22,
  },
  [FishRarity.Apex]: {
    taps: 5,
    missesAllowed: 0,
    speedMultiplier: 1.8,
    arcSize: 0.15,
  },
} as const;

/**
 * @deprecated Use `CastDifficultyPayload` from `difficulty.ts` — the server
 * now sends a full `DifficultyProfile` instead of this narrow subset.
 */
export interface CircularTapClientConfig {
  targets: number[];
  arcSize: number;
  tapsRequired: number;
  missesAllowed: number;
  speedMultiplier: number;
}

import { FishRarity } from "./fish.js";

export type RotationPattern = "linear" | "reversing" | "burst";

// PRD §6.4. Until `FishSpecies` carries a pattern field, `buildDifficultyProfile`
// picks one deterministically from a rarity-indexed pool using the cast seed.
export type FishPattern = "mixed" | "dart" | "smooth" | "sinker" | "floater";

export interface VerticalProfile {
  kind: "vertical";
  movementSpeed: number;
  acceleration: number;
  directionChangeHz: number;
  fakeOutChance: number;
  fakeOutMagnitude: number;
  /** Max target offset from current position per dir-change, in simulation units. */
  oscillationMagnitude: number;
  pattern: FishPattern;
  catchZoneWidth: number;
  fillPerTickHit: number;
  drainPerTickMiss: number;
  inertia: number;
  durationMs: number;
  /** PRD §6.3 — base green-bar height in px (pre rod-bonus); 60–140px per rarity. */
  greenBarHeightBase: number;
}

export interface CircularProfile {
  kind: "circular";
  indicatorSpeed: number;
  arcSize: number;
  rotationPattern: RotationPattern;
  timingWindowMs: number;
  tapsRequired: number;
  missesAllowed: number;
  missPenalty: number;
  tensionPerMiss: number;
  recoveryPerHit: number;
  phaseEscalation: boolean;
  durationMs: number;
}

export type DifficultyProfile = VerticalProfile | CircularProfile;

export type VerticalTier = FishRarity.Basic | FishRarity.Rare | FishRarity.Monster;
export type CircularTier = FishRarity.Legendary | FishRarity.Apex;

// Baseline values keyed to playtest table: Basic 0.5× / Rare 1.0× / Monster 1.5× of a 42-unit/sec reference.
export const VERTICAL_BASE: Record<VerticalTier, VerticalProfile> = {
  [FishRarity.Basic]: {
    kind: "vertical",
    movementSpeed: 28,
    acceleration: 260,
    directionChangeHz: 0.7,
    fakeOutChance: 0.05,
    fakeOutMagnitude: 20,
    oscillationMagnitude: 90,
    pattern: "mixed",
    catchZoneWidth: 0.32,
    fillPerTickHit: 0.02,
    drainPerTickMiss: 0.006,
    inertia: 1,
    durationMs: 9000,
    greenBarHeightBase: 95,
  },
  [FishRarity.Rare]: {
    kind: "vertical",
    movementSpeed: 52,
    acceleration: 450,
    directionChangeHz: 1.2,
    fakeOutChance: 0.15,
    fakeOutMagnitude: 55,
    oscillationMagnitude: 150,
    pattern: "mixed",
    catchZoneWidth: 0.22,
    fillPerTickHit: 0.018,
    drainPerTickMiss: 0.012,
    inertia: 1,
    durationMs: 8000,
    greenBarHeightBase: 70,
  },
  [FishRarity.Monster]: {
    kind: "vertical",
    movementSpeed: 85,
    acceleration: 780,
    directionChangeHz: 2.2,
    fakeOutChance: 0.28,
    fakeOutMagnitude: 95,
    oscillationMagnitude: 230,
    pattern: "mixed",
    catchZoneWidth: 0.18,
    fillPerTickHit: 0.015,
    drainPerTickMiss: 0.022,
    inertia: 1,
    durationMs: 7500,
    greenBarHeightBase: 45,
  },
};

const VERTICAL_PATTERN_POOL: Record<VerticalTier, FishPattern[]> = {
  [FishRarity.Basic]: ["smooth", "sinker", "floater"],
  [FishRarity.Rare]: ["mixed", "sinker", "floater"],
  [FishRarity.Monster]: ["dart", "mixed"],
};

// Secondary timing-bar phase following a successful circular tap on legendary/apex hooks.
// Calibrated to extend the encounter without doubling failure rate.
export const LEGENDARY_VERTICAL_BASE: Record<CircularTier, VerticalProfile> = {
  [FishRarity.Legendary]: {
    kind: "vertical",
    movementSpeed: 78,
    acceleration: 720,
    directionChangeHz: 2.0,
    fakeOutChance: 0.22,
    fakeOutMagnitude: 80,
    oscillationMagnitude: 210,
    pattern: "mixed",
    catchZoneWidth: 0.2,
    fillPerTickHit: 0.018,
    drainPerTickMiss: 0.018,
    inertia: 1,
    durationMs: 8000,
    greenBarHeightBase: 60,
  },
  [FishRarity.Apex]: {
    kind: "vertical",
    movementSpeed: 95,
    acceleration: 880,
    directionChangeHz: 2.6,
    fakeOutChance: 0.32,
    fakeOutMagnitude: 105,
    oscillationMagnitude: 260,
    pattern: "dart",
    catchZoneWidth: 0.16,
    fillPerTickHit: 0.016,
    drainPerTickMiss: 0.024,
    inertia: 1,
    durationMs: 8500,
    greenBarHeightBase: 50,
  },
};

export const CIRCULAR_BASE: Record<CircularTier, CircularProfile> = {
  [FishRarity.Legendary]: {
    kind: "circular",
    indicatorSpeed: 6.4,
    arcSize: 0.11,
    rotationPattern: "reversing",
    timingWindowMs: 120,
    tapsRequired: 5,
    missesAllowed: 0,
    missPenalty: 0.3,
    tensionPerMiss: 0.4,
    recoveryPerHit: 0.05,
    phaseEscalation: false,
    durationMs: 11000,
  },
  [FishRarity.Apex]: {
    kind: "circular",
    indicatorSpeed: 9.2,
    arcSize: 0.07,
    rotationPattern: "burst",
    timingWindowMs: 70,
    tapsRequired: 9,
    missesAllowed: 0,
    missPenalty: 0.5,
    tensionPerMiss: 0.6,
    recoveryPerHit: 0.03,
    phaseEscalation: true,
    durationMs: 13000,
  },
};

export interface DifficultyModifiers {
  variance: number;
  streakBonus: number;
  poolTierBonus: number;
  sessionTimeBonus: number;
}

export interface DifficultyContext {
  streak: number;
  poolTier: number;
  sessionElapsedMs: number;
}

export const VARIANCE_RANGE = 0.1;
export const MAX_STREAK_BONUS = 0.15;
export const MAX_POOL_TIER_BONUS = 0.2;
export const MAX_SESSION_TIME_BONUS = 0.1;
export const SESSION_TIME_RAMP_MS = 20 * 60 * 1000;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function computeModifiers(ctx: DifficultyContext): Omit<DifficultyModifiers, "variance"> {
  return {
    streakBonus: Math.min(MAX_STREAK_BONUS, ctx.streak * 0.02),
    poolTierBonus: Math.min(MAX_POOL_TIER_BONUS, ctx.poolTier * 0.05),
    sessionTimeBonus: Math.min(
      MAX_SESSION_TIME_BONUS,
      (ctx.sessionElapsedMs / SESSION_TIME_RAMP_MS) * MAX_SESSION_TIME_BONUS,
    ),
  };
}

function varianceFromSeed(seed: number): number {
  const r = mulberry32(seed)();
  return (r * 2 - 1) * VARIANCE_RANGE;
}

function scale(base: number, factor: number): number {
  return base * factor;
}

function isVerticalTier(r: FishRarity): r is VerticalTier {
  return r === FishRarity.Basic || r === FishRarity.Rare || r === FishRarity.Monster;
}

function isCircularTier(r: FishRarity): r is CircularTier {
  return r === FishRarity.Legendary || r === FishRarity.Apex;
}

export function buildDifficultyProfile(
  rarity: FishRarity,
  seed: number,
  mods: Omit<DifficultyModifiers, "variance">,
): DifficultyProfile {
  const variance = varianceFromSeed(seed);
  const harder = 1 + variance + mods.streakBonus + mods.poolTierBonus + mods.sessionTimeBonus;
  const easier = 1 / harder;

  if (isVerticalTier(rarity)) {
    const b = VERTICAL_BASE[rarity];
    // XOR constant keeps pattern selection independent of the variance draw on the same seed.
    const patternRng = mulberry32((seed >>> 0) ^ 0xa5a5a5a5);
    const pool = VERTICAL_PATTERN_POOL[rarity];
    const pattern = pool[Math.floor(patternRng() * pool.length)];
    return {
      ...b,
      movementSpeed: scale(b.movementSpeed, harder),
      acceleration: scale(b.acceleration, harder),
      directionChangeHz: scale(b.directionChangeHz, harder),
      fakeOutChance: Math.min(1, b.fakeOutChance * harder),
      oscillationMagnitude: scale(b.oscillationMagnitude, harder),
      pattern,
      catchZoneWidth: Math.max(0.05, scale(b.catchZoneWidth, easier)),
      drainPerTickMiss: scale(b.drainPerTickMiss, harder),
      durationMs: Math.round(scale(b.durationMs, easier)),
    };
  }

  if (isCircularTier(rarity)) {
    const b = CIRCULAR_BASE[rarity];
    return {
      ...b,
      indicatorSpeed: scale(b.indicatorSpeed, harder),
      arcSize: Math.max(0.05, scale(b.arcSize, easier)),
      timingWindowMs: Math.max(60, Math.round(scale(b.timingWindowMs, easier))),
      tensionPerMiss: Math.min(1, b.tensionPerMiss * harder),
    };
  }

  throw new Error(`buildDifficultyProfile: unknown rarity ${rarity}`);
}

export function buildLegendaryVerticalProfile(
  rarity: CircularTier,
  seed: number,
  mods: Omit<DifficultyModifiers, "variance">,
): VerticalProfile {
  const variance = varianceFromSeed(seed ^ 0x5a5a5a5a);
  const harder =
    1 + variance + mods.streakBonus + mods.poolTierBonus + mods.sessionTimeBonus;
  const easier = 1 / harder;
  const b = LEGENDARY_VERTICAL_BASE[rarity];
  return {
    ...b,
    movementSpeed: scale(b.movementSpeed, harder),
    acceleration: scale(b.acceleration, harder),
    directionChangeHz: scale(b.directionChangeHz, harder),
    fakeOutChance: Math.min(1, b.fakeOutChance * harder),
    oscillationMagnitude: scale(b.oscillationMagnitude, harder),
    catchZoneWidth: Math.max(0.05, scale(b.catchZoneWidth, easier)),
    drainPerTickMiss: scale(b.drainPerTickMiss, harder),
    durationMs: Math.round(scale(b.durationMs, easier)),
  };
}

export interface CastDifficultyPayload {
  seed: number;
  mods: Omit<DifficultyModifiers, "variance">;
  profile: DifficultyProfile;
}

export interface TapResult {
  targetAngle: number;
  tapAngle: number;
  hit: boolean;
  /**
   * Per-tap-local elapsed time (ms since the renderer started rotating this tap's indicator).
   * Required for server-side replay validation via `validateCircularTapTaps` — must use
   * `performance.now()` deltas, not `Date.now()`, for bit-for-bit replay parity.
   */
  msSinceTapStart: number;
}

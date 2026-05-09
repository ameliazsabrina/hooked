import type { VerticalProfile } from "./difficulty.js";
import { getBait } from "./equipment.js";

export const GRAVITY = 900;
export const BOOST = 1700;
export const MAX_VELOCITY = 950;
export const BAR_MIN_Y = 0;
export const BAR_MAX_Y = 800;
export const FILL_RATE_PER_SEC = 22 / 100;
// Fly (no-bait) baseline: fill:drain = 1 : 1.9. Higher-tier baits scale this
// down via state.drainMultiplier (1 - bait.progressDrainReduction).
export const BASE_DRAIN_RATE_PER_SEC = (22 / 100) * 1.9;
export const TICK_HZ = 30;
export const TICK_DT = 1 / TICK_HZ;
export const INPUT_SAMPLE_HZ = 20;
export const CHEST_BASE_SPAWN_CHANCE = 0.15;
export const CHEST_HOLD_SECONDS_REQUIRED = 2;
export const GREEN_BAR_HEIGHT_BASE = 60;
export const ROD_GREEN_BAR_STEP_PX = 10;
// Hit-detection radius in physics units; matches sprite (~44px in 460px track / 800 units).
export const FISH_HIT_RADIUS = 38;

export interface FishingGameState {
  barY: number;
  barVelocity: number;
  fishY: number;
  fishVelocity: number;
  fishTargetY: number;
  fishLastDirChangeAt: number;
  // Sampled seconds until the next dir-change. 0 means "roll on next tick".
  fishDirInterval: number;
  progress: number;
  timeInBar: number;
  totalTime: number;
  distanceFromCenterSum: number;
  sampleCount: number;
  chest: ChestState;
  rngState: number;
  // 1 - bait.progressDrainReduction. Set at session init from baitSlug.
  drainMultiplier: number;
}

export interface ChestState {
  spawned: boolean;
  y: number;
  holdSeconds: number;
  collected: boolean;
}

export interface InputSample {
  sessionId: string;
  sampleIndex: number;
  clientTimestamp: number;
  isHolding: boolean;
}

export interface FishingGameSessionParams {
  sessionId: string;
  verticalProfile: VerticalProfile;
  greenBarHeight: number;
  rodTier: number;
  luckyLureTier: number;
  baitSlug?: string;
  rngSeed: number;
  startingBarY: number;
  startingFishY: number;
  chestSpawned: boolean;
  chestY: number;
  startedAt: number;
}

export interface FishingGameMetrics {
  durationMs: number;
  timeInBarPct: number;
  avgDistanceFromCenter: number;
  sampleCount: number;
  chestCollected: boolean;
  timeEfficiency: number;
  centerAccuracy: number;
}

export interface FishingGameOutcome {
  win: boolean;
  metrics: FishingGameMetrics;
}

function mulberry32Next(state: number): { value: number; next: number } {
  let a = (state + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, next: a };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function resolveGreenBarHeight(
  profile: VerticalProfile,
  rodTier: number,
): number {
  const base = profile.greenBarHeightBase ?? GREEN_BAR_HEIGHT_BASE;
  const rodBonus = rodTier * ROD_GREEN_BAR_STEP_PX;
  return clamp(base + rodBonus, 40, BAR_MAX_Y);
}

// Acceleration-based bar: hold = upward boost, release = gravity. Pulse-tap
// rhythm is required to track the fish — holding parks it at the top.
export function stepPhysics(
  state: FishingGameState,
  isHolding: boolean,
  dt: number,
): void {
  const accel = isHolding ? -BOOST : GRAVITY;
  state.barVelocity = clamp(
    state.barVelocity + accel * dt,
    -MAX_VELOCITY,
    MAX_VELOCITY,
  );
  const nextY = state.barY + state.barVelocity * dt;
  if (nextY <= BAR_MIN_Y) {
    state.barY = BAR_MIN_Y;
    if (state.barVelocity < 0) state.barVelocity = 0;
  } else if (nextY >= BAR_MAX_Y) {
    state.barY = BAR_MAX_Y;
    if (state.barVelocity > 0) state.barVelocity = 0;
  } else {
    state.barY = nextY;
  }
}

// Target never chosen within this of the top/bottom wall.
const FISH_EDGE_BUFFER = 40;
// Constant upward drift as a fraction of movementSpeed — preserves the
// "fish eventually escapes if you fail to catch" mechanic.
const FISH_DRIFT_FRACTION = 0.35;
// Proportional-steering gain: converts target-offset (units) into desired velocity.
const FISH_STEERING_STIFFNESS = 7;
// Max oscillation speed as a multiple of movementSpeed.
const FISH_MAX_SPEED_MULT = 2.8;
// Per-tick velocity noise amplitude, as a multiple of oscillationMagnitude per second.
// Adds high-frequency trembling on top of target-seeking for the jittery feel.
const FISH_JITTER_AMP_RATE = 2.0;

export function stepFishPosition(
  state: FishingGameState,
  profile: VerticalProfile,
  dt: number,
): void {
  const baseInterval =
    profile.directionChangeHz > 0 ? 1 / profile.directionChangeHz : 1.5;
  const elapsed = state.totalTime - state.fishLastDirChangeAt;
  const usableTop = BAR_MIN_Y + FISH_EDGE_BUFFER;
  const usableBot = BAR_MAX_Y - FISH_EDGE_BUFFER;
  const usableRange = usableBot - usableTop;

  if (state.fishDirInterval === 0 || elapsed >= state.fishDirInterval) {
    const r1 = mulberry32Next(state.rngState);
    const r2 = mulberry32Next(r1.next);
    state.rngState = r2.next;

    state.fishDirInterval = baseInterval * (0.7 + 0.6 * r1.value);
    state.fishLastDirChangeAt = state.totalTime;

    // Pattern-tilted full-range target. Y=0 is top, Y=BAR_MAX_Y is bottom,
    // so sinker skews toward 1, floater toward 0.
    let tilt: number;
    switch (profile.pattern) {
      case "sinker":
        tilt = Math.sqrt(r2.value);
        break;
      case "floater":
        tilt = r2.value * r2.value;
        break;
      case "smooth":
        tilt = 0.15 + r2.value * 0.7;
        break;
      case "dart":
      case "mixed":
      default:
        tilt = r2.value;
        break;
    }
    state.fishTargetY = usableTop + tilt * usableRange;

    // Fake-out: an occasional velocity impulse for sharp darts.
    if (profile.fakeOutChance > 0) {
      const r3 = mulberry32Next(state.rngState);
      state.rngState = r3.next;
      if (r3.value < profile.fakeOutChance) {
        const r4 = mulberry32Next(state.rngState);
        state.rngState = r4.next;
        state.fishVelocity +=
          (r4.value < 0.5 ? -1 : 1) * profile.fakeOutMagnitude;
      }
    }
  }

  // Steer toward target, capped at a multiple of movementSpeed.
  const toTarget = state.fishTargetY - state.fishY;
  const maxSpeed = profile.movementSpeed * FISH_MAX_SPEED_MULT;
  const desired = clamp(
    toTarget * FISH_STEERING_STIFFNESS,
    -maxSpeed,
    maxSpeed,
  );
  const accel = profile.acceleration > 0 ? profile.acceleration : maxSpeed * 4;
  const dv = clamp(desired - state.fishVelocity, -accel * dt, accel * dt);
  state.fishVelocity += dv;

  // Per-tick velocity jitter — rarity scales via oscillationMagnitude.
  if (profile.oscillationMagnitude > 0) {
    const rJ = mulberry32Next(state.rngState);
    state.rngState = rJ.next;
    const jitterAmp = profile.oscillationMagnitude * FISH_JITTER_AMP_RATE;
    state.fishVelocity += (rJ.value - 0.5) * 2 * jitterAmp * dt;
  }

  // Upward drift. Y=0 is the top (escape zone), so drift is negative.
  state.fishVelocity -= profile.movementSpeed * FISH_DRIFT_FRACTION * dt;

  // Integrate and absorb wall hits.
  let nextY = state.fishY + state.fishVelocity * dt;
  if (nextY <= BAR_MIN_Y) {
    nextY = BAR_MIN_Y;
    if (state.fishVelocity < 0) state.fishVelocity = 0;
  } else if (nextY >= BAR_MAX_Y) {
    nextY = BAR_MAX_Y;
    if (state.fishVelocity > 0) state.fishVelocity = 0;
  }
  state.fishY = nextY;
}

export function isFishInGreenBar(
  barY: number,
  fishY: number,
  greenBarHeight: number,
): boolean {
  const halfH = greenBarHeight / 2 + FISH_HIT_RADIUS;
  return fishY >= barY - halfH && fishY <= barY + halfH;
}

export function stepProgress(
  state: FishingGameState,
  greenBarHeight: number,
  dt: number,
): void {
  const inBar = isFishInGreenBar(state.barY, state.fishY, greenBarHeight);
  if (inBar) {
    state.progress = clamp(state.progress + FILL_RATE_PER_SEC * dt, 0, 1);
    state.timeInBar += dt;
  } else {
    const drain = BASE_DRAIN_RATE_PER_SEC * (state.drainMultiplier ?? 1);
    state.progress = clamp(state.progress - drain * dt, 0, 1);
  }
  state.totalTime += dt;
  state.distanceFromCenterSum += Math.abs(state.fishY - state.barY) / BAR_MAX_Y;
  state.sampleCount += 1;
}

export function stepChest(
  state: FishingGameState,
  greenBarHeight: number,
  dt: number,
): void {
  if (!state.chest.spawned || state.chest.collected) return;
  const halfH = greenBarHeight / 2;
  const overlapping =
    state.chest.y >= state.barY - halfH && state.chest.y <= state.barY + halfH;
  if (overlapping) {
    state.chest.holdSeconds += dt;
    if (state.chest.holdSeconds >= CHEST_HOLD_SECONDS_REQUIRED) {
      state.chest.collected = true;
    }
  }
}

export function stepAll(
  state: FishingGameState,
  profile: VerticalProfile,
  greenBarHeight: number,
  isHolding: boolean,
  dt: number,
): void {
  stepPhysics(state, isHolding, dt);
  stepFishPosition(state, profile, dt);
  stepProgress(state, greenBarHeight, dt);
  stepChest(state, greenBarHeight, dt);
}

export type FishingGameTerminal = "caught" | "escaped" | null;

// If progress is this close to 1.0, treat the catch as earned — don't let a
// one-frame fish dart to the top flip the outcome to escaped. Fish can still
// "get away" honestly once progress drains back below this value.
const NEAR_WIN_GRACE = 0.85;

export function terminalState(
  state: FishingGameState,
  _greenBarHeight: number,
): FishingGameTerminal {
  if (state.progress >= 1) return "caught";
  if (state.fishY <= BAR_MIN_Y + 1 && state.progress < NEAR_WIN_GRACE) {
    return "escaped";
  }
  return null;
}

export function computeMetrics(
  state: FishingGameState,
  profile: VerticalProfile,
): FishingGameMetrics {
  const durationMs = state.totalTime * 1000;
  const timeInBarPct = state.totalTime > 0 ? state.timeInBar / state.totalTime : 0;
  const avgDistanceFromCenter =
    state.sampleCount > 0 ? state.distanceFromCenterSum / state.sampleCount : 1;
  const optimalMs = profile.durationMs;
  const timeEfficiency = clamp(optimalMs / Math.max(1, durationMs), 0, 1.5);
  const centerAccuracy = clamp(1 - avgDistanceFromCenter, 0, 1);
  return {
    durationMs,
    timeInBarPct,
    avgDistanceFromCenter,
    sampleCount: state.sampleCount,
    chestCollected: state.chest.collected,
    timeEfficiency,
    centerAccuracy,
  };
}

export function initialFishingGameState(params: FishingGameSessionParams): FishingGameState {
  const bait = getBait(params.baitSlug);
  return {
    barY: params.startingBarY,
    barVelocity: 0,
    fishY: params.startingFishY,
    fishVelocity: 0,
    fishTargetY: params.startingFishY,
    fishLastDirChangeAt: 0,
    fishDirInterval: 0,
    progress: 0.05,
    timeInBar: 0,
    totalTime: 0,
    distanceFromCenterSum: 0,
    sampleCount: 0,
    chest: {
      spawned: params.chestSpawned,
      y: params.chestY,
      holdSeconds: 0,
      collected: false,
    },
    rngState: params.rngSeed >>> 0,
    drainMultiplier: 1 - bait.progressDrainReduction,
  };
}

export function rollChestSpawn(seed: number, chestBonus: number): { spawned: boolean; y: number; next: number } {
  const r1 = mulberry32Next(seed);
  const r2 = mulberry32Next(r1.next);
  return {
    spawned: r1.value < CHEST_BASE_SPAWN_CHANCE + chestBonus,
    y: BAR_MIN_Y + 40 + r2.value * (BAR_MAX_Y - 80),
    next: r2.next,
  };
}

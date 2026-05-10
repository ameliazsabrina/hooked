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
// Authoritative physics step rate. MUST be identical on client and server:
// `stepFishPosition` consumes the shared `mulberry32` RNG state once per
// step (jitter) plus on each direction change, so any rate divergence makes
// the fish swim down different trajectories on the two sides — the player
// tracks what they see locally while the server's fish is elsewhere, and
// every cast resolves as escaped because progress never fills.
export const PHYSICS_FIXED_DT = 1 / 60;
// Cap on how much wall-time the accumulator can absorb in a single tick,
// so a long pause / GC doesn't dump a huge backlog of physics steps in one
// frame. Mirrors the client's local cap.
export const PHYSICS_MAX_STEP_ACCUM = 0.1;
export const INPUT_SAMPLE_HZ = 20;
// Lag-comp buffer: simulation time trails wall time by this much on BOTH
// sides. Inputs carry a wallclock `t_ms`; both client and server convert
// `t_ms` → `simTimeS` against the *same* origin (the first input's `t_ms`),
// then step physics up to `wallSinceOriginS - INPUT_DELAY_S`. Because the
// input timeline is the only non-deterministic axis (fish RNG is seeded),
// aligning the timeline aligns both simulations bit-for-bit.
//
// Sized to absorb regional one-way latency + a tick boundary. Smaller =
// snappier visual response but more samples land "late" (after their step
// has already been processed) and get clamped forward, reintroducing drift.
// Larger = wider safety margin but more perceived input lag.
export const INPUT_DELAY_MS = 60;
export const INPUT_DELAY_S = INPUT_DELAY_MS / 1000;

export interface TimedInput {
  /** Seconds since the per-cast simulation origin (first input's `t_ms`). */
  simTimeS: number;
  held: boolean;
}

/**
 * Look up the input that was active at `simTimeS` from a history sorted by
 * ascending `simTimeS`. Returns the `held` value of the most recent input
 * with `simTimeS <= queriedSimTimeS`, or `defaultHeld` if none.
 *
 * Uses a moving cursor that the caller advances monotonically to keep
 * lookups O(1) amortized when stepping forward through simulation time.
 * The cursor points at the index of the input whose `simTimeS <= queried`
 * with the largest such simTime — i.e. the active one. Returns the new
 * cursor so the caller can thread it forward across steps.
 */
export function lookupActiveInput(
  history: ReadonlyArray<TimedInput>,
  queriedSimTimeS: number,
  cursor: number,
  defaultHeld: boolean,
): { held: boolean; cursor: number } {
  let i = cursor < 0 ? -1 : Math.min(cursor, history.length - 1);
  while (i + 1 < history.length && history[i + 1]!.simTimeS <= queriedSimTimeS) {
    i += 1;
  }
  if (i < 0) return { held: defaultHeld, cursor: -1 };
  return { held: history[i]!.held, cursor: i };
}
export const CHEST_BASE_SPAWN_CHANCE = 0.15;
export const CHEST_HOLD_SECONDS_REQUIRED = 2;
export const GREEN_BAR_HEIGHT_BASE = 60;
export const ROD_GREEN_BAR_STEP_PX = 10;
// Hit-detection radius in physics units; matches sprite (~44px in 460px track / 800 units).
export const FISH_HIT_RADIUS = 38;

export interface FishingGameState {
  barY: number;
  barVelocity: number;
  /** Raw fish position (physics-driven, with oscillation noise). */
  fishY: number;
  /**
   * Smoothed fish position used by progress and terminal-state checks AND
   * pushed to the client for display. Server and client both score against
   * THIS value, not the raw `fishY`, so the in-bar predicate can never
   * disagree across the wire (the previous design had the client lerping
   * `fishY` toward server and computing local progress against the lerped
   * value, while the server scored against raw `fishY` — that ~135ms gap
   * caused local progress to fill while server progress stayed at 0).
   */
  fishYDisplay: number;
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

/**
 * Exponential-smoothing rate (1/sec) applied to `fishY → fishYDisplay`.
 * Filters per-tick oscillation jitter so both sides see a stable "playable"
 * fish trajectory. Lag-to-95% ≈ 3 / rate seconds.
 */
export const FISH_DISPLAY_SMOOTHING_PER_SEC = 22;

/**
 * Precomputed smoothing factor for the hot path (`dt === PHYSICS_FIXED_DT`).
 * `Math.exp` is NOT correctly-rounded by IEEE 754 so its result can differ
 * by ~1 ULP between V8 (Node, Chrome) and other engines (JavaScriptCore,
 * SpiderMonkey). Calling it per step means that ULP error accumulates into
 * client/server fishYDisplay drift. By computing it once at module init we
 * fold any cross-engine difference into a single constant — the per-step
 * arithmetic is then pure IEEE multiply/add, which IS deterministic, so
 * fishYDisplay stays bit-equal across the wire over a 30s session.
 */
export const FISH_DISPLAY_SMOOTHING_K_FIXED =
  1 - Math.exp(-FISH_DISPLAY_SMOOTHING_PER_SEC * PHYSICS_FIXED_DT);

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
  // Score against the SMOOTHED fish position (`fishYDisplay`), not the raw
  // `fishY`. Both client and server render `fishYDisplay` and use it here,
  // which means the in-bar predicate can never disagree across the wire.
  const inBar = isFishInGreenBar(
    state.barY,
    state.fishYDisplay,
    greenBarHeight,
  );
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
  // Smooth the displayed fish position toward the raw physics value. The
  // smoothed value is what stepProgress and terminalState read, and what the
  // gateway pushes over the wire — keeping client visuals and server scoring
  // bit-aligned on a single fish trajectory. For the hot path we use the
  // precomputed K to keep cross-engine arithmetic deterministic; arbitrary
  // dt callers fall back to per-call exp (off the wire path).
  const smoothK =
    dt === PHYSICS_FIXED_DT
      ? FISH_DISPLAY_SMOOTHING_K_FIXED
      : 1 - Math.exp(-FISH_DISPLAY_SMOOTHING_PER_SEC * dt);
  state.fishYDisplay += (state.fishY - state.fishYDisplay) * smoothK;
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
  // Use the smoothed fish position so a one-frame oscillation noise spike
  // can't falsely trigger the "escape" verdict.
  if (state.fishYDisplay <= BAR_MIN_Y + 1 && state.progress < NEAR_WIN_GRACE) {
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
    fishYDisplay: params.startingFishY,
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

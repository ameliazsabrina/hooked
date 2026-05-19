import { FishRarity } from "./fish.js";
import {
  CIRCULAR_BASE,
  type CircularProfile,
  type RotationPattern,
} from "./difficulty.js";

// Spinner physics — single source of truth shared by the client renderer and the
// server replay validator. Changes to indicator motion or target layout MUST land
// here, or honest players get false misses server-side.

export const BASE_ORBIT_MS = 1200;
export const AUTO_MISS_REVOLUTIONS = 2.0;
export const PHASE_ESCALATION_STEP = 0.08;

/**
 * Per-tap target angles for a circular-tap encounter. Deterministic from
 * `(castCount, taps)`; `_rarity` is reserved for future per-rarity variation.
 * Golden-angle 137.5° between casts, 72° between taps within a cast.
 */
export function buildCircularTapTargets(
  _rarity: FishRarity,
  castCount: number,
  taps: number,
): number[] {
  const targets: number[] = [];
  for (let i = 0; i < taps; i++) {
    const angle = ((castCount * 137.5 + i * 72.0) % 360) * (Math.PI / 180);
    targets.push(angle);
  }
  return targets;
}

export function shortestAngularDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % (2 * Math.PI);
  return diff > Math.PI ? 2 * Math.PI - diff : diff;
}

/**
 * Indicator angle at `elapsedMs` into the current tap. All patterns average the
 * same net speed — difficulty comes from predictability, not raw pace.
 */
export function angleForPattern(
  pattern: RotationPattern,
  speedRadPerSec: number,
  elapsedMs: number,
  tapIndex: number,
): number {
  const t = elapsedMs / 1000;
  switch (pattern) {
    case "linear":
      return (speedRadPerSec * t) % (2 * Math.PI);
    case "reversing": {
      const dir = tapIndex % 2 === 0 ? 1 : -1;
      const raw = dir * speedRadPerSec * t + tapIndex * 0.7;
      const mod = raw % (2 * Math.PI);
      return mod < 0 ? mod + 2 * Math.PI : mod;
    }
    case "burst": {
      const period = 0.6;
      const k = (2 * Math.PI) / period;
      const integral = t - Math.cos(k * t) / k + 1 / k;
      const raw = speedRadPerSec * integral;
      return raw % (2 * Math.PI);
    }
  }
}

/**
 * "Effective" spinner state for a given tap — `phaseEscalation` mutates speed
 * and arc after each successful tap. Server replay must compute this identically.
 */
export interface EffectiveCircularState {
  speedRadPerSec: number;
  arcSize: number;
  tapsRequired: number;
  missesAllowed: number;
  timingWindowMs: number;
  rotationPattern: RotationPattern;
  autoMissMs: number;
}

export function computeEffectiveCircularState(
  profile: CircularProfile,
  escalationStep: number,
): EffectiveCircularState {
  const escFactor = profile.phaseEscalation
    ? 1 + escalationStep * PHASE_ESCALATION_STEP
    : 1;
  const shrinkFactor = profile.phaseEscalation
    ? Math.max(0.5, 1 - escalationStep * PHASE_ESCALATION_STEP)
    : 1;
  const speedRadPerSec = profile.indicatorSpeed * escFactor;
  return {
    speedRadPerSec,
    arcSize: Math.max(0.05, profile.arcSize * shrinkFactor),
    tapsRequired: profile.tapsRequired,
    missesAllowed: profile.missesAllowed,
    timingWindowMs: profile.timingWindowMs,
    rotationPattern: profile.rotationPattern,
    autoMissMs: ((AUTO_MISS_REVOLUTIONS * 2 * Math.PI) / speedRadPerSec) * 1000,
  };
}

/** `msSinceTapStart` is per-tap-local elapsed time, resetting each time the spinner advances. */
export interface CircularTapInput {
  tapIndex: number;
  msSinceTapStart: number;
}

export interface CircularTapOutcome {
  tapIndex: number;
  hit: boolean;
  reason: "ok" | "auto_miss" | "out_of_arc" | "out_of_order" | "bad_timing";
  indicatorAngle: number;
  targetAngle: number;
  angularDistance: number;
}

export interface ValidateCircularTapTapsArgs {
  profile: CircularProfile;
  targets: number[];
  taps: CircularTapInput[];
  /** Slack added to per-tap timing window for network jitter + RAF granularity. Default 60ms. */
  jitterSlackMs?: number;
}

export interface ValidateCircularTapTapsResult {
  hits: number;
  misses: number;
  /** Cleared the encounter: hits satisfy `tapsRequired` AND `misses <= missesAllowed`. */
  passed: boolean;
  perTap: CircularTapOutcome[];
}

const DEFAULT_JITTER_SLACK_MS = 60;

/**
 * Replay each reported tap through the server's spinner physics. Contract:
 *   - Taps processed in submission order; `tapIndex` is only cross-checked, not trusted for order.
 *   - `msSinceTapStart` > `autoMissMs + jitterSlackMs` → auto_miss (renderer would have force-missed).
 *   - After each hit, escalation step increments when `phaseEscalation: true`.
 */
export function validateCircularTapTaps(
  args: ValidateCircularTapTapsArgs,
): ValidateCircularTapTapsResult {
  const slack = args.jitterSlackMs ?? DEFAULT_JITTER_SLACK_MS;
  const perTap: CircularTapOutcome[] = [];
  let hits = 0;
  let misses = 0;
  let escalationStep = 0;

  const baseTapsRequired = args.profile.tapsRequired;
  const baseMissesAllowed = args.profile.missesAllowed;

  for (let i = 0; i < args.taps.length; i++) {
    const tap = args.taps[i];
    const expectedIndex = i;
    const eff = computeEffectiveCircularState(args.profile, escalationStep);

    if (tap.tapIndex !== expectedIndex || tap.tapIndex >= baseTapsRequired) {
      misses++;
      perTap.push({
        tapIndex: tap.tapIndex,
        hit: false,
        reason: "out_of_order",
        indicatorAngle: NaN,
        targetAngle: NaN,
        angularDistance: NaN,
      });
      continue;
    }

    const target = args.targets[tap.tapIndex];
    if (target === undefined) {
      misses++;
      perTap.push({
        tapIndex: tap.tapIndex,
        hit: false,
        reason: "out_of_order",
        indicatorAngle: NaN,
        targetAngle: NaN,
        angularDistance: NaN,
      });
      continue;
    }

    if (
      tap.msSinceTapStart < 0 ||
      tap.msSinceTapStart > eff.autoMissMs + slack
    ) {
      misses++;
      perTap.push({
        tapIndex: tap.tapIndex,
        hit: false,
        reason: "auto_miss",
        indicatorAngle: NaN,
        targetAngle: target,
        angularDistance: NaN,
      });
      continue;
    }

    const indicator = angleForPattern(
      eff.rotationPattern,
      eff.speedRadPerSec,
      tap.msSinceTapStart,
      tap.tapIndex,
    );
    const arcHalf = eff.arcSize * Math.PI;
    const timingSlack =
      (eff.timingWindowMs / 1000) * eff.speedRadPerSec * 0.5;
    const effectiveArcHalf = arcHalf + timingSlack;
    const angularDist = shortestAngularDistance(indicator, target);
    const hit = angularDist <= effectiveArcHalf;

    if (hit) {
      hits++;
      if (args.profile.phaseEscalation) escalationStep++;
      perTap.push({
        tapIndex: tap.tapIndex,
        hit: true,
        reason: "ok",
        indicatorAngle: indicator,
        targetAngle: target,
        angularDistance: angularDist,
      });
    } else {
      misses++;
      perTap.push({
        tapIndex: tap.tapIndex,
        hit: false,
        reason: "out_of_arc",
        indicatorAngle: indicator,
        targetAngle: target,
        angularDistance: angularDist,
      });
    }
  }

  const passed =
    hits >= baseTapsRequired - baseMissesAllowed &&
    misses <= baseMissesAllowed;

  return { hits, misses, passed, perTap };
}

/** Canonical circular state for fish_hooked: CIRCULAR_BASE profile + targets. Throws if rarity is not a circular tier. */
export function buildCircularTapState(
  rarity: FishRarity,
  castCount: number,
): { profile: CircularProfile; targets: number[] } {
  if (rarity !== FishRarity.Legendary && rarity !== FishRarity.Apex) {
    throw new Error(
      `buildCircularTapState: rarity ${rarity} is not a circular tier`,
    );
  }
  const profile = CIRCULAR_BASE[rarity];
  const targets = buildCircularTapTargets(
    rarity,
    castCount,
    profile.tapsRequired,
  );
  return { profile, targets };
}

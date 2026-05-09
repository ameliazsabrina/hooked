import { FishRarity } from "./fish.js";
import {
  CIRCULAR_BASE,
  type CircularProfile,
  type RotationPattern,
} from "./difficulty.js";

// ----------------------------------------------------------------------------
// Spinner physics — single source of truth shared by the client renderer
// (`packages/client/src/components/fishing/circular-tap.tsx`) and the server
// replay validator (`validateCircularTapTaps`). Anything that changes how the
// indicator moves or where targets sit MUST land here so client and server
// stay bit-identical; otherwise honest players will get false misses on the
// server side.
// ----------------------------------------------------------------------------

export const BASE_ORBIT_MS = 1200;
export const AUTO_MISS_REVOLUTIONS = 2.0;
export const PHASE_ESCALATION_STEP = 0.08;

/**
 * Generate the per-tap target angles for a circular-tap encounter. Currently
 * deterministic from `(rarity, taps)` only — `castCount` is a plumbing knob
 * the renderer always passes 0, kept here so we can re-introduce per-cast
 * variation without changing the call shape.
 */
export function buildCircularTapTargets(
  // Reserved for future per-rarity layout variation; currently the layout is
  // determined by `(castCount, taps)` only.
  _rarity: FishRarity,
  castCount: number,
  taps: number,
): number[] {
  // Match the legacy CIRCULAR_TAP_CONFIG shape: deterministic angular layout
  // around the ring keyed off the cast index + tap index. Golden-angle 137.5°
  // spreads adjacent casts; 72° between taps within a cast keeps them visually
  // distinct around the ring.
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
 * Indicator angle at `elapsedMs` into the current tap. All patterns average
 * the same net speed — difficulty comes from predictability, not raw pace.
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
 * The "effective" spinner state for a given tap. The renderer recomputes
 * this per-tap because `phaseEscalation` mutates speed and arc width after
 * each successful tap; the server replay does the same so its indicator
 * angle and arc match the client's exactly at the moment of tap.
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

/** One tap as reported by the client. `msSinceTapStart` is the per-tap-local
 *  elapsed time at the moment the player tapped (resets to 0 each time the
 *  spinner advances to the next tap). */
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
  /** Extra slack added to the per-tap timing window to absorb network jitter
   *  and client RAF granularity. Tunable; default 60ms covers a typical
   *  60Hz frame plus a single round-trip. */
  jitterSlackMs?: number;
}

export interface ValidateCircularTapTapsResult {
  hits: number;
  misses: number;
  /** True when the client cleared the encounter under the rules: enough hits
   *  to satisfy `tapsRequired` AND `misses <= missesAllowed`. */
  passed: boolean;
  perTap: CircularTapOutcome[];
}

const DEFAULT_JITTER_SLACK_MS = 60;

/**
 * Replay each reported tap through the server's copy of the spinner physics
 * and decide pass/fail. The contract:
 *   - taps are processed in submission order; the validator does NOT trust
 *     `tapIndex` for ordering, only for cross-checking against expected.
 *   - a tap whose `msSinceTapStart` exceeds `autoMissMs + jitterSlackMs` for
 *     its tap is treated as auto_miss (the renderer would have force-missed
 *     it locally; an attacker can't claim a hit past the spinner timeout).
 *   - escalation: after each *hit*, `escalationStep` increments when the
 *     profile has `phaseEscalation: true`. Subsequent taps replay against
 *     the updated effective state, matching the renderer.
 */
export function validateCircularTapTaps(
  args: ValidateCircularTapTapsArgs,
): ValidateCircularTapTapsResult {
  const slack = args.jitterSlackMs ?? DEFAULT_JITTER_SLACK_MS;
  const perTap: CircularTapOutcome[] = [];
  let hits = 0;
  let misses = 0;
  let escalationStep = 0;

  // Use the unescalated profile to read tapsRequired / missesAllowed, since
  // those don't change with escalation.
  const baseTapsRequired = args.profile.tapsRequired;
  const baseMissesAllowed = args.profile.missesAllowed;

  for (let i = 0; i < args.taps.length; i++) {
    const tap = args.taps[i];
    const expectedIndex = i;
    const eff = computeEffectiveCircularState(args.profile, escalationStep);

    // Out-of-order or out-of-range tapIndex: treat as miss with a distinct
    // reason so the gateway can log/telemetry it.
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

    // Negative or implausibly-future timestamps are auto_miss. We allow up to
    // autoMissMs + slack: anything past that, the renderer would have
    // force-missed itself.
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

/**
 * Convenience: build the canonical circular state needed by the gateway at
 * fish_hooked time. Returns the rarity's CIRCULAR_BASE profile (the renderer
 * uses this same source) plus the deterministic targets array.
 *
 * Throws if rarity is not a circular tier — caller should gate on mechanic.
 */
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

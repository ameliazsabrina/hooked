import { describe, expect, it } from "vitest";
import {
  CIRCULAR_BASE,
  FishRarity,
  angleForPattern,
  buildCircularTapState,
  computeEffectiveCircularState,
  validateCircularTapTaps,
  type CircularProfile,
} from "@hooked/shared";


function honestTapAt(
  profile: CircularProfile,
  targets: number[],
  tapIndex: number,
  escalationStep: number,
): { tapIndex: number; msSinceTapStart: number } {
  const eff = computeEffectiveCircularState(profile, escalationStep);
  const target = targets[tapIndex];
  if (eff.rotationPattern === "linear") {
    return {
      tapIndex,
      msSinceTapStart: (target / eff.speedRadPerSec) * 1000,
    };
  }
  const arcHalf = eff.arcSize * Math.PI;
  for (let ms = 0; ms <= eff.autoMissMs; ms += 2) {
    const a = angleForPattern(
      eff.rotationPattern,
      eff.speedRadPerSec,
      ms,
      tapIndex,
    );
    const dist = Math.min(
      Math.abs(a - target),
      2 * Math.PI - Math.abs(a - target),
    );
    if (dist <= arcHalf) return { tapIndex, msSinceTapStart: ms };
  }
  throw new Error(
    `honestTapAt: no in-arc time found for tap ${tapIndex} (pattern=${eff.rotationPattern})`,
  );
}

describe("validateCircularTapTaps — honest play passes", () => {
  it("Legendary: every tap on-target → passed=true", () => {
    const { profile, targets } = buildCircularTapState(FishRarity.Legendary, 0);
    const taps = targets.map((_, i) => honestTapAt(profile, targets, i, 0));
    const result = validateCircularTapTaps({ profile, targets, taps });
    expect(result.passed).toBe(true);
    expect(result.misses).toBe(0);
    expect(result.hits).toBe(profile.tapsRequired);
  });

  it("Apex (with phaseEscalation): every tap on-target → passed=true", () => {
    const { profile, targets } = buildCircularTapState(FishRarity.Apex, 0);
    // Walk escalationStep alongside each successful tap, mirroring the
    // renderer's behaviour. honestTapAt needs the same step the validator
    // will see when it gets to that tap.
    const taps: { tapIndex: number; msSinceTapStart: number }[] = [];
    for (let i = 0; i < profile.tapsRequired; i++) {
      taps.push(honestTapAt(profile, targets, i, i));
    }
    const result = validateCircularTapTaps({ profile, targets, taps });
    expect(result.passed).toBe(true);
    expect(result.misses).toBe(0);
    expect(result.hits).toBe(profile.tapsRequired);
  });
});

describe("validateCircularTapTaps — cheat scenarios fail (C-1)", () => {
  it("all-zero timestamps (script that didn't actually tap) → fails", () => {
    // Apex's first target is non-zero (137.5°·0 + 0·72° = 0 — wait, this
    // happens to be 0). Use Legendary which also has target[0]=0 but the
    // remaining targets aren't 0; the indicator won't be at all of them
    // at t=0 simultaneously.
    const { profile, targets } = buildCircularTapState(FishRarity.Legendary, 0);
    const taps = targets.map((_, i) => ({ tapIndex: i, msSinceTapStart: 0 }));
    const result = validateCircularTapTaps({ profile, targets, taps });
    expect(result.passed).toBe(false);
    // First tap might land (target[0]=0, indicator at t=0 is 0), but the
    // rest are at t=0 — angularDistance won't satisfy missesAllowed=0.
    expect(result.misses).toBeGreaterThan(0);
  });

  it("timestamps past autoMissMs are rejected as auto_miss", () => {
    const { profile, targets } = buildCircularTapState(FishRarity.Legendary, 0);
    const eff = computeEffectiveCircularState(profile, 0);
    const taps = targets.map((_, i) => ({
      tapIndex: i,
      msSinceTapStart: eff.autoMissMs + 1000,
    }));
    const result = validateCircularTapTaps({ profile, targets, taps });
    expect(result.passed).toBe(false);
    expect(result.perTap.every((t) => t.reason === "auto_miss")).toBe(true);
  });

  it("negative timestamps are rejected as auto_miss", () => {
    const { profile, targets } = buildCircularTapState(FishRarity.Legendary, 0);
    const taps = targets.map((_, i) => ({ tapIndex: i, msSinceTapStart: -1 }));
    const result = validateCircularTapTaps({ profile, targets, taps });
    expect(result.passed).toBe(false);
    expect(result.perTap.every((t) => t.reason === "auto_miss")).toBe(true);
  });

  it("out-of-order tapIndex is rejected as out_of_order", () => {
    const { profile, targets } = buildCircularTapState(FishRarity.Legendary, 0);
    // Submit a tap with tapIndex=5 in the first slot — out of expected order.
    const taps = [
      { tapIndex: 5, msSinceTapStart: 100 },
      { tapIndex: 1, msSinceTapStart: 100 },
    ];
    const result = validateCircularTapTaps({ profile, targets, taps });
    expect(result.passed).toBe(false);
    expect(result.perTap[0].reason).toBe("out_of_order");
  });

  it("empty taps array → fails (no taps == no encounter cleared)", () => {
    const { profile, targets } = buildCircularTapState(FishRarity.Legendary, 0);
    const result = validateCircularTapTaps({ profile, targets, taps: [] });
    expect(result.passed).toBe(false);
    expect(result.hits).toBe(0);
    expect(result.misses).toBe(0);
  });
});

describe("validateCircularTapTaps — slack tuning", () => {
  it("a tap that lands just past autoMissMs is rejected by default slack", () => {
    const { profile, targets } = buildCircularTapState(FishRarity.Legendary, 0);
    const eff = computeEffectiveCircularState(profile, 0);
    const tap = { tapIndex: 0, msSinceTapStart: eff.autoMissMs + 100 };
    const result = validateCircularTapTaps({
      profile,
      targets,
      taps: [tap],
    });
    expect(result.perTap[0].reason).toBe("auto_miss");
  });

  it("custom slack accepts late taps within the slack window", () => {
    const { profile, targets } = buildCircularTapState(FishRarity.Legendary, 0);
    const eff = computeEffectiveCircularState(profile, 0);
    const tap = { tapIndex: 0, msSinceTapStart: eff.autoMissMs + 50 };
    const result = validateCircularTapTaps({
      profile,
      targets,
      taps: [tap],
      jitterSlackMs: 200,
    });
    // 50ms past autoMissMs is within 200ms slack — should NOT be auto_miss.
    expect(result.perTap[0].reason).not.toBe("auto_miss");
  });
});

describe("CIRCULAR_BASE invariants the validator depends on", () => {
  it("Legendary and Apex have missesAllowed=0 (one miss = fail)", () => {
    expect(CIRCULAR_BASE[FishRarity.Legendary].missesAllowed).toBe(0);
    expect(CIRCULAR_BASE[FishRarity.Apex].missesAllowed).toBe(0);
  });
});

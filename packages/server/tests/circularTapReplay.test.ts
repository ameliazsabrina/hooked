import { describe, it, expect } from "vitest";
import {
  FishRarity,
  angleForPattern,
  buildCircularTapState,
  shortestAngularDistance,
  validateCircularTapTaps,
  type CircularTapInputMsg,
} from "@hooked/shared";

describe("circular-tap replay (Legendary/Apex chain)", () => {
  it("Legendary: a perfect ideal-hit replay validates as passed", () => {
    const { profile, targets } = buildCircularTapState(FishRarity.Legendary, 0);

    const taps: CircularTapInputMsg[] = targets.map((target, tapIndex) => {
      const escFactor = profile.phaseEscalation ? 1 + tapIndex * 0.08 : 1;
      const speedRadPerSec = profile.indicatorSpeed * escFactor;
      let bestMs = 0;
      let bestDist = Infinity;
      const autoMissMs =
        ((2.0 * 2 * Math.PI) / speedRadPerSec) * 1000;
      for (let ms = 0; ms < autoMissMs; ms += 0.5) {
        const ang = angleForPattern(
          profile.rotationPattern,
          speedRadPerSec,
          ms,
          tapIndex,
        );
        const d = shortestAngularDistance(ang, target);
        if (d < bestDist) {
          bestDist = d;
          bestMs = ms;
        }
      }
      return { tapIndex, msSinceTapStart: bestMs };
    });

    const verdict = validateCircularTapTaps({ profile, targets, taps });
    expect(verdict.passed).toBe(true);
    expect(verdict.hits).toBe(profile.tapsRequired);
    expect(verdict.misses).toBe(0);
  });

  it("Legendary: an auto-miss replay (negative tap timestamps) validates as failed", () => {
    const { profile, targets } = buildCircularTapState(FishRarity.Legendary, 0);

    const taps: CircularTapInputMsg[] = targets.map((_t, tapIndex) => ({
      tapIndex,
      msSinceTapStart: -1,
    }));

    const verdict = validateCircularTapTaps({ profile, targets, taps });
    expect(verdict.passed).toBe(false);
    expect(verdict.hits).toBe(0);
    expect(verdict.misses).toBe(profile.tapsRequired);
    for (const t of verdict.perTap) {
      expect(t.reason).toBe("auto_miss");
    }
  });

  it("validates as failed when no taps were captured (regression check)", () => {
    const { profile, targets } = buildCircularTapState(FishRarity.Legendary, 0);
    const verdict = validateCircularTapTaps({ profile, targets, taps: [] });
    expect(verdict.passed).toBe(false);
    expect(verdict.hits).toBe(0);
  });
});

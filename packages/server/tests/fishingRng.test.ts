import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";

import {
  BPS_SCALE,
  DAY_RARITY_WEIGHTS,
  GREEN_ZONE_WIDTH_BPS,
  NIGHT_RARITY_WEIGHTS,
  SPECIES_TABLE,
} from "../src/services/fishing/constants.js";
import { rollCast, rollRarity, seedForCast } from "../src/services/fishing/rng.js";
import { Mechanic, Rarity, Window } from "../src/services/fishing/types.js";

function sampleRarityDistribution(window: Window, n: number, apexBp: number): [number, number, number, number, number] {
  const dailySeed = randomBytes(32);
  const playerWallet = "Test1111111111111111111111111111111111111111";
  const bins: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const seed = seedForCast({
      dailySeed,
      sessionId: `s${(i % 100).toString()}`,
      castIndex: i,
      pity: 0,
      playerWallet,
    });
    bins[rollRarity(seed, window, apexBp)]++;
  }
  return bins;
}

describe("rollRarity distribution", () => {
  // PRD §6.2 day target: Basic 7604 / Rare 1980 / Monster 380 / Legendary 36 / Apex 0 (per 10k).
  // ±150 absolute tolerance for the three meaningful tiers; ±40 for legendary; apex must be 0.
  test("day distribution matches PRD targets", () => {
    const bins = sampleRarityDistribution(Window.Day, 10_000, 0);
    expect(Math.abs(bins[0] - 7604)).toBeLessThan(150);
    expect(Math.abs(bins[1] - 1980)).toBeLessThan(150);
    expect(Math.abs(bins[2] - 380)).toBeLessThan(100);
    expect(Math.abs(bins[3] - 36)).toBeLessThan(40);
    expect(bins[4]).toBe(0); // Apex unreachable without active event
  });

  test("night distribution matches PRD targets", () => {
    const bins = sampleRarityDistribution(Window.Night, 10_000, 0);
    expect(Math.abs(bins[0] - 7516)).toBeLessThan(150);
    expect(Math.abs(bins[1] - 2020)).toBeLessThan(150);
    expect(Math.abs(bins[2] - 420)).toBeLessThan(100);
    expect(Math.abs(bins[3] - 44)).toBeLessThan(40);
    expect(bins[4]).toBe(0);
  });

  test("active event redistributes basic to apex", () => {
    // 1000 bp = 10% Apex. Basic should drop by ~1000 bp; other tiers unchanged.
    const bins = sampleRarityDistribution(Window.Day, 10_000, 1000);
    expect(Math.abs(bins[0] - 6604)).toBeLessThan(200);
    expect(Math.abs(bins[1] - 1980)).toBeLessThan(150);
    expect(Math.abs(bins[2] - 380)).toBeLessThan(100);
    expect(Math.abs(bins[3] - 36)).toBeLessThan(40);
    expect(Math.abs(bins[4] - 1000)).toBeLessThan(150);
    const total = bins.reduce((a, b) => a + b, 0);
    expect(total).toBe(10_000);
  });

  test("max event apex_bp produces mostly apex", () => {
    const bins = sampleRarityDistribution(Window.Day, 10_000, 5000);
    expect(Math.abs(bins[0] - 2604)).toBeLessThan(200);
    expect(Math.abs(bins[4] - 5000)).toBeLessThan(200);
  });
});

describe("rollRarity invariants", () => {
  test("day weights sum to BPS_SCALE", () => {
    expect(DAY_RARITY_WEIGHTS.reduce((a, b) => a + b, 0)).toBe(BPS_SCALE);
  });
  test("night weights sum to BPS_SCALE", () => {
    expect(NIGHT_RARITY_WEIGHTS.reduce((a, b) => a + b, 0)).toBe(BPS_SCALE);
  });
});

describe("rollCast", () => {
  test("species index is within rarity's range", () => {
    const dailySeed = randomBytes(32);
    for (let i = 0; i < 1000; i++) {
      const seed = seedForCast({
        dailySeed,
        sessionId: "s1",
        castIndex: i,
        pity: 0,
        playerWallet: "Test1111111111111111111111111111111111111111",
      });
      const cast = rollCast({ seedBytes: seed, window: Window.Day, apexBp: 0, castCount: i, pity: 0 });
      const species = SPECIES_TABLE[cast.speciesId];
      expect(species.rarity).toBe(cast.rarity);
    }
  });

  test("weight is within species range", () => {
    const dailySeed = randomBytes(32);
    for (let i = 0; i < 1000; i++) {
      const seed = seedForCast({
        dailySeed,
        sessionId: "s2",
        castIndex: i,
        pity: 0,
        playerWallet: "Test1111111111111111111111111111111111111111",
      });
      const cast = rollCast({ seedBytes: seed, window: Window.Day, apexBp: 0, castCount: i, pity: 0 });
      const species = SPECIES_TABLE[cast.speciesId];
      expect(cast.weightHg).toBeGreaterThanOrEqual(species.minWeightHg);
      expect(cast.weightHg).toBeLessThanOrEqual(species.maxWeightHg);
    }
  });

  test("green zone fits within bps scale", () => {
    const dailySeed = randomBytes(32);
    for (let i = 0; i < 1000; i++) {
      const seed = seedForCast({
        dailySeed,
        sessionId: "s3",
        castIndex: i,
        pity: 0,
        playerWallet: "Test1111111111111111111111111111111111111111",
      });
      const cast = rollCast({ seedBytes: seed, window: Window.Day, apexBp: 0, castCount: i, pity: 0 });
      expect(cast.greenZoneStart + cast.greenZoneWidth).toBeLessThanOrEqual(BPS_SCALE);
      expect(cast.greenZoneWidth).toBe(GREEN_ZONE_WIDTH_BPS);
    }
  });

  test("mechanic matches rarity (CircularTap for legendary+, TimingBar otherwise)", () => {
    // apex_bp = 5000 (the documented MAX_EVENT_APEX_BP) puts ~50% of rolls in
    // Apex so the loop hits both branches without flake.
    const dailySeed = randomBytes(32);
    let sawHighRarity = false;
    let sawLowRarity = false;
    for (let i = 0; i < 5_000; i++) {
      const seed = seedForCast({
        dailySeed,
        sessionId: "s4",
        castIndex: i,
        pity: 0,
        playerWallet: "Test1111111111111111111111111111111111111111",
      });
      const cast = rollCast({ seedBytes: seed, window: Window.Day, apexBp: 5_000, castCount: i, pity: 0 });
      if (cast.rarity >= Rarity.Legendary) {
        expect(cast.mechanic).toBe(Mechanic.CircularTap);
        sawHighRarity = true;
      } else {
        expect(cast.mechanic).toBe(Mechanic.TimingBar);
        sawLowRarity = true;
      }
    }
    expect(sawHighRarity).toBe(true);
    expect(sawLowRarity).toBe(true);
  });

  test("pity forces basic to rare on cast 10/13 when threshold reached", () => {
    // Find a seed whose vanilla rarity rolls Basic, then verify pity bumps it.
    const dailySeed = randomBytes(32);
    let foundBasicSeed: Buffer | null = null;
    for (let i = 0; i < 1000; i++) {
      const seed = seedForCast({
        dailySeed,
        sessionId: "spity",
        castIndex: i,
        pity: 0,
        playerWallet: "Test1111111111111111111111111111111111111111",
      });
      if (rollRarity(seed, Window.Day, 0) === Rarity.Basic) {
        foundBasicSeed = seed;
        break;
      }
    }
    expect(foundBasicSeed).not.toBeNull();
    const cast = rollCast({
      seedBytes: foundBasicSeed!,
      window: Window.Day,
      apexBp: 0,
      castCount: 10,
      pity: 10,
    });
    expect(cast.rarity).toBe(Rarity.Rare);
  });
});

describe("seedForCast determinism", () => {
  test("same inputs produce same seed", () => {
    const dailySeed = randomBytes(32);
    const args = {
      dailySeed,
      sessionId: "s_det",
      castIndex: 7,
      pity: 3,
      playerWallet: "Det1111111111111111111111111111111111111111",
    };
    expect(seedForCast(args).equals(seedForCast(args))).toBe(true);
  });

  test("different cast index produces different seed", () => {
    const dailySeed = randomBytes(32);
    const a = seedForCast({
      dailySeed,
      sessionId: "s_diff",
      castIndex: 1,
      pity: 0,
      playerWallet: "Diff111111111111111111111111111111111111111",
    });
    const b = seedForCast({
      dailySeed,
      sessionId: "s_diff",
      castIndex: 2,
      pity: 0,
      playerWallet: "Diff111111111111111111111111111111111111111",
    });
    expect(a.equals(b)).toBe(false);
  });

  test("rejects daily seed of wrong length", () => {
    expect(() =>
      seedForCast({
        dailySeed: Buffer.alloc(16),
        sessionId: "s",
        castIndex: 0,
        pity: 0,
        playerWallet: "x",
      }),
    ).toThrow();
  });
});

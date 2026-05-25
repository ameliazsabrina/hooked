import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";

import { rollCast, seedForCast } from "../src/services/fishing/rng.ts";
import { Mechanic, Rarity, Window } from "../src/services/fishing/types.ts";
import {
  RARITY_START_INDEX,
  SPECIES_PER_RARITY,
} from "../src/services/fishing/constants.ts";


const PLAYER = "Test1111111111111111111111111111111111111111";

function seed(label: string): Buffer {
  const dailySeed = randomBytes(32);
  return seedForCast({
    dailySeed,
    sessionId: label,
    castIndex: 1,
    pity: 0,
    playerWallet: PLAYER,
  });
}

describe("rollCast — apexSpeciesIds override", () => {
  test("when Apex rolls and apexSpeciesIds is non-empty, picks only from the list", async () => {
    const allowed = [21, 22] as const;
    let sawApex = false;
    for (let i = 0; i < 5_000; i++) {
      const seedBytes = seed(`apex-${i}`);
      const cast = rollCast({
        seedBytes,
        window: Window.Day,
        apexBp: 5000,
        castCount: i,
        pity: 0,
        apexSpeciesIds: allowed,
      });
      if (cast.rarity === Rarity.Apex) {
        sawApex = true;
        expect(allowed).toContain(cast.speciesId as 21 | 22);
        // species index 20 is the third hardcoded apex; it should NEVER be
        // picked while it's not in the allow-list.
        expect(cast.speciesId).not.toBe(20);
        expect(cast.mechanic).toBe(Mechanic.CircularTap);
      }
    }
    expect(sawApex).toBe(true);
  });

  test("non-Apex rolls ignore apexSpeciesIds and use the legacy slice", async () => {
    // No event-level apex weight; rolls are basically Basic.
    const allowed = [21] as const;
    for (let i = 0; i < 200; i++) {
      const seedBytes = seed(`base-${i}`);
      const cast = rollCast({
        seedBytes,
        window: Window.Day,
        apexBp: 0,
        castCount: i,
        pity: 0,
        apexSpeciesIds: allowed,
      });
      expect(cast.rarity).not.toBe(Rarity.Apex);
      // Sanity: species id is within the rarity's hardcoded slice.
      const start = RARITY_START_INDEX[cast.rarity];
      const count = SPECIES_PER_RARITY[cast.rarity];
      expect(cast.speciesId).toBeGreaterThanOrEqual(start);
      expect(cast.speciesId).toBeLessThan(start + count);
    }
  });

  test("Apex rolls fall back to the legacy slice when apexSpeciesIds is undefined", async () => {
    let sawApex = false;
    for (let i = 0; i < 5_000; i++) {
      const seedBytes = seed(`fallback-${i}`);
      const cast = rollCast({
        seedBytes,
        window: Window.Day,
        apexBp: 5000,
        castCount: i,
        pity: 0,
      });
      if (cast.rarity === Rarity.Apex) {
        sawApex = true;
        // Legacy apex slice: [20, 21, 22] from the hardcoded SPECIES_TABLE.
        expect([20, 21, 22]).toContain(cast.speciesId);
      }
    }
    expect(sawApex).toBe(true);
  });

  test("empty apexSpeciesIds also falls back to the legacy slice", async () => {
    let sawApex = false;
    for (let i = 0; i < 5_000; i++) {
      const seedBytes = seed(`empty-${i}`);
      const cast = rollCast({
        seedBytes,
        window: Window.Day,
        apexBp: 5000,
        castCount: i,
        pity: 0,
        apexSpeciesIds: [],
      });
      if (cast.rarity === Rarity.Apex) {
        sawApex = true;
        expect([20, 21, 22]).toContain(cast.speciesId);
      }
    }
    expect(sawApex).toBe(true);
  });

  test("single-id apexSpeciesIds always picks that species when Apex rolls", async () => {
    const onlyId = 22;
    let sawApex = false;
    for (let i = 0; i < 5_000; i++) {
      const seedBytes = seed(`single-${i}`);
      const cast = rollCast({
        seedBytes,
        window: Window.Day,
        apexBp: 5000,
        castCount: i,
        pity: 0,
        apexSpeciesIds: [onlyId],
      });
      if (cast.rarity === Rarity.Apex) {
        sawApex = true;
        expect(cast.speciesId).toBe(onlyId);
      }
    }
    expect(sawApex).toBe(true);
  });
});

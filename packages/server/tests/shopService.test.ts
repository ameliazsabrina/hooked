import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { RODS, BAITS } from "@hooked/shared";
import { Player, Catch } from "../src/db/schema.js";
import * as shop from "../src/services/shop.js";
import { startTestMongo, stopTestMongo, clearAllCollections } from "./setup.js";

// Direct unit coverage of the extracted business logic — the router test
// exercises buyRod + sell paths; this fills the gaps (buyBait, equip*, error
// branches) the extraction made independently testable.

const ROD = RODS.find((r) => r.slug === "branch")!; // tier 1, cost 150
const ROD2 = RODS.find((r) => r.slug === "duck")!; // tier 2, cost 300
const BAIT = BAITS.find((b) => b.slug === "hophop")!; // tier 1, cost 300

function createTestPlayer(opts: {
  wallet: string;
  shellBalance: number;
  ownedRods?: string[];
  ownedBaits?: string[];
  rodTier?: number;
}) {
  return Player.create({
    walletAddress: opts.wallet,
    nickname: `test_${opts.wallet.slice(0, 8)}`,
    shellBalance: opts.shellBalance,
    equipment: {
      rodTier: opts.rodTier ?? 0,
      rodEquipped: "old",
      baitEquipped: "fly",
      luckyLureTier: 0,
      ownedRods: opts.ownedRods ?? ["old"],
      ownedBaits: opts.ownedBaits ?? ["fly"],
    },
  });
}

describe("shop service", () => {
  beforeAll(async () => {
    await startTestMongo();
  });
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearAllCollections();
  });

  describe("buyBait", () => {
    it("deducts shell, adds and auto-equips a higher-tier bait", async () => {
      await createTestPlayer({ wallet: "B1", shellBalance: 1000 });
      const res = await shop.buyBait("B1", BAIT.slug);
      expect(res.shellBalance).toBe(1000 - BAIT.shellCost);
      expect(res.equipment.ownedBaits).toContain(BAIT.slug);
      expect(res.equipment.baitEquipped).toBe(BAIT.slug);
      expect(res.equipment.luckyLureTier).toBe(BAIT.tier);
    });

    it("refuses when shell is insufficient", async () => {
      await createTestPlayer({ wallet: "B2", shellBalance: 10 });
      await expect(shop.buyBait("B2", BAIT.slug)).rejects.toThrow(
        /Not enough Shell/,
      );
      const p = await Player.findOne({ walletAddress: "B2" }).lean();
      expect(p?.shellBalance).toBe(10);
    });

    it("refuses to re-buy an owned bait", async () => {
      await createTestPlayer({
        wallet: "B3",
        shellBalance: 1000,
        ownedBaits: ["fly", BAIT.slug],
      });
      await expect(shop.buyBait("B3", BAIT.slug)).rejects.toThrow(
        /Already owned/,
      );
    });

    it("rejects an unknown bait slug", async () => {
      await createTestPlayer({ wallet: "B4", shellBalance: 1000 });
      await expect(shop.buyBait("B4", "not-a-bait")).rejects.toThrow(
        /Unknown bait/,
      );
    });

    it("rejects when the player does not exist", async () => {
      await expect(shop.buyBait("ghost", BAIT.slug)).rejects.toThrow(
        /Player not found/,
      );
    });
  });

  describe("buyRod tier upgrade & errors", () => {
    it("auto-equips when the bought rod outranks the equipped one", async () => {
      await createTestPlayer({ wallet: "R1", shellBalance: 1000 });
      const res = await shop.buyRod("R1", ROD2.slug);
      expect(res.equipment.rodEquipped).toBe(ROD2.slug);
      expect(res.equipment.rodTier).toBe(ROD2.tier);
    });

    it("rejects an unknown rod slug", async () => {
      await createTestPlayer({ wallet: "R2", shellBalance: 1000 });
      await expect(shop.buyRod("R2", "not-a-rod")).rejects.toThrow(
        /Unknown rod/,
      );
    });

    it("rejects when the player does not exist", async () => {
      await expect(shop.buyRod("ghost", ROD.slug)).rejects.toThrow(
        /Player not found/,
      );
    });
  });

  describe("equipRod", () => {
    it("equips an owned rod and sets its tier", async () => {
      await createTestPlayer({
        wallet: "E1",
        shellBalance: 0,
        ownedRods: ["old", ROD.slug],
      });
      const res = await shop.equipRod("E1", ROD.slug);
      expect(res.equipment.rodEquipped).toBe(ROD.slug);
      expect(res.equipment.rodTier).toBe(ROD.tier);
    });

    it("refuses to equip a rod the player does not own", async () => {
      await createTestPlayer({ wallet: "E2", shellBalance: 0 });
      await expect(shop.equipRod("E2", ROD.slug)).rejects.toThrow(
        /Rod not owned/,
      );
    });

    it("rejects when the player does not exist", async () => {
      await expect(shop.equipRod("ghost", ROD.slug)).rejects.toThrow(
        /Player not found/,
      );
    });
  });

  describe("equipBait", () => {
    it("equips an owned bait and sets its lure tier", async () => {
      await createTestPlayer({
        wallet: "EB1",
        shellBalance: 0,
        ownedBaits: ["fly", BAIT.slug],
      });
      const res = await shop.equipBait("EB1", BAIT.slug);
      expect(res.equipment.baitEquipped).toBe(BAIT.slug);
      expect(res.equipment.luckyLureTier).toBe(BAIT.tier);
    });

    it("refuses to equip a bait the player does not own", async () => {
      await createTestPlayer({ wallet: "EB2", shellBalance: 0 });
      await expect(shop.equipBait("EB2", BAIT.slug)).rejects.toThrow(
        /Bait not owned/,
      );
    });
  });

  describe("sellFish error branches", () => {
    it("rejects a non-ObjectId catch id", async () => {
      await createTestPlayer({ wallet: "S1", shellBalance: 0 });
      await expect(shop.sellFish("S1", "nope")).rejects.toThrow(
        /Invalid catch id/,
      );
    });

    it("rejects when the player does not exist", async () => {
      const id = new mongoose.Types.ObjectId().toString();
      await expect(shop.sellFish("ghost", id)).rejects.toThrow(
        /Player not found/,
      );
    });

    it("rejects a catch that isn't available", async () => {
      await createTestPlayer({ wallet: "S2", shellBalance: 0 });
      const id = new mongoose.Types.ObjectId().toString();
      await expect(shop.sellFish("S2", id)).rejects.toThrow(
        /Catch not available/,
      );
    });
  });

  describe("sellFishBulk error branches", () => {
    it("rejects when no ids are valid ObjectIds", async () => {
      await createTestPlayer({ wallet: "SB1", shellBalance: 0 });
      await expect(shop.sellFishBulk("SB1", ["bad", "ids"])).rejects.toThrow(
        /No valid catch ids/,
      );
    });

    it("rejects when nothing is sellable", async () => {
      await createTestPlayer({ wallet: "SB2", shellBalance: 0 });
      const id = new mongoose.Types.ObjectId().toString();
      await expect(shop.sellFishBulk("SB2", [id])).rejects.toThrow(
        /Nothing to sell/,
      );
    });

    it("sells owned catches and credits shell", async () => {
      const player = await createTestPlayer({ wallet: "SB3", shellBalance: 0 });
      const c = await Catch.create({
        playerId: player._id,
        species: "trout",
        rarity: "rare",
        weightKg: 2,
        score: 50,
        zone: "open_sea",
        sellValue: 50,
        caughtAt: new Date(),
      });
      const res = await shop.sellFishBulk("SB3", [String(c._id)]);
      expect(res.totalPrice).toBe(50);
      expect(res.shellBalance).toBe(50);
    });
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { shopRouter } from "../src/trpc/shopRouter.js";
import { Player, Catch } from "../src/db/schema.js";
import type { Context } from "../src/trpc/context.js";
import {
  startTestMongo,
  stopTestMongo,
  clearAllCollections,
  makeRedis,
} from "./setup.js";

function buildContext(
  redis: any,
  walletAddress: string,
  overrides: Partial<Context> = {},
): Context {
  return {
    walletAddress,
    sessionToken: "test-token",
    ipCountry: null,
    ipAddress: null,
    adminHeaders: {
      wallet: null,
      timestamp: null,
      nonce: null,
      signature: null,
    },
    redis,
    ...overrides,
  };
}

async function createTestPlayer(opts: {
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

describe("shopRouter — atomicity", () => {
  beforeAll(async () => {
    await startTestMongo();
  });
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearAllCollections();
  });

  describe("buyRod", () => {
    it("deducts shell and adds rod on success", async () => {
      const wallet = "Wallet1";
      await createTestPlayer({ wallet, shellBalance: 500 });

      const caller = shopRouter.createCaller(buildContext(makeRedis(), wallet));
      const res = await caller.buyRod({ slug: "branch" }); // cost 150

      expect(res.shellBalance).toBe(350);
      expect(res.equipment.ownedRods).toContain("branch");
    });

    it("refuses when shell balance is insufficient", async () => {
      const wallet = "WalletBroke";
      await createTestPlayer({ wallet, shellBalance: 10 });

      const caller = shopRouter.createCaller(buildContext(makeRedis(), wallet));
      await expect(caller.buyRod({ slug: "branch" })).rejects.toThrow(
        /Not enough Shell/,
      );

      // Shell balance untouched
      const player = await Player.findOne({ walletAddress: wallet }).lean();
      expect(player?.shellBalance).toBe(10);
      expect(player?.equipment.ownedRods).not.toContain("branch");
    });

    it("refuses to re-buy an already-owned rod", async () => {
      const wallet = "WalletHasBranch";
      await createTestPlayer({
        wallet,
        shellBalance: 1000,
        ownedRods: ["old", "branch"],
      });

      const caller = shopRouter.createCaller(buildContext(makeRedis(), wallet));
      await expect(caller.buyRod({ slug: "branch" })).rejects.toThrow(
        /Already owned/,
      );

      const player = await Player.findOne({ walletAddress: wallet }).lean();
      expect(player?.shellBalance).toBe(1000); // no deduction
    });

    it("under concurrent buys of the same rod, only one wins; shell isn't over-deducted", async () => {
      // This is the core P1 behavior. Before the fix, both calls could
      // read shellBalance=500, compute new=350, and the last write would
      // land — but the rod would be pushed twice too. Now: only one wins.
      const wallet = "WalletRacing";
      await createTestPlayer({ wallet, shellBalance: 500 });

      const caller = shopRouter.createCaller(buildContext(makeRedis(), wallet));
      const results = await Promise.allSettled([
        caller.buyRod({ slug: "branch" }),
        caller.buyRod({ slug: "branch" }),
        caller.buyRod({ slug: "branch" }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(2);

      const player = await Player.findOne({ walletAddress: wallet }).lean();
      expect(player?.shellBalance).toBe(350); // exactly one 150-cost deduction
      expect(
        player?.equipment.ownedRods.filter((r) => r === "branch"),
      ).toHaveLength(1);
    });

    it("concurrent buys of different rods both deduct correctly", async () => {
      const wallet = "WalletDiverse";
      await createTestPlayer({ wallet, shellBalance: 2000 });

      const caller = shopRouter.createCaller(buildContext(makeRedis(), wallet));
      const [r1, r2] = await Promise.all([
        caller.buyRod({ slug: "branch" }), // 150
        caller.buyRod({ slug: "duck" }), //   300
      ]);
      // Each operation observes a consistent balance; total deducted = 450
      expect(r1.shellBalance + r2.shellBalance).toBeGreaterThan(0);

      const player = await Player.findOne({ walletAddress: wallet }).lean();
      expect(player?.shellBalance).toBe(2000 - 150 - 300);
      expect(player?.equipment.ownedRods).toEqual(
        expect.arrayContaining(["branch", "duck"]),
      );
    });
  });

  describe("sellFishBulk", () => {
    it("credits shell exactly once per catch; concurrent sells don't double-credit", async () => {
      const wallet = "WalletSell";
      const player = await createTestPlayer({ wallet, shellBalance: 0 });

      // Seed 3 saleable catches, each worth 10
      const catches = await Catch.insertMany(
        Array.from({ length: 3 }, (_, i) => ({
          playerId: player._id,
          species: `species_${i}`,
          rarity: "basic",
          weightKg: 1,
          score: 10,
          zone: "open_sea",
          sellValue: 10,
          caughtAt: new Date(),
        })),
      );
      const ids = catches.map((c) => String(c._id));

      const caller = shopRouter.createCaller(buildContext(makeRedis(), wallet));
      // Fire the same bulk sell twice in parallel — classic double-submit.
      const [a, b] = await Promise.allSettled([
        caller.sellFishBulk({ catchIds: ids }),
        caller.sellFishBulk({ catchIds: ids }),
      ]);

      const fulfilled = [a, b].filter(
        (r): r is PromiseFulfilledResult<{
          totalPrice: number;
          soldIds: string[];
          shellBalance: number;
        }> => r.status === "fulfilled",
      );

      // Either both resolved (with one crediting 30, the other 0-via-rejection
      // because nothing sellable remained) OR one resolved with 30 and the other
      // rejected. Total credit must equal 30 either way.
      const totalCredited = fulfilled.reduce(
        (acc, r) => acc + r.value.totalPrice,
        0,
      );
      expect(totalCredited).toBe(30);

      const updated = await Player.findOne({ walletAddress: wallet }).lean();
      expect(updated?.shellBalance).toBe(30);

      // Each catch is released exactly once
      const stillReleasable = await Catch.countDocuments({
        playerId: player._id,
        released: false,
      });
      expect(stillReleasable).toBe(0);
    });

    it("sells apex fish in bulk and credits the full sellValue", async () => {
      const wallet = "WalletApexBulk";
      const player = await createTestPlayer({ wallet, shellBalance: 0 });

      const apex = await Catch.create({
        playerId: player._id,
        species: "kraken",
        rarity: "apex",
        weightKg: 999,
        score: 9999,
        zone: "open_sea",
        sellValue: 9999,
        caughtAt: new Date(),
      });

      const caller = shopRouter.createCaller(buildContext(makeRedis(), wallet));
      const res = await caller.sellFishBulk({ catchIds: [String(apex._id)] });
      expect(res.totalPrice).toBe(9999);
      expect(res.shellBalance).toBe(9999);

      const sold = await Catch.findById(apex._id).lean();
      expect(sold?.released).toBe(true);
      expect(sold?.soldPrice).toBe(9999);
    });
  });

  describe("sellFish (single)", () => {
    it("credits shell atomically and marks the catch released", async () => {
      const wallet = "WalletSingle";
      const player = await createTestPlayer({ wallet, shellBalance: 100 });
      const catchDoc = await Catch.create({
        playerId: player._id,
        species: "trout",
        rarity: "rare",
        weightKg: 2,
        score: 50,
        zone: "open_sea",
        sellValue: 50,
        caughtAt: new Date(),
      });

      const caller = shopRouter.createCaller(buildContext(makeRedis(), wallet));
      const res = await caller.sellFish({ catchId: String(catchDoc._id) });
      expect(res.price).toBe(50);
      expect(res.shellBalance).toBe(150);

      const updated = await Catch.findById(catchDoc._id).lean();
      expect(updated?.released).toBe(true);
      expect(updated?.soldPrice).toBe(50);
    });

    it("sells a single apex fish for its full sellValue", async () => {
      const wallet = "WalletApexSingle";
      const player = await createTestPlayer({ wallet, shellBalance: 0 });
      const apex = await Catch.create({
        playerId: player._id,
        species: "leviathan",
        rarity: "apex",
        weightKg: 1500,
        score: 12000,
        zone: "open_sea",
        sellValue: 12000,
        caughtAt: new Date(),
      });

      const caller = shopRouter.createCaller(buildContext(makeRedis(), wallet));
      const res = await caller.sellFish({ catchId: String(apex._id) });
      expect(res.price).toBe(12000);
      expect(res.shellBalance).toBe(12000);

      const updated = await Catch.findById(apex._id).lean();
      expect(updated?.released).toBe(true);
      expect(updated?.soldPrice).toBe(12000);
    });
  });
});

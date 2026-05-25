import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Player, PoolTier } from "../src/db/schema.js";
import * as lb from "../src/services/leaderboard.js";
import {
  creditCatch,
  __resetActivePoolCacheForTests,
} from "../src/services/leaderboardCredit.js";
import {
  clearAllCollections,
  makeFreshRedis,
  startTestMongo,
  stopTestMongo,
} from "./setup.js";

const WALLET = "WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ROOM_ID = "room-test-1";

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

beforeAll(async () => {
  await startTestMongo();
});

afterAll(async () => {
  await stopTestMongo();
});

beforeEach(async () => {
  __resetActivePoolCacheForTests();
});

afterEach(async () => {
  await clearAllCollections();
});

describe("creditCatch", () => {
  it("credits room, daily-tier, and pool LBs when all scopes are available", async () => {
    const redis = await makeFreshRedis();
    const player = await Player.create({ walletAddress: WALLET });
    const pool = await PoolTier.create({
      tier: 1,
      activeMonth: currentMonth(),
    });

    await creditCatch({
      redis,
      walletAddress: WALLET,
      score: 42,
      weightHg: 75,
      rarity: 2,
      speciesName: "tuna",
      roomId: ROOM_ID,
    });

    const playerId = player._id.toString();
    const date = todayUTC();
    const poolId = pool._id.toString();

    expect(await lb.getRoomPlayerScore(redis, ROOM_ID, playerId)).toBe(42);
    expect(await lb.getPlayerScore(redis, 1, date, playerId)).toBe(42);
    expect(await lb.getPoolPlayerScore(redis, poolId, playerId)).toBe(42);
  });

  it("writes top-catch with stringified rarity and weightKg = weightHg/10", async () => {
    const redis = await makeFreshRedis();
    const player = await Player.create({ walletAddress: WALLET });
    await PoolTier.create({ tier: 1, activeMonth: currentMonth() });

    await creditCatch({
      redis,
      walletAddress: WALLET,
      score: 100,
      weightHg: 250,
      rarity: 4,
      speciesName: "great-white",
      roomId: ROOM_ID,
    });

    const playerId = player._id.toString();
    const roomTop = await lb.getRoomTopCatches(redis, ROOM_ID, [playerId]);
    const entry = roomTop.get(playerId);
    expect(entry).toEqual({
      species: "great-white",
      rarity: "apex",
      weightKg: 25,
      score: 100,
    });
  });

  it("accumulates score across multiple catches via zincrby", async () => {
    const redis = await makeFreshRedis();
    const player = await Player.create({ walletAddress: WALLET });

    for (const score of [10, 25, 5]) {
      await creditCatch({
        redis,
        walletAddress: WALLET,
        score,
        weightHg: 50,
        rarity: 0,
        speciesName: "perch",
        roomId: ROOM_ID,
      });
    }

    const playerId = player._id.toString();
    expect(await lb.getRoomPlayerScore(redis, ROOM_ID, playerId)).toBe(40);
  });

  it("only overwrites top-catch when the new score is higher", async () => {
    const redis = await makeFreshRedis();
    const player = await Player.create({ walletAddress: WALLET });

    await creditCatch({
      redis,
      walletAddress: WALLET,
      score: 50,
      weightHg: 100,
      rarity: 1,
      speciesName: "first",
      roomId: ROOM_ID,
    });
    await creditCatch({
      redis,
      walletAddress: WALLET,
      score: 30,
      weightHg: 60,
      rarity: 0,
      speciesName: "smaller",
      roomId: ROOM_ID,
    });

    const playerId = player._id.toString();
    const top = await lb.getRoomTopCatches(redis, ROOM_ID, [playerId]);
    expect(top.get(playerId)?.species).toBe("first");
    expect(top.get(playerId)?.score).toBe(50);
  });

  it("skips room scope when roomId is null but still credits daily and pool", async () => {
    const redis = await makeFreshRedis();
    const player = await Player.create({ walletAddress: WALLET });
    const pool = await PoolTier.create({
      tier: 1,
      activeMonth: currentMonth(),
    });

    await creditCatch({
      redis,
      walletAddress: WALLET,
      score: 17,
      weightHg: 30,
      rarity: 0,
      speciesName: "minnow",
      roomId: null,
    });

    const playerId = player._id.toString();
    expect(await lb.getRoomPlayerScore(redis, ROOM_ID, playerId)).toBeNull();
    expect(await lb.getPlayerScore(redis, 1, todayUTC(), playerId)).toBe(17);
    expect(await lb.getPoolPlayerScore(redis, pool._id.toString(), playerId)).toBe(17);
  });

  it("skips pool scope when no active PoolTier for current month", async () => {
    const redis = await makeFreshRedis();
    const player = await Player.create({ walletAddress: WALLET });

    await creditCatch({
      redis,
      walletAddress: WALLET,
      score: 9,
      weightHg: 20,
      rarity: 0,
      speciesName: "sardine",
      roomId: ROOM_ID,
    });

    const playerId = player._id.toString();
    expect(await lb.getRoomPlayerScore(redis, ROOM_ID, playerId)).toBe(9);
    expect(await lb.getPlayerScore(redis, 1, todayUTC(), playerId)).toBe(9);
    expect(await lb.getPoolEntryCount(redis, "any-pool")).toBe(0);
  });

  it("returns silently when wallet has no Player row (does not throw)", async () => {
    const redis = await makeFreshRedis();

    await expect(
      creditCatch({
        redis,
        walletAddress: WALLET,
        score: 100,
        weightHg: 50,
        rarity: 1,
        speciesName: "ghost",
        roomId: ROOM_ID,
      }),
    ).resolves.toBeUndefined();

    expect(await lb.getRoomEntryCount(redis, ROOM_ID)).toBe(0);
    expect(await lb.getEntryCount(redis, 1, todayUTC())).toBe(0);
  });

  it("no-ops when score is 0 or negative", async () => {
    const redis = await makeFreshRedis();
    const player = await Player.create({ walletAddress: WALLET });
    await PoolTier.create({ tier: 1, activeMonth: currentMonth() });

    await creditCatch({
      redis,
      walletAddress: WALLET,
      score: 0,
      weightHg: 10,
      rarity: 0,
      speciesName: "nothing",
      roomId: ROOM_ID,
    });

    const playerId = player._id.toString();
    expect(await lb.getRoomPlayerScore(redis, ROOM_ID, playerId)).toBeNull();
    expect(await lb.getPlayerScore(redis, 1, todayUTC(), playerId)).toBeNull();
  });

  it("ranks multiple players correctly in the room LB", async () => {
    const redis = await makeFreshRedis();
    const alice = await Player.create({
      walletAddress: "AliceWalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      nickname: "alice",
    });
    const bob = await Player.create({
      walletAddress: "BobWalletBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      nickname: "bob",
    });

    await creditCatch({
      redis,
      walletAddress: alice.walletAddress,
      score: 100,
      weightHg: 50,
      rarity: 1,
      speciesName: "a",
      roomId: ROOM_ID,
    });
    await creditCatch({
      redis,
      walletAddress: bob.walletAddress,
      score: 200,
      weightHg: 80,
      rarity: 2,
      speciesName: "b",
      roomId: ROOM_ID,
    });

    const top = await lb.getRoomLeaderboard(redis, ROOM_ID, 0, 10);
    expect(top.map((e) => e.member)).toEqual([
      bob._id.toString(),
      alice._id.toString(),
    ]);
    expect(top.map((e) => e.score)).toEqual([200, 100]);

    expect(await lb.getRoomPlayerRank(redis, ROOM_ID, bob._id.toString())).toBe(0);
    expect(await lb.getRoomPlayerRank(redis, ROOM_ID, alice._id.toString())).toBe(1);
  });
});

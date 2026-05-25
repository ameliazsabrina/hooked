import { randomBytes } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "vitest";

import {
  Catch,
  FishingSession,
  Player,
} from "../src/db/schema.js";
import { playerRouter } from "../src/trpc/playerRouter.js";
import type { Context } from "../src/trpc/context.js";
import { assignWindow } from "../src/services/fishing/window.js";
import {
  clearAllCollections,
  makeRedis,
  startTestMongo,
  stopTestMongo,
} from "./setup.js";


beforeAll(async () => {
  await startTestMongo();
  await FishingSession.syncIndexes();
  await Catch.syncIndexes();
});
afterAll(async () => {
  await stopTestMongo();
});
afterEach(async () => {
  await clearAllCollections();
});

function buildContext(redis: any, walletAddress: string): Context {
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
  };
}

async function seedPlayerWithSession(opts: {
  wallet: string;
  bait: number;
}): Promise<void> {
  const player = await Player.create({
    walletAddress: opts.wallet,
    nickname: `t_${randomBytes(4).toString("hex")}`,
    shellBalance: 0,
  });
  const { window, dateKey } = assignWindow(new Date());
  await FishingSession.create({
    playerId: player._id,
    walletAddress: opts.wallet,
    dateKey,
    window,
    baitInitial: 10,
    baitRemaining: opts.bait,
    tier: 1,
    dailySeedDate: "2026-05-09",
  });
}

describe("player.sessionState — DB-backed bait read", () => {
  test("returns the bait value from the FishingSession row when one exists", async () => {
    const wallet = "WalletSS1";
    await seedPlayerWithSession({ wallet, bait: 7 });

    const caller = playerRouter.createCaller(buildContext(makeRedis(), wallet));
    const res = await caller.sessionState();
    expect(res.bait).toBe(7);
  });

  test("returns bait=0 when no session exists for the current window", async () => {
    const wallet = "WalletSS2";
    await Player.create({
      walletAddress: wallet,
      nickname: `t_${randomBytes(4).toString("hex")}`,
      shellBalance: 0,
    });
    const caller = playerRouter.createCaller(buildContext(makeRedis(), wallet));
    const res = await caller.sessionState();
    expect(res.bait).toBe(0);
    expect(res.catches).toEqual([]);
  });

  test("returns bait=0 when no Player row exists", async () => {
    const caller = playerRouter.createCaller(
      buildContext(makeRedis(), "GhostWallet"),
    );
    const res = await caller.sessionState();
    expect(res.bait).toBe(0);
    expect(res.score).toBe(0);
    expect(res.catches).toEqual([]);
  });

  test("does not need a chain RPC — completes well under the legacy 5s deadline", async () => {
    // The legacy version raced a 5s ER RPC deadline. The DB path resolves
    // in well under 500ms — covered by an upper bound here so we'd notice
    // an accidental synchronous chain call regression.
    const wallet = "WalletSS4";
    await seedPlayerWithSession({ wallet, bait: 3 });
    const caller = playerRouter.createCaller(buildContext(makeRedis(), wallet));
    const start = Date.now();
    await caller.sessionState();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });
});

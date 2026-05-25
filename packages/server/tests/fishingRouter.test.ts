import { randomBytes } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { Catch, FishingSession, Player } from "../src/db/schema.js";
import type { Context } from "../src/trpc/context.js";
import { fishingRouter } from "../src/trpc/fishingRouter.js";
import {
  clearAllCollections,
  makeRedis,
  startTestMongo,
  stopTestMongo,
} from "./setup.js";

function buildContext(redis: any, walletAddress: string | null): Context {
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

async function createTestPlayer(
  wallet: string,
  opts: { depositSol?: number; returned?: boolean } = {},
) {
  return Player.create({
    walletAddress: wallet,
    nickname: `t_${randomBytes(4).toString("hex")}`,
    shellBalance: 0,
    deposits: opts.depositSol
      ? [
          {
            poolId: "test-pool",
            amount: opts.depositSol,
            depositTxSignature: "sig-" + randomBytes(8).toString("hex"),
            activeMonth: "2026-05",
            depositedAt: new Date(),
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            returned: opts.returned ?? false,
          },
        ]
      : [],
  });
}

describe("fishingRouter", () => {
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

  describe("sessionStart", () => {
    test("derives bait from active deposit and creates session", async () => {
      const wallet = "WalletSS1";
      await createTestPlayer(wallet, { depositSol: 1.0 });
      const caller = fishingRouter.createCaller(buildContext(makeRedis(), wallet));
      const res = await caller.sessionStart();
      expect(res.isNew).toBe(true);
      expect(res.baitInitial).toBe(10); // 1 SOL → 10 bait
      expect(res.baitRemaining).toBe(10);
      expect(res.status).toBe("active");
      expect(res.sessionId).toMatch(/^[0-9a-f]{24}$/);
    });

    test("idempotent: second call returns existing session", async () => {
      const wallet = "WalletSS2";
      await createTestPlayer(wallet, { depositSol: 0.5 });
      const caller = fishingRouter.createCaller(buildContext(makeRedis(), wallet));
      const first = await caller.sessionStart();
      const second = await caller.sessionStart();
      expect(first.sessionId).toBe(second.sessionId);
      expect(second.isNew).toBe(false);
    });

    test("rejects when no active deposit", async () => {
      const wallet = "WalletSS3";
      await createTestPlayer(wallet); // no deposits
      const caller = fishingRouter.createCaller(buildContext(makeRedis(), wallet));
      await expect(caller.sessionStart()).rejects.toThrow(/No active room deposit/);
    });

    test("rejects when only deposits are returned", async () => {
      const wallet = "WalletSS4";
      await createTestPlayer(wallet, { depositSol: 1.0, returned: true });
      const caller = fishingRouter.createCaller(buildContext(makeRedis(), wallet));
      await expect(caller.sessionStart()).rejects.toThrow(/No active room deposit/);
    });

    test("rejects unauthenticated", async () => {
      const caller = fishingRouter.createCaller(buildContext(makeRedis(), null));
      await expect(caller.sessionStart()).rejects.toThrow(/Wallet not connected/);
    });
  });

  describe("sessionCurrent", () => {
    test("returns null when no session for current window", async () => {
      const wallet = "WalletSC1";
      await createTestPlayer(wallet);
      const caller = fishingRouter.createCaller(buildContext(makeRedis(), wallet));
      const res = await caller.sessionCurrent();
      expect(res).toBeNull();
    });

    test("returns existing session", async () => {
      const wallet = "WalletSC2";
      await createTestPlayer(wallet, { depositSol: 1.0 });
      const caller = fishingRouter.createCaller(buildContext(makeRedis(), wallet));
      const started = await caller.sessionStart();
      const current = await caller.sessionCurrent();
      expect(current).not.toBeNull();
      expect(current!.sessionId).toBe(started.sessionId);
    });
  });

  describe("castInitiate / castSubmit / castCancel", () => {
    async function startSessionFor(wallet: string) {
      await createTestPlayer(wallet, { depositSol: 1.0 });
      const caller = fishingRouter.createCaller(buildContext(makeRedis(), wallet));
      const session = await caller.sessionStart();
      return { caller, sessionId: session.sessionId };
    }

    test("initiate decrements bait and returns cast roll", async () => {
      const { caller, sessionId } = await startSessionFor("WalletCI1");
      const cast = await caller.castInitiate({ sessionId });
      expect(cast.castIndex).toBe(1);
      expect(cast.baitRemaining).toBe(9);
      expect(cast.seedHash).toMatch(/^[0-9a-f]{64}$/);
      expect([0, 1]).toContain(cast.mechanic);
      expect([0, 1, 2, 3, 4]).toContain(cast.rarity);
    });

    test("initiate rejects when cast already pending", async () => {
      const { caller, sessionId } = await startSessionFor("WalletCI2");
      await caller.castInitiate({ sessionId });
      await expect(caller.castInitiate({ sessionId })).rejects.toMatchObject({
        code: "CONFLICT",
      });
    });

    test("submit hit writes catch and updates score", async () => {
      const { caller, sessionId } = await startSessionFor("WalletCI3");
      await caller.castInitiate({ sessionId });
      const result = await caller.castSubmit({ sessionId, hit: true });
      expect(result.hit).toBe(true);
      expect(result.catchId).toMatch(/^[0-9a-f]{24}$/);
      expect(result.score).toBeGreaterThan(0);
      expect(result.catchCount).toBe(1);
    });

    test("submit miss increments pity, writes no catch", async () => {
      const { caller, sessionId } = await startSessionFor("WalletCI4");
      await caller.castInitiate({ sessionId });
      const result = await caller.castSubmit({ sessionId, hit: false });
      expect(result.hit).toBe(false);
      expect(result.catchId).toBeNull();
      expect(result.pityCounter).toBe(1);
      expect(result.catchCount).toBe(0);
    });

    test("cancel within grace refunds bait", async () => {
      const { caller, sessionId } = await startSessionFor("WalletCI5");
      await caller.castInitiate({ sessionId });
      const result = await caller.castCancel({ sessionId });
      expect(result.baitRemaining).toBe(10); // refunded
    });

    test("cross-wallet access forbidden", async () => {
      const { sessionId } = await startSessionFor("WalletOwner");
      await createTestPlayer("WalletAttacker", { depositSol: 1.0 });
      const attackerCaller = fishingRouter.createCaller(
        buildContext(makeRedis(), "WalletAttacker"),
      );
      await expect(
        attackerCaller.castInitiate({ sessionId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        attackerCaller.castCancel({ sessionId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        attackerCaller.castSubmit({ sessionId, hit: true }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    test("rejects malformed sessionId via Zod regex", async () => {
      const wallet = "WalletCI6";
      await createTestPlayer(wallet, { depositSol: 1.0 });
      const caller = fishingRouter.createCaller(buildContext(makeRedis(), wallet));
      await expect(
        caller.castInitiate({ sessionId: "not-an-objectid" }),
      ).rejects.toThrow();
    });

    test("rejects unknown sessionId with NOT_FOUND", async () => {
      const wallet = "WalletCI7";
      await createTestPlayer(wallet, { depositSol: 1.0 });
      const caller = fishingRouter.createCaller(buildContext(makeRedis(), wallet));
      await expect(
        caller.castInitiate({ sessionId: "000000000000000000000000" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    test("rejects extra keys in input via .strict()", async () => {
      const wallet = "WalletCI8";
      await createTestPlayer(wallet, { depositSol: 1.0 });
      const caller = fishingRouter.createCaller(buildContext(makeRedis(), wallet));
      const session = await caller.sessionStart();
      await expect(
        caller.castSubmit({
          sessionId: session.sessionId,
          hit: true,
          // @ts-expect-error testing strict-mode rejection
          extraField: "should be rejected",
        }),
      ).rejects.toThrow();
    });
  });

  describe("sessionCommit", () => {
    test("commits a session and returns hex merkleRoot", async () => {
      const wallet = "WalletCM1";
      await createTestPlayer(wallet, { depositSol: 1.0 });
      const caller = fishingRouter.createCaller(buildContext(makeRedis(), wallet));
      const session = await caller.sessionStart();
      await caller.castInitiate({ sessionId: session.sessionId });
      await caller.castSubmit({ sessionId: session.sessionId, hit: true });

      const result = await caller.sessionCommit({ sessionId: session.sessionId });
      expect(result.alreadyCommitted).toBe(false);
      expect(result.catchCount).toBe(1);
      expect(result.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
      expect(result.committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test("idempotent: second commit returns alreadyCommitted=true", async () => {
      const wallet = "WalletCM2";
      await createTestPlayer(wallet, { depositSol: 1.0 });
      const caller = fishingRouter.createCaller(buildContext(makeRedis(), wallet));
      const session = await caller.sessionStart();
      await caller.sessionCommit({ sessionId: session.sessionId });
      const second = await caller.sessionCommit({ sessionId: session.sessionId });
      expect(second.alreadyCommitted).toBe(true);
    });

    test("forbidden across wallets", async () => {
      const ownerWallet = "WalletCMOwner";
      await createTestPlayer(ownerWallet, { depositSol: 1.0 });
      const ownerCaller = fishingRouter.createCaller(
        buildContext(makeRedis(), ownerWallet),
      );
      const session = await ownerCaller.sessionStart();

      await createTestPlayer("WalletCMAttacker", { depositSol: 1.0 });
      const attackerCaller = fishingRouter.createCaller(
        buildContext(makeRedis(), "WalletCMAttacker"),
      );
      await expect(
        attackerCaller.sessionCommit({ sessionId: session.sessionId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("eventsCurrent", () => {
    test("returns inactive when no event configured", async () => {
      const caller = fishingRouter.createCaller(buildContext(makeRedis(), null));
      const res = await caller.eventsCurrent();
      expect(res.active).toBe(false);
      expect(res.name).toBe("");
      expect(res.apexBp).toBe(0);
      expect(res.endsAt).toBeNull();
      expect(res.startsAt).toBeNull();
      expect(res.apexSpeciesIds).toEqual([]);
    });
  });
});

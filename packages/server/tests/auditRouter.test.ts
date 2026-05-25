import { createHash, randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";
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
  FishingDailySeed,
  FishingSession,
  Player,
} from "../src/db/schema.js";
import { auditRouter } from "../src/trpc/auditRouter.js";
import { fishingRouter } from "../src/trpc/fishingRouter.js";
import type { Context } from "../src/trpc/context.js";
import {
  ensureDailySeed,
  getDailySeedAudit,
} from "../src/services/fishing/dailySeed.js";
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
  await FishingDailySeed.syncIndexes();
});
afterAll(async () => {
  await stopTestMongo();
});
afterEach(async () => {
  await clearAllCollections();
});

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

async function createTestPlayer(wallet: string, depositSol: number) {
  return Player.create({
    walletAddress: wallet,
    nickname: `t_${randomBytes(4).toString("hex")}`,
    deposits: [
      {
        poolId: "room-test-1",
        amount: depositSol,
        depositTxSignature: "sig-" + randomBytes(8).toString("hex"),
        activeMonth: "2026-05",
        depositedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        returned: false,
      },
    ],
  });
}

describe("ensureDailySeed", () => {
  test("creates a row if missing, idempotent on second call", async () => {
    const a = await ensureDailySeed("2026-05-09");
    const b = await ensureDailySeed("2026-05-09");
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32);
    const rows = await FishingDailySeed.find({ date: "2026-05-09" });
    expect(rows.length).toBe(1);
  });

  test("two distinct dates get distinct rows", async () => {
    await ensureDailySeed("2026-05-09");
    await ensureDailySeed("2026-05-10");
    const rows = await FishingDailySeed.find({});
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.date === "2026-05-09")).toBeTruthy();
    expect(rows.find((r) => r.date === "2026-05-10")).toBeTruthy();
  });

  test("revealAfter is start of next UTC day", async () => {
    await ensureDailySeed("2026-05-09");
    const row = await FishingDailySeed.findOne({ date: "2026-05-09" });
    expect(row?.revealAfter.toISOString()).toBe("2026-05-10T00:00:00.000Z");
  });

  test("seedHash is sha256(seed)", async () => {
    const seed = await ensureDailySeed("2026-05-11");
    const row = await FishingDailySeed.findOne({ date: "2026-05-11" });
    const expectedHash = createHash("sha256").update(seed).digest();
    expect(Buffer.from(row!.seedHash).equals(expectedHash)).toBe(true);
  });
});

describe("getDailySeedAudit", () => {
  test("hides raw seed before revealAfter", async () => {
    await ensureDailySeed("2026-05-09");
    const view = await getDailySeedAudit(
      "2026-05-09",
      new Date("2026-05-09T15:00:00Z"),
    );
    expect(view).not.toBeNull();
    expect(view!.revealed).toBe(false);
    expect(view!.seed).toBeNull();
    expect(view!.seedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("exposes raw seed after revealAfter", async () => {
    await ensureDailySeed("2026-05-09");
    const view = await getDailySeedAudit(
      "2026-05-09",
      new Date("2026-05-10T00:00:00.001Z"),
    );
    expect(view!.revealed).toBe(true);
    expect(view!.seed).toMatch(/^[0-9a-f]{64}$/);
    // Computed hash matches the published commitment.
    const recomputed = createHash("sha256")
      .update(Buffer.from(view!.seed!, "hex"))
      .digest("hex");
    expect(recomputed).toBe(view!.seedHash);
  });

  test("returns null on unknown date", async () => {
    const view = await getDailySeedAudit("1999-12-31");
    expect(view).toBeNull();
  });
});

describe("auditRouter.dailySeed", () => {
  test("returns commitment-only before reveal", async () => {
    await ensureDailySeed("2026-05-09");
    // Use revealAfter in the future so reveal is gated.
    await FishingDailySeed.updateOne(
      { date: "2026-05-09" },
      { $set: { revealAfter: new Date(Date.now() + 60_000) } },
    );
    const caller = auditRouter.createCaller(buildContext(makeRedis(), null));
    const res = await caller.dailySeed({ date: "2026-05-09" });
    expect(res!.revealed).toBe(false);
    expect(res!.seed).toBeNull();
  });

  test("returns null for unknown date", async () => {
    const caller = auditRouter.createCaller(buildContext(makeRedis(), null));
    const res = await caller.dailySeed({ date: "1999-01-01" });
    expect(res).toBeNull();
  });

  test("rejects malformed date via Zod", async () => {
    const caller = auditRouter.createCaller(buildContext(makeRedis(), null));
    await expect(
      caller.dailySeed({ date: "not-a-date" }),
    ).rejects.toThrow();
  });
});

describe("auditRouter.session", () => {
  test("recomputed digest matches stored merkleRoot after commit", async () => {
    const wallet = "WalletAS1";
    await createTestPlayer(wallet, 1.0);
    const fishingCaller = fishingRouter.createCaller(
      buildContext(makeRedis(), wallet),
    );
    const session = await fishingCaller.sessionStart();
    await fishingCaller.castInitiate({ sessionId: session.sessionId });
    await fishingCaller.castSubmit({ sessionId: session.sessionId, hit: true });
    const commit = await fishingCaller.sessionCommit({
      sessionId: session.sessionId,
    });

    const auditCaller = auditRouter.createCaller(buildContext(makeRedis(), null));
    const audit = await auditCaller.session({ sessionId: session.sessionId });
    expect(audit.merkleRoot).toBe(commit.merkleRoot);
    expect(audit.recomputedDigest).toBe(commit.merkleRoot);
    expect(audit.catches.length).toBe(1);
    expect(audit.status).toBe("committed");
  });

  test("rejects unknown sessionId", async () => {
    const caller = auditRouter.createCaller(buildContext(makeRedis(), null));
    await expect(
      caller.session({ sessionId: "000000000000000000000000" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("active (uncommitted) session: merkleRoot null, digest still computable", async () => {
    const wallet = "WalletAS2";
    await createTestPlayer(wallet, 1.0);
    const fishingCaller = fishingRouter.createCaller(
      buildContext(makeRedis(), wallet),
    );
    const session = await fishingCaller.sessionStart();
    await fishingCaller.castInitiate({ sessionId: session.sessionId });
    await fishingCaller.castSubmit({ sessionId: session.sessionId, hit: true });

    const auditCaller = auditRouter.createCaller(buildContext(makeRedis(), null));
    const audit = await auditCaller.session({ sessionId: session.sessionId });
    expect(audit.status).toBe("active");
    expect(audit.merkleRoot).toBeNull();
    expect(audit.recomputedDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(audit.catches.length).toBe(1);
  });
});

describe("auditRouter.castVerify", () => {
  test("matches when caller supplies the correct daily seed", async () => {
    const wallet = "WalletCV1";
    await createTestPlayer(wallet, 1.0);
    const fishingCaller = fishingRouter.createCaller(
      buildContext(makeRedis(), wallet),
    );
    const session = await fishingCaller.sessionStart();
    const cast = await fishingCaller.castInitiate({ sessionId: session.sessionId });

    // Pull the actual daily seed for the date this session used.
    const sessionRow = await FishingSession.findById(session.sessionId);
    const seedRow = await FishingDailySeed.findOne({ date: sessionRow!.dailySeedDate });
    const dailySeedHex = Buffer.from(seedRow!.seed).toString("hex");

    const auditCaller = auditRouter.createCaller(buildContext(makeRedis(), null));
    const verify = await auditCaller.castVerify({
      sessionId: session.sessionId,
      castIndex: cast.castIndex,
      dailySeed: dailySeedHex,
    });
    expect(verify.matchesStoredHash).toBe(true);
    expect(verify.storedSeedHash).toBe(verify.recomputedSeedHash);
    expect(verify.storedSeedHash).toBe(cast.seedHash);
  });

  test("does not match with a wrong daily seed", async () => {
    const wallet = "WalletCV2";
    await createTestPlayer(wallet, 1.0);
    const fishingCaller = fishingRouter.createCaller(
      buildContext(makeRedis(), wallet),
    );
    const session = await fishingCaller.sessionStart();
    const cast = await fishingCaller.castInitiate({ sessionId: session.sessionId });

    const auditCaller = auditRouter.createCaller(buildContext(makeRedis(), null));
    const verify = await auditCaller.castVerify({
      sessionId: session.sessionId,
      castIndex: cast.castIndex,
      // Wrong seed — all zeros.
      dailySeed: "00".repeat(32),
    });
    expect(verify.matchesStoredHash).toBe(false);
    expect(verify.storedSeedHash).not.toBe(verify.recomputedSeedHash);
  });

  test("rejects when castIndex doesn't match the pending cast", async () => {
    const wallet = "WalletCV3";
    await createTestPlayer(wallet, 1.0);
    const fishingCaller = fishingRouter.createCaller(
      buildContext(makeRedis(), wallet),
    );
    const session = await fishingCaller.sessionStart();
    await fishingCaller.castInitiate({ sessionId: session.sessionId });

    const auditCaller = auditRouter.createCaller(buildContext(makeRedis(), null));
    await expect(
      auditCaller.castVerify({
        sessionId: session.sessionId,
        castIndex: 999,
        dailySeed: "ab".repeat(32),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("rejects when no pending cast (post-resolve)", async () => {
    const wallet = "WalletCV4";
    await createTestPlayer(wallet, 1.0);
    const fishingCaller = fishingRouter.createCaller(
      buildContext(makeRedis(), wallet),
    );
    const session = await fishingCaller.sessionStart();
    const cast = await fishingCaller.castInitiate({ sessionId: session.sessionId });
    await fishingCaller.castSubmit({ sessionId: session.sessionId, hit: true });

    const auditCaller = auditRouter.createCaller(buildContext(makeRedis(), null));
    await expect(
      auditCaller.castVerify({
        sessionId: session.sessionId,
        castIndex: cast.castIndex,
        dailySeed: "ab".repeat(32),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("rejects malformed inputs via Zod", async () => {
    const caller = auditRouter.createCaller(buildContext(makeRedis(), null));
    await expect(
      caller.castVerify({
        sessionId: "not-an-objectid" as never,
        castIndex: 1,
        dailySeed: "ab".repeat(32),
      }),
    ).rejects.toThrow();
    await expect(
      caller.castVerify({
        sessionId: "0".repeat(24),
        castIndex: 1,
        dailySeed: "not-hex" as never,
      }),
    ).rejects.toThrow();
  });

  test("uses Keypair-shaped wallet (real-world session)", async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    await createTestPlayer(wallet, 1.0);
    const fishingCaller = fishingRouter.createCaller(
      buildContext(makeRedis(), wallet),
    );
    const session = await fishingCaller.sessionStart();
    const cast = await fishingCaller.castInitiate({ sessionId: session.sessionId });

    const sessionRow = await FishingSession.findById(session.sessionId);
    const seedRow = await FishingDailySeed.findOne({ date: sessionRow!.dailySeedDate });
    const dailySeedHex = Buffer.from(seedRow!.seed).toString("hex");

    const auditCaller = auditRouter.createCaller(buildContext(makeRedis(), null));
    const verify = await auditCaller.castVerify({
      sessionId: session.sessionId,
      castIndex: cast.castIndex,
      dailySeed: dailySeedHex,
    });
    expect(verify.matchesStoredHash).toBe(true);
  });
});

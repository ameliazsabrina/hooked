import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { Catch, FishingSession, Player } from "../src/db/schema.js";
import {
  initiateCast,
  submitInputSamples,
} from "../src/services/fishing/castEngine.js";
import { CastEngineError } from "../src/services/fishing/errors.js";
import {
  commitSession,
  computeSessionDigest,
  startSession,
} from "../src/services/fishing/sessionEngine.js";
import {
  clearAllCollections,
  startTestMongo,
  stopTestMongo,
} from "./setup.js";

const DAILY_SEED = randomBytes(32);

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

async function makePlayer(wallet = "Wallet" + randomBytes(8).toString("hex")) {
  return Player.create({ walletAddress: wallet });
}

describe("startSession", () => {
  test("creates a fresh session with snapshotted event config", async () => {
    const player = await makePlayer();
    const result = await startSession({
      walletAddress: player.walletAddress,
      baitInitial: 10,
      tier: 1,
      event: {
        active: true,
        name: "Colosseum",
        apexBp: 1000,
        apexSpeciesIds: [20, 21, 22],
      },
      dailySeedDate: "2026-05-09",
      now: new Date(Date.UTC(2026, 4, 9, 8, 0)),
    });
    expect(result.isNew).toBe(true);
    expect(result.window).toBe(0);
    expect(result.baitRemaining).toBe(10);
    expect(result.eventApexBpAtStart).toBe(1000);
    expect(result.status).toBe("active");

    const reloaded = await FishingSession.findById(result.sessionId);
    expect(reloaded?.eventActiveAtStart).toBe(true);
    expect(reloaded?.eventNameAtStart).toBe("Colosseum");
    expect(reloaded?.eventApexBpAtStart).toBe(1000);
    expect(reloaded?.eventApexSpeciesAtStart).toEqual([20, 21, 22]);
  });

  test("idempotent: same player + slot returns existing session", async () => {
    const player = await makePlayer();
    const at = new Date(Date.UTC(2026, 4, 9, 8, 0));
    const first = await startSession({
      walletAddress: player.walletAddress,
      baitInitial: 10,
      tier: 1,
      dailySeedDate: "2026-05-09",
      now: at,
    });
    const second = await startSession({
      walletAddress: player.walletAddress,
      baitInitial: 20,
      tier: 2,
      dailySeedDate: "2026-05-09",
      now: at,
    });
    expect(second.isNew).toBe(false);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.baitRemaining).toBe(10);
  });

  test("rejects unknown wallet", async () => {
    await expect(
      startSession({
        walletAddress: "Ghost11111111111111111111111111111111111111",
        baitInitial: 10,
        tier: 1,
        dailySeedDate: "2026-05-09",
      }),
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });

  test("creates separate sessions for day vs night same calendar day", async () => {
    const player = await makePlayer();
    const day = await startSession({
      walletAddress: player.walletAddress,
      baitInitial: 10,
      tier: 1,
      dailySeedDate: "2026-05-09",
      now: new Date(Date.UTC(2026, 4, 9, 8, 0)),
    });
    const night = await startSession({
      walletAddress: player.walletAddress,
      baitInitial: 10,
      tier: 1,
      dailySeedDate: "2026-05-09",
      now: new Date(Date.UTC(2026, 4, 9, 20, 0)),
    });
    expect(day.window).toBe(0);
    expect(night.window).toBe(1);
    expect(day.sessionId).not.toBe(night.sessionId);
  });

  test("absent event defaults apexBp to 0", async () => {
    const player = await makePlayer();
    const result = await startSession({
      walletAddress: player.walletAddress,
      baitInitial: 10,
      tier: 1,
      dailySeedDate: "2026-05-09",
    });
    expect(result.eventApexBpAtStart).toBe(0);
  });
});

describe("computeSessionDigest", () => {
  test("non-empty digest for zero catches (domain-separated)", () => {
    const d = computeSessionDigest([]);
    expect(d.length).toBe(32);
    const emptyHash = Buffer.from(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "hex",
    );
    expect(d.equals(emptyHash)).toBe(false);
  });

  test("deterministic for same catches", () => {
    const a = computeSessionDigest([
      { castIndex: 1, speciesId: 5, rarity: 1, weightHg: 75, score: 12 },
      { castIndex: 2, speciesId: 0, rarity: 0, weightHg: 25, score: 3 },
    ]);
    const b = computeSessionDigest([
      { castIndex: 2, speciesId: 0, rarity: 0, weightHg: 25, score: 3 },
      { castIndex: 1, speciesId: 5, rarity: 1, weightHg: 75, score: 12 },
    ]);
    expect(a.equals(b)).toBe(true);
  });

  test("different catches → different digests", () => {
    const a = computeSessionDigest([
      { castIndex: 1, speciesId: 5, rarity: 1, weightHg: 75, score: 12 },
    ]);
    const b = computeSessionDigest([
      { castIndex: 1, speciesId: 5, rarity: 1, weightHg: 76, score: 12 },
    ]);
    expect(a.equals(b)).toBe(false);
  });
});

describe("commitSession", () => {
  test("happy path: commits, locks bait, computes digest, bumps player aggregates", async () => {
    const player = await makePlayer();
    const start = await startSession({
      walletAddress: player.walletAddress,
      baitInitial: 10,
      tier: 1,
      dailySeedDate: "2026-05-09",
    });
    for (let i = 0; i < 3; i++) {
      await initiateCast({ sessionId: start.sessionId, dailySeed: DAILY_SEED });
      await submitInputSamples({ sessionId: start.sessionId, hit: true });
    }

    const sessionPre = await FishingSession.findById(start.sessionId);
    const expectedScore = sessionPre!.sessionScore;
    const expectedCatches = sessionPre!.catchCount;
    expect(expectedScore).toBeGreaterThan(0);
    expect(expectedCatches).toBe(3);

    const result = await commitSession({ sessionId: start.sessionId });
    expect(result.alreadyCommitted).toBe(false);
    expect(result.sessionScore).toBe(expectedScore);
    expect(result.catchCount).toBe(expectedCatches);
    expect(result.baitUnused).toBe(7);
    expect(result.merkleRoot.length).toBe(32);

    const reloaded = await FishingSession.findById(start.sessionId);
    expect(reloaded?.status).toBe("committed");
    expect(reloaded?.baitRemaining).toBe(0);
    expect(reloaded?.committedAt).toBeTruthy();
    expect(reloaded?.merkleRoot).toBeTruthy();
    expect(Buffer.from(reloaded!.merkleRoot!).equals(result.merkleRoot)).toBe(true);

    const reloadedPlayer = await Player.findById(player._id);
    expect(reloadedPlayer?.totalScore).toBe(expectedScore);
    expect(reloadedPlayer?.totalCatches).toBe(expectedCatches);
  });

  test("idempotent: second commit returns same result without double-bumping aggregates", async () => {
    const player = await makePlayer();
    const start = await startSession({
      walletAddress: player.walletAddress,
      baitInitial: 10,
      tier: 1,
      dailySeedDate: "2026-05-09",
    });
    await initiateCast({ sessionId: start.sessionId, dailySeed: DAILY_SEED });
    await submitInputSamples({ sessionId: start.sessionId, hit: true });

    const first = await commitSession({ sessionId: start.sessionId });
    expect(first.alreadyCommitted).toBe(false);
    const playerAfterFirst = await Player.findById(player._id);

    const second = await commitSession({ sessionId: start.sessionId });
    expect(second.alreadyCommitted).toBe(true);
    expect(second.sessionScore).toBe(first.sessionScore);
    expect(second.merkleRoot.equals(first.merkleRoot)).toBe(true);

    const playerAfterSecond = await Player.findById(player._id);
    expect(playerAfterSecond?.totalScore).toBe(playerAfterFirst?.totalScore);
    expect(playerAfterSecond?.totalCatches).toBe(playerAfterFirst?.totalCatches);
  });

  test("commits a session with zero catches (digest is still valid)", async () => {
    const player = await makePlayer();
    const start = await startSession({
      walletAddress: player.walletAddress,
      baitInitial: 5,
      tier: 1,
      dailySeedDate: "2026-05-09",
    });
    const result = await commitSession({ sessionId: start.sessionId });
    expect(result.sessionScore).toBe(0);
    expect(result.catchCount).toBe(0);
    expect(result.baitUnused).toBe(5);
    expect(result.merkleRoot.length).toBe(32);
  });

  test("rejects abandoned sessions", async () => {
    const player = await makePlayer();
    const start = await startSession({
      walletAddress: player.walletAddress,
      baitInitial: 5,
      tier: 1,
      dailySeedDate: "2026-05-09",
    });
    await FishingSession.updateOne(
      { _id: start.sessionId },
      { $set: { status: "abandoned" } },
    );
    await expect(
      commitSession({ sessionId: start.sessionId }),
    ).rejects.toMatchObject({ code: "SESSION_NOT_ACTIVE" });
  });

  test("rejects unknown session", async () => {
    await expect(
      commitSession({ sessionId: "000000000000000000000000" }),
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });

  test("reproducibility: digest matches a re-derivation from public catches", async () => {
    const player = await makePlayer();
    const start = await startSession({
      walletAddress: player.walletAddress,
      baitInitial: 10,
      tier: 1,
      dailySeedDate: "2026-05-09",
    });
    for (let i = 0; i < 3; i++) {
      await initiateCast({ sessionId: start.sessionId, dailySeed: DAILY_SEED });
      await submitInputSamples({ sessionId: start.sessionId, hit: true });
    }
    const result = await commitSession({ sessionId: start.sessionId });

    const catches = await Catch.find({ sessionId: start.sessionId })
      .sort({ castIndex: 1 })
      .lean();
    const RARITY_NAME_TO_INT: Record<string, number> = {
      basic: 0, rare: 1, monster: 2, legendary: 3, apex: 4,
    };
    const reDerived = computeSessionDigest(
      catches.map((c) => ({
        castIndex: c.castIndex ?? 0,
        speciesId: c.speciesId ?? 0,
        rarity: RARITY_NAME_TO_INT[c.rarity] ?? 0,
        weightHg: Math.round(c.weightKg * 10),
        score: c.score,
      })),
    );
    expect(reDerived.equals(result.merkleRoot)).toBe(true);
  });
});

import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { Catch, FishingSession, Player } from "../src/db/schema.js";
import { MAX_CATCHES } from "../src/services/fishing/constants.js";
import {
  CANCEL_CAST_GRACE_SECS,
  cancelCast,
  initiateCast,
  submitInputSamples,
} from "../src/services/fishing/castEngine.js";
import { CastEngineError } from "../src/services/fishing/errors.js";
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

async function makeSession(overrides: Partial<{
  baitRemaining: number;
  status: "active" | "committed" | "abandoned";
  pendingCast: NonNullable<ReturnType<typeof FishingSession.prototype.toObject>["pendingCast"]>;
  castCount: number;
  pityCounter: number;
  eventApexBpAtStart: number;
}> = {}) {
  const player = await Player.create({
    walletAddress: "Wallet" + randomBytes(8).toString("hex"),
  });
  const session = await FishingSession.create({
    playerId: player._id,
    walletAddress: player.walletAddress,
    dateKey: 20_000,
    window: 0,
    baitInitial: 10,
    baitRemaining: overrides.baitRemaining ?? 10,
    tier: 1,
    castCount: overrides.castCount ?? 0,
    pityCounter: overrides.pityCounter ?? 0,
    status: overrides.status ?? "active",
    pendingCast: overrides.pendingCast ?? null,
    dailySeedDate: "2026-05-09",
    eventApexBpAtStart: overrides.eventApexBpAtStart ?? 0,
  });
  return { player, session };
}

describe("initiateCast", () => {
  test("happy path: decrements bait, increments castCount, sets pendingCast", async () => {
    const { session } = await makeSession({ baitRemaining: 10 });
    const result = await initiateCast({ sessionId: session._id, dailySeed: DAILY_SEED });

    expect(result.castIndex).toBe(1);
    expect(result.baitRemaining).toBe(9);
    expect(result.seedHash.length).toBe(32);

    const reloaded = await FishingSession.findById(session._id);
    expect(reloaded?.baitRemaining).toBe(9);
    expect(reloaded?.castCount).toBe(1);
    expect(reloaded?.pendingCast).not.toBeNull();
    expect(reloaded?.pendingCast?.castIndex).toBe(1);
    expect(reloaded?.pendingCast?.speciesId).toBe(result.speciesId);
  });

  test("rejects when no bait", async () => {
    const { session } = await makeSession({ baitRemaining: 0 });
    await expect(
      initiateCast({ sessionId: session._id, dailySeed: DAILY_SEED }),
    ).rejects.toMatchObject({ code: "NO_BAIT" });
  });

  test("rejects when session is not active", async () => {
    const { session } = await makeSession({ status: "committed" });
    await expect(
      initiateCast({ sessionId: session._id, dailySeed: DAILY_SEED }),
    ).rejects.toMatchObject({ code: "SESSION_NOT_ACTIVE" });
  });

  test("rejects when cast already pending", async () => {
    const { session } = await makeSession();
    await initiateCast({ sessionId: session._id, dailySeed: DAILY_SEED });
    await expect(
      initiateCast({ sessionId: session._id, dailySeed: DAILY_SEED }),
    ).rejects.toMatchObject({ code: "CAST_PENDING" });
  });

  test("rejects when session not found", async () => {
    await expect(
      initiateCast({ sessionId: "000000000000000000000000", dailySeed: DAILY_SEED }),
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });

  test("concurrent initiates: one succeeds, one races", async () => {
    const { session } = await makeSession();
    const [a, b] = await Promise.allSettled([
      initiateCast({ sessionId: session._id, dailySeed: DAILY_SEED }),
      initiateCast({ sessionId: session._id, dailySeed: DAILY_SEED }),
    ]);
    const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
    const rejected = [a, b].filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    const losingCode = (rejected[0] as PromiseRejectedResult).reason.code;
    expect(["CAST_PENDING", "CAST_RACE"]).toContain(losingCode);
  });
});

describe("cancelCast", () => {
  test("happy path within grace: refunds bait, clears pendingCast", async () => {
    const { session } = await makeSession({ baitRemaining: 10 });
    await initiateCast({ sessionId: session._id, dailySeed: DAILY_SEED });
    const result = await cancelCast({ sessionId: session._id });
    expect(result.baitRemaining).toBe(10);

    const reloaded = await FishingSession.findById(session._id);
    expect(reloaded?.pendingCast).toBeNull();
    expect(reloaded?.baitRemaining).toBe(10);
    expect(reloaded?.castCount).toBe(1);
  });

  test("rejects after grace expired", async () => {
    const { session } = await makeSession();
    const cast = await initiateCast({
      sessionId: session._id,
      dailySeed: DAILY_SEED,
      now: new Date(2026, 0, 1),
    });
    expect(cast.castAt.getTime()).toBe(new Date(2026, 0, 1).getTime());
    await expect(
      cancelCast({
        sessionId: session._id,
        now: new Date(2026, 0, 1, 0, 0, CANCEL_CAST_GRACE_SECS + 1),
      }),
    ).rejects.toMatchObject({ code: "CANCEL_GRACE_EXPIRED" });
  });

  test("rejects when no pending cast", async () => {
    const { session } = await makeSession();
    await expect(
      cancelCast({ sessionId: session._id }),
    ).rejects.toMatchObject({ code: "NO_CAST_TO_RESOLVE" });
  });
});

describe("submitInputSamples", () => {
  test("hit on basic: writes catch, increments pity, adds score", async () => {
    const { session } = await makeSession({ pityCounter: 3 });
    let cast = await initiateCast({ sessionId: session._id, dailySeed: DAILY_SEED });
    for (let i = 0; i < 20 && cast.rarity !== 0; i++) {
      await cancelCast({ sessionId: session._id });
      cast = await initiateCast({ sessionId: session._id, dailySeed: DAILY_SEED });
    }
    if (cast.rarity !== 0) return;

    const result = await submitInputSamples({ sessionId: session._id, hit: true });
    expect(result.hit).toBe(true);
    expect(result.catchId).toBeTruthy();
    expect(result.score).toBeGreaterThan(0);
    expect(result.pityCounter).toBe(4);
    expect(result.catchCount).toBe(1);

    const catchDoc = await Catch.findOne({ sessionId: session._id });
    expect(catchDoc?.castIndex).toBe(cast.castIndex);
    expect(catchDoc?.speciesId).toBe(cast.speciesId);
    expect(catchDoc?.zone).toBe("open_sea");
  });

  test("hit on rare+: resets pity to 0", async () => {
    const { session } = await makeSession({ pityCounter: 7, eventApexBpAtStart: 5000 });
    let cast = await initiateCast({ sessionId: session._id, dailySeed: DAILY_SEED });
    for (let i = 0; i < 30 && cast.rarity < 1; i++) {
      await cancelCast({ sessionId: session._id });
      cast = await initiateCast({ sessionId: session._id, dailySeed: DAILY_SEED });
    }
    expect(cast.rarity).toBeGreaterThanOrEqual(1);

    const result = await submitInputSamples({ sessionId: session._id, hit: true });
    expect(result.pityCounter).toBe(0);
  });

  test("miss: no catch written, pity increments, pendingCast cleared", async () => {
    const { session } = await makeSession({ pityCounter: 5 });
    await initiateCast({ sessionId: session._id, dailySeed: DAILY_SEED });

    const result = await submitInputSamples({ sessionId: session._id, hit: false });
    expect(result.hit).toBe(false);
    expect(result.catchId).toBeNull();
    expect(result.score).toBe(0);
    expect(result.pityCounter).toBe(6);

    const catches = await Catch.countDocuments({ sessionId: session._id });
    expect(catches).toBe(0);
    const reloaded = await FishingSession.findById(session._id);
    expect(reloaded?.pendingCast).toBeNull();
    expect(reloaded?.catchCount).toBe(0);
  });

  test("rejects when no pending cast", async () => {
    const { session } = await makeSession();
    await expect(
      submitInputSamples({ sessionId: session._id, hit: true }),
    ).rejects.toMatchObject({ code: "NO_CAST_TO_RESOLVE" });
  });

  test("rejects hit when MAX_CATCHES reached", async () => {
    const { session } = await makeSession({ baitRemaining: 30 });
    await FishingSession.updateOne({ _id: session._id }, { $set: { catchCount: MAX_CATCHES } });
    await initiateCast({ sessionId: session._id, dailySeed: DAILY_SEED });
    await expect(
      submitInputSamples({ sessionId: session._id, hit: true }),
    ).rejects.toMatchObject({ code: "CATCHES_FULL" });
  });

  test("client weight=0 falls back to rolled weight", async () => {
    const { session } = await makeSession();
    const cast = await initiateCast({ sessionId: session._id, dailySeed: DAILY_SEED });
    const result = await submitInputSamples({ sessionId: session._id, hit: true, weightHg: 0 });
    expect(result.hit).toBe(true);
    const c = await Catch.findOne({ sessionId: session._id });
    expect(c?.weightKg).toBe(cast.weightHg / 10);
  });

  test("client-supplied weightHg used when nonzero", async () => {
    const { session } = await makeSession();
    await initiateCast({ sessionId: session._id, dailySeed: DAILY_SEED });
    const result = await submitInputSamples({
      sessionId: session._id,
      hit: true,
      weightHg: 50,
    });
    expect(result.hit).toBe(true);
    const c = await Catch.findOne({ sessionId: session._id });
    expect(c?.weightKg).toBe(5);
  });
});

describe("end-to-end cast cycle", () => {
  test("initiate → submit → initiate again chains correctly", async () => {
    const { session } = await makeSession({ baitRemaining: 10 });

    const cast1 = await initiateCast({ sessionId: session._id, dailySeed: DAILY_SEED });
    expect(cast1.castIndex).toBe(1);
    expect(cast1.baitRemaining).toBe(9);

    await submitInputSamples({ sessionId: session._id, hit: true });

    const cast2 = await initiateCast({ sessionId: session._id, dailySeed: DAILY_SEED });
    expect(cast2.castIndex).toBe(2);
    expect(cast2.baitRemaining).toBe(8);

    const reloaded = await FishingSession.findById(session._id);
    expect(reloaded?.castCount).toBe(2);
    expect(reloaded?.catchCount).toBe(1);
  });

  test("initiate → cancel → initiate keeps castCount monotonic", async () => {
    const { session } = await makeSession({ baitRemaining: 10 });
    const cast1 = await initiateCast({ sessionId: session._id, dailySeed: DAILY_SEED });
    expect(cast1.castIndex).toBe(1);
    await cancelCast({ sessionId: session._id });

    const cast2 = await initiateCast({ sessionId: session._id, dailySeed: DAILY_SEED });
    expect(cast2.castIndex).toBe(2);
    const reloaded = await FishingSession.findById(session._id);
    expect(reloaded?.baitRemaining).toBe(9);
  });
});

describe("CastEngineError", () => {
  test("preserves code field on thrown errors", async () => {
    try {
      await initiateCast({ sessionId: "000000000000000000000000", dailySeed: DAILY_SEED });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CastEngineError);
      expect((err as CastEngineError).code).toBe("SESSION_NOT_FOUND");
    }
  });
});

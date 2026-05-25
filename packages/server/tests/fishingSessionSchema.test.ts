import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import {
  Catch,
  FishingSession,
  Player,
} from "../src/db/schema.js";
import { assignWindow, dateKeyToISO } from "../src/services/fishing/window.js";
import {
  clearAllCollections,
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

async function makePlayer(wallet = "Wallet111111111111111111111111111111111111") {
  return Player.create({ walletAddress: wallet });
}

function fakeSeedHash(label: string): Buffer {
  return createHash("sha256").update(label).digest();
}

describe("FishingSession schema", () => {
  test("creates a session with sane defaults", async () => {
    const player = await makePlayer();
    const session = await FishingSession.create({
      playerId: player._id,
      walletAddress: player.walletAddress,
      dateKey: 20_000,
      window: 0,
      baitInitial: 10,
      baitRemaining: 10,
      tier: 0,
      dailySeedDate: "2026-05-09",
    });

    expect(session.status).toBe("active");
    expect(session.sessionScore).toBe(0);
    expect(session.castCount).toBe(0);
    expect(session.catchCount).toBe(0);
    expect(session.pityCounter).toBe(0);
    expect(session.pendingCast).toBeNull();
    expect(session.committedAt).toBeNull();
    expect(session.merkleRoot).toBeNull();
    expect(session.eventActiveAtStart).toBe(false);
    expect(session.startedAt).toBeInstanceOf(Date);
  });

  test("enforces unique (playerId, dateKey, window)", async () => {
    const player = await makePlayer();
    const base = {
      playerId: player._id,
      walletAddress: player.walletAddress,
      dateKey: 20_001,
      window: 0 as const,
      baitInitial: 10,
      baitRemaining: 10,
      dailySeedDate: "2026-05-09",
    };
    await FishingSession.create(base);
    await expect(FishingSession.create(base)).rejects.toThrow();
  });

  test("allows distinct sessions for same player across windows", async () => {
    const player = await makePlayer();
    const day = await FishingSession.create({
      playerId: player._id,
      walletAddress: player.walletAddress,
      dateKey: 20_002,
      window: 0,
      baitInitial: 10,
      baitRemaining: 10,
      dailySeedDate: "2026-05-09",
    });
    const night = await FishingSession.create({
      playerId: player._id,
      walletAddress: player.walletAddress,
      dateKey: 20_002,
      window: 1,
      baitInitial: 10,
      baitRemaining: 10,
      dailySeedDate: "2026-05-09",
    });
    expect(day.id).not.toBe(night.id);
  });

  test("rejects invalid window value", async () => {
    const player = await makePlayer();
    await expect(
      FishingSession.create({
        playerId: player._id,
        walletAddress: player.walletAddress,
        dateKey: 20_003,
        window: 2 as unknown as 0,
        baitInitial: 10,
        baitRemaining: 10,
        dailySeedDate: "2026-05-09",
      }),
    ).rejects.toThrow();
  });

  test("pendingCast subdoc enforces shape", async () => {
    const player = await makePlayer();
    const session = await FishingSession.create({
      playerId: player._id,
      walletAddress: player.walletAddress,
      dateKey: 20_004,
      window: 0,
      baitInitial: 10,
      baitRemaining: 10,
      dailySeedDate: "2026-05-09",
      pendingCast: {
        castIndex: 1,
        speciesId: 5,
        rarity: 1,
        weightHg: 75,
        greenZoneStart: 3000,
        greenZoneWidth: 2000,
        mechanic: 0,
        castAt: new Date(),
        seedHash: fakeSeedHash("c1"),
      },
    });
    expect(session.pendingCast).not.toBeNull();
    expect(session.pendingCast?.speciesId).toBe(5);
    expect(session.pendingCast?.seedHash).toBeInstanceOf(Buffer);
    expect(session.pendingCast?.seedHash.length).toBe(32);
  });

  test("rejects rarity outside 0..4", async () => {
    const player = await makePlayer();
    await expect(
      FishingSession.create({
        playerId: player._id,
        walletAddress: player.walletAddress,
        dateKey: 20_005,
        window: 0,
        baitInitial: 10,
        baitRemaining: 10,
        dailySeedDate: "2026-05-09",
        pendingCast: {
          castIndex: 1,
          speciesId: 5,
          rarity: 5,
          weightHg: 75,
          greenZoneStart: 3000,
          greenZoneWidth: 2000,
          mechanic: 0,
          castAt: new Date(),
          seedHash: fakeSeedHash("c1"),
        },
      }),
    ).rejects.toThrow();
  });

  test("can clear pendingCast back to null", async () => {
    const player = await makePlayer();
    const session = await FishingSession.create({
      playerId: player._id,
      walletAddress: player.walletAddress,
      dateKey: 20_006,
      window: 0,
      baitInitial: 10,
      baitRemaining: 10,
      dailySeedDate: "2026-05-09",
      pendingCast: {
        castIndex: 1,
        speciesId: 5,
        rarity: 1,
        weightHg: 75,
        greenZoneStart: 3000,
        greenZoneWidth: 2000,
        mechanic: 0,
        castAt: new Date(),
        seedHash: fakeSeedHash("c1"),
      },
    });
    await FishingSession.updateOne({ _id: session._id }, { $set: { pendingCast: null } });
    const reloaded = await FishingSession.findById(session._id).lean();
    expect(reloaded?.pendingCast).toBeNull();
  });

  test("status transition active → committed sets committedAt", async () => {
    const player = await makePlayer();
    const session = await FishingSession.create({
      playerId: player._id,
      walletAddress: player.walletAddress,
      dateKey: 20_007,
      window: 0,
      baitInitial: 10,
      baitRemaining: 3,
      dailySeedDate: "2026-05-09",
      castCount: 7,
      sessionScore: 142,
    });
    const committedAt = new Date();
    const merkleRoot = Buffer.alloc(32, 0xab);
    await FishingSession.updateOne(
      { _id: session._id, status: "active" },
      { $set: { status: "committed", committedAt, merkleRoot } },
    );
    const reloaded = await FishingSession.findById(session._id);
    expect(reloaded?.status).toBe("committed");
    expect(reloaded?.committedAt?.getTime()).toBe(committedAt.getTime());
    const root = reloaded?.merkleRoot;
    expect(root).toBeTruthy();
    expect(Buffer.from(root as Uint8Array).length).toBe(32);
    expect(Buffer.from(root as Uint8Array).every((b) => b === 0xab)).toBe(true);
  });
});

describe("Catch ↔ FishingSession linkage", () => {
  test("can persist a catch with sessionId + castIndex + speciesId", async () => {
    const player = await makePlayer();
    const session = await FishingSession.create({
      playerId: player._id,
      walletAddress: player.walletAddress,
      dateKey: 20_010,
      window: 0,
      baitInitial: 10,
      baitRemaining: 9,
      dailySeedDate: "2026-05-09",
    });
    const c = await Catch.create({
      playerId: player._id,
      sessionId: session._id,
      castIndex: 1,
      speciesId: 5,
      species: "rare-species-name",
      rarity: "rare",
      weightKg: 0.75,
      score: 12,
      zone: "open_sea",
    });
    expect(c.sessionId?.toString()).toBe(session._id.toString());
    expect(c.castIndex).toBe(1);
    expect(c.speciesId).toBe(5);
  });

  test("rejects catches with legacy zone values post-migration", async () => {
    const player = await makePlayer();
    await expect(
      Catch.create({
        playerId: player._id,
        species: "x",
        rarity: "basic",
        weightKg: 0.3,
        score: 3,
        zone: "shore",
      }),
    ).rejects.toThrow();
  });

  test("legacy catches without sessionId still load", async () => {
    const player = await makePlayer();
    await mongoose.connection.collection("catches").insertOne({
      playerId: player._id,
      species: "legacy",
      rarity: "basic",
      weightKg: 0.3,
      score: 3,
      zone: "shore",
      isBounty: false,
      released: false,
      sellValue: 0,
      caughtAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const found = await Catch.findOne({ playerId: player._id }).lean();
    expect(found?.sessionId).toBeFalsy();
    expect(found?.castIndex).toBeFalsy();
  });
});

describe("assignWindow", () => {
  test("01:30 UTC → night window of yesterday", () => {
    const { window, dateKey } = assignWindow(new Date(Date.UTC(2026, 4, 9, 1, 30)));
    expect(window).toBe(1);
    expect(dateKeyToISO(dateKey)).toBe("2026-05-08");
  });

  test("08:00 UTC → day window today", () => {
    const { window, dateKey } = assignWindow(new Date(Date.UTC(2026, 4, 9, 8, 0)));
    expect(window).toBe(0);
    expect(dateKeyToISO(dateKey)).toBe("2026-05-09");
  });

  test("20:00 UTC → night window today", () => {
    const { window, dateKey } = assignWindow(new Date(Date.UTC(2026, 4, 9, 20, 0)));
    expect(window).toBe(1);
    expect(dateKeyToISO(dateKey)).toBe("2026-05-09");
  });

  test("dateKey is days since epoch", () => {
    const epoch = new Date(Date.UTC(1970, 0, 1, 12, 0));
    const { dateKey } = assignWindow(epoch);
    expect(dateKey).toBe(0);
    const oneDayLater = new Date(Date.UTC(1970, 0, 2, 12, 0));
    expect(assignWindow(oneDayLater).dateKey).toBe(1);
  });
});

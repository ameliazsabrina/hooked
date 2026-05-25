import { randomBytes } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "vitest";

import { Catch, FishingEvent, Player } from "../src/db/schema.ts";
import {
  computeEventWinners,
  EVENT_PRIZE_WEIGHTS_PCT,
} from "../src/services/eventWinners.ts";
import {
  clearAllCollections,
  startTestMongo,
  stopTestMongo,
} from "./setup.ts";

beforeAll(async () => {
  await startTestMongo();
  await FishingEvent.syncIndexes();
});
afterAll(async () => {
  await stopTestMongo();
});
afterEach(async () => {
  await clearAllCollections();
});

async function makePlayer(label: string) {
  return Player.create({
    walletAddress: `Wallet${label}11111111111111111111111111111111`.slice(0, 44),
    nickname: `t_${randomBytes(4).toString("hex")}`,
    shellBalance: 0,
  });
}

interface SeedCatchOpts {
  playerId: unknown;
  caughtAt: Date;
  score: number;
}
async function seedCatch(opts: SeedCatchOpts) {
  return Catch.create({
    playerId: opts.playerId,
    species: "TestFish",
    speciesId: 0,
    rarity: "basic",
    weightKg: 1,
    score: opts.score,
    zone: "open_sea",
    isBounty: false,
    released: false,
    sellValue: 0,
    caughtAt: opts.caughtAt,
  });
}

async function makeEndedEvent(prizePoolSol = 10) {
  return FishingEvent.create({
    name: "Test",
    active: false,
    startsAt: new Date(Date.now() - 2 * 60 * 60_000),
    endsAt: new Date(Date.now() - 60 * 60_000),
    apexBp: 1000,
    prizePoolSol,
    apexSpeciesIds: [20, 21, 22],
    createdBy: "Admin1111111111111111111111111111111111111",
  });
}

describe("computeEventWinners", () => {
  test("ranks players by total score within the event window", async () => {
    const event = await makeEndedEvent(10);
    const p1 = await makePlayer("aaa");
    const p2 = await makePlayer("bbb");
    const p3 = await makePlayer("ccc");

    const inWindow = new Date(event.startsAt.getTime() + 30 * 60_000);
    await seedCatch({ playerId: p1._id, caughtAt: inWindow, score: 50 });
    await seedCatch({ playerId: p1._id, caughtAt: inWindow, score: 50 });
    await seedCatch({ playerId: p2._id, caughtAt: inWindow, score: 80 });
    await seedCatch({ playerId: p3._id, caughtAt: inWindow, score: 30 });

    const result = await computeEventWinners(String(event._id));
    expect(result.alreadyComputed).toBe(false);
    expect(result.ranks).toHaveLength(3);
    expect(result.ranks[0].walletAddress).toBe(p1.walletAddress); // 100
    expect(result.ranks[0].score).toBe(100);
    expect(result.ranks[1].walletAddress).toBe(p2.walletAddress); // 80
    expect(result.ranks[2].walletAddress).toBe(p3.walletAddress); // 30
  });

  test("ignores catches outside the event window", async () => {
    const event = await makeEndedEvent();
    const p = await makePlayer("ddd");
    const before = new Date(event.startsAt.getTime() - 60_000);
    const after = new Date(event.endsAt.getTime() + 60_000);
    await seedCatch({ playerId: p._id, caughtAt: before, score: 10_000 });
    await seedCatch({ playerId: p._id, caughtAt: after, score: 10_000 });

    const result = await computeEventWinners(String(event._id));
    expect(result.ranks).toEqual([]);
  });

  test("applies the prize-split formula", async () => {
    const prizePool = 100;
    const event = await makeEndedEvent(prizePool);
    const inWindow = new Date(event.startsAt.getTime() + 30 * 60_000);
    // 12 players to overflow the top-10 cap.
    for (let i = 0; i < 12; i++) {
      const p = await makePlayer(`p${i}`);
      await seedCatch({
        playerId: p._id,
        caughtAt: inWindow,
        score: 1000 - i, // descending so player 0 wins
      });
    }

    const result = await computeEventWinners(String(event._id));
    expect(result.ranks).toHaveLength(EVENT_PRIZE_WEIGHTS_PCT.length);
    for (let i = 0; i < result.ranks.length; i++) {
      const expected =
        Math.round(((prizePool * EVENT_PRIZE_WEIGHTS_PCT[i]) / 100) * 1e9) / 1e9;
      expect(result.ranks[i].prizeSol).toBeCloseTo(expected, 9);
      expect(result.ranks[i].rank).toBe(i + 1);
      expect(result.ranks[i].paid).toBe(false);
      expect(result.ranks[i].signature).toBeNull();
    }
    const totalPaid = result.ranks.reduce((s, r) => s + r.prizeSol, 0);
    expect(totalPaid).toBeCloseTo(prizePool, 6);
  });

  test("idempotent by default: doesn't overwrite already-computed ranks", async () => {
    const event = await makeEndedEvent();
    const p = await makePlayer("e1");
    const inWindow = new Date(event.startsAt.getTime() + 30 * 60_000);
    await seedCatch({ playerId: p._id, caughtAt: inWindow, score: 100 });

    const first = await computeEventWinners(String(event._id));
    expect(first.alreadyComputed).toBe(false);
    expect(first.ranks).toHaveLength(1);

    // Add more catches after the first compute. The default call shouldn't
    // pick them up.
    await seedCatch({ playerId: p._id, caughtAt: inWindow, score: 99 });
    const second = await computeEventWinners(String(event._id));
    expect(second.alreadyComputed).toBe(true);
    expect(second.ranks[0].score).toBe(100);
  });

  test("force: true recomputes from scratch", async () => {
    const event = await makeEndedEvent();
    const p = await makePlayer("f1");
    const inWindow = new Date(event.startsAt.getTime() + 30 * 60_000);
    await seedCatch({ playerId: p._id, caughtAt: inWindow, score: 100 });
    await computeEventWinners(String(event._id));

    await seedCatch({ playerId: p._id, caughtAt: inWindow, score: 50 });
    const second = await computeEventWinners(String(event._id), { force: true });
    expect(second.alreadyComputed).toBe(false);
    expect(second.ranks[0].score).toBe(150);
  });

  test("zero catches: persists empty array, not null", async () => {
    const event = await makeEndedEvent();
    const result = await computeEventWinners(String(event._id));
    expect(result.ranks).toEqual([]);
    const reread = await FishingEvent.findById(event._id).lean();
    expect(reread?.finalRanks).toEqual([]);
  });

  test("refuses to compute before endsAt", async () => {
    const event = await FishingEvent.create({
      name: "Future",
      active: true,
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 60_000),
      apexBp: 1000,
      prizePoolSol: 1,
      apexSpeciesIds: [20],
      createdBy: "Admin1111111111111111111111111111111111111",
    });
    await expect(computeEventWinners(String(event._id))).rejects.toThrow(/hasn't ended/);
  });

  test("rejects unknown event", async () => {
    await expect(
      computeEventWinners("000000000000000000000000"),
    ).rejects.toThrow(/not found/);
  });
});

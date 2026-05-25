import { randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { ADMIN_SESSION } from "../src/trpc/trpc.ts";
import { Catch, FishingEvent, Player } from "../src/db/schema.ts";
import { adminEventRouter } from "../src/trpc/admin/eventRouter.ts";
import type { Context } from "../src/trpc/context.ts";
import { TEST_ADMIN_PUBKEY } from "./testAdmin.ts";
import {
  clearAllCollections,
  makeFreshRedis,
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

let redis: ReturnType<typeof makeFreshRedis> extends Promise<infer R> ? R : never;

beforeEach(async () => {
  redis = await makeFreshRedis();
});

async function mintAdminSession(): Promise<{ ctx: Context; token: string }> {
  const token = randomBytes(16).toString("hex");
  await redis.set(
    `${ADMIN_SESSION.redisPrefix}${token}`,
    TEST_ADMIN_PUBKEY,
    "EX",
    ADMIN_SESSION.ttlSeconds,
  );
  const ctx: Context = {
    walletAddress: null,
    sessionToken: token,
    ipCountry: null,
    ipAddress: "127.0.0.1",
    adminHeaders: {
      wallet: null,
      timestamp: null,
      nonce: null,
      signature: null,
    },
    redis,
  };
  return { ctx, token };
}

async function caller() {
  const { ctx } = await mintAdminSession();
  return adminEventRouter.createCaller(ctx);
}

const FUTURE = (mins: number) => new Date(Date.now() + mins * 60_000);
const PAST = (mins: number) => new Date(Date.now() - mins * 60_000);

const VALID_CREATE = {
  name: "Colosseum",
  startsAt: FUTURE(10),
  endsAt: FUTURE(70),
  apexBp: 1000,
  prizePoolSol: 5,
  apexSpeciesIds: [20, 21, 22],
};

describe("admin.event router — apexCatalog & list", () => {
  test("apexCatalog returns the filesystem-driven entries with FISH_SPECIES match", async () => {
    const c = await caller();
    const catalog = await c.apexCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(3);
    for (const entry of catalog) {
      expect(entry.id).toBeGreaterThanOrEqual(0);
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.filename).toBe("string");
      expect(entry.assetPath).toMatch(/^\/assets\/fish\/apex\//);
      expect(entry.assetUrl).toContain(entry.assetPath);
      expect(entry.weightMin).toBeGreaterThan(0);
      expect(entry.weightMax).toBeGreaterThanOrEqual(entry.weightMin);
    }
    // The 3 shipped apex fish (FISH_SPECIES indices 20/21/22) should all be present.
    const ids = catalog.map((entry) => entry.id);
    expect(ids).toContain(20);
    expect(ids).toContain(21);
    expect(ids).toContain(22);
  });

  test("list returns paginated events", async () => {
    const c = await caller();
    await c.create(VALID_CREATE);
    await c.create({ ...VALID_CREATE, name: "Other" });
    const res = await c.list({ status: "all", page: 1, limit: 50 });
    expect(res.events.length).toBe(2);
    expect(res.total).toBe(2);
  });

  test("list filters by status: scheduled", async () => {
    const c = await caller();
    await c.create({ ...VALID_CREATE, name: "Future" });
    // Create a doc with past endsAt directly via DB to simulate "ended".
    await FishingEvent.create({
      name: "Past",
      active: false,
      startsAt: PAST(120),
      endsAt: PAST(60),
      apexBp: 1000,
      prizePoolSol: 1,
      apexSpeciesIds: [20],
      createdBy: "Admin1",
    });
    const sched = await c.list({ status: "scheduled", page: 1, limit: 50 });
    expect(sched.events.map((e) => e.name)).toEqual(["Future"]);
    const ended = await c.list({ status: "ended", page: 1, limit: 50 });
    expect(ended.events.map((e) => e.name)).toEqual(["Past"]);
  });
});

describe("admin.event.create", () => {
  test("happy path persists with active: false", async () => {
    const c = await caller();
    const created = await c.create(VALID_CREATE);
    expect(created.name).toBe("Colosseum");
    expect(created.active).toBe(false);
    expect(created.status).toBe("scheduled");
    expect(created.apexSpeciesIds).toEqual([20, 21, 22]);
    expect(created.createdBy).toBe(TEST_ADMIN_PUBKEY);
  });

  test("rejects endsAt <= startsAt", async () => {
    const c = await caller();
    await expect(
      c.create({ ...VALID_CREATE, startsAt: FUTURE(70), endsAt: FUTURE(10) }),
    ).rejects.toThrow();
  });

  test("rejects apexBp > 5000", async () => {
    const c = await caller();
    await expect(
      c.create({ ...VALID_CREATE, apexBp: 5001 }),
    ).rejects.toThrow();
  });

  test("rejects empty apexSpeciesIds", async () => {
    const c = await caller();
    await expect(
      c.create({ ...VALID_CREATE, apexSpeciesIds: [] }),
    ).rejects.toThrow();
  });

  test("rejects non-Apex species id", async () => {
    const c = await caller();
    await expect(
      c.create({ ...VALID_CREATE, apexSpeciesIds: [0] }), // id 0 is Basic
    ).rejects.toThrow(/apex/i);
  });
});

describe("admin.event.update / activate / deactivate", () => {
  test("update rejects edits to an active event", async () => {
    const c = await caller();
    const ev = await c.create(VALID_CREATE);
    await c.activate({ id: ev.id });
    await expect(c.update({ id: ev.id, name: "Renamed" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  test("update edits an inactive event", async () => {
    const c = await caller();
    const ev = await c.create(VALID_CREATE);
    const updated = await c.update({ id: ev.id, name: "Renamed" });
    expect(updated.name).toBe("Renamed");
  });

  test("activate refuses if another event is already active", async () => {
    const c = await caller();
    const a = await c.create({ ...VALID_CREATE, name: "First" });
    const b = await c.create({ ...VALID_CREATE, name: "Second" });
    await c.activate({ id: a.id });
    await expect(c.activate({ id: b.id })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("deactivate triggers winners-compute when endsAt has passed", async () => {
    const c = await caller();
    // Create directly (in-window) and activate.
    const ev = await FishingEvent.create({
      name: "Live",
      active: true,
      startsAt: PAST(60),
      endsAt: PAST(1),
      apexBp: 1000,
      prizePoolSol: 1,
      apexSpeciesIds: [20],
      createdBy: TEST_ADMIN_PUBKEY,
    });
    const result = await c.deactivate({ id: String(ev._id) });
    expect(result.event.active).toBe(false);
    expect(result.winnersComputedAt).not.toBeNull();
    expect(result.winnersError).toBeNull();
    const reread = await FishingEvent.findById(ev._id).lean();
    expect(reread?.finalRanks).toEqual([]);
  });
});

describe("admin.event winners flow", () => {
  test("computeWinners + payAllWinners walks the dashboard flow", async () => {
    const c = await caller();
    const player = await Player.create({
      walletAddress: "Wallet1111111111111111111111111111111111111",
      nickname: "player1",
      shellBalance: 0,
    });
    const ev = await FishingEvent.create({
      name: "Done",
      active: false,
      startsAt: PAST(120),
      endsAt: PAST(60),
      apexBp: 1000,
      prizePoolSol: 10,
      apexSpeciesIds: [20],
      createdBy: TEST_ADMIN_PUBKEY,
    });
    await Catch.create({
      playerId: player._id,
      species: "TestFish",
      speciesId: 0,
      rarity: "basic",
      weightKg: 1,
      score: 100,
      zone: "open_sea",
      isBounty: false,
      released: false,
      sellValue: 0,
      caughtAt: PAST(90),
    });

    const computed = await c.computeWinners({ id: String(ev._id), force: false });
    expect(computed.alreadyComputed).toBe(false);
    expect(computed.ranks.length).toBe(1);
    expect(computed.ranks[0].walletAddress).toBe(player.walletAddress);
    expect(computed.ranks[0].paid).toBe(false);

    const payAll = await c.payAllWinners({ id: String(ev._id) });
    expect(payAll.ok).toBe(true);
    expect(payAll.paid).toBe(1);

    const reread = await FishingEvent.findById(ev._id).lean();
    expect(reread?.finalRanks?.[0].paid).toBe(true);
    expect(reread?.finalRanks?.[0].signature).toBeTruthy();
  });

  test("payAllWinners is idempotent on a fully-paid event", async () => {
    const c = await caller();
    const ev = await FishingEvent.create({
      name: "PaidUp",
      active: false,
      startsAt: PAST(120),
      endsAt: PAST(60),
      apexBp: 1000,
      prizePoolSol: 10,
      apexSpeciesIds: [20],
      createdBy: TEST_ADMIN_PUBKEY,
      finalRanks: [
        {
          rank: 1,
          walletAddress: "wallet",
          displayName: "Anon",
          score: 100,
          prizeSol: 10,
          paid: true,
          signature: "sig",
          paidAt: new Date(),
          attempts: 1,
          lastError: null,
        },
      ],
    });
    const result = await c.payAllWinners({ id: String(ev._id) });
    expect(result.paid).toBe(0);
  });
});

describe("admin.event.delete", () => {
  test("refuses to delete an active event", async () => {
    const c = await caller();
    const ev = await c.create(VALID_CREATE);
    await c.activate({ id: ev.id });
    await expect(c.delete({ id: ev.id })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("refuses to delete an event with finalRanks (audit trail)", async () => {
    const c = await caller();
    const ev = await FishingEvent.create({
      name: "Audited",
      active: false,
      startsAt: PAST(120),
      endsAt: PAST(60),
      apexBp: 1000,
      prizePoolSol: 1,
      apexSpeciesIds: [20],
      createdBy: TEST_ADMIN_PUBKEY,
      finalRanks: [
        {
          rank: 1,
          walletAddress: "w",
          displayName: "A",
          score: 1,
          prizeSol: 1,
          paid: false,
          signature: null,
          paidAt: null,
          attempts: 0,
          lastError: null,
        },
      ],
    });
    await expect(c.delete({ id: String(ev._id) })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  test("deletes a clean inactive event", async () => {
    const c = await caller();
    const ev = await c.create(VALID_CREATE);
    const result = await c.delete({ id: ev.id });
    expect(result.ok).toBe(true);
    expect(await FishingEvent.findById(ev.id).lean()).toBeNull();
  });
});

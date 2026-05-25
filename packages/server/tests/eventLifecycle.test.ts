import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "vitest";

import { FishingEvent } from "../src/db/schema.ts";
import { processEventLifecycleTick } from "../src/jobs/eventLifecycle.ts";
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

interface MakeOpts {
  active?: boolean;
  startsAt?: Date;
  endsAt?: Date;
  name?: string;
}
async function makeEvent(opts: MakeOpts = {}) {
  return FishingEvent.create({
    name: opts.name ?? "Test",
    active: opts.active ?? false,
    startsAt: opts.startsAt ?? new Date(Date.now() - 60_000),
    endsAt: opts.endsAt ?? new Date(Date.now() + 60 * 60_000),
    apexBp: 1000,
    prizePoolSol: 1,
    apexSpeciesIds: [20, 21, 22],
    createdBy: "Admin1111111111111111111111111111111111111",
  });
}

describe("processEventLifecycleTick", () => {
  test("noop when nothing to do", async () => {
    const outcome = await processEventLifecycleTick();
    expect(outcome.promoted).toEqual([]);
    expect(outcome.demoted).toEqual([]);
  });

  test("promotes a scheduled event whose window has opened", async () => {
    const ev = await makeEvent({
      active: false,
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 60 * 60_000),
    });
    const outcome = await processEventLifecycleTick();
    expect(outcome.promoted).toEqual([String(ev._id)]);
    const reread = await FishingEvent.findById(ev._id);
    expect(reread?.active).toBe(true);
  });

  test("demotes an active event whose endsAt has passed and computes winners", async () => {
    const ev = await makeEvent({
      active: true,
      startsAt: new Date(Date.now() - 2 * 60 * 60_000),
      endsAt: new Date(Date.now() - 60_000),
    });
    const outcome = await processEventLifecycleTick();
    expect(outcome.demoted).toEqual([String(ev._id)]);
    expect(outcome.computedWinnersFor).toEqual([String(ev._id)]);
    const reread = await FishingEvent.findById(ev._id);
    expect(reread?.active).toBe(false);
    expect(reread?.finalRanks).toEqual([]);
  });

  test("does not promote when another event is already active", async () => {
    const active = await makeEvent({
      active: true,
      name: "Existing",
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 60 * 60_000),
    });
    const candidate = await makeEvent({
      active: false,
      name: "Wannabe",
      startsAt: new Date(Date.now() - 30_000),
      endsAt: new Date(Date.now() + 30 * 60_000),
    });
    const outcome = await processEventLifecycleTick();
    expect(outcome.promoted).toEqual([]);
    const a = await FishingEvent.findById(active._id);
    const c = await FishingEvent.findById(candidate._id);
    expect(a?.active).toBe(true);
    expect(c?.active).toBe(false);
  });

  test("simultaneous demote + promote is one transaction", async () => {
    const ending = await makeEvent({
      active: true,
      name: "Ending",
      startsAt: new Date(Date.now() - 2 * 60 * 60_000),
      endsAt: new Date(Date.now() - 60_000),
    });
    const starting = await makeEvent({
      active: false,
      name: "Starting",
      startsAt: new Date(Date.now() - 30_000),
      endsAt: new Date(Date.now() + 60 * 60_000),
    });
    const outcome = await processEventLifecycleTick();
    expect(outcome.demoted).toEqual([String(ending._id)]);
    expect(outcome.promoted).toEqual([String(starting._id)]);
    const e = await FishingEvent.findById(ending._id);
    const s = await FishingEvent.findById(starting._id);
    expect(e?.active).toBe(false);
    expect(s?.active).toBe(true);
  });

  test("idempotent: running twice in the same minute is a noop the second time", async () => {
    const ev = await makeEvent({
      active: false,
      startsAt: new Date(Date.now() - 60_000),
    });
    const first = await processEventLifecycleTick();
    expect(first.promoted).toEqual([String(ev._id)]);
    const second = await processEventLifecycleTick();
    expect(second.promoted).toEqual([]);
    expect(second.demoted).toEqual([]);
  });
});

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { FishingEvent } from "../src/db/schema.ts";
import {
  _resetEventCache,
  getActiveApexBp,
  getActiveEvent,
  getEventStatus,
  onEventChange,
} from "../src/services/eventConfig.ts";
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
  _resetEventCache();
});
beforeEach(() => {
  _resetEventCache();
});

async function seedActiveEvent(overrides: {
  name?: string;
  startsAt?: Date;
  endsAt?: Date;
  apexBp?: number;
  apexSpeciesIds?: number[];
} = {}) {
  return FishingEvent.create({
    name: overrides.name ?? "Test Event",
    active: true,
    startsAt: overrides.startsAt ?? new Date(Date.now() - 60_000),
    endsAt: overrides.endsAt ?? new Date(Date.now() + 60 * 60_000),
    apexBp: overrides.apexBp ?? 1000,
    prizePoolSol: 5,
    apexSpeciesIds: overrides.apexSpeciesIds ?? [20, 21, 22],
    createdBy: "Admin1111111111111111111111111111111111111",
  });
}

describe("getEventStatus / getActiveEvent — DB-backed", () => {
  test("returns null when no active event in DB", async () => {
    const status = await getEventStatus(true);
    expect(status).toBeNull();
    expect(getActiveEvent()).toBeNull();
    expect(getActiveApexBp()).toBe(0);
  });

  test("returns the active event with new shape (name, apexSpeciesIds)", async () => {
    await seedActiveEvent({
      name: "Colosseum",
      apexBp: 2500,
      apexSpeciesIds: [20, 21],
    });
    const status = await getEventStatus(true);
    expect(status).not.toBeNull();
    expect(status?.name).toBe("Colosseum");
    expect(status?.apexBp).toBe(2500);
    expect(status?.apexSpeciesIds).toEqual([20, 21]);
    expect(getActiveApexBp()).toBe(2500);
    expect(getActiveEvent()?.name).toBe("Colosseum");
  });

  test("self-heals: an active row whose endsAt has passed reads as inactive", async () => {
    await seedActiveEvent({
      startsAt: new Date(Date.now() - 2 * 60 * 60_000),
      endsAt: new Date(Date.now() - 60_000),
    });
    const status = await getEventStatus(true);
    expect(status).toBeNull();
    expect(getActiveEvent()).toBeNull();
  });

  test("self-heals: a future-scheduled event is not yet active", async () => {
    await FishingEvent.create({
      name: "Future",
      active: false,
      startsAt: new Date(Date.now() + 60 * 60_000),
      endsAt: new Date(Date.now() + 2 * 60 * 60_000),
      apexBp: 1000,
      prizePoolSol: 1,
      apexSpeciesIds: [20],
      createdBy: "Admin1111111111111111111111111111111111111",
    });
    const status = await getEventStatus(true);
    expect(status).toBeNull();
  });
});

describe("eventConfig caching", () => {
  test("force=false returns the cached value without re-querying within the TTL", async () => {
    await seedActiveEvent({ name: "First" });
    const first = await getEventStatus(true);
    expect(first?.name).toBe("First");

    await FishingEvent.updateMany({}, { $set: { name: "Second" } });
    const cached = await getEventStatus(false);
    expect(cached?.name).toBe("First");

    const fresh = await getEventStatus(true);
    expect(fresh?.name).toBe("Second");
  });
});

describe("onEventChange listener", () => {
  test("fires when status transitions to a different value", async () => {
    const events: Array<{ name: string } | null> = [];
    const unsubscribe = onEventChange((status) => {
      events.push(status ? { name: status.name } : null);
    });

    await getEventStatus(true);
    expect(events).toEqual([]);

    await seedActiveEvent({ name: "Alpha" });
    await getEventStatus(true);
    expect(events).toEqual([{ name: "Alpha" }]);

    await getEventStatus(true);
    expect(events).toEqual([{ name: "Alpha" }]);

    await FishingEvent.updateMany({}, { $set: { name: "Beta" } });
    await getEventStatus(true);
    expect(events).toEqual([{ name: "Alpha" }, { name: "Beta" }]);

    unsubscribe();
  });

  test("unsubscribe stops the listener", async () => {
    const events: unknown[] = [];
    const unsubscribe = onEventChange((s) => events.push(s?.name ?? null));
    unsubscribe();
    await seedActiveEvent({ name: "Zeta" });
    await getEventStatus(true);
    expect(events).toEqual([]);
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { KeeperHeartbeat } from "../src/db/schema.js";
import {
  recordKeeperTick,
  getKeeperHealth,
  KEEPER_STALENESS_MS,
  MAX_CONSECUTIVE_ERRORS,
} from "../src/services/keeperHeartbeat.js";
import {
  startTestMongo,
  stopTestMongo,
  clearAllCollections,
} from "./setup.js";

describe("keeperHeartbeat", () => {
  beforeAll(async () => {
    await startTestMongo();
  });
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearAllCollections();
  });

  describe("recordKeeperTick", () => {
    it("creates a new row on first call (upsert)", async () => {
      await recordKeeperTick("room-lifecycle", "ok");
      const row = await KeeperHeartbeat.findOne({
        keeperName: "room-lifecycle",
      }).lean();
      expect(row).not.toBeNull();
      expect(row?.lastTickStatus).toBe("ok");
      expect(row?.consecutiveErrors).toBe(0);
      expect(row?.lastError).toBeNull();
      expect(row?.lastTickAt).toBeInstanceOf(Date);
    });

    it("resets consecutiveErrors when a tick succeeds after failures", async () => {
      await recordKeeperTick("room-lifecycle", "error", "redis timeout");
      await recordKeeperTick("room-lifecycle", "error", "redis timeout");
      let row = await KeeperHeartbeat.findOne({
        keeperName: "room-lifecycle",
      }).lean();
      expect(row?.consecutiveErrors).toBe(2);
      expect(row?.lastError).toBe("redis timeout");

      await recordKeeperTick("room-lifecycle", "ok");
      row = await KeeperHeartbeat.findOne({
        keeperName: "room-lifecycle",
      }).lean();
      expect(row?.consecutiveErrors).toBe(0);
      expect(row?.lastError).toBeNull();
      expect(row?.lastTickStatus).toBe("ok");
    });

    it("increments consecutiveErrors on each failure", async () => {
      await recordKeeperTick("event-lifecycle", "error", "boom");
      await recordKeeperTick("event-lifecycle", "error", "boom");
      await recordKeeperTick("event-lifecycle", "error", "boom");
      const row = await KeeperHeartbeat.findOne({
        keeperName: "event-lifecycle",
      }).lean();
      expect(row?.consecutiveErrors).toBe(3);
    });

    it("clamps lastError to 500 chars to avoid bloating the doc", async () => {
      const longMsg = "x".repeat(2000);
      await recordKeeperTick("room-lifecycle", "error", longMsg);
      const row = await KeeperHeartbeat.findOne({
        keeperName: "room-lifecycle",
      }).lean();
      expect(row?.lastError?.length).toBe(500);
    });
  });

  describe("getKeeperHealth", () => {
    it("reports stale=true and healthy=false when no rows exist (never-ticked)", async () => {
      const report = await getKeeperHealth();
      expect(report.healthy).toBe(false);
      expect(report.keepers).toHaveLength(2);
      for (const k of report.keepers) {
        expect(k.stale).toBe(true);
        expect(k.lastTickAt).toBeNull();
        expect(k.ageMs).toBeNull();
        expect(k.consecutiveErrors).toBe(0);
      }
    });

    it("reports healthy=true when all keepers ticked recently and clean", async () => {
      await recordKeeperTick("room-lifecycle", "ok");
      await recordKeeperTick("event-lifecycle", "ok");
      const report = await getKeeperHealth();
      expect(report.healthy).toBe(true);
      for (const k of report.keepers) {
        expect(k.stale).toBe(false);
        expect(k.lastTickStatus).toBe("ok");
        expect(k.consecutiveErrorsAboveThreshold).toBe(false);
      }
    });

    it("reports stale=true when lastTickAt is older than the threshold", async () => {
      await recordKeeperTick("room-lifecycle", "ok");
      const past = new Date(
        Date.now() - KEEPER_STALENESS_MS["room-lifecycle"] - 60_000,
      );
      await KeeperHeartbeat.updateOne(
        { keeperName: "room-lifecycle" },
        { $set: { lastTickAt: past } },
      );
      await recordKeeperTick("event-lifecycle", "ok");

      const report = await getKeeperHealth();
      expect(report.healthy).toBe(false);
      const room = report.keepers.find(
        (k) => k.keeperName === "room-lifecycle",
      );
      const event = report.keepers.find(
        (k) => k.keeperName === "event-lifecycle",
      );
      expect(room?.stale).toBe(true);
      expect(event?.stale).toBe(false);
    });

    it("reports unhealthy when consecutiveErrors >= MAX_CONSECUTIVE_ERRORS even if recent", async () => {
      for (let i = 0; i < MAX_CONSECUTIVE_ERRORS; i++) {
        await recordKeeperTick("room-lifecycle", "error", `attempt ${i}`);
      }
      // Event-lifecycle is healthy
      await recordKeeperTick("event-lifecycle", "ok");

      const report = await getKeeperHealth();
      expect(report.healthy).toBe(false);
      const room = report.keepers.find(
        (k) => k.keeperName === "room-lifecycle",
      );
      expect(room?.stale).toBe(false); // last tick was just now
      expect(room?.consecutiveErrors).toBe(MAX_CONSECUTIVE_ERRORS);
      expect(room?.consecutiveErrorsAboveThreshold).toBe(true);
      expect(room?.lastError).toMatch(/attempt /);
    });

    it("returns per-keeper threshold for ops drill-down", async () => {
      const report = await getKeeperHealth();
      const room = report.keepers.find(
        (k) => k.keeperName === "room-lifecycle",
      );
      const event = report.keepers.find(
        (k) => k.keeperName === "event-lifecycle",
      );
      // Room threshold should be bigger than event (15m × 2 vs 1m × 2).
      expect(room?.stalenessThresholdMs).toBeGreaterThan(
        event?.stalenessThresholdMs ?? 0,
      );
    });

    it("ageMs reflects elapsed time since lastTickAt", async () => {
      const fakeNow = new Date("2026-05-18T12:00:00.000Z");
      await recordKeeperTick("room-lifecycle", "ok");
      await KeeperHeartbeat.updateOne(
        { keeperName: "room-lifecycle" },
        { $set: { lastTickAt: new Date(fakeNow.getTime() - 5 * 60_000) } },
      );
      await recordKeeperTick("event-lifecycle", "ok");
      const report = await getKeeperHealth(fakeNow);
      const room = report.keepers.find(
        (k) => k.keeperName === "room-lifecycle",
      );
      expect(room?.ageMs).toBe(5 * 60_000);
      expect(room?.stale).toBe(false); // 5m < 31m threshold
    });
  });
});

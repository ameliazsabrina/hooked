import { KeeperHeartbeat } from "../db/schema.js";

// Heartbeat lives in Mongo (not Redis): Redis itself is the most likely
// "keeper dead" failure mode, so the store would mask the symptom.

export type KeeperName = "room-lifecycle" | "event-lifecycle";

/** Budget = (cron interval) × 2 + 60s to absorb a missed tick without flapping. */
export const KEEPER_STALENESS_MS: Record<KeeperName, number> = {
  "room-lifecycle": 15 * 60 * 1000 * 2 + 60_000,
  "event-lifecycle": 60_000 * 2 + 60_000,
};

/** "Running but broken" — ticks fire but always error. */
export const MAX_CONSECUTIVE_ERRORS = 5;

/** Best-effort write — failures are logged but don't propagate. */
export async function recordKeeperTick(
  keeperName: KeeperName,
  status: "ok" | "error",
  errorMessage?: string,
): Promise<void> {
  try {
    if (status === "ok") {
      await KeeperHeartbeat.updateOne(
        { keeperName },
        {
          $set: {
            keeperName,
            lastTickAt: new Date(),
            lastTickStatus: "ok",
            lastError: null,
            consecutiveErrors: 0,
          },
        },
        { upsert: true },
      );
    } else {
      await KeeperHeartbeat.updateOne(
        { keeperName },
        {
          $set: {
            keeperName,
            lastTickAt: new Date(),
            lastTickStatus: "error",
            lastError: errorMessage?.slice(0, 500) ?? "(no message)",
          },
          $inc: { consecutiveErrors: 1 },
        },
        { upsert: true },
      );
    }
  } catch (err) {
    console.error(
      `[keeperHeartbeat] failed to record ${keeperName}=${status}: ${(err as Error).message}`,
    );
  }
}

export type KeeperHealthEntry = {
  keeperName: KeeperName;
  lastTickAt: string | null;
  ageMs: number | null;
  stalenessThresholdMs: number;
  stale: boolean;
  lastTickStatus: "ok" | "error" | null;
  consecutiveErrors: number;
  consecutiveErrorsAboveThreshold: boolean;
  lastError: string | null;
};

export type KeeperHealthReport = {
  healthy: boolean;
  /** ISO of the check time. */
  now: string;
  keepers: KeeperHealthEntry[];
};

/**
 * Unhealthy when consecutiveErrors >= MAX, lastTickAt > threshold,
 * or no row exists (treated as stale).
 */
export async function getKeeperHealth(
  now: Date = new Date(),
): Promise<KeeperHealthReport> {
  const rows = await KeeperHeartbeat.find({}).lean();
  const byName = new Map(rows.map((r) => [r.keeperName, r]));

  const entries: KeeperHealthEntry[] = (
    Object.keys(KEEPER_STALENESS_MS) as KeeperName[]
  ).map((keeperName) => {
    const row = byName.get(keeperName);
    const threshold = KEEPER_STALENESS_MS[keeperName];
    const lastTickAt = row?.lastTickAt ?? null;
    const ageMs = lastTickAt ? now.getTime() - lastTickAt.getTime() : null;
    const stale = ageMs === null || ageMs > threshold;
    const consecutiveErrors = row?.consecutiveErrors ?? 0;
    return {
      keeperName,
      lastTickAt: lastTickAt ? lastTickAt.toISOString() : null,
      ageMs,
      stalenessThresholdMs: threshold,
      stale,
      lastTickStatus: (row?.lastTickStatus as "ok" | "error" | undefined) ?? null,
      consecutiveErrors,
      consecutiveErrorsAboveThreshold:
        consecutiveErrors >= MAX_CONSECUTIVE_ERRORS,
      lastError: row?.lastError ?? null,
    };
  });

  const healthy = entries.every(
    (e) => !e.stale && !e.consecutiveErrorsAboveThreshold,
  );
  return { healthy, now: now.toISOString(), keepers: entries };
}

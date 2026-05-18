import { KeeperHeartbeat } from "../db/schema.js";

/**
 * Heartbeat plumbing for BullMQ keepers.
 *
 * Every scheduled worker is expected to call `recordKeeperTick` at the
 * end of its work — once for success ("ok"), once for failure ("error").
 * The /healthz/keeper endpoint then queries `getKeeperHealth` and 500s
 * when any required keeper is stale or has too many consecutive errors.
 *
 * The store lives in Mongo, not Redis, because the most likely "keeper
 * is dead" failure mode is Redis itself (BullMQ scheduler key lost on
 * Redis flush / TLS cert rotation / connection storm). Storing the
 * heartbeat in the same store as the trigger would mask that failure.
 *
 * Heartbeat writes are best-effort — a Mongo write failure should not
 * prevent the keeper from completing its actual work. `recordKeeperTick`
 * swallows errors and logs them, so the keeper's own outcome is reported
 * to BullMQ normally.
 */

/** Known keeper names. Used as the `keeperName` unique key and matched
 *  by the /healthz/keeper endpoint against per-keeper staleness budgets. */
export type KeeperName = "room-lifecycle" | "event-lifecycle";

/** Maximum age (ms) between ticks before /healthz/keeper considers a
 *  keeper stale. Budget is `(cron interval) × 2 + 60s` to absorb a
 *  single missed tick + Mongo write latency without flapping. */
export const KEEPER_STALENESS_MS: Record<KeeperName, number> = {
  // room-lifecycle cron: every 15 min → stale at 31 min
  "room-lifecycle": 15 * 60 * 1000 * 2 + 60_000,
  // event-lifecycle cron: every 1 min → stale at 3 min
  "event-lifecycle": 60_000 * 2 + 60_000,
};

/** Threshold for treating a keeper as "running but broken" — every tick
 *  succeeds in firing but the work itself keeps erroring. Flagged by
 *  the health endpoint even when the last tick is recent. */
export const MAX_CONSECUTIVE_ERRORS = 5;

/**
 * Write a heartbeat for the given keeper. Idempotent: the same tick
 * called twice in rapid succession just overwrites. On status="error",
 * `consecutiveErrors` increments via $inc; on status="ok", it's reset.
 *
 * Failures here are swallowed and logged — see file-level docstring.
 */
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
    // Best-effort: don't let heartbeat write failures mask the real work.
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
 * Return a per-keeper health report. Reads from Mongo, no side effects.
 * Used by the /healthz/keeper Fastify route to decide 200 vs 500.
 *
 * A keeper is unhealthy when:
 *   1. `consecutiveErrors >= MAX_CONSECUTIVE_ERRORS`, OR
 *   2. `lastTickAt` is older than its `stalenessThresholdMs`, OR
 *   3. no heartbeat row exists at all (keeper never ran since deploy —
 *      treated as stale because we can't distinguish "first boot" from
 *      "totally broken").
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

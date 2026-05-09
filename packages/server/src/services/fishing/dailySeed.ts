import { createHash, randomBytes } from "node:crypto";

import { env } from "../../config/env.js";
import { FishingDailySeed } from "../../db/schema.js";

/**
 * UTC date string used as `dailySeedDate` on FishingSession documents and as
 * the primary key for FishingDailySeed rows.
 */
export function dailySeedDateFor(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Start of the UTC day that follows `dateISO` (e.g. "2026-05-09" → 2026-05-10
 * 00:00:00.000 UTC). Used as `revealAfter` so today's seed becomes
 * audit-visible only after the day is over.
 */
function nextUtcMidnight(dateISO: string): Date {
  const [y, m, d] = dateISO.split("-").map((s) => Number(s));
  return new Date(Date.UTC(y, m - 1, d + 1));
}

/**
 * Lazily ensure a FishingDailySeed row exists for the given UTC date and
 * return the raw seed buffer. Idempotent — concurrent callers see the same
 * row (mongoose unique index on `date`).
 *
 * Bootstrap: if `FISHING_DAILY_SEED_HEX` env is set AND no row exists yet
 * (typically test setup or first prod boot), the env value is used as the
 * seed bytes. Otherwise a fresh `randomBytes(32)` is generated. After the
 * first row is written, env is ignored — DB is the source of truth.
 */
export async function ensureDailySeed(dateISO: string): Promise<Buffer> {
  const existing = await FishingDailySeed.findOne({ date: dateISO });
  if (existing) return Buffer.from(existing.seed);

  const seed = env.FISHING_DAILY_SEED_HEX
    ? Buffer.from(env.FISHING_DAILY_SEED_HEX, "hex")
    : randomBytes(32);
  const seedHash = createHash("sha256").update(seed).digest();
  const revealAfter = nextUtcMidnight(dateISO);

  // Race-safe: another caller may have written the row between our find and
  // create. The unique index makes the second create throw — fall through to
  // re-fetch and return the winner's seed.
  try {
    const row = await FishingDailySeed.create({
      date: dateISO,
      seed,
      seedHash,
      publishedAt: new Date(),
      revealAfter,
    });
    return Buffer.from(row.seed);
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const winner = await FishingDailySeed.findOne({ date: dateISO });
      if (winner) return Buffer.from(winner.seed);
    }
    throw err;
  }
}

/**
 * Load today's daily seed for use by castEngine. Async because it may need
 * to write a fresh row on first call. Cast routes already run in async
 * handlers so this doesn't ripple through the API.
 */
export async function loadDailySeed(now: Date = new Date()): Promise<Buffer> {
  const dateISO = dailySeedDateFor(now);
  return ensureDailySeed(dateISO);
}

/**
 * Audit view: always exposes the commitment (seedHash). Exposes the raw seed
 * only after `revealAfter`. Returns null if no row exists for the date.
 */
export interface DailySeedAuditView {
  date: string;
  seedHash: string;
  publishedAt: string;
  revealAfter: string;
  revealed: boolean;
  /** Hex-encoded raw seed, only populated if revealed. */
  seed: string | null;
}

export async function getDailySeedAudit(
  dateISO: string,
  now: Date = new Date(),
): Promise<DailySeedAuditView | null> {
  // Don't use .lean() — mongoose returns Buffer fields as BSON Binary in
  // lean mode, which doesn't round-trip through `Buffer.from(...).toString
  // ("hex")` cleanly. Hydrated docs preserve Node Buffer.
  const row = await FishingDailySeed.findOne({ date: dateISO });
  if (!row) return null;
  const revealed = now >= row.revealAfter;
  return {
    date: row.date,
    seedHash: Buffer.from(row.seedHash as unknown as Uint8Array).toString("hex"),
    publishedAt: row.publishedAt.toISOString(),
    revealAfter: row.revealAfter.toISOString(),
    revealed,
    seed: revealed
      ? Buffer.from(row.seed as unknown as Uint8Array).toString("hex")
      : null,
  };
}

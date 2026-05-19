import { createHash, randomBytes } from "node:crypto";

import { env } from "../../config/env.js";
import { FishingDailySeed } from "../../db/schema.js";

export function dailySeedDateFor(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function nextUtcMidnight(dateISO: string): Date {
  const [y, m, d] = dateISO.split("-").map((s) => Number(s));
  return new Date(Date.UTC(y, m - 1, d + 1));
}

/**
 * Idempotent (unique index on date). Bootstrap uses
 * FISHING_DAILY_SEED_HEX if set and no row exists; DB is source of truth after.
 */
export async function ensureDailySeed(dateISO: string): Promise<Buffer> {
  const existing = await FishingDailySeed.findOne({ date: dateISO });
  if (existing) return Buffer.from(existing.seed);

  const seed = env.FISHING_DAILY_SEED_HEX
    ? Buffer.from(env.FISHING_DAILY_SEED_HEX, "hex")
    : randomBytes(32);
  const seedHash = createHash("sha256").update(seed).digest();
  const revealAfter = nextUtcMidnight(dateISO);

  // Race-safe via unique index — re-fetch the winner on 11000.
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

export async function loadDailySeed(now: Date = new Date()): Promise<Buffer> {
  const dateISO = dailySeedDateFor(now);
  return ensureDailySeed(dateISO);
}

/** Raw seed exposed only after revealAfter. */
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
  // Hydrated (not .lean()) — lean returns BSON Binary, not Node Buffer.
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

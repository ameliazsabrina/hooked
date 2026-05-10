import type Redis from "ioredis";
import { Player, PoolTier } from "../db/schema.js";
import * as lb from "./leaderboard.js";
import { scheduleLeaderboardBroadcast } from "../ws/gateway.js";

// Numeric rarity index → string. Mirrors the FishRarity enum order in
// `@hooked/shared`; kept inline so this module doesn't pull the shared
// package just for a five-element array.
const RARITY_NAMES = ["basic", "rare", "monster", "legendary", "apex"] as const;

// Daily-tier leaderboard key. POOL_TIERS is `[1]` today; if more tiers are
// added, this constant should follow whatever tier the cast actually came
// from (which means threading it through the credit call).
const DAILY_TIER = 1;

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

// Pool docs flip at month boundaries; cache the lookup so we don't hit
// Mongo on every catch. Cache is keyed by month string so the entry
// auto-invalidates when the month rolls over.
let activePoolCache: { month: string; poolId: string | null } | null = null;

/** Test-only: drops the cached active pool id so each test starts fresh. */
export function __resetActivePoolCacheForTests(): void {
  activePoolCache = null;
}

async function resolveActivePoolId(): Promise<string | null> {
  const month = currentMonth();
  if (activePoolCache && activePoolCache.month === month) {
    return activePoolCache.poolId;
  }
  const pool = await PoolTier.findOne(
    { tier: DAILY_TIER, activeMonth: month },
    { _id: 1 },
  ).lean();
  const poolId = pool?._id?.toString() ?? null;
  activePoolCache = { month, poolId };
  return poolId;
}

interface CreditCatchInput {
  redis: Redis;
  walletAddress: string;
  score: number;
  weightHg: number;
  rarity: number;
  speciesName: string;
  roomId: string | null;
}

/**
 * Credit a successful catch to room, daily-tier, and pool leaderboards.
 *
 * Caller must invoke this only after a persisted hit (off-chain submit
 * succeeded) so the LB stays consistent with the Mongo catch rows.
 * Failures are logged and swallowed — a Redis hiccup must never break
 * the WS catch reply.
 */
export async function creditCatch(input: CreditCatchInput): Promise<void> {
  const { redis, walletAddress, score, weightHg, rarity, speciesName, roomId } =
    input;

  if (score <= 0) return;

  try {
    const player = await Player.findOne(
      { walletAddress },
      { _id: 1 },
    ).lean();
    if (!player) {
      console.warn(
        `[lb] no player row for wallet ${walletAddress}; skipping credit`,
      );
      return;
    }
    const playerId = player._id.toString();
    const date = todayUTC();
    const rarityName = RARITY_NAMES[rarity] ?? `unknown:${rarity}`;
    const topCatch = {
      species: speciesName,
      rarity: rarityName,
      weightKg: weightHg / 10,
      score,
    };

    const poolId = await resolveActivePoolId();

    const ops: Promise<unknown>[] = [
      lb.addScore(redis, DAILY_TIER, date, playerId, score),
      lb.updateTopCatch(redis, DAILY_TIER, date, playerId, topCatch),
    ];
    if (roomId) {
      ops.push(lb.addRoomScore(redis, roomId, playerId, score));
      ops.push(lb.updateRoomTopCatch(redis, roomId, playerId, topCatch));
    }
    if (poolId) {
      ops.push(lb.addPoolScore(redis, poolId, playerId, score));
      ops.push(lb.updatePoolTopCatch(redis, poolId, playerId, topCatch));
    }

    await Promise.all(ops);

    // Schedule a real-time fan-out to all sockets in this room so other
    // players see the new score without waiting on the tRPC poll. Debounced
    // per-room inside the gateway — bursts of catches collapse into one
    // broadcast.
    if (roomId) scheduleLeaderboardBroadcast(roomId);
  } catch (err) {
    console.error("[lb] creditCatch failed:", (err as Error).message);
  }
}

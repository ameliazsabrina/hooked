import type Redis from "ioredis";
import { Player, PoolTier } from "../db/schema.js";
import * as lb from "./leaderboard.js";
import { scheduleLeaderboardBroadcast } from "../ws/gateway.js";

const RARITY_NAMES = ["basic", "rare", "monster", "legendary", "apex"] as const;

const DAILY_TIER = 1;

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

// Keyed by month so it auto-invalidates on rollover.
let activePoolCache: { month: string; poolId: string | null } | null = null;

/** Test-only. */
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

/** Caller must only invoke after a persisted hit. Failures are swallowed. */
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

    // Per-room debounced fan-out so other players see the score in real time.
    if (roomId) scheduleLeaderboardBroadcast(roomId);
  } catch (err) {
    console.error("[lb] creditCatch failed:", (err as Error).message);
  }
}

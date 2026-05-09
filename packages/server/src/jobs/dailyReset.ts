import { Worker, type ConnectionOptions, type Job } from "bullmq";
import { POOL_TIERS, DEPOSIT_APY_ESTIMATE } from "@hooked/shared";
import { PoolTier, DailyLeaderboard, Player } from "../db/schema.js";
import * as lb from "../services/leaderboard.js";
import Redis from "ioredis";
import { getOrCreateCurrentPeriod } from "../bounties/period.js";
import { awardLeaderboardRankBounty } from "../bounties/progress.js";

function yesterdayUTC(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

async function processDailyReset(job: Job) {
  const closingDate = yesterdayUTC();
  const month = currentMonth();

  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  const redis = new Redis(redisUrl);

  try {
    for (const tier of POOL_TIERS) {
      const poolTier = await PoolTier.findOne({ tier, activeMonth: month }).lean();
      if (!poolTier || poolTier.realPlayerCount === 0) continue;

      const allScores = await lb.getAllScores(redis, tier, closingDate);
      const topCatches = await lb.getTopCatches(
        redis,
        tier,
        closingDate,
        allScores.map((s) => s.member)
      );

      const playerIds = allScores.map((s) => s.member);
      const players = playerIds.length > 0
        ? await Player.find({ _id: { $in: playerIds } }, { _id: 1, nickname: 1 }).lean()
        : [];
      const playerNameMap = new Map(players.map((p) => [p._id.toString(), p.nickname ?? "Anonymous"]));

      const entries = allScores.map((s) => ({
        playerId: s.member,
        displayName: playerNameMap.get(s.member) ?? "Anonymous",
        dailyScore: s.score,
        catchCount: 0,
        topCatch: topCatches.get(s.member) ?? null,
      }));

      const grossYield = (tier * poolTier.realPlayerCount * DEPOSIT_APY_ESTIMATE) / 365;

      await DailyLeaderboard.findOneAndUpdate(
        { date: closingDate, tier },
        {
          $set: {
            entries,
            prizePool: grossYield,
            distributed: false,
          },
        },
        { upsert: true }
      );

      job.log(`Tier ${tier}: ${entries.length} entries, est. daily yield ${grossYield.toFixed(9)} SOL`);
    }

    try {
      await resolveLeaderboardBounties();
    } catch (err) {
      console.error("[bounty] resolveLeaderboardBounties failed", err);
    }
  } finally {
    await redis.quit();
  }
}

async function resolveLeaderboardBounties() {
  const period = await getOrCreateCurrentPeriod("weekly");
  const rankSlots = period.slots.filter(
    (s) => s.goalType === "leaderboard_rank"
  );
  if (rankSlots.length === 0) return;

  const maxRank = Math.max(
    ...rankSlots.map((s) => Number(s.goalParams?.rankLeq ?? 0))
  );
  if (!Number.isFinite(maxRank) || maxRank <= 0) return;

  const closingDate = yesterdayUTC();
  const boards = await DailyLeaderboard.find({ date: closingDate }).lean();
  if (boards.length === 0) return;

  const playerBestRank = new Map<string, number>();
  for (const board of boards) {
    const ranked = [...(board.entries ?? [])]
      .filter((e) => e.playerId)
      .sort((a, b) => (b.dailyScore ?? 0) - (a.dailyScore ?? 0));
    ranked.forEach((entry, i) => {
      const rank = i + 1;
      if (rank > maxRank) return;
      const pid = String(entry.playerId);
      const prev = playerBestRank.get(pid);
      if (prev === undefined || rank < prev) {
        playerBestRank.set(pid, rank);
      }
    });
  }

  if (playerBestRank.size === 0) return;

  const ids = Array.from(playerBestRank.keys());
  const players = await Player.find(
    { _id: { $in: ids } },
    { _id: 1, walletAddress: 1 }
  ).lean();

  for (const p of players) {
    const rank = playerBestRank.get(String(p._id));
    if (!rank) continue;
    await awardLeaderboardRankBounty({
      playerId: p._id,
      walletAddress: p.walletAddress,
      period: period as Parameters<typeof awardLeaderboardRankBounty>[0]["period"],
      rank,
    });
  }
}

export function createDailyResetWorker(connection: ConnectionOptions) {
  const worker = new Worker("daily-reset", processDailyReset, {
    connection,
    concurrency: 1,
  });

  worker.on("completed", (job) => {
    console.log(`Daily reset completed: ${job.id}`);
  });

  worker.on("failed", (job, err) => {
    console.error(`Daily reset failed: ${job?.id}`, err);
  });

  return worker;
}

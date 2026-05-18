import { Worker, type ConnectionOptions, type Job } from "bullmq";
import type Redis from "ioredis";
import { YIELD_SPLIT, DEPOSIT_APY_ESTIMATE, POOL_DURATION_DAYS } from "@hooked/shared";
import { PoolTier, Player } from "../db/schema.js";
import * as lb from "../services/leaderboard.js";
import { getQueues } from "./queue.js";
import { buildRedis } from "../plugins/redisFactory.js";

async function processPoolLifecycle(job: Job) {
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  // buildRedis applies tls.rejectUnauthorized=false for rediss:// URLs.
  // Skipping that was one of the silent ioredis "self-signed cert"
  // failure modes catalogued in the 2026-05-18 incident.
  const redis = buildRedis(redisUrl);

  try {
    const now = new Date();

    const toLock = await PoolTier.find({
      status: "open",
      entryClosesAt: { $lte: now },
    });

    for (const pool of toLock) {
      pool.status = "locked";
      await pool.save();
      job.log(`Pool ${pool._id} (tier ${pool.tier}, ${pool.activeMonth}) → locked`);
    }

    const toClose = await PoolTier.find({
      status: "locked",
      endsAt: { $lte: now },
    });

    for (const pool of toClose) {
      await closePoolAndDistribute(redis, pool, job);
    }
  } finally {
    await redis.quit();
  }
}

async function closePoolAndDistribute(
  redis: Redis,
  pool: InstanceType<typeof PoolTier>,
  job: Job
) {
  const poolId = pool.onChainPoolId;
  if (!poolId) {
    job.log(`Pool ${pool._id} has no onChainPoolId — skipping close`);
    return;
  }

  const allEntries = await lb.getPoolLeaderboard(redis, poolId, 0, 100);
  if (allEntries.length === 0) {
    job.log(`Pool ${pool._id} has no leaderboard entries — marking closed`);
    pool.status = "closed";
    await pool.save();
    return;
  }

  const totalDeposited = pool.totalDepositedSol ?? pool.realPlayerCount * pool.tier;
  const poolDays = POOL_DURATION_DAYS;
  const estimatedYield = totalDeposited * DEPOSIT_APY_ESTIMATE * (poolDays / 365);

  const totalYield = Math.max(pool.totalYieldSol ?? estimatedYield, 0);

  const top3 = allEntries.slice(0, 3);

  const playerIds = top3.map((e) => lb.parseMemberId(e.member).playerId);

  const players = playerIds.length > 0
    ? await Player.find({ _id: { $in: playerIds } }, { _id: 1, nickname: 1, walletAddress: 1 }).lean()
    : [];
  const playerMap = new Map(players.map((p) => [p._id.toString(), p]));

  const splits = [YIELD_SPLIT.first, YIELD_SPLIT.second, YIELD_SPLIT.third];
  const protocolCut = totalYield * YIELD_SPLIT.protocol;
  const winners: { rank: number; walletAddress: string; displayName: string; prizeSol: number }[] = [];

  const { payoutQueue } = getQueues();

  for (let i = 0; i < Math.min(3, top3.length); i++) {
    const entry = top3[i];
    const playerId = lb.parseMemberId(entry.member).playerId;
    const prizeSol = Math.round(totalYield * splits[i] * 1e9) / 1e9;

    const player = playerMap.get(playerId);
    const walletAddress = player?.walletAddress ?? "";
    const displayName = player?.nickname ?? "Anonymous";

    winners.push({ rank: i + 1, walletAddress, displayName, prizeSol });

    if (walletAddress && payoutQueue) {
      await payoutQueue.add("pool-payout", {
        playerId,
        walletAddress,
        prizeSOL: prizeSol,
        poolId,
        poolDocId: pool._id.toString(),
        rank: i + 1,
      });
    }
  }

  pool.status = "closed";
  pool.totalYieldSol = totalYield;
  pool.winners = winners as any;
  await pool.save();

  job.log(
    `Pool ${pool._id} closed. Yield: ${totalYield.toFixed(6)} SOL ` +
    `(protocol: ${protocolCut.toFixed(6)}). Winners: ${winners.map((w) => `#${w.rank} ${w.displayName} → ${w.prizeSol} SOL`).join(", ")}`
  );
}

export function createPoolLifecycleWorker(connection: ConnectionOptions) {
  const worker = new Worker("pool-lifecycle", processPoolLifecycle, {
    connection,
    concurrency: 1,
  });

  worker.on("completed", (job) => {
    console.log(`Pool lifecycle check completed: ${job.id}`);
  });

  worker.on("failed", (job, err) => {
    console.error(`Pool lifecycle check failed: ${job?.id}`, err);
  });

  return worker;
}

import { Worker, type ConnectionOptions, type Job } from "bullmq";
import { Room } from "../db/schema.js";
import { settleAllReadyRooms } from "../services/roomKeeper.js";
import { createRoomOnChainAndDb } from "../services/roomFactory.js";
import {
  deployReadyRoomLp,
  exitReadyRoomLp,
} from "../services/lpRoomLifecycle.js";
import { recordKeeperTick } from "../services/keeperHeartbeat.js";
import { formatSolanaError } from "../solana/formatError.js";
import { buildRedis } from "../plugins/redisFactory.js";
import { env } from "../config/env.js";

type LifecycleLogger = (msg: string) => void;

export async function runRoomLifecycleTick(
  log: LifecycleLogger = () => {},
): Promise<void> {
  const now = new Date();

  const toActive = await Room.updateMany(
    { phase: "entry", entryClosesAt: { $lte: now } },
    { $set: { phase: "active" } },
  );
  if (toActive.modifiedCount > 0) {
    log(`${toActive.modifiedCount} room(s) entry → active`);
  }

  // Watchdog: spin up a room if none is joinable. Self-heals after missed
  // crons / restart gaps / filled rooms.
  const joinable = await Room.countDocuments({
    phase: "entry",
    onChainPoolId: { $ne: null },
    entryClosesAt: { $gt: now },
    $expr: {
      $and: [
        { $lt: ["$realPlayerCount", "$maxPlayers"] },
        { $lt: ["$depositedSol", "$capacitySol"] },
      ],
    },
  });
  if (joinable === 0) {
    try {
      const result = await createRoomOnChainAndDb({
        createdBy: "system:rotation",
        trigger: "system:rotation",
      });
      if (result.ok) {
        log(`watchdog: created ${result.roomId} (${result.txSignature})`);
      } else {
        log(`watchdog: skipped (${result.reason})`);
      }
    } catch (err) {
      // B8: surface program logs / cause chain, not just err.message.
      log(`watchdog: error ${formatSolanaError(err)}`);
    }
  }

  try {
    await deployReadyRoomLp({
      info: (msg) => log(msg),
      error: (msg) => log(`ERROR ${msg}`),
    });
  } catch (err) {
    log(`lpDeploy error: ${(err as Error).message}`);
  }

  try {
    await exitReadyRoomLp({
      info: (msg) => log(msg),
      error: (msg) => log(`ERROR ${msg}`),
    });
  } catch (err) {
    log(`lpExit error: ${(err as Error).message}`);
  }

  const toSettling = await Room.updateMany(
    { phase: "active", closesAt: { $lte: now } },
    { $set: { phase: "settling" } },
  );
  if (toSettling.modifiedCount > 0) {
    log(`${toSettling.modifiedCount} room(s) active → settling`);
  }

  // Per-tick Redis client for B10 leaderboard-finalize. Best-effort.
  let tickRedis: ReturnType<typeof buildRedis> | null = null;
  try {
    tickRedis = buildRedis(env.REDIS_URL);
  } catch (err) {
    log(`tickRedis init failed: ${(err as Error).message}`);
  }

  try {
    const results = await settleAllReadyRooms(
      {
        info: (msg) => log(msg),
        error: (msg) => log(`ERROR ${msg}`),
      },
      { redis: tickRedis },
    );
    for (const r of results) {
      const stats =
        r.returned !== undefined
          ? ` returned=${r.returned} reconciled=${r.reconciled} failed=${r.failed}`
          : "";
      log(
        `roomKeeper ${r.roomId}: ${r.status}${r.message ? ` (${r.message})` : ""}${stats}`,
      );
    }
  } catch (err) {
    log(`roomKeeper error: ${(err as Error).message}`);
  } finally {
    if (tickRedis) {
      tickRedis.quit().catch(() => {});
    }
  }
}

async function processRoomLifecycle(job: Job) {
  try {
    await runRoomLifecycleTick((msg) => {
      job.log(msg);
      console.log(`[room-lifecycle] ${msg}`);
    });
    await recordKeeperTick("room-lifecycle", "ok");
  } catch (err) {
    // Record before re-throw so /healthz/keeper sees "running-but-erroring".
    await recordKeeperTick(
      "room-lifecycle",
      "error",
      (err as Error).message,
    );
    throw err;
  }
}

export function createRoomLifecycleWorker(connection: ConnectionOptions) {
  const worker = new Worker("room-lifecycle", processRoomLifecycle, {
    connection,
    concurrency: 1,
  });

  worker.on("completed", (job) => {
    console.log(`Room lifecycle check completed: ${job.id}`);
  });

  worker.on("failed", (job, err) => {
    console.error(`Room lifecycle check failed: ${job?.id}`, err);
  });

  return worker;
}

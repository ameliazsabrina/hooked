import { Worker, type ConnectionOptions, type Job } from "bullmq";
import { Room } from "../db/schema.js";
import { settleAllReadyRooms } from "../services/roomKeeper.js";
import { createRoomOnChainAndDb } from "../services/roomFactory.js";
import {
  deployReadyRoomLp,
  exitReadyRoomLp,
} from "../services/lpRoomLifecycle.js";

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

    // Continuous-availability guarantee: if no entry-phase room remains,
    // spin up a successor. The factory enforces the 2-rooms-per-UTC-day
    // cap, so this is a no-op once the daily budget is exhausted.
    const stillEntry = await Room.countDocuments({ phase: "entry" });
    if (stillEntry === 0) {
      try {
        const result = await createRoomOnChainAndDb({
          createdBy: "system:rotation",
          trigger: "system:rotation",
        });
        if (result.ok) {
          log(`rotation: created ${result.roomId} (${result.txSignature})`);
        } else {
          log(`rotation: skipped (${result.reason})`);
        }
      } catch (err) {
        log(`rotation: error ${(err as Error).message}`);
      }
    }
  }

  // LP deploy: rooms freshly transitioned to `active` get their principal
  // moved into LP_MANAGER and a DLMM position opened. No-ops when LP is
  // disabled, kill-switched, or the buffer is too low.
  try {
    await deployReadyRoomLp({
      info: (msg) => log(msg),
      error: (msg) => log(`ERROR ${msg}`),
    });
  } catch (err) {
    log(`lpDeploy error: ${(err as Error).message}`);
  }

  // LP exit: rooms within LP_EXIT_HOURS_BEFORE_CLOSE of closes_at have their
  // position pulled, USDC swapped back to SOL, principal+yield returned to
  // the room_vault, and `room.lp.realizedYieldLamports` written so the
  // settlement keeper picks it up.
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

  try {
    const results = await settleAllReadyRooms({
      info: (msg) => log(msg),
      error: (msg) => log(`ERROR ${msg}`),
    });
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
  }
}

async function processRoomLifecycle(job: Job) {
  await runRoomLifecycleTick((msg) => job.log(msg));
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

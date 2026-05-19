import { Worker, type ConnectionOptions, type Job } from "bullmq";

import { FishingEvent } from "../db/schema.js";
import { getEventStatus } from "../services/eventConfig.js";
import { computeEventWinners } from "../services/eventWinners.js";
import { recordKeeperTick } from "../services/keeperHeartbeat.js";

export const EVENT_LIFECYCLE_QUEUE_NAME = "event-lifecycle";

export interface EventLifecycleOutcome {
  promoted: string[];
  demoted: string[];
  computedWinnersFor: string[];
  /** Errors encountered for individual transitions, by eventId. */
  errors: Record<string, string>;
}

/** Idempotent tick. Partial unique index on active makes flips race-safe. */
export async function processEventLifecycleTick(
  options: { now?: Date } = {},
): Promise<EventLifecycleOutcome> {
  const now = options.now ?? new Date();
  const outcome: EventLifecycleOutcome = {
    promoted: [],
    demoted: [],
    computedWinnersFor: [],
    errors: {},
  };

  // Demote before promote — overlapping transitions would otherwise
  // deadlock the partial unique index.
  const expiring = await FishingEvent.find({
    active: true,
    endsAt: { $lte: now },
  });
  for (const ev of expiring) {
    try {
      const updated = await FishingEvent.updateOne(
        { _id: ev._id, active: true },
        { $set: { active: false } },
      );
      if (updated.modifiedCount > 0) {
        outcome.demoted.push(String(ev._id));
        try {
          await computeEventWinners(String(ev._id), { now });
          outcome.computedWinnersFor.push(String(ev._id));
        } catch (err) {
          outcome.errors[String(ev._id)] = `computeWinners: ${(err as Error).message}`;
        }
      }
    } catch (err) {
      outcome.errors[String(ev._id)] = `demote: ${(err as Error).message}`;
    }
  }

  // Oldest startsAt wins when multiple events overlap.
  const active = await FishingEvent.findOne({ active: true });
  if (!active) {
    const candidate = await FishingEvent.findOne({
      active: false,
      startsAt: { $lte: now },
      endsAt: { $gt: now },
    }).sort({ startsAt: 1 });
    if (candidate) {
      try {
        const promoted = await FishingEvent.findOneAndUpdate(
          { _id: candidate._id, active: false },
          { $set: { active: true } },
          { new: true },
        );
        if (promoted) {
          outcome.promoted.push(String(promoted._id));
        }
      } catch (err) {
        const code = (err as { code?: number }).code;
        if (code === 11000) {
          // Another worker won the race.
        } else {
          outcome.errors[String(candidate._id)] = `promote: ${(err as Error).message}`;
        }
      }
    }
  }

  // Skip the 30s cache TTL.
  if (outcome.promoted.length > 0 || outcome.demoted.length > 0) {
    await getEventStatus(true).catch(() => {});
  }

  return outcome;
}

export function createEventLifecycleWorker(connection: ConnectionOptions): Worker {
  const worker = new Worker(
    EVENT_LIFECYCLE_QUEUE_NAME,
    async (job: Job) => {
      job.log("event lifecycle tick");
      try {
        const outcome = await processEventLifecycleTick();
        if (outcome.promoted.length || outcome.demoted.length) {
          job.log(
            `promoted=${outcome.promoted.length} demoted=${outcome.demoted.length} winners=${outcome.computedWinnersFor.length}`,
          );
        }
        const errCount = Object.keys(outcome.errors).length;
        if (errCount > 0) {
          job.log(`errors: ${JSON.stringify(outcome.errors)}`);
          // Surface as degraded heartbeat without failing the tick.
          await recordKeeperTick(
            "event-lifecycle",
            "error",
            `per-event errors: ${JSON.stringify(outcome.errors).slice(0, 400)}`,
          );
        } else {
          await recordKeeperTick("event-lifecycle", "ok");
        }
        return outcome;
      } catch (err) {
        await recordKeeperTick(
          "event-lifecycle",
          "error",
          (err as Error).message,
        );
        throw err;
      }
    },
    { connection, concurrency: 1 },
  );
  worker.on("failed", (job, err) => {
    console.error(`[eventLifecycle] failed job=${job?.id}: ${err.message}`);
  });
  return worker;
}

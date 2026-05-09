import { Worker, type ConnectionOptions, type Job } from "bullmq";

import { FishingEvent } from "../db/schema.js";
import { getEventStatus } from "../services/eventConfig.js";
import { computeEventWinners } from "../services/eventWinners.js";

export const EVENT_LIFECYCLE_QUEUE_NAME = "event-lifecycle";

export interface EventLifecycleOutcome {
  promoted: string[];
  demoted: string[];
  computedWinnersFor: string[];
  /** Errors encountered for individual transitions, by eventId. */
  errors: Record<string, string>;
}

/**
 * Process one tick of the event-lifecycle worker. Pure of BullMQ — tests call
 * directly. Idempotent: running twice in the same minute is a no-op the second
 * time.
 *
 * Transitions:
 *   - Promote: an event with `active: false, startsAt <= now < endsAt` becomes
 *     active when no other event is active. Mongo's partial unique index on
 *     `active: true` makes the update race-safe across replicas — only one
 *     transition wins.
 *   - Demote: an event with `active: true, endsAt <= now` flips to inactive
 *     and we kick off `computeEventWinners` (best-effort; failure logs but
 *     doesn't block the demotion).
 *
 * After any transition, refresh the in-process eventConfig cache so the
 * gateway broadcast and any in-flight session starts pick up the new state.
 */
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

  // 1. Demote events whose endsAt has passed. Order matters: demote before
  // promote so a window where two events transition simultaneously (one
  // ending, one starting) doesn't deadlock the partial unique index.
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

  // 2. Promote the most recently-created scheduled event in window if none
  // is currently active. We oldest-first by startsAt: if multiple events
  // overlap their windows, the one that started first wins. The partial
  // unique index makes the actual flip race-safe.
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
          // Another worker / replica won the race. Not an error.
        } else {
          outcome.errors[String(candidate._id)] = `promote: ${(err as Error).message}`;
        }
      }
    }
  }

  // 3. Force a cache refresh so the next gateway broadcast and session-start
  // call see the new state immediately, instead of waiting up to 30s for
  // the cache TTL.
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
      const outcome = await processEventLifecycleTick();
      if (outcome.promoted.length || outcome.demoted.length) {
        job.log(
          `promoted=${outcome.promoted.length} demoted=${outcome.demoted.length} winners=${outcome.computedWinnersFor.length}`,
        );
      }
      const errCount = Object.keys(outcome.errors).length;
      if (errCount > 0) {
        job.log(`errors: ${JSON.stringify(outcome.errors)}`);
      }
      return outcome;
    },
    { connection, concurrency: 1 },
  );
  worker.on("failed", (job, err) => {
    console.error(`[eventLifecycle] failed job=${job?.id}: ${err.message}`);
  });
  return worker;
}

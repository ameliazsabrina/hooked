import { Queue } from "bullmq";
import { buildBullMqConnection } from "../plugins/redisFactory.js";

let dailyResetQueue: Queue | null = null;
let payoutQueue: Queue | null = null;
let poolLifecycleQueue: Queue | null = null;
let roomLifecycleQueue: Queue | null = null;
let roomCreateQueue: Queue | null = null;
let bountyWeeklyResetQueue: Queue | null = null;
let bountySolPayoutQueue: Queue | null = null;
let scoreBridgeQueue: Queue | null = null;
let eventLifecycleQueue: Queue | null = null;

export function getQueues() {
  return {
    dailyResetQueue,
    payoutQueue,
    poolLifecycleQueue,
    roomLifecycleQueue,
    roomCreateQueue,
    bountyWeeklyResetQueue,
    bountySolPayoutQueue,
    scoreBridgeQueue,
    eventLifecycleQueue,
  };
}

export function registerJobs(redisUrl: string) {
  const connection = buildBullMqConnection(redisUrl);

  dailyResetQueue = new Queue("daily-reset", { connection });
  payoutQueue = new Queue("payout", { connection });

  dailyResetQueue.upsertJobScheduler(
    "daily-reset-scheduler",
    { pattern: "0 0 * * *", tz: "UTC" },
    { name: "daily-reset" },
  );

  poolLifecycleQueue = new Queue("pool-lifecycle", { connection });
  poolLifecycleQueue.upsertJobScheduler(
    "pool-lifecycle-scheduler",
    { every: 15 * 60 * 1000 },
    { name: "pool-lifecycle" },
  );

  roomLifecycleQueue = new Queue("room-lifecycle", { connection });
  roomLifecycleQueue.upsertJobScheduler(
    "room-lifecycle-scheduler",
    { every: 15 * 60 * 1000 },
    { name: "room-lifecycle" },
  );

  import("./dailyReset.js").then(({ createDailyResetWorker }) => {
    createDailyResetWorker(connection);
  });

  import("./payoutWorker.js").then(({ createPayoutWorker }) => {
    createPayoutWorker(connection);
  });

  import("./poolLifecycle.js").then(({ createPoolLifecycleWorker }) => {
    createPoolLifecycleWorker(connection);
  });

  import("./roomLifecycle.js").then(({ createRoomLifecycleWorker }) => {
    createRoomLifecycleWorker(connection);
  });

  roomCreateQueue = new Queue("room-create", {
    connection,
    // Retries protect the window-aligned slot from transient RPC blips.
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  });
  // 02:00/14:00 UTC aligns "new bait" with "new room".
  roomCreateQueue.upsertJobScheduler(
    "room-create-window",
    { pattern: "0 2,14 * * *", tz: "UTC" },
    { name: "room-create" },
  );
  import("./roomCreate.js").then(({ createRoomCreateWorker }) => {
    createRoomCreateWorker(connection);
  });

  bountyWeeklyResetQueue = new Queue("bounty-weekly-reset", { connection });
  bountyWeeklyResetQueue.upsertJobScheduler(
    "bounty-weekly-reset-mon",
    { pattern: "0 0 * * 1", tz: "UTC" },
    { name: "bounty-weekly-reset" },
  );

  bountySolPayoutQueue = new Queue("bounty-sol-payout", { connection });

  import("./bountyReset.js").then(({ createBountyWeeklyResetWorker }) => {
    createBountyWeeklyResetWorker(connection);
  });

  import("./bountySolPayout.js").then(({ createBountySolPayoutWorker }) => {
    createBountySolPayoutWorker(connection);
  });

  // Triggered per-session by sessionCommit; no scheduled poller.
  scoreBridgeQueue = new Queue("score-bridge", { connection });
  import("./scoreBridge.js").then(({ createScoreBridgeWorker }) => {
    createScoreBridgeWorker(connection);
  });

  // 1-min tick; race-safe via partial unique index on FishingEvent.active.
  eventLifecycleQueue = new Queue("event-lifecycle", { connection });
  eventLifecycleQueue.upsertJobScheduler(
    "event-lifecycle-tick",
    { every: 60 * 1000 },
    { name: "event-lifecycle" },
  );
  import("./eventLifecycle.js").then(({ createEventLifecycleWorker }) => {
    createEventLifecycleWorker(connection);
  });

  console.log(
    "Job queues registered (daily-reset, payout, pool-lifecycle, room-lifecycle, room-create, bounty-weekly-reset, bounty-sol-payout, score-bridge, event-lifecycle)",
  );
}

/** No-op in tests (queue not registered). Dedupes via jobId = sessionId. */
export async function enqueueScoreBridge(sessionId: string): Promise<void> {
  if (!scoreBridgeQueue) return;
  await scoreBridgeQueue.add(
    "score-bridge",
    { sessionId },
    { jobId: sessionId, removeOnComplete: 100, removeOnFail: 200 },
  );
}

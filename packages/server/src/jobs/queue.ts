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
  // TLS handling (Heroku rediss:// self-signed chain) is consolidated in
  // buildBullMqConnection — see plugins/redisFactory.ts. Don't open-code
  // the connection object here or the next `new Queue(...)` author will
  // copy a config that's silently missing the tls flag.
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

  // session-lifecycle queue removed Phase 6: the legacy keeper job created
  // on-chain `FishingSession` PDAs and called `issue_bait` at window
  // rotations. Off-chain v2 creates session rows lazily on first cast via
  // `executeInitiateCastOffchain`, so no scheduled keeper run is needed.

  roomCreateQueue = new Queue("room-create", {
    connection,
    // Transient RPC failures (devnet hiccups, leader rotation) shouldn't
    // burn the 02:00 / 14:00 UTC slot — retry a few times so we keep the
    // window-aligned room. The lifecycle watchdog is the safety net for
    // anything still missing after these run out.
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  });
  // Phase-aligned with bait refills (02:00 / 14:00 UTC) so "new bait" and
  // "new room" arrive together — see services/fishing/window.ts.
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

  // Score bridge: pushes off-chain session scores to hooked_rooms. Triggered
  // per-session by fishingRouter.sessionCommit; no scheduled poller — if a
  // commit slips through, an admin can re-enqueue manually.
  scoreBridgeQueue = new Queue("score-bridge", { connection });
  import("./scoreBridge.js").then(({ createScoreBridgeWorker }) => {
    createScoreBridgeWorker(connection);
  });

  // Event lifecycle: 1-minute tick promotes scheduled events when their
  // startsAt arrives and demotes active ones at endsAt (kicks off
  // computeEventWinners). Race-safe via the partial unique index on
  // FishingEvent.active.
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

/**
 * Enqueue a score-bridge job for a committed session. Safe to call from
 * routes — silently no-ops if `registerJobs` hasn't run (test environment).
 * BullMQ dedupes on `jobId = sessionId` so retries / double-commits collapse.
 */
export async function enqueueScoreBridge(sessionId: string): Promise<void> {
  if (!scoreBridgeQueue) return;
  await scoreBridgeQueue.add(
    "score-bridge",
    { sessionId },
    { jobId: sessionId, removeOnComplete: 100, removeOnFail: 200 },
  );
}

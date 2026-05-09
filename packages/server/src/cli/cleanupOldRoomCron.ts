import { Queue } from "bullmq";
import { env } from "../config/env.js";

/**
 * One-shot: remove the old `room-create-daily` BullMQ job scheduler that ran
 * the midnight-UTC cron pre-cadence-shift. The current scheduler is named
 * `room-create-window` (02:00 / 14:00 UTC); leftover schedulers in Redis fire
 * independently of code changes.
 *
 * Safe to run repeatedly — `removeJobScheduler` is a no-op if the scheduler
 * doesn't exist.
 *
 * Usage:
 *   pnpm exec tsx src/cli/cleanupOldRoomCron.ts
 */
async function main() {
  const queue = new Queue("room-create", { connection: { url: env.REDIS_URL } });

  const removed = await queue.removeJobScheduler("room-create-daily");
  console.log(
    JSON.stringify(
      {
        ok: true,
        removed,
        note: removed
          ? "old `room-create-daily` scheduler removed"
          : "scheduler not present (already removed or never existed in this Redis)",
      },
      null,
      2,
    ),
  );

  await queue.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

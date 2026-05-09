import { Worker, type ConnectionOptions, type Job } from "bullmq";
import { getOrCreateCurrentPeriod } from "../bounties/period.js";

async function processWeeklyReset(job: Job) {
  const period = await getOrCreateCurrentPeriod("weekly");
  job.log(
    `Weekly period seeded: ${String(period._id)} (${period.slots.length} slots)`
  );
}

export function createBountyWeeklyResetWorker(connection: ConnectionOptions) {
  const worker = new Worker("bounty-weekly-reset", processWeeklyReset, {
    connection,
    concurrency: 1,
  });
  worker.on("failed", (job, err) => {
    console.error(`bounty-weekly-reset failed: ${job?.id}`, err);
  });
  return worker;
}

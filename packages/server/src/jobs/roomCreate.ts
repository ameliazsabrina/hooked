import { Worker, type ConnectionOptions, type Job } from "bullmq";
import { createRoomOnChainAndDb } from "../services/roomFactory.js";

async function processRoomCreate(job: Job) {
  try {
    const result = await createRoomOnChainAndDb({
      createdBy: "system:cron",
      trigger: "system:cron",
    });
    if (result.ok) {
      job.log(
        `room-create: created ${result.roomId} (${result.onChainRoomAddress}, tx ${result.txSignature})`
      );
    } else {
      job.log(`room-create: skipped (${result.reason})`);
    }
  } catch (err) {
    job.log(`room-create: error ${(err as Error).message}`);
    throw err;
  }
}

export function createRoomCreateWorker(connection: ConnectionOptions) {
  const worker = new Worker("room-create", processRoomCreate, {
    connection,
    concurrency: 1,
  });

  worker.on("completed", (job) => {
    console.log(`Room create job completed: ${job.id}`);
  });

  worker.on("failed", (job, err) => {
    console.error(`Room create job failed: ${job?.id}`, err);
  });

  return worker;
}

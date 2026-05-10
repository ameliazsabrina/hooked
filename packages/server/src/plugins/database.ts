import fp from "fastify-plugin";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { FishingSession } from "../db/schema.js";

export default fp(async (fastify) => {
  await mongoose.connect(env.MONGODB_URI);
  fastify.log.info(`MongoDB connected: ${env.MONGODB_URI}`);

  // One-shot migration: the prior unique index on (playerId, dateKey,
  // window) was rewritten as a partial unique filtered on status:"active"
  // so a new room deposit mid-window can abandon the prior session and
  // create a fresh one. Mongoose's auto-sync on next start would refuse
  // to create the new partial index while the old non-partial unique
  // still exists, so drop the legacy index here. Idempotent: catches
  // "IndexNotFound" once the migration has run. Production rollout will
  // need a real migration script — this is dev-only.
  try {
    await FishingSession.collection.dropIndex(
      "playerId_1_dateKey_1_window_1",
    );
    fastify.log.info(
      "Dropped legacy FishingSession index playerId_1_dateKey_1_window_1",
    );
  } catch (err) {
    const code = (err as { code?: number; codeName?: string }).code;
    if (code !== 27 /* IndexNotFound */) {
      fastify.log.warn(
        { err },
        "FishingSession legacy index drop failed (non-fatal)",
      );
    }
  }
  await FishingSession.syncIndexes();

  fastify.addHook("onClose", async () => {
    await mongoose.disconnect();
  });
});

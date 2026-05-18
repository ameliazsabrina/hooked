import mongoose from "mongoose";
import { env } from "../config/env.js";
import { buildRedis } from "../plugins/redisFactory.js";

/**
 * One-off cleanup after the bot system was removed.
 *
 * - Drops the `botplayers` Mongo collection (no longer modeled).
 * - Removes any `bot:*` members from existing leaderboard sorted sets in Redis,
 *   and clears bot entries from per-room top-catch hashes.
 *
 * Usage:
 *   pnpm tsx src/cli/dropBotData.ts [--dry-run]
 */

async function dropMongoBotCollection(dryRun: boolean): Promise<void> {
  await mongoose.connect(env.MONGODB_URI);
  const db = mongoose.connection.db;
  if (!db) throw new Error("mongo connection not ready");

  const collections = await db.listCollections({ name: "botplayers" }).toArray();
  if (collections.length === 0) {
    console.log("[mongo] botplayers collection not present — nothing to drop");
  } else if (dryRun) {
    const count = await db.collection("botplayers").countDocuments();
    console.log(`[mongo] would drop botplayers (${count} docs)`);
  } else {
    await db.collection("botplayers").drop();
    console.log("[mongo] botplayers dropped");
  }

  await mongoose.disconnect();
}

async function pruneRedisBotEntries(dryRun: boolean): Promise<void> {
  const redis = buildRedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  try {
    let cursor = "0";
    let zsetRemoved = 0;
    let hashFieldsRemoved = 0;

    do {
      const [next, keys] = await redis.scan(
        cursor,
        "MATCH",
        "lb:*",
        "COUNT",
        500,
      );
      cursor = next;
      for (const key of keys) {
        const type = await redis.type(key);
        if (type === "zset") {
          // Members like `bot:<id>` are lexically bounded; use ZRANGEBYLEX
          // to find them precisely.
          const botMembers = await redis.zrangebylex(key, "[bot:", "(bot:\xff");
          if (botMembers.length === 0) continue;
          if (dryRun) {
            zsetRemoved += botMembers.length;
          } else {
            zsetRemoved += await redis.zrem(key, ...botMembers);
          }
        } else if (type === "hash") {
          // top-catch keys hash member-id -> JSON; member ids include
          // `bot:<id>` for old bot rows.
          const fields = await redis.hkeys(key);
          const botFields = fields.filter((f) => f.startsWith("bot:"));
          if (botFields.length === 0) continue;
          if (dryRun) {
            hashFieldsRemoved += botFields.length;
          } else {
            hashFieldsRemoved += await redis.hdel(key, ...botFields);
          }
        }
      }
    } while (cursor !== "0");

    console.log(
      `[redis] ${dryRun ? "would remove" : "removed"} ${zsetRemoved} zset members, ${hashFieldsRemoved} hash fields with bot:* prefix`,
    );
  } finally {
    await redis.quit();
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`bot data cleanup — ${dryRun ? "DRY RUN" : "APPLYING"}`);
  await dropMongoBotCollection(dryRun);
  await pruneRedisBotEntries(dryRun);
}

main().catch((err) => {
  console.error("dropBotData failed:", err);
  process.exit(1);
});

import mongoose from "mongoose";
import { env } from "../config/env.js";
import { createRoomOnChainAndDb } from "../services/roomFactory.js";

/**
 * One-off: create a fresh on-chain Room with the current (post-bot-removal)
 * layout. Use after deploying a program upgrade that changed Room::SIZE so
 * old room accounts (which deserialize-fail under the new layout) can be
 * abandoned.
 *
 * Usage:
 *   pnpm tsx src/cli/createFreshRoom.ts
 */
async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const result = await createRoomOnChainAndDb({
    createdBy: "cli:fresh-room",
    trigger: "admin",
  });
  console.log(JSON.stringify(result, null, 2));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

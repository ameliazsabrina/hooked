import mongoose from "mongoose";
import { FishRarity } from "@hooked/shared";
import { env } from "../config/env.js";
import { Catch } from "../db/schema.js";

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  await mongoose.connect(env.MONGODB_URI);
  console.log(`connected to ${env.MONGODB_URI}`);

  const cursor = Catch.find({
    rarity: { $ne: FishRarity.Apex },
  }).cursor();

  let scanned = 0;
  let updated = 0;
  const byRarity: Record<string, number> = {};

  for await (const doc of cursor) {
    scanned += 1;
    const score = doc.score ?? 0;
    if (doc.sellValue === score) continue;

    const rarity = doc.rarity as string;
    byRarity[rarity] = (byRarity[rarity] ?? 0) + 1;

    if (!dryRun) {
      await Catch.updateOne(
        { _id: doc._id },
        { $set: { sellValue: score } },
      );
    }
    updated += 1;
  }

  console.log(
    `${dryRun ? "[dry-run] " : ""}scanned=${scanned} updated=${updated} breakdown=${JSON.stringify(byRarity)}`
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

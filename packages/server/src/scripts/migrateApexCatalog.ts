/**
 * Idempotent migration: filesystem apex assets → ApexFish docs; rewrites
 * legacy FishingEvent.apexSpeciesIds and FishingSession.eventApexSpeciesAtStart.
 * Run: pnpm --filter @hooked/server tsx src/scripts/migrateApexCatalog.ts
 * Uses raw collection ops to read fields mongoose schemas no longer declare.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";

import mongoose from "mongoose";
import { FishRarity, FISH_SPECIES } from "@hooked/shared";

import { env } from "../config/env.js";
import { ApexFish } from "../db/schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function clientApexAssetsDir(): string {
  return path.resolve(
    __dirname,
    "../../../client/public/assets/fish/apex",
  );
}

interface SeedEntry {
  legacyIdx: number;
  name: string;
  weightMinKg: number;
  weightMaxKg: number;
  filename: string;
  bytes: Buffer;
  mime: "image/png";
}

function legacyApexEntries(): SeedEntry[] {
  const dir = clientApexAssetsDir();
  const out: SeedEntry[] = [];
  for (let i = 0; i < FISH_SPECIES.length; i++) {
    const sp = FISH_SPECIES[i];
    if (sp.rarity !== FishRarity.Apex) continue;
    const filename = sp.asset.split("/").pop();
    if (!filename) continue;
    let bytes: Buffer;
    try {
      bytes = readFileSync(path.join(dir, filename));
    } catch (err) {
      console.warn(
        `[migrateApexCatalog] skipping "${sp.name}" — cannot read ${filename}: ${(err as Error).message}`,
      );
      continue;
    }
    out.push({
      legacyIdx: i,
      name: sp.name,
      weightMinKg: sp.weightMin,
      weightMaxKg: sp.weightMax,
      filename,
      bytes,
      mime: "image/png",
    });
  }
  return out;
}

async function seedApexFish(entries: SeedEntry[]): Promise<Map<number, string>> {
  // legacy FISH_SPECIES idx → ApexFish ObjectId string
  const map = new Map<number, string>();
  for (const e of entries) {
    const existing = await ApexFish.findOne({ name: e.name });
    if (existing) {
      // Keep image bytes; sync weight range only.
      if (
        existing.weightMinKg !== e.weightMinKg ||
        existing.weightMaxKg !== e.weightMaxKg
      ) {
        await ApexFish.updateOne(
          { _id: existing._id },
          {
            $set: {
              weightMinKg: e.weightMinKg,
              weightMaxKg: e.weightMaxKg,
            },
          },
        );
      }
      map.set(e.legacyIdx, String(existing._id));
      continue;
    }
    const created = await ApexFish.create({
      name: e.name,
      weightMinKg: e.weightMinKg,
      weightMaxKg: e.weightMaxKg,
      imageData: e.bytes,
      imageMimeType: e.mime,
      createdBy: "system:migrateApexCatalog",
    });
    map.set(e.legacyIdx, String(created._id));
    console.log(`[migrateApexCatalog] seeded ApexFish "${e.name}" (${created._id})`);
  }
  return map;
}

async function rewriteFishingEvents(
  legacyToObjectId: Map<number, string>,
): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error("mongoose.connection.db is null");
  const col = db.collection("fishingevents");
  const cursor = col.find({ apexSpeciesIds: { $exists: true } });
  let touched = 0;
  for await (const doc of cursor) {
    const legacyIds = doc.apexSpeciesIds as number[] | undefined;
    if (!legacyIds || legacyIds.length === 0) {
      await col.updateOne(
        { _id: doc._id },
        { $unset: { apexSpeciesIds: 1 } },
      );
      touched++;
      continue;
    }
    const apexFishIds: mongoose.Types.ObjectId[] = [];
    for (const idx of legacyIds) {
      const objId = legacyToObjectId.get(idx);
      if (!objId) {
        throw new Error(
          `Event ${doc._id} references unknown legacy idx ${idx} — re-run after seeding`,
        );
      }
      apexFishIds.push(new mongoose.Types.ObjectId(objId));
    }
    await col.updateOne(
      { _id: doc._id },
      {
        $set: { apexFishIds },
        $unset: { apexSpeciesIds: 1 },
      },
    );
    touched++;
  }
  console.log(`[migrateApexCatalog] rewrote ${touched} FishingEvent doc(s)`);
}

async function rewriteFishingSessions(
  legacyToObjectId: Map<number, string>,
): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error("mongoose.connection.db is null");
  const col = db.collection("fishingsessions");
  const cursor = col.find({
    eventApexSpeciesAtStart: { $exists: true },
  });
  let touched = 0;
  for await (const doc of cursor) {
    const legacy = doc.eventApexSpeciesAtStart as number[] | undefined;
    if (!legacy) continue;
    const richer: Array<{
      apexFishId: mongoose.Types.ObjectId;
      name: string;
      weightMinHg: number;
      weightMaxHg: number;
    }> = [];
    for (const idx of legacy) {
      const objId = legacyToObjectId.get(idx);
      const sp = FISH_SPECIES[idx];
      if (!objId || !sp) continue;
      richer.push({
        apexFishId: new mongoose.Types.ObjectId(objId),
        name: sp.name,
        weightMinHg: Math.round(sp.weightMin * 10),
        weightMaxHg: Math.round(sp.weightMax * 10),
      });
    }
    await col.updateOne(
      { _id: doc._id },
      {
        $set: { eventApexFishesAtStart: richer },
        $unset: { eventApexSpeciesAtStart: 1 },
      },
    );
    touched++;
  }
  console.log(`[migrateApexCatalog] rewrote ${touched} FishingSession doc(s)`);
}

async function main(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI);
  console.log(`[migrateApexCatalog] connected to ${env.MONGODB_URI}`);
  try {
    const entries = legacyApexEntries();
    console.log(`[migrateApexCatalog] found ${entries.length} legacy apex entries`);
    const legacyToObjectId = await seedApexFish(entries);
    await rewriteFishingEvents(legacyToObjectId);
    await rewriteFishingSessions(legacyToObjectId);
    console.log("[migrateApexCatalog] done");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("[migrateApexCatalog] failed:", err);
  process.exitCode = 1;
});

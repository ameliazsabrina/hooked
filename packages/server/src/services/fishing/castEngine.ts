import { createHash } from "node:crypto";
import type { Types } from "mongoose";

import { Catch, FishingSession } from "../../db/schema.js";
import { MAX_CATCHES, SPECIES_TABLE } from "./constants.js";
import { CastEngineError } from "./errors.js";
import { rollCast, seedForCast } from "./rng.js";
import { computeCatchScore } from "./scoring.js";
import { Mechanic, RARITY_LABEL, Rarity, ZONE_OPEN_SEA, Window } from "./types.js";

/** Pre-nibble disconnect refund window. */
export const CANCEL_CAST_GRACE_SECS = 8;

/**
 * Mid-cast (including post-hook) disconnect refund window. Broader than
 * cancelCast's 8s — past 30s the stale-cast sweep clears pendingCast
 * WITHOUT refund. Reroll cheats are bounded by audit telemetry and the
 * RNG's fixed expected rarity.
 */
export const ABANDON_CAST_GRACE_SECS = 30;

export interface InitiateCastInput {
  /** Mongo ObjectId or string id of the FishingSession. */
  sessionId: string | Types.ObjectId;
  /** 32-byte daily secret (pre-image of the daily seed hash committed publicly). */
  dailySeed: Buffer;
  /** Override `now` for deterministic tests. */
  now?: Date;
}

export interface InitiateCastResult {
  castIndex: number;
  /** SPECIES_TABLE index for non-apex casts; -1 when apex rolled. */
  speciesId: number;
  /** ApexFish ObjectId (24-char hex) when apex rolled; null otherwise. */
  apexFishId: string | null;
  /** Display name (FISH_SPECIES for non-apex, ApexFish.name for apex). */
  speciesName: string;
  rarity: Rarity;
  weightHg: number;
  greenZoneStart: number;
  greenZoneWidth: number;
  mechanic: Mechanic;
  baitRemaining: number;
  castAt: Date;
  /** sha256 of the per-cast seed; published with the cast for audit reveal. */
  seedHash: Buffer;
}

/**
 * Decrement bait, increment cast count, roll the catch, store as pendingCast.
 * Atomicity: conditional findOneAndUpdate on pre-cast castCount — concurrent
 * initiates can't both succeed; loser gets CAST_RACE.
 */
export async function initiateCast(input: InitiateCastInput): Promise<InitiateCastResult> {
  const session = await FishingSession.findById(input.sessionId);
  if (!session) throw new CastEngineError("SESSION_NOT_FOUND", "Session not found");
  if (session.status !== "active") {
    throw new CastEngineError("SESSION_NOT_ACTIVE", `Session status is ${session.status}`);
  }
  if (session.baitRemaining <= 0) throw new CastEngineError("NO_BAIT", "No bait remaining");
  if (session.pendingCast) throw new CastEngineError("CAST_PENDING", "A cast is already pending");

  const castIndex = session.castCount + 1;
  const seedBytes = seedForCast({
    dailySeed: input.dailySeed,
    sessionId: String(session._id),
    castIndex,
    pity: session.pityCounter,
    playerWallet: session.walletAddress,
  });
  const seedHash = createHash("sha256").update(seedBytes).digest();

  const cast = rollCast({
    seedBytes,
    window: session.window === 1 ? Window.Night : Window.Day,
    apexBp: session.eventApexBpAtStart,
    castCount: castIndex,
    pity: session.pityCounter,
    apexFishes: (session.eventApexFishesAtStart ?? []).map((f) => ({
      apexFishId: String(f.apexFishId),
      name: f.name,
      weightMinHg: f.weightMinHg,
      weightMaxHg: f.weightMaxHg,
    })),
  });

  const castAt = input.now ?? new Date();

  const updated = await FishingSession.findOneAndUpdate(
    {
      _id: session._id,
      status: "active",
      pendingCast: null,
      baitRemaining: { $gt: 0 },
      castCount: session.castCount,
    },
    {
      $inc: { baitRemaining: -1, castCount: 1 },
      $set: {
        pendingCast: {
          castIndex,
          speciesId: cast.speciesId >= 0 ? cast.speciesId : null,
          apexFishId: cast.apexFishId,
          speciesName: cast.speciesName,
          rarity: cast.rarity,
          weightHg: cast.weightHg,
          greenZoneStart: cast.greenZoneStart,
          greenZoneWidth: cast.greenZoneWidth,
          mechanic: cast.mechanic,
          castAt,
          seedHash,
        },
      },
    },
    { new: true },
  );
  if (!updated) {
    throw new CastEngineError("CAST_RACE", "Concurrent cast detected, retry");
  }

  return {
    castIndex,
    speciesId: cast.speciesId,
    apexFishId: cast.apexFishId,
    speciesName: cast.speciesName,
    rarity: cast.rarity,
    weightHg: cast.weightHg,
    greenZoneStart: cast.greenZoneStart,
    greenZoneWidth: cast.greenZoneWidth,
    mechanic: cast.mechanic,
    baitRemaining: updated.baitRemaining,
    castAt,
    seedHash,
  };
}

export interface CancelCastInput {
  sessionId: string | Types.ObjectId;
  now?: Date;
}

export interface CancelCastResult {
  baitRemaining: number;
}

/**
 * Refunds bait but does NOT decrement castCount — RNG seed material stays
 * monotonic so the same cast index can't be retried by repeated cancels.
 * pityCounter untouched: the cast is erased, not resolved.
 */
export async function cancelCast(input: CancelCastInput): Promise<CancelCastResult> {
  const now = input.now ?? new Date();
  const session = await FishingSession.findById(input.sessionId);
  if (!session) throw new CastEngineError("SESSION_NOT_FOUND", "Session not found");
  if (session.status !== "active") {
    throw new CastEngineError("SESSION_NOT_ACTIVE", `Session status is ${session.status}`);
  }
  if (!session.pendingCast) {
    throw new CastEngineError("NO_CAST_TO_RESOLVE", "No pending cast to cancel");
  }

  const elapsedMs = now.getTime() - session.pendingCast.castAt.getTime();
  if (elapsedMs > CANCEL_CAST_GRACE_SECS * 1000) {
    throw new CastEngineError(
      "CANCEL_GRACE_EXPIRED",
      `Cancel grace expired (${Math.round(elapsedMs / 1000)}s elapsed, ${CANCEL_CAST_GRACE_SECS}s allowed)`,
    );
  }

  const pendingCastIndex = session.pendingCast.castIndex;
  const updated = await FishingSession.findOneAndUpdate(
    {
      _id: session._id,
      status: "active",
      "pendingCast.castIndex": pendingCastIndex,
    },
    {
      $inc: { baitRemaining: 1 },
      $set: { pendingCast: null },
    },
    { new: true },
  );
  if (!updated) throw new CastEngineError("CAST_RACE", "Pending cast changed, retry");
  return { baitRemaining: updated.baitRemaining };
}

export interface AbandonCastInput {
  sessionId: string | Types.ObjectId;
  now?: Date;
}

export interface AbandonCastResult {
  baitRemaining: number;
  refunded: boolean;
}

/**
 * WS-disconnect refund — broader than cancelCast: refunds post-hook too,
 * within ABANDON_CAST_GRACE_SECS. Idempotent on null pendingCast.
 */
export async function abandonCast(
  input: AbandonCastInput,
): Promise<AbandonCastResult> {
  const now = input.now ?? new Date();
  const session = await FishingSession.findById(input.sessionId);
  if (!session) throw new CastEngineError("SESSION_NOT_FOUND", "Session not found");
  // Disconnect handlers race with normal resolution — silent no-op.
  if (session.status !== "active" || !session.pendingCast) {
    return { baitRemaining: session.baitRemaining, refunded: false };
  }

  const elapsedMs = now.getTime() - session.pendingCast.castAt.getTime();
  if (elapsedMs > ABANDON_CAST_GRACE_SECS * 1000) {
    // Bait counts as spent past the window; stale-cast sweep cleans up.
    return { baitRemaining: session.baitRemaining, refunded: false };
  }

  const pendingCastIndex = session.pendingCast.castIndex;
  const updated = await FishingSession.findOneAndUpdate(
    {
      _id: session._id,
      status: "active",
      "pendingCast.castIndex": pendingCastIndex,
    },
    {
      $inc: { baitRemaining: 1 },
      $set: { pendingCast: null },
    },
    { new: true },
  );
  // Concurrent resolve is fine — player already got catch_resolved.
  if (!updated) {
    return { baitRemaining: session.baitRemaining, refunded: false };
  }
  return { baitRemaining: updated.baitRemaining, refunded: true };
}

export interface SubmitInputSamplesInput {
  sessionId: string | Types.ObjectId;
  hit: boolean;
  /** 0/undefined falls back to pendingCast.weightHg. Clamped to species range. */
  weightHg?: number;
  now?: Date;
}

export interface SubmitInputSamplesResult {
  hit: boolean;
  catchId: string | null;
  score: number;
  sessionScore: number;
  pityCounter: number;
  catchCount: number;
}

/**
 * Resolve a pending cast. Pity rules:
 *   hit + rarity >= Rare → reset to 0
 *   hit + Basic / miss   → increment
 */
export async function submitInputSamples(input: SubmitInputSamplesInput): Promise<SubmitInputSamplesResult> {
  const session = await FishingSession.findById(input.sessionId);
  if (!session) throw new CastEngineError("SESSION_NOT_FOUND", "Session not found");
  if (session.status !== "active") {
    throw new CastEngineError("SESSION_NOT_ACTIVE", `Session status is ${session.status}`);
  }
  if (!session.pendingCast) {
    throw new CastEngineError("NO_CAST_TO_RESOLVE", "No pending cast to resolve");
  }
  if (session.catchCount >= MAX_CATCHES && input.hit) {
    throw new CastEngineError("CATCHES_FULL", `Catch log full (${MAX_CATCHES})`);
  }

  const pc = session.pendingCast;
  const rarityEnum = pc.rarity as Rarity;

  if (input.hit) {
    // Anti-cheat: clamp client weight to the rolled fish's [min, max] range
    // (SPECIES_TABLE or pinned apex snapshot). Falls back to rolled weight.
    const clientWeight = input.weightHg ?? 0;
    let effectiveWeight = pc.weightHg;
    if (clientWeight > 0) {
      let minHg: number | null = null;
      let maxHg: number | null = null;
      if (rarityEnum === Rarity.Apex && pc.apexFishId) {
        const apexId = String(pc.apexFishId);
        const pinned = (session.eventApexFishesAtStart ?? []).find(
          (f) => String(f.apexFishId) === apexId,
        );
        if (pinned) {
          minHg = pinned.weightMinHg;
          maxHg = pinned.weightMaxHg;
        }
      } else if (pc.speciesId !== null && pc.speciesId !== undefined) {
        const sp = SPECIES_TABLE[pc.speciesId];
        if (sp) {
          minHg = sp.minWeightHg;
          maxHg = sp.maxWeightHg;
        }
      }
      if (minHg !== null && maxHg !== null) {
        effectiveWeight = Math.max(minHg, Math.min(maxHg, clientWeight));
      }
    }
    const score = computeCatchScore(rarityEnum, effectiveWeight);

    const speciesName = pc.speciesName ?? `species_${pc.speciesId ?? "?"}`;
    const newPity = rarityEnum >= Rarity.Rare ? 0 : session.pityCounter + 1;

    const catchDoc = await Catch.create({
      playerId: session.playerId,
      sessionId: session._id,
      castIndex: pc.castIndex,
      speciesId: pc.speciesId ?? null,
      apexFishId: pc.apexFishId ?? null,
      species: speciesName,
      rarity: RARITY_LABEL[rarityEnum],
      weightKg: effectiveWeight / 10, // hg → kg
      score,
      // Mirrors backfill CLI formula; default 0 would break the shell economy.
      sellValue: score,
      zone: ZONE_OPEN_SEA,
      caughtAt: input.now ?? new Date(),
    });

    const updated = await FishingSession.findOneAndUpdate(
      {
        _id: session._id,
        status: "active",
        "pendingCast.castIndex": pc.castIndex,
      },
      {
        $inc: { sessionScore: score, catchCount: 1 },
        $set: { pendingCast: null, pityCounter: newPity },
      },
      { new: true },
    );
    if (!updated) {
      await Catch.deleteOne({ _id: catchDoc._id });
      throw new CastEngineError("CAST_RACE", "Pending cast changed, retry");
    }
    return {
      hit: true,
      catchId: String(catchDoc._id),
      score,
      sessionScore: updated.sessionScore,
      pityCounter: updated.pityCounter,
      catchCount: updated.catchCount,
    };
  }

  const newPity = session.pityCounter + 1;
  const updated = await FishingSession.findOneAndUpdate(
    {
      _id: session._id,
      status: "active",
      "pendingCast.castIndex": pc.castIndex,
    },
    {
      $set: { pendingCast: null, pityCounter: newPity },
    },
    { new: true },
  );
  if (!updated) throw new CastEngineError("CAST_RACE", "Pending cast changed, retry");
  return {
    hit: false,
    catchId: null,
    score: 0,
    sessionScore: updated.sessionScore,
    pityCounter: updated.pityCounter,
    catchCount: updated.catchCount,
  };
}

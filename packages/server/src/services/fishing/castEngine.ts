import { createHash } from "node:crypto";
import type { Types } from "mongoose";

import { FISH_SPECIES } from "@hooked/shared";

import { Catch, FishingSession } from "../../db/schema.js";
import { MAX_CATCHES, SCORE_MULTIPLIERS } from "./constants.js";
import { CastEngineError } from "./errors.js";
import { rollCast, seedForCast } from "./rng.js";
import { Mechanic, RARITY_LABEL, Rarity, ZONE_OPEN_SEA, Window } from "./types.js";

/**
 * Cancel-cast grace window. Mirrors the on-chain `CANCEL_CAST_GRACE_SECS`
 * (cancel_cast.rs) — bound to the gateway's worst-case nibble + reaction
 * timeline so a player who disconnects pre-nibble gets their bait back, but
 * a player who missed the reaction can't retroactively unwind the cast.
 */
export const CANCEL_CAST_GRACE_SECS = 8;

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
  speciesId: number;
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
 * Initiate a cast. Decrements bait, increments cast count, rolls the catch,
 * and stores the result on the session as `pendingCast` for the player to
 * resolve via `submitInputSamples` or abandon via `cancelCast`.
 *
 * Atomicity is enforced via a conditional `findOneAndUpdate` filtered on the
 * pre-cast `castCount` — two concurrent initiate calls on the same session
 * cannot both succeed; the loser gets `CAST_RACE`.
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
    // Empty snapshot (no event at session start) falls back to the legacy
    // hardcoded apex slice in rollCast — see rng.ts for the branch.
    apexSpeciesIds: session.eventApexSpeciesAtStart ?? [],
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
          speciesId: cast.speciesId,
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
 * Cancel an in-flight cast within the grace window. Refunds bait but does
 * NOT decrement `castCount` — RNG seed material stays monotonic so a player
 * cannot retry the same cast index by repeatedly cancelling. `pityCounter`
 * is also untouched: the cast is being erased, not resolved.
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

export interface SubmitInputSamplesInput {
  sessionId: string | Types.ObjectId;
  hit: boolean;
  /**
   * Client-reported weight from the mechanic. If 0/undefined, the rolled
   * weight from `pendingCast.weightHg` is used. Mirrors the on-chain
   * `submit_input_samples(weight_hg: u16)` parameter; v1.1 anti-cheat will
   * clamp this to the rolled species range to prevent inflation.
   */
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
 * Resolve a pending cast: write a Catch record on hit, update score/pity,
 * always clear pendingCast. Pity rules:
 *   hit + rarity >= Rare  → reset to 0
 *   hit + Basic            → increment
 *   miss                   → increment
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
    const effectiveWeight =
      !input.weightHg || input.weightHg === 0 ? pc.weightHg : input.weightHg;
    const multiplier = SCORE_MULTIPLIERS[rarityEnum] ?? 1;
    // Ceil((multiplier * weight) / 100), matching the on-chain integer math
    // (a + 99) / 100 — guarantees sub-1kg basics still score 1 point.
    const score = Math.floor((multiplier * effectiveWeight + 99) / 100);

    const speciesName = FISH_SPECIES[pc.speciesId]?.name ?? `species_${pc.speciesId}`;
    const newPity = rarityEnum >= Rarity.Rare ? 0 : session.pityCounter + 1;

    const catchDoc = await Catch.create({
      playerId: session.playerId,
      sessionId: session._id,
      castIndex: pc.castIndex,
      speciesId: pc.speciesId,
      species: speciesName,
      rarity: RARITY_LABEL[rarityEnum],
      weightKg: effectiveWeight / 10, // hg → kg
      score,
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
      // Roll back the catch row we wrote optimistically.
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

  // Miss path
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

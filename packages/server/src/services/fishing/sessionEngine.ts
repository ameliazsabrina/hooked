import { createHash } from "node:crypto";
import type { Types } from "mongoose";

import { Catch, FishingSession, Player } from "../../db/schema.js";
import { CastEngineError } from "./errors.js";
import { assignWindow } from "./window.js";

/**
 * Start a fishing session for a player. Idempotent within (player, dateKey,
 * window) — calling twice returns the existing session, matching the on-chain
 * `init_session` PDA semantics where the seeds enforce one session per slot.
 *
 * The event config is captured by value at session start so an admin can't
 * retroactively change Apex availability for an already-rolled session. The
 * caller (tRPC route in Phase 2) is responsible for fetching the current
 * event status and passing the snapshot in here.
 */
export interface StartSessionInput {
  walletAddress: string;
  /** SOL deposit on the room — used to derive baitInitial. */
  baitInitial: number;
  /** Bait deposit tier (0 = none, 1+ = derived from deposit). */
  tier: number;
  /**
   * Snapshot of the active FishingEvent at session start. Captured by value
   * so an admin can't retroactively change Apex availability or species
   * choice for an already-rolled session. `name` is the admin-set display
   * name; `apexSpeciesIds` pins which fish the cast roll picks from when
   * Apex is rolled (see services/fishing/rng.ts:rollCast). Both unused
   * when no event is active.
   */
  event?: {
    active: true;
    name: string;
    apexBp: number;
    apexSpeciesIds: number[];
  };
  /** Daily seed identifier for audit linkage (e.g. "2026-05-09"). */
  dailySeedDate: string;
  /** Override `now` for deterministic tests. */
  now?: Date;
}

export interface StartSessionResult {
  sessionId: string;
  dateKey: number;
  window: 0 | 1;
  baitRemaining: number;
  baitInitial: number;
  status: "active" | "committed" | "abandoned";
  startedAt: Date;
  eventApexBpAtStart: number;
  isNew: boolean;
}

export async function startSession(input: StartSessionInput): Promise<StartSessionResult> {
  const now = input.now ?? new Date();
  const { window, dateKey } = assignWindow(now);

  const player = await Player.findOne({ walletAddress: input.walletAddress });
  if (!player) {
    throw new CastEngineError("SESSION_NOT_FOUND", `No player for wallet ${input.walletAddress}`);
  }

  // Idempotent: return the existing session if one already exists for this slot.
  const existing = await FishingSession.findOne({
    playerId: player._id,
    dateKey,
    window,
  });
  if (existing) {
    return {
      sessionId: String(existing._id),
      dateKey: existing.dateKey,
      window: existing.window as 0 | 1,
      baitRemaining: existing.baitRemaining,
      baitInitial: existing.baitInitial,
      status: existing.status as "active" | "committed" | "abandoned",
      startedAt: existing.startedAt,
      eventApexBpAtStart: existing.eventApexBpAtStart,
      isNew: false,
    };
  }

  const session = await FishingSession.create({
    playerId: player._id,
    walletAddress: input.walletAddress,
    dateKey,
    window,
    baitInitial: input.baitInitial,
    baitRemaining: input.baitInitial,
    tier: input.tier,
    dailySeedDate: input.dailySeedDate,
    startedAt: now,
    eventActiveAtStart: input.event?.active ?? false,
    eventNameAtStart: input.event?.name ?? null,
    eventApexBpAtStart: input.event?.apexBp ?? 0,
    eventApexSpeciesAtStart: input.event?.apexSpeciesIds ?? [],
  });

  return {
    sessionId: String(session._id),
    dateKey: session.dateKey,
    window: session.window as 0 | 1,
    baitRemaining: session.baitRemaining,
    baitInitial: session.baitInitial,
    status: session.status as "active",
    startedAt: session.startedAt,
    eventApexBpAtStart: session.eventApexBpAtStart,
    isNew: true,
  };
}

/**
 * Compute the canonical session digest used for audit. v1: sha256 over the
 * concatenation of canonical catch leaves sorted by castIndex. Phase 5 will
 * upgrade this to a true Merkle tree if per-catch inclusion proofs are
 * needed; the leaf encoding here stays stable so the upgrade is additive.
 *
 * Leaf encoding (per catch, big-endian):
 *   castIndex (u32) || speciesId (u8) || rarity (u8) || weightHg (u16) || score (u32)
 */
export function computeSessionDigest(catches: ReadonlyArray<{
  castIndex: number;
  speciesId: number;
  rarity: number;
  weightHg: number;
  score: number;
}>): Buffer {
  const sorted = [...catches].sort((a, b) => a.castIndex - b.castIndex);
  const hasher = createHash("sha256");
  // Domain-separation prefix so a 0-catch digest is non-empty and can never
  // collide with an arbitrary external sha256 of empty bytes.
  hasher.update("hooked:session:v1\n");
  for (const c of sorted) {
    const buf = Buffer.alloc(4 + 1 + 1 + 2 + 4);
    buf.writeUInt32BE(c.castIndex, 0);
    buf.writeUInt8(c.speciesId, 4);
    buf.writeUInt8(c.rarity, 5);
    buf.writeUInt16BE(c.weightHg, 6);
    buf.writeUInt32BE(c.score, 8);
    hasher.update(buf);
  }
  return hasher.digest();
}

export interface CommitSessionInput {
  sessionId: string | Types.ObjectId;
  now?: Date;
}

export interface CommitSessionResult {
  sessionId: string;
  sessionScore: number;
  catchCount: number;
  baitUnused: number;
  merkleRoot: Buffer;
  committedAt: Date;
  alreadyCommitted: boolean;
}

const RARITY_NAME_TO_INT: Record<string, number> = {
  basic: 0,
  rare: 1,
  monster: 2,
  legendary: 3,
  apex: 4,
};

/**
 * Commit a session: lock score in, compute the audit digest, bump the
 * player's lifetime aggregates. Idempotent — calling twice returns the
 * existing committed result without changing state.
 *
 * Note: this does NOT push the score to chain. That's Phase 3
 * (jobs/scoreBridge.ts) — the keeper consumes a queue of committed
 * sessionIds and calls hooked_rooms.update_room_entry_score with the
 * merkle root in the tx memo.
 */
export async function commitSession(input: CommitSessionInput): Promise<CommitSessionResult> {
  const session = await FishingSession.findById(input.sessionId);
  if (!session) throw new CastEngineError("SESSION_NOT_FOUND", "Session not found");

  if (session.status === "committed") {
    return {
      sessionId: String(session._id),
      sessionScore: session.sessionScore,
      catchCount: session.catchCount,
      baitUnused: session.baitRemaining,
      merkleRoot: Buffer.from(session.merkleRoot ?? Buffer.alloc(32)),
      committedAt: session.committedAt ?? new Date(0),
      alreadyCommitted: true,
    };
  }
  if (session.status !== "active") {
    throw new CastEngineError("SESSION_NOT_ACTIVE", `Cannot commit ${session.status} session`);
  }

  // Compute digest from persisted catches (NOT from session.sessionScore — we
  // want a content-addressed value that an auditor can re-derive from the
  // public catch records).
  const catches = await Catch.find({ sessionId: session._id })
    .sort({ castIndex: 1 })
    .lean();
  const digest = computeSessionDigest(
    catches.map((c) => ({
      castIndex: c.castIndex ?? 0,
      speciesId: c.speciesId ?? 0,
      rarity: RARITY_NAME_TO_INT[c.rarity] ?? 0,
      // weightKg → weightHg (× 10) to match the leaf encoding domain.
      weightHg: Math.round(c.weightKg * 10),
      score: c.score,
    })),
  );

  const committedAt = input.now ?? new Date();
  const baitUnused = session.baitRemaining;

  // Conditional update so a parallel committer doesn't double-bump player aggregates.
  const updated = await FishingSession.findOneAndUpdate(
    { _id: session._id, status: "active" },
    {
      $set: {
        status: "committed",
        committedAt,
        baitRemaining: 0,
        merkleRoot: digest,
        pendingCast: null,
      },
    },
    { new: true },
  );
  if (!updated) {
    // Lost the race — the session was committed by another caller between
    // the read and update. Fall through to read-and-return the result.
    const reread = await FishingSession.findById(session._id);
    if (reread?.status === "committed") {
      return {
        sessionId: String(reread._id),
        sessionScore: reread.sessionScore,
        catchCount: reread.catchCount,
        baitUnused: reread.baitRemaining,
        merkleRoot: Buffer.from(reread.merkleRoot ?? Buffer.alloc(32)),
        committedAt: reread.committedAt ?? committedAt,
        alreadyCommitted: true,
      };
    }
    throw new CastEngineError("CAST_RACE", "Concurrent commit detected, retry");
  }

  // Bump player lifetime aggregates. Independent operation — failure here
  // shouldn't unwind the commit (the score is already locked in on the
  // session document; aggregates are derivative).
  await Player.updateOne(
    { _id: session.playerId },
    { $inc: { totalScore: updated.sessionScore, totalCatches: updated.catchCount } },
  );

  return {
    sessionId: String(updated._id),
    sessionScore: updated.sessionScore,
    catchCount: updated.catchCount,
    baitUnused,
    merkleRoot: digest,
    committedAt,
    alreadyCommitted: false,
  };
}

import { createHash } from "node:crypto";
import type { Types } from "mongoose";

import { Catch, FishingSession, Player } from "../../db/schema.js";
import { CastEngineError } from "./errors.js";
import { assignWindow } from "./window.js";

/**
 * Idempotent within (player, dateKey, window) on the active session.
 * Event config is captured by value so admin edits don't retroactively
 * change Apex availability for an already-rolled session.
 */
export interface StartSessionInput {
  walletAddress: string;
  roomId: string;
  baitInitial: number;
  tier: number;
  /** apexFishes pins the apex pool + weight ranges (hg) used by rollCast. */
  event?: {
    active: true;
    name: string;
    apexBp: number;
    apexFishes: Array<{
      apexFishId: string;
      name: string;
      weightMinHg: number;
      weightMaxHg: number;
    }>;
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

  // Active-only — committed/abandoned at same slot are ignored so a
  // fresh deposit can lazy-create a new active session.
  const existing = await FishingSession.findOne({
    playerId: player._id,
    dateKey,
    window,
    status: "active",
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
    roomId: input.roomId,
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
    eventApexFishesAtStart: (input.event?.apexFishes ?? []).map((f) => ({
      apexFishId: f.apexFishId,
      name: f.name,
      weightMinHg: f.weightMinHg,
      weightMaxHg: f.weightMaxHg,
    })),
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
 * sha256 over canonical catch leaves sorted by castIndex.
 * Leaf BE: castIndex u32 || speciesId u8 (0xFF for apex) || rarity u8 ||
 *          weightHg u16 || score u32 || (if apex) 12-byte ObjectId.
 */
export function computeSessionDigest(catches: ReadonlyArray<{
  castIndex: number;
  speciesId: number | null;
  apexFishId?: string | null;
  rarity: number;
  weightHg: number;
  score: number;
}>): Buffer {
  const sorted = [...catches].sort((a, b) => a.castIndex - b.castIndex);
  const hasher = createHash("sha256");
  // Domain-separation prefix so a 0-catch digest can't collide with sha256("").
  hasher.update("hooked:session:v1\n");
  for (const c of sorted) {
    const isApex = c.rarity === 4;
    const speciesByte = isApex ? 0xff : (c.speciesId ?? 0);
    const buf = Buffer.alloc(4 + 1 + 1 + 2 + 4);
    buf.writeUInt32BE(c.castIndex, 0);
    buf.writeUInt8(speciesByte & 0xff, 4);
    buf.writeUInt8(c.rarity, 5);
    buf.writeUInt16BE(c.weightHg, 6);
    buf.writeUInt32BE(c.score, 8);
    hasher.update(buf);
    if (isApex) {
      // Zero-filled defensively if apexFishId is missing.
      const idBuf = Buffer.alloc(12);
      if (c.apexFishId && /^[0-9a-f]{24}$/i.test(c.apexFishId)) {
        Buffer.from(c.apexFishId, "hex").copy(idBuf);
      }
      hasher.update(idBuf);
    }
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

/** Idempotent. Score push to chain happens in jobs/scoreBridge.ts. */
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

  // Content-addressed digest — auditors can re-derive from public catch records.
  const catches = await Catch.find({ sessionId: session._id })
    .sort({ castIndex: 1 })
    .lean();
  const digest = computeSessionDigest(
    catches.map((c) => ({
      castIndex: c.castIndex ?? 0,
      speciesId: c.speciesId ?? null,
      apexFishId: c.apexFishId ? String(c.apexFishId) : null,
      rarity: RARITY_NAME_TO_INT[c.rarity] ?? 0,
      weightHg: Math.round(c.weightKg * 10),
      score: c.score,
    })),
  );

  const committedAt = input.now ?? new Date();
  const baitUnused = session.baitRemaining;

  // Conditional update prevents double-bump on parallel commits.
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
    // Lost race — re-read the concurrently-committed result.
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

  // Aggregates are derivative — failure here doesn't unwind the commit.
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

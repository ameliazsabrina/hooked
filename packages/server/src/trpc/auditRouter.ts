import { TRPCError } from "@trpc/server";
import { createHash } from "node:crypto";
import { z } from "zod";

import { Catch, FishingSession } from "../db/schema.js";
import { getDailySeedAudit } from "../services/fishing/dailySeed.js";
import { computeSessionDigest } from "../services/fishing/sessionEngine.js";
import { seedForCast } from "../services/fishing/rng.js";
import { publicProcedure, router } from "./trpc.js";

// ---------------------------------------------------------------------------
// Audit router — public read-only endpoints that let any player verify the
// off-chain RNG was fair. Three layers of evidence:
//
//   1. dailySeed(date)
//      - Pre-day-end:  returns sha256(seed) only (commitment).
//      - Post-day-end: returns the raw seed too. Combined with the per-cast
//                      seedHash stored on FishingSession.pendingCast, the
//                      player can prove their cast wasn't rerolled by
//                      recomputing seedForCast(seed, sessionId, castIndex,
//                      pity, wallet) → sha256 → equals stored seedHash.
//
//   2. session(sessionId)
//      - Returns the canonical catch leaves (sorted by castIndex) plus the
//        merkleRoot stored at commit time. Player recomputes the digest
//        from leaves and asserts equality with the on-chain memo's root.
//
//   3. castVerify(sessionId, castIndex, dailySeedHex, ...)
//      - Convenience: server reproduces the seed → catch derivation given
//        a revealed daily seed and returns the recomputed catch alongside
//        the stored values so a player without local crypto tooling can
//        spot-check.
// ---------------------------------------------------------------------------

const ObjectIdString = z
  .string()
  .regex(/^[0-9a-f]{24}$/i, "Must be a 24-char hex ObjectId");

const DateISO = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD UTC");

const HexSeed = z
  .string()
  .regex(/^[0-9a-f]{64}$/i, "Must be 64 hex chars (32 bytes)");

const DailySeedOutput = z
  .object({
    date: z.string(),
    seedHash: z.string(),
    publishedAt: z.string(),
    revealAfter: z.string(),
    revealed: z.boolean(),
    seed: z.string().nullable(),
  })
  .strict();

const SessionAuditOutput = z
  .object({
    sessionId: z.string(),
    walletAddress: z.string(),
    dateKey: z.number().int(),
    window: z.number().int().min(0).max(1),
    status: z.enum(["active", "committed", "abandoned"]),
    sessionScore: z.number().int().nonnegative(),
    castCount: z.number().int().nonnegative(),
    catchCount: z.number().int().nonnegative(),
    dailySeedDate: z.string(),
    merkleRoot: z.string().nullable(),
    chainScoreTxSignature: z.string().nullable(),
    catches: z.array(
      z
        .object({
          castIndex: z.number().int().nonnegative(),
          speciesId: z.number().int().nonnegative(),
          rarity: z.number().int().min(0).max(4),
          weightHg: z.number().int().nonnegative(),
          score: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    /** Merkle root the server recomputes from public catches; should match
     *  `merkleRoot` if the session was committed. */
    recomputedDigest: z.string(),
  })
  .strict();

const CastVerifyInput = z
  .object({
    sessionId: ObjectIdString,
    castIndex: z.number().int().positive(),
    dailySeed: HexSeed,
  })
  .strict();

const CastVerifyOutput = z
  .object({
    matchesStoredHash: z.boolean(),
    storedSeedHash: z.string(),
    recomputedSeedHash: z.string(),
  })
  .strict();

const RARITY_NAME_TO_INT: Record<string, number> = {
  basic: 0,
  rare: 1,
  monster: 2,
  legendary: 3,
  apex: 4,
};

export const auditRouter = router({
  /**
   * Return the daily seed commitment (sha256) and, after the reveal
   * timestamp, the raw seed itself. Public: anyone can audit any past day.
   */
  dailySeed: publicProcedure
    .input(z.object({ date: DateISO }).strict())
    .output(DailySeedOutput.nullable())
    .query(async ({ input }) => {
      const view = await getDailySeedAudit(input.date);
      return view;
    }),

  /**
   * Return the canonical catch leaves for a session plus the merkle root
   * recomputed server-side. A player compares `recomputedDigest` against the
   * `merkleRoot` field — if equal, the catch list is the same one used to
   * compute the on-chain memo.
   */
  session: publicProcedure
    .input(z.object({ sessionId: ObjectIdString }).strict())
    .output(SessionAuditOutput)
    .query(async ({ input }) => {
      // Avoid .lean() — mongoose returns Buffer fields as BSON Binary in lean
      // mode, which doesn't round-trip through `.toString("hex")`.
      const session = await FishingSession.findById(input.sessionId);
      if (!session) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
      }
      // Catch docs have no Buffer fields, so .lean() is safe and saves a
      // hydration pass when the catch list is large.
      const catches = await Catch.find({ sessionId: session._id })
        .sort({ castIndex: 1 })
        .lean();
      const leaves = catches.map((c) => ({
        castIndex: c.castIndex ?? 0,
        speciesId: c.speciesId ?? 0,
        rarity: RARITY_NAME_TO_INT[c.rarity] ?? 0,
        weightHg: Math.round(c.weightKg * 10),
        score: c.score,
      }));
      const recomputed = computeSessionDigest(leaves);
      return {
        sessionId: String(session._id),
        walletAddress: session.walletAddress,
        dateKey: session.dateKey,
        window: session.window as 0 | 1,
        status: session.status as "active" | "committed" | "abandoned",
        sessionScore: session.sessionScore,
        castCount: session.castCount,
        catchCount: session.catchCount,
        dailySeedDate: session.dailySeedDate,
        merkleRoot: session.merkleRoot
          ? Buffer.from(session.merkleRoot as unknown as Uint8Array).toString("hex")
          : null,
        chainScoreTxSignature: session.chainScoreTxSignature ?? null,
        catches: leaves,
        recomputedDigest: recomputed.toString("hex"),
      };
    }),

  /**
   * Given a revealed daily seed, recompute the per-cast HMAC seed hash and
   * compare it to the stored value on the session's pendingCast (or, after
   * resolution, the value committed in the catch's audit context).
   *
   * For now we only verify against `pendingCast.seedHash` — Phase 6 will
   * persist seedHash on the Catch row itself so historical casts are
   * verifiable too. v1 is sufficient for live-cast audit.
   */
  castVerify: publicProcedure
    .input(CastVerifyInput)
    .output(CastVerifyOutput)
    .query(async ({ input }) => {
      // Hydrated doc — see note on session() above.
      const session = await FishingSession.findById(input.sessionId);
      if (!session) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
      }
      const pending = session.pendingCast;
      if (!pending || pending.castIndex !== input.castIndex) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No pending cast at castIndex ${input.castIndex}`,
        });
      }

      const dailySeedBuf = Buffer.from(input.dailySeed, "hex");
      const recomputed = seedForCast({
        dailySeed: dailySeedBuf,
        sessionId: String(session._id),
        castIndex: input.castIndex,
        pity: session.pityCounter,
        playerWallet: session.walletAddress,
      });
      const recomputedHash = createHash("sha256").update(recomputed).digest();
      const storedHash = Buffer.from(pending.seedHash as unknown as Uint8Array);

      return {
        matchesStoredHash: recomputedHash.equals(storedHash),
        storedSeedHash: storedHash.toString("hex"),
        recomputedSeedHash: recomputedHash.toString("hex"),
      };
    }),
});

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { adminSessionProcedure, router } from "../trpc.js";
import { Catch, FishingSession, Player, ReactionLog } from "../../db/schema.js";

// Lean() returns mongoose Buffers as BSON Binary, not Node Buffer. Normalize
// to hex so the wire shape is stable.
function bytesToHex(value: unknown): string | null {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  const maybe = value as { buffer?: ArrayBufferLike; toString?: () => string };
  if (maybe.buffer instanceof ArrayBuffer) {
    return Buffer.from(maybe.buffer as ArrayBuffer).toString("hex");
  }
  if (typeof maybe.toString === "function") return maybe.toString();
  return null;
}

const STATUS_VALUES = ["active", "committed", "abandoned"] as const;

// Exported for tRPC type inference: when a procedure returns a value typed
// as a private interface, the generated router type can't be named in the
// dashboard's typecheck and inference collapses to `never`.
export interface SessionListItem {
  id: string;
  walletAddress: string;
  dateKey: number;
  window: number;
  status: string;
  tier: number;
  baitInitial: number;
  baitRemaining: number;
  sessionScore: number;
  castCount: number;
  catchCount: number;
  pityCounter: number;
  startedAt: Date;
  committedAt: Date | null;
  dailySeedDate: string;
  chainScoreTxSignature: string | null;
  chainScoreBridgedAt: Date | null;
  eventActiveAtStart: boolean;
  eventNameAtStart: string | null;
  eventApexBpAtStart: number;
  eventApexSpeciesAtStart: number[];
  hasPendingCast: boolean;
}

export const adminSessionsRouter = router({
  list: adminSessionProcedure
    .input(
      z.object({
        status: z.enum(STATUS_VALUES).optional(),
        wallet: z.string().min(32).max(64).optional(),
        dateKey: z.number().int().optional(),
        page: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ input }) => {
      const filter: Record<string, unknown> = {};
      if (input.status) filter.status = input.status;
      if (input.wallet) filter.walletAddress = input.wallet;
      if (input.dateKey !== undefined) filter.dateKey = input.dateKey;

      const [items, totalCount] = await Promise.all([
        FishingSession.find(filter)
          .sort({ startedAt: -1 })
          .skip((input.page - 1) * input.limit)
          .limit(input.limit)
          .lean(),
        FishingSession.countDocuments(filter),
      ]);

      const mapped: SessionListItem[] = items.map((s) => ({
        id: String(s._id),
        walletAddress: s.walletAddress,
        dateKey: s.dateKey,
        window: s.window,
        status: s.status,
        tier: s.tier,
        baitInitial: s.baitInitial,
        baitRemaining: s.baitRemaining,
        sessionScore: s.sessionScore,
        castCount: s.castCount,
        catchCount: s.catchCount,
        pityCounter: s.pityCounter,
        startedAt: s.startedAt,
        committedAt: s.committedAt ?? null,
        dailySeedDate: s.dailySeedDate,
        chainScoreTxSignature: s.chainScoreTxSignature ?? null,
        chainScoreBridgedAt: s.chainScoreBridgedAt ?? null,
        eventActiveAtStart: s.eventActiveAtStart,
        eventNameAtStart: s.eventNameAtStart ?? null,
        eventApexBpAtStart: s.eventApexBpAtStart,
        eventApexSpeciesAtStart: Array.from(s.eventApexSpeciesAtStart ?? []),
        hasPendingCast: s.pendingCast != null,
      }));

      return {
        items: mapped,
        totalCount,
        page: input.page,
        limit: input.limit,
      };
    }),

  get: adminSessionProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .query(async ({ input }) => {
      const session = await FishingSession.findById(input.sessionId).lean();
      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Session ${input.sessionId} not found`,
        });
      }
      const [catches, reactionLogs, player] = await Promise.all([
        Catch.find({ sessionId: session._id })
          .sort({ castIndex: 1 })
          .lean(),
        ReactionLog.find({ wallet: session.walletAddress })
          .sort({ createdAt: -1 })
          .limit(100)
          .lean(),
        Player.findById(session.playerId)
          .select({ walletAddress: 1, nickname: 1, shellBalance: 1 })
          .lean(),
      ]);

      const merkleRootHex = bytesToHex(session.merkleRoot);
      const pendingCastSerialized = session.pendingCast
        ? {
            ...session.pendingCast,
            seedHash: bytesToHex(session.pendingCast.seedHash),
          }
        : null;

      return {
        session: {
          id: String(session._id),
          playerId: String(session.playerId),
          walletAddress: session.walletAddress,
          dateKey: session.dateKey,
          window: session.window,
          status: session.status,
          tier: session.tier,
          baitInitial: session.baitInitial,
          baitRemaining: session.baitRemaining,
          sessionScore: session.sessionScore,
          castCount: session.castCount,
          catchCount: session.catchCount,
          pityCounter: session.pityCounter,
          startedAt: session.startedAt,
          committedAt: session.committedAt,
          dailySeedDate: session.dailySeedDate,
          merkleRootHex,
          chainScoreTxSignature: session.chainScoreTxSignature,
          chainScoreBridgedAt: session.chainScoreBridgedAt,
          eventActiveAtStart: session.eventActiveAtStart,
          eventNameAtStart: session.eventNameAtStart ?? null,
          eventApexBpAtStart: session.eventApexBpAtStart,
          eventApexSpeciesAtStart: Array.from(session.eventApexSpeciesAtStart ?? []) as number[],
          pendingCast: pendingCastSerialized,
        },
        player,
        catches: catches.map((c) => ({
          id: String(c._id),
          castIndex: c.castIndex,
          speciesId: c.speciesId,
          species: c.species,
          rarity: c.rarity,
          weightKg: c.weightKg,
          score: c.score,
          isBounty: c.isBounty,
          eventTag: c.eventTag,
          released: c.released,
          sellValue: c.sellValue,
          caughtAt: c.caughtAt,
        })),
        reactionLogs: reactionLogs.map((r) => ({
          id: String(r._id),
          clientCastId: r.clientCastId,
          nibbleDelayMs: r.nibbleDelayMs,
          reactionTimeMs: r.reactionTimeMs,
          preNibbleTapCount: r.preNibbleTapCount,
          sampleJitterMaxMs: r.sampleJitterMaxMs,
          outcome: r.outcome,
          rarity: r.rarity,
          speciesId: r.speciesId,
          createdAt: (r as { createdAt?: Date }).createdAt ?? null,
        })),
      };
    }),
});

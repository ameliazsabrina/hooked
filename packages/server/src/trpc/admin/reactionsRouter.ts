import { z } from "zod";
import { adminSessionProcedure, router } from "../trpc.js";
import { ReactionLog } from "../../db/schema.js";

const OUTCOME_VALUES = [
  "hit",
  "escaped_no_tap",
  "escaped_miss",
  "cancelled",
] as const;

// Reflexes faster than this are physically implausible; surface them so an
// admin can investigate (matches the threshold used by the gateway logger).
const SUSPICIOUS_REACTION_MS = 100;

export const adminReactionsRouter = router({
  list: adminSessionProcedure
    .input(
      z.object({
        wallet: z.string().min(32).max(64).optional(),
        outcome: z.enum(OUTCOME_VALUES).optional(),
        suspiciousOnly: z.boolean().optional(),
        sinceHours: z.number().int().min(1).max(24 * 30).optional(),
        page: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(200).default(100),
      }),
    )
    .query(async ({ input }) => {
      const filter: Record<string, unknown> = {};
      if (input.wallet) filter.wallet = input.wallet;
      if (input.outcome) filter.outcome = input.outcome;
      if (input.sinceHours) {
        filter.createdAt = {
          $gte: new Date(Date.now() - input.sinceHours * 3600_000),
        };
      }
      if (input.suspiciousOnly) {
        filter.reactionTimeMs = { $gt: 0, $lt: SUSPICIOUS_REACTION_MS };
      }

      const [items, totalCount] = await Promise.all([
        ReactionLog.find(filter)
          .sort({ createdAt: -1 })
          .skip((input.page - 1) * input.limit)
          .limit(input.limit)
          .lean(),
        ReactionLog.countDocuments(filter),
      ]);

      return {
        items: items.map((r) => ({
          id: String(r._id),
          wallet: r.wallet,
          clientCastId: r.clientCastId,
          sessionPda: r.sessionPda,
          nibbleDelayMs: r.nibbleDelayMs,
          reactionTimeMs: r.reactionTimeMs,
          preNibbleTapCount: r.preNibbleTapCount,
          sampleJitterMaxMs: r.sampleJitterMaxMs,
          outcome: r.outcome,
          rarity: r.rarity,
          speciesId: r.speciesId,
          createdAt: (r as { createdAt?: Date }).createdAt ?? null,
          suspicious:
            typeof r.reactionTimeMs === "number" &&
            r.reactionTimeMs > 0 &&
            r.reactionTimeMs < SUSPICIOUS_REACTION_MS,
        })),
        totalCount,
        page: input.page,
        limit: input.limit,
        suspiciousThresholdMs: SUSPICIOUS_REACTION_MS,
      };
    }),

  summary: adminSessionProcedure
    .input(
      z.object({
        sinceHours: z.number().int().min(1).max(24 * 30).default(24),
      }),
    )
    .query(async ({ input }) => {
      const since = new Date(Date.now() - input.sinceHours * 3600_000);
      const [outcomes, suspicious, totalSamples] = await Promise.all([
        ReactionLog.aggregate<{ _id: string; count: number }>([
          { $match: { createdAt: { $gte: since } } },
          { $group: { _id: "$outcome", count: { $sum: 1 } } },
        ]),
        ReactionLog.countDocuments({
          createdAt: { $gte: since },
          reactionTimeMs: { $gt: 0, $lt: SUSPICIOUS_REACTION_MS },
        }),
        ReactionLog.countDocuments({ createdAt: { $gte: since } }),
      ]);
      return {
        windowHours: input.sinceHours,
        outcomes,
        suspicious,
        totalSamples,
        suspiciousThresholdMs: SUSPICIOUS_REACTION_MS,
      };
    }),
});

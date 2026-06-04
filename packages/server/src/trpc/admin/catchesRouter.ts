import { z } from "zod";
import { adminSessionProcedure, router } from "../trpc.js";
import { Catch } from "../../db/schema.js";

const RARITY_VALUES = ["basic", "rare", "monster", "legendary", "apex"] as const;

export const adminCatchesRouter = router({
  list: adminSessionProcedure
    .input(
      z.object({
        wallet: z.string().min(32).max(64).optional(),
        rarity: z.enum(RARITY_VALUES).optional(),
        sessionId: z.string().min(1).optional(),
        isBounty: z.boolean().optional(),
        sinceHours: z.number().int().min(1).max(24 * 30).optional(),
        page: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(100).default(50),
      }).strict(),
    )
    .query(async ({ input }) => {
      const filter: Record<string, unknown> = {};
      if (input.rarity) filter.rarity = input.rarity;
      if (input.sessionId) filter.sessionId = input.sessionId;
      if (input.isBounty !== undefined) filter.isBounty = input.isBounty;
      if (input.sinceHours) {
        filter.caughtAt = {
          $gte: new Date(Date.now() - input.sinceHours * 3600_000),
        };
      }

      // wallet filter joins via Player (aggregate); denorm wallet onto Catch if volume grows.
      type Stage = Record<string, unknown>;
      const pipeline: Stage[] = [
        { $match: filter },
        { $sort: { caughtAt: -1 } },
      ];
      if (input.wallet) {
        pipeline.push(
          {
            $lookup: {
              from: "players",
              localField: "playerId",
              foreignField: "_id",
              as: "player",
            },
          },
          { $unwind: "$player" },
          { $match: { "player.walletAddress": input.wallet } },
        );
      }
      const countPipeline = [...pipeline, { $count: "n" }];
      pipeline.push(
        { $skip: (input.page - 1) * input.limit },
        { $limit: input.limit },
      );
      if (!input.wallet) {
        // need player for display even without filter
        pipeline.push(
          {
            $lookup: {
              from: "players",
              localField: "playerId",
              foreignField: "_id",
              as: "player",
            },
          },
          { $unwind: { path: "$player", preserveNullAndEmptyArrays: true } },
        );
      }

      const [items, countRes] = await Promise.all([
        Catch.aggregate(pipeline as never),
        Catch.aggregate<{ n: number }>(countPipeline as never),
      ]);
      const totalCount = countRes[0]?.n ?? 0;

      return {
        items: items.map((c) => ({
          id: String(c._id),
          playerId: String(c.playerId),
          walletAddress: c.player?.walletAddress ?? null,
          nickname: c.player?.nickname ?? null,
          sessionId: c.sessionId ? String(c.sessionId) : null,
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
          soldAt: c.soldAt,
          soldPrice: c.soldPrice,
          caughtAt: c.caughtAt,
        })),
        totalCount,
        page: input.page,
        limit: input.limit,
      };
    }),

  rarityBreakdown: adminSessionProcedure
    .input(
      z.object({
        sinceHours: z.number().int().min(1).max(24 * 30).default(24),
      }).strict(),
    )
    .query(async ({ input }) => {
      const since = new Date(Date.now() - input.sinceHours * 3600_000);
      const buckets = await Catch.aggregate<{
        _id: string;
        count: number;
        scoreSum: number;
      }>([
        { $match: { caughtAt: { $gte: since } } },
        {
          $group: {
            _id: "$rarity",
            count: { $sum: 1 },
            scoreSum: { $sum: "$score" },
          },
        },
      ]);
      return {
        windowHours: input.sinceHours,
        buckets,
      };
    }),
});

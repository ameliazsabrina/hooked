import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure } from "./trpc.js";
import { Player, PoolTier, DailyLeaderboard } from "../db/schema.js";
import { POOL_TIERS, DEPOSIT_APY_ESTIMATE, YIELD_SPLIT, POOL_DURATION_DAYS } from "@hooked/shared";
import * as lb from "../services/leaderboard.js";
import { env } from "../config/env.js";

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function parseTierFromPoolId(poolId: string | null): number | null {
  if (!poolId) return null;
  const tier = parseInt(poolId.split("_")[0], 10);
  return POOL_TIERS.includes(tier as any) ? tier : null;
}

const tierInput = z.object({
  tier: z.number().refine((v) => POOL_TIERS.includes(v as any), {
    message: "Invalid pool tier",
  }),
});

export const poolRouter = router({
  activePool: protectedProcedure
    .input(tierInput)
    .query(async ({ input }) => {
      if (!env.FEATURES_LP_ENABLED) return null;
      const month = currentMonth();
      const poolTier = await PoolTier.findOne({
        tier: input.tier,
        activeMonth: month,
        onChainPoolId: { $ne: null },
      }).lean();

      if (!poolTier?.onChainPoolId) {
        return null;
      }

      return {
        poolId: poolTier.onChainPoolId,
        poolAddress: poolTier.onChainPoolAddress,
        tier: poolTier.tier,
        activeMonth: poolTier.activeMonth,
      };
    }),

  tiers: publicProcedure.query(async () => {
    if (!env.FEATURES_LP_ENABLED) return [];
    const month = currentMonth();
    const tiers = await PoolTier.find({ activeMonth: month }).lean();

    return POOL_TIERS.map((tier) => {
      const poolTier = tiers.find((t) => t.tier === tier);
      const realCount = poolTier?.realPlayerCount ?? 0;
      const grossPoolYield = tier * realCount * DEPOSIT_APY_ESTIMATE * (POOL_DURATION_DAYS / 365);
      const playerShare = grossPoolYield * (1 - YIELD_SPLIT.protocol);

      return {
        tier,
        activeMonth: month,
        realPlayerCount: realCount,
        totalPlayerCount: realCount,
        estimatedPoolYield: Math.round(playerShare * 1e9) / 1e9,
      };
    });
  }),

  leaderboard: protectedProcedure
    .input(
      z.object({
        tier: z.number().refine((v) => POOL_TIERS.includes(v as any)),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      if (!env.FEATURES_LP_ENABLED) {
        return { entries: [], playerRank: null, totalEntries: 0 };
      }
      const date = input.date ?? todayUTC();
      const isToday = date === todayUTC();

      if (isToday) {
        const entries = await lb.getLeaderboard(ctx.redis, input.tier, date, 0, 50);
        const memberIds = entries.map((e) => e.member);
        const topCatches = await lb.getTopCatches(ctx.redis, input.tier, date, memberIds);

        const players = memberIds.length > 0
          ? await Player.find(
              { _id: { $in: memberIds } },
              { _id: 1, nickname: 1 }
            ).lean()
          : [];

        const playerMap = new Map(players.map((p) => [p._id.toString(), p.nickname ?? "Anonymous"]));

        const leaderboardEntries = entries.map((e, index) => ({
          rank: index + 1,
          displayName: playerMap.get(e.member) ?? "Anonymous",
          dailyScore: e.score,
          topCatch: topCatches.get(e.member) ?? null,
        }));

        const player = await Player.findOne(
          { walletAddress: ctx.walletAddress },
          { _id: 1 }
        ).lean();

        let playerRank: number | null = null;
        if (player) {
          const rank = await lb.getPlayerRank(
            ctx.redis,
            input.tier,
            date,
            player._id.toString()
          );
          playerRank = rank !== null ? rank + 1 : null;
        }

        const totalEntries = await lb.getEntryCount(ctx.redis, input.tier, date);

        return { entries: leaderboardEntries, playerRank, totalEntries };
      }

      const doc = await DailyLeaderboard.findOne({
        date,
        tier: input.tier,
      }).lean();

      if (!doc) {
        return { entries: [], playerRank: null, totalEntries: 0 };
      }

      const player = await Player.findOne(
        { walletAddress: ctx.walletAddress },
        { _id: 1 }
      ).lean();

      const playerIdStr = player?._id.toString();
      let playerRank: number | null = null;

      const entries = doc.entries.map((e, index) => {
        if (playerIdStr && e.playerId?.toString() === playerIdStr) {
          playerRank = index + 1;
        }
        return {
          rank: index + 1,
          displayName: e.displayName,
          dailyScore: e.dailyScore,
          topCatch: e.topCatch ?? null,
        };
      });

      return { entries, playerRank, totalEntries: entries.length };
    }),

  myRank: protectedProcedure.query(async ({ ctx }) => {
    if (!env.FEATURES_LP_ENABLED) {
      return { rank: null, dailyScore: 0, totalEntries: 0, estimatedPrize: null };
    }
    const player = await Player.findOne(
      { walletAddress: ctx.walletAddress },
      { _id: 1, currentPoolId: 1 }
    ).lean();

    if (!player?.currentPoolId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Not deposited in any pool" });
    }

    const tier = parseTierFromPoolId(player.currentPoolId);
    if (!tier) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Invalid pool ID" });
    }

    const date = todayUTC();
    const playerId = player._id.toString();

    const [rank, score, totalEntries] = await Promise.all([
      lb.getPlayerRank(ctx.redis, tier, date, playerId),
      lb.getPlayerScore(ctx.redis, tier, date, playerId),
      lb.getEntryCount(ctx.redis, tier, date),
    ]);

    const poolTierDoc = await PoolTier.findOne({
      tier,
      activeMonth: currentMonth(),
    }).lean();

    const realCount = poolTierDoc?.realPlayerCount ?? 0;
    const grossPoolYield = tier * realCount * DEPOSIT_APY_ESTIMATE * (POOL_DURATION_DAYS / 365);
    const splits = [YIELD_SPLIT.first, YIELD_SPLIT.second, YIELD_SPLIT.third];

    let estimatedPrize: number | null = null;
    if (rank !== null && rank < 3) {
      estimatedPrize = Math.round(grossPoolYield * splits[rank] * 1e9) / 1e9;
    }

    return {
      rank: rank !== null ? rank + 1 : null,
      dailyScore: score ?? 0,
      totalEntries,
      estimatedPrize,
    };
  }),

  info: protectedProcedure
    .input(tierInput)
    .query(async ({ input }) => {
      if (!env.FEATURES_LP_ENABLED) return null;
      const month = currentMonth();
      const poolTier = await PoolTier.findOne({
        tier: input.tier,
        activeMonth: month,
      }).lean();

      const realCount = poolTier?.realPlayerCount ?? 0;
      const grossPoolYield = input.tier * realCount * DEPOSIT_APY_ESTIMATE * (POOL_DURATION_DAYS / 365);
      const playerShare = grossPoolYield * (1 - YIELD_SPLIT.protocol);

      return {
        tier: input.tier,
        activeMonth: month,
        realPlayerCount: realCount,
        totalPlayerCount: realCount,
        estimatedPoolYield: Math.round(playerShare * 1e9) / 1e9,
        status: poolTier?.status ?? "open",
        endsAt: poolTier?.endsAt?.toISOString() ?? null,
      };
    }),

  poolLeaderboard: protectedProcedure
    .input(
      z.object({
        poolId: z.string(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      if (!env.FEATURES_LP_ENABLED) {
        return { entries: [], playerRank: null, playerScore: null, totalEntries: 0 };
      }
      const entries = await lb.getPoolLeaderboard(ctx.redis, input.poolId, input.offset, input.limit);
      const memberIds = entries.map((e) => e.member);

      const players = memberIds.length > 0
        ? await Player.find({ _id: { $in: memberIds } }, { _id: 1, nickname: 1 }).lean()
        : [];
      const playerMap = new Map(players.map((p) => [p._id.toString(), p.nickname ?? "Anonymous"]));

      const leaderboardEntries = entries.map((e, index) => ({
        rank: input.offset + index + 1,
        displayName: playerMap.get(e.member) ?? "Anonymous",
        cumulativeScore: e.score,
      }));

      const player = await Player.findOne(
        { walletAddress: ctx.walletAddress },
        { _id: 1 }
      ).lean();

      let playerRank: number | null = null;
      let playerScore: number | null = null;
      if (player) {
        const pid = player._id.toString();
        const [rank, score] = await Promise.all([
          lb.getPoolPlayerRank(ctx.redis, input.poolId, pid),
          lb.getPoolPlayerScore(ctx.redis, input.poolId, pid),
        ]);
        playerRank = rank !== null ? rank + 1 : null;
        playerScore = score;
      }

      const totalEntries = await lb.getPoolEntryCount(ctx.redis, input.poolId);

      return { entries: leaderboardEntries, playerRank, playerScore, totalEntries };
    }),

  history: protectedProcedure
    .input(
      z.object({
        tier: z.number().refine((v) => POOL_TIERS.includes(v as any)),
        days: z.number().int().min(1).max(30).default(7),
      })
    )
    .query(async ({ ctx, input }) => {
      if (!env.FEATURES_LP_ENABLED) return [];
      const today = new Date();
      const dates: string[] = [];
      for (let i = 1; i <= input.days; i++) {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() - i);
        dates.push(d.toISOString().slice(0, 10));
      }

      const docs = await DailyLeaderboard.find({
        tier: input.tier,
        date: { $in: dates },
      })
        .sort({ date: -1 })
        .lean();

      const player = await Player.findOne(
        { walletAddress: ctx.walletAddress },
        { _id: 1 }
      ).lean();

      const playerIdStr = player?._id.toString();

      return docs.map((doc) => {
        let playerRank: number | null = null;
        let playerScore: number | null = null;

        if (playerIdStr) {
          const idx = doc.entries.findIndex(
            (e) => e.playerId?.toString() === playerIdStr
          );
          if (idx !== -1) {
            playerRank = idx + 1;
            playerScore = doc.entries[idx].dailyScore;
          }
        }

        const top3 = (doc.finalRanks ?? []).map((r) => ({
          rank: r.rank,
          displayName: r.displayName,
          dailyScore:
            doc.entries.find(
              (e) => r.playerId && e.playerId?.toString() === r.playerId.toString()
            )?.dailyScore ?? 0,
          prizeSOL: r.prizeSOL,
        }));

        return {
          date: doc.date,
          tier: doc.tier,
          top3,
          prizePool: doc.prizePool,
          playerRank,
          playerScore,
        };
      });
    }),
});

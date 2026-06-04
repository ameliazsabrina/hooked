import { z } from "zod";
import { Connection } from "@solana/web3.js";
import { router, protectedProcedure } from "./trpc.js";
import {
  ApexFish,
  Player,
  PoolTier,
  Catch,
  Room,
  FishingSession,
} from "../db/schema.js";
import type { Types } from "mongoose";
import { env } from "../config/env.js";
import {
  isValidDepositAmount,
  VALID_DEPOSIT_AMOUNTS,
  NICKNAME_MIN,
  NICKNAME_MAX,
  NICKNAME_REGEX,
  NICKNAME_ERRORS,
} from "@hooked/shared";
import { assignWindow } from "../services/fishing/window.js";
import { baitAmountForDeposit } from "../services/baitAmount.js";
import {
  ConflictError,
  ValidationError,
  mapAppErrorToTRPC,
} from "../errors/AppError.js";
import * as lb from "../services/leaderboard.js";

const BUCKET_TIER = 1;

const RARITY_LABELS = ["basic", "rare", "monster", "legendary", "apex"] as const;

function currentSessionStart(now: Date): Date {
  const hour = now.getUTCHours();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  if (hour < 2) {
    start.setUTCDate(start.getUTCDate() - 1);
    start.setUTCHours(14);
  } else if (hour < 14) {
    start.setUTCHours(2);
  } else {
    start.setUTCHours(14);
  }
  return start;
}

const solanaConnection = new Connection(env.SOLANA_RPC_URL, "confirmed");

export const playerRouter = router({
  me: protectedProcedure.query(async ({ ctx }) => {
    const now = new Date();
    const existing = await Player.findOne({ walletAddress: ctx.walletAddress }).lean();

    const utcDay = (d: Date) =>
      `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    const todayKey = utcDay(now);
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayKey = utcDay(yesterday);

    let nextStreak = existing?.loginStreak ?? 0;
    const prevSeen = existing?.lastSeenAt ?? null;
    if (!prevSeen) {
      nextStreak = 1;
    } else {
      const prevKey = utcDay(prevSeen);
      if (prevKey === todayKey) {
        if (nextStreak === 0) nextStreak = 1;
      } else if (prevKey === yesterdayKey) {
        nextStreak += 1;
      } else {
        nextStreak = 1;
      }
    }

    const player = await Player.findOneAndUpdate(
      { walletAddress: ctx.walletAddress },
      {
        $set: {
          lastSeenAt: now,
          ipCountry: ctx.ipCountry,
          loginStreak: nextStreak,
        },
        $setOnInsert: { walletAddress: ctx.walletAddress },
      },
      { new: true, upsert: true }
    ).lean();

    if (!player || !player.nickname) {
      return { exists: false as const };
    }

    // Active = SOL still on-chain. `returned` flips exactly when keeper's
    // return_principal lands. expiresAt is informational; gating on it
    // would prompt redeposits before SOL has actually returned.
    const activeDeposit =
      player.deposits?.find((d) => !d.returned) ?? null;

    const lpEnabled = env.FEATURES_LP_ENABLED;

    // States driven from room.phase + closesAt (B4):
    //   "deposit"  — no active deposit
    //   "active"   — entry/active + closesAt future; cast enabled
    //   "closing"  — closesAt passed, lifecycle tick hasn't run
    //   "settling" — close_room may have run, SOL returning
    //   "closed"   — finalized but deposit.returned race not flipped
    //   "missing"  — deposit references a deleted room (defensive)
    let windowState:
      | "deposit"
      | "active"
      | "closing"
      | "settling"
      | "closed"
      | "missing" = "deposit";
    if (activeDeposit) {
      const room = await Room.findOne(
        { roomId: activeDeposit.poolId },
        { phase: 1, closesAt: 1 },
      ).lean();
      const nowMs = Date.now();
      if (!room) windowState = "missing";
      else if (room.phase === "closed") windowState = "closed";
      else if (room.phase === "settling") windowState = "settling";
      else if (room.closesAt.getTime() <= nowMs) windowState = "closing";
      else windowState = "active";
    }

    return {
      exists: true as const,
      nickname: player.nickname,
      skin: player.skin ?? null,
      depositAmount: activeDeposit?.amount ?? null,
      depositedAt: activeDeposit?.depositedAt?.toISOString() ?? null,
      roomId: activeDeposit?.poolId ?? null,
      activeMonth: lpEnabled ? activeDeposit?.activeMonth ?? null : null,
      // Backwards-compat clock math; windowState is the source of truth.
      expiresAt: activeDeposit?.expiresAt?.toISOString() ?? null,
      windowState,
      shellBalance: player.shellBalance,
      loginStreak: player.loginStreak,
      totalCatches: player.totalCatches,
      equipment: player.equipment ?? {
        rodTier: 0,
        rodEquipped: "old",
        baitEquipped: "fly",
        luckyLureTier: 0,
        ownedRods: ["old"],
        ownedBaits: ["fly"],
      },
    };
  }),

  sessionState: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(500).default(200),
        })
        .strict()
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 200;
      const now = new Date();
      const { window, dateKey } = assignWindow(now);
      // Legacy wire name `date`; value is now the full dateKey.
      const date = dateKey;

      const player = await Player.findOne({
        walletAddress: ctx.walletAddress,
      }).lean();

      if (!player) {
        return {
          bait: 0,
          score: 0,
          catches: [],
          discoveredSpeciesIds: [],
          discoveredApexFish: [],
          date,
          window,
          windowState: "deposit" as const,
        };
      }

      const activeDeposit = player.deposits?.find((d) => !d.returned);

      // Fall back to deposit-projected bait so the first cast can fire
      // before ensureActiveSession lazy-creates the session row.
      let bait = 0;
      try {
        const session = await FishingSession.findOne(
          {
            walletAddress: ctx.walletAddress,
            dateKey,
            window,
            status: "active",
          },
          { baitRemaining: 1 },
        ).lean();
        if (session) {
          bait = session.baitRemaining;
        } else if (activeDeposit) {
          bait = baitAmountForDeposit(activeDeposit.amount);
        }
      } catch {
        // Defensive.
      }
      const activeRoom = activeDeposit
        ? await Room.findOne({ roomId: activeDeposit.poolId }).lean()
        : null;

      // Room window state (mirrors player.me) so the client can gate casting
      // off a read-only, poll-safe query. Only "active" allows casting.
      let windowState:
        | "deposit"
        | "active"
        | "closing"
        | "settling"
        | "closed"
        | "missing" = "deposit";
      if (activeDeposit) {
        if (!activeRoom) windowState = "missing";
        else if (activeRoom.phase === "closed") windowState = "closed";
        else if (activeRoom.phase === "settling") windowState = "settling";
        else if (activeRoom.closesAt.getTime() <= now.getTime())
          windowState = "closing";
        else windowState = "active";
      }

      const windowStart = activeRoom
        ? activeRoom.createdAt
        : currentSessionStart(now);
      const windowEnd = activeRoom ? activeRoom.closesAt : now;

      const playerId = player._id as Types.ObjectId;

      // Room-scoped score from Redis sorted set lb:room:<roomId>. New rooms
      // show 0 immediately rather than leaking score from a prior overlapping room.
      let score = 0;
      if (activeRoom) {
        try {
          const roomScore = await lb.getRoomPlayerScore(
            ctx.redis,
            activeRoom.roomId,
            playerId.toString(),
          );
          score = roomScore ?? 0;
        } catch {
          // Defensive.
        }
      }

      // Apex excluded (not sellable) — surfaced via discoveredApexFish.
      const inventory = await Catch.find({
        playerId,
        caughtAt: { $gte: windowStart, $lte: windowEnd },
        released: { $ne: true },
        speciesId: { $gte: 0 },
      })
        .sort({ caughtAt: -1 })
        .limit(limit)
        .lean();

      // Lifetime Fish-Index unlock state — survives selling and room rotation.
      const discoveredSpeciesIds = (
        (await Catch.distinct("speciesId", {
          playerId,
          speciesId: { $gte: 0 },
        })) as number[]
      ).filter((id): id is number => typeof id === "number");

      const apexIds = (await Catch.distinct("apexFishId", {
        playerId,
        apexFishId: { $ne: null },
      })) as Types.ObjectId[];
      let discoveredApexFish: Array<{
        id: string;
        name: string;
        weightMinKg: number;
        weightMaxKg: number;
        assetUrl: string;
      }> = [];
      if (apexIds.length > 0) {
        const docs = await ApexFish.find(
          { _id: { $in: apexIds } },
          { name: 1, weightMinKg: 1, weightMaxKg: 1 },
        ).lean();
        discoveredApexFish = docs.map((d) => ({
          id: String(d._id),
          name: d.name,
          weightMinKg: d.weightMinKg,
          weightMaxKg: d.weightMaxKg,
          assetUrl: `${env.SERVER_PUBLIC_URL}/admin/apex-fish/${String(d._id)}/image`,
        }));
      }

      return {
        bait,
        score,
        date,
        window,
        windowState,
        discoveredSpeciesIds,
        discoveredApexFish,
        catches: inventory.map((c) => ({
          id: String(c._id),
          speciesId: c.speciesId ?? 0,
          rarity: Math.max(
            0,
            RARITY_LABELS.indexOf(c.rarity as typeof RARITY_LABELS[number]),
          ),
          weightHg: Math.round(c.weightKg * 10),
          score: c.score,
          sellValue: c.sellValue ?? 0,
          caughtAt: c.caughtAt.toISOString(),
        })),
      };
    }),

  setNickname: protectedProcedure
    .input(
      z
        .object({
          nickname: z
            .string()
            .min(NICKNAME_MIN, NICKNAME_ERRORS.min)
            .max(NICKNAME_MAX, NICKNAME_ERRORS.max)
            .regex(NICKNAME_REGEX, NICKNAME_ERRORS.charset),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const taken = await Player.findOne({ nickname: input.nickname }).lean();
        if (taken && taken.walletAddress !== ctx.walletAddress) {
          throw new ConflictError("Nickname already taken");
        }

        const player = await Player.findOneAndUpdate(
          { walletAddress: ctx.walletAddress },
          { $set: { nickname: input.nickname }, $setOnInsert: { walletAddress: ctx.walletAddress } },
          { upsert: true, new: true }
        ).lean();

        return {
          nickname: player!.nickname,
          shellBalance: player!.shellBalance,
          loginStreak: player!.loginStreak,
          totalCatches: player!.totalCatches,
        };
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),

  setSkin: protectedProcedure
    .input(
      z.object({
        head: z.number().int().min(1).max(3),
        shirt: z.number().int().min(1).max(3),
        pants: z.number().int().min(1).max(3),
        shoes: z.number().int().min(1).max(2),
      }).strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const existing = await Player.findOne({ walletAddress: ctx.walletAddress }).lean();
        if (!existing || !existing.nickname) {
          throw new ValidationError("Set nickname first");
        }

        await Player.updateOne(
          { walletAddress: ctx.walletAddress },
          { $set: { skin: input } }
        );

        return { skin: input };
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),

  confirmDeposit: protectedProcedure
    .input(
      z.object({
        txSignature: z.string(),
        depositAmount: z.number().refine(isValidDepositAmount, {
          message: `Deposit must be one of ${VALID_DEPOSIT_AMOUNTS.join(", ")} SOL`,
        }),
        poolId: z.string().optional(),
      }).strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const existing = await Player.findOne({ walletAddress: ctx.walletAddress }).lean();
        if (!existing || !existing.nickname) {
          throw new ValidationError("Complete onboarding first");
        }

        const activeDeposit = existing.deposits?.find((d) => !d.returned);
        if (activeDeposit) {
          throw new ValidationError("Already deposited");
        }

        const duplicate = await Player.findOne({
          "deposits.depositTxSignature": input.txSignature,
        }).lean();
        if (duplicate) {
          throw new ConflictError("Transaction already used");
        }

        const tx = await solanaConnection.getTransaction(input.txSignature, {
          maxSupportedTransactionVersion: 0,
        });

        if (!tx) {
          throw new ValidationError("Transaction not found");
        }

        if (tx.meta?.err) {
          throw new ValidationError("Transaction failed on-chain");
        }

        const staticKeys = tx.transaction.message.staticAccountKeys;
        const walletInvolved = staticKeys.some(
          (key) => key.toBase58() === ctx.walletAddress
        );
        if (!walletInvolved) {
          throw new ValidationError("Transaction does not involve your wallet");
        }

        const now = new Date();
        const activeMonth = now.toISOString().slice(0, 7);
        const lpEnabled = env.FEATURES_LP_ENABLED;
        const serverPoolId = lpEnabled ? `${BUCKET_TIER}_${activeMonth}` : null;
        const expiresAt = lpEnabled
          ? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
          : null;

        const depositEntry = {
          poolId: serverPoolId ?? "vault",
          amount: input.depositAmount,
          depositTxSignature: input.txSignature,
          activeMonth,
          depositedAt: now,
          expiresAt: expiresAt ?? new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
          returned: false,
        };

        await Player.updateOne(
          { walletAddress: ctx.walletAddress },
          {
            $push: { deposits: depositEntry },
            $set: { currentPoolId: serverPoolId },
          },
        );

        if (lpEnabled) {
          await PoolTier.findOneAndUpdate(
            { tier: BUCKET_TIER, activeMonth },
            { $inc: { realPlayerCount: 1, totalDepositedSol: input.depositAmount } },
            { upsert: true, new: true }
          ).lean();
        }

        return {
          depositAmount: depositEntry.amount,
          depositedAt: depositEntry.depositedAt,
          activeMonth: lpEnabled ? activeMonth : null,
          expiresAt: expiresAt?.toISOString() ?? null,
          currentPoolId: serverPoolId,
        };
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),
});

import { z } from "zod";
import { adminSessionProcedure, router } from "../trpc.js";
import { Room } from "../../db/schema.js";
import {
  getRoomsConnection,
  loadLpManagerKeypair,
  loadTreasuryKeypair,
} from "../../solana/roomsProgram.js";

const STATUS_VALUES = ["pending", "deployed", "exited", "failed", "skipped"] as const;

export const adminLpRouter = router({
  list: adminSessionProcedure
    .input(
      z.object({
        status: z.enum(STATUS_VALUES).optional(),
        page: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ input }) => {
      const filter: Record<string, unknown> = {};
      if (input.status) filter["lp.status"] = input.status;

      const [rooms, totalCount] = await Promise.all([
        Room.find(filter)
          .sort({ createdAt: -1 })
          .skip((input.page - 1) * input.limit)
          .limit(input.limit)
          .lean(),
        Room.countDocuments(filter),
      ]);

      const items = rooms.map((r) => {
        const lp = (r.lp ?? {}) as Record<string, unknown>;
        return {
          roomId: r.roomId,
          phase: r.phase,
          createdAt: r.createdAt,
          closesAt: r.closesAt,
          status: (lp.status as string) ?? "pending",
          positionPubkey: (lp.positionPubkey as string | null) ?? null,
          deployedLamports: (lp.deployedLamports as number | null) ?? null,
          exitedLamports: (lp.exitedLamports as number | null) ?? null,
          feesLamports: (lp.feesLamports as number | null) ?? null,
          swapSlippageLamports:
            (lp.swapSlippageLamports as number | null) ?? null,
          realizedYieldLamports:
            (lp.realizedYieldLamports as number | null) ?? null,
          bufferTopUpLamports:
            (lp.bufferTopUpLamports as number | null) ?? null,
          deployedAt: (lp.deployedAt as Date | null) ?? null,
          exitedAt: (lp.exitedAt as Date | null) ?? null,
          lastError: (lp.lastError as string | null) ?? null,
        };
      });

      const totals = await Room.aggregate<{
        _id: null;
        totalDeployed: number;
        totalRealizedYield: number;
        totalSlippage: number;
        totalBufferTopUp: number;
        totalFees: number;
      }>([
        {
          $group: {
            _id: null,
            totalDeployed: { $sum: { $ifNull: ["$lp.deployedLamports", 0] } },
            totalRealizedYield: {
              $sum: { $ifNull: ["$lp.realizedYieldLamports", 0] },
            },
            totalSlippage: {
              $sum: { $ifNull: ["$lp.swapSlippageLamports", 0] },
            },
            totalBufferTopUp: {
              $sum: { $ifNull: ["$lp.bufferTopUpLamports", 0] },
            },
            totalFees: { $sum: { $ifNull: ["$lp.feesLamports", 0] } },
          },
        },
      ]);

      return {
        items,
        totalCount,
        page: input.page,
        limit: input.limit,
        totals: totals[0] ?? {
          totalDeployed: 0,
          totalRealizedYield: 0,
          totalSlippage: 0,
          totalBufferTopUp: 0,
          totalFees: 0,
        },
      };
    }),

  managerBalance: adminSessionProcedure.query(async () => {
    const lpManager = loadLpManagerKeypair();
    const treasury = loadTreasuryKeypair();
    const conn = getRoomsConnection();

    const [lpBalance, treasuryBalance] = await Promise.all([
      lpManager
        ? conn.getBalance(lpManager.publicKey).catch(() => null)
        : Promise.resolve(null),
      treasury
        ? conn.getBalance(treasury.publicKey).catch(() => null)
        : Promise.resolve(null),
    ]);

    return {
      lpManager: lpManager
        ? {
            address: lpManager.publicKey.toBase58(),
            lamports: lpBalance,
          }
        : null,
      treasury: treasury
        ? {
            address: treasury.publicKey.toBase58(),
            lamports: treasuryBalance,
          }
        : null,
    };
  }),
});

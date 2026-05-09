import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { adminSessionProcedure, router } from "../trpc.js";
import { FishingSession, Room } from "../../db/schema.js";
import {
  getRoomsProgram,
  getRoomPda,
} from "../../solana/roomsProgram.js";

const PHASE_VALUES = ["entry", "active", "settling", "closed"] as const;

type LeanRoom = {
  roomId: string;
  phase: string;
  createdAt: Date;
  entryClosesAt: Date;
  closesAt: Date;
  capacitySol: number;
  maxPlayers: number;
  depositedSol: number;
  realPlayerCount: number;
  onChainPoolId: string | null;
  onChainPoolAddress: string | null;
  totalYieldSol: number | null;
  lp?: Record<string, unknown> | null;
  players?: Array<Record<string, unknown>>;
  winners?: Array<Record<string, unknown>>;
  createdByAdmin: string;
  overflowTriggered?: boolean;
  createTxSignature?: string | null;
  closeTxSignature?: string | null;
  finalizeTxSignature?: string | null;
};

type TxRow = {
  kind:
    | "create_room"
    | "deposit"
    | "withdraw_to_lp_manager"
    | "swap_in"
    | "add_liquidity"
    | "remove_liquidity"
    | "swap_out"
    | "deposit_yield"
    | "close_room"
    | "return_principal"
    | "finalize_room";
  at: Date | null;
  signature: string | null;
  wallet?: string | null;
  lamports?: number | null;
  notes?: string | null;
};

function buildTxTrail(room: LeanRoom): TxRow[] {
  const rows: TxRow[] = [];
  const lp = (room.lp ?? {}) as Record<string, unknown>;

  rows.push({
    kind: "create_room",
    at: room.createdAt,
    signature: (room.createTxSignature as string | null | undefined) ?? null,
    wallet: room.createdByAdmin,
    lamports: null,
    notes: `room ${room.roomId} created`,
  });

  for (const p of room.players ?? []) {
    rows.push({
      kind: "deposit",
      at: (p.depositedAt as Date | null) ?? null,
      signature: (p.depositTxSignature as string | null) ?? null,
      wallet: (p.walletAddress as string) ?? null,
      lamports: Math.round(((p.deposit as number) ?? 0) * 1e9),
    });
  }

  if (lp.deployedAt || lp.withdrawTxSignature) {
    rows.push({
      kind: "withdraw_to_lp_manager",
      at: (lp.deployedAt as Date | null) ?? null,
      signature: (lp.withdrawTxSignature as string | null) ?? null,
      lamports: (lp.deployedLamports as number | null) ?? null,
      notes: "principal → LP_MANAGER",
    });
  }
  if (lp.swapInTxSignature) {
    rows.push({
      kind: "swap_in",
      at: (lp.deployedAt as Date | null) ?? null,
      signature: lp.swapInTxSignature as string,
      lamports: (lp.swapInSolLamports as number | null) ?? null,
      notes: `SOL→USDC (USDC out: ${lp.swapInUsdcRaw ?? "?"})`,
    });
  }
  if (lp.addLiquidityTxSignature) {
    rows.push({
      kind: "add_liquidity",
      at: (lp.deployedAt as Date | null) ?? null,
      signature: lp.addLiquidityTxSignature as string,
      lamports: null,
      notes: `position ${lp.positionPubkey ?? "?"}`,
    });
  }
  if (lp.removeLiquidityTxSignature) {
    rows.push({
      kind: "remove_liquidity",
      at: (lp.exitedAt as Date | null) ?? null,
      signature: lp.removeLiquidityTxSignature as string,
      lamports: (lp.removeLiquiditySolLamports as number | null) ?? null,
      notes: `USDC removed: ${lp.removeLiquidityUsdcRaw ?? "?"}`,
    });
  }
  if (lp.swapOutTxSignature) {
    rows.push({
      kind: "swap_out",
      at: (lp.exitedAt as Date | null) ?? null,
      signature: lp.swapOutTxSignature as string,
      lamports: (lp.swapOutSolLamports as number | null) ?? null,
      notes: `USDC→SOL (USDC in: ${lp.swapOutUsdcRaw ?? "?"})`,
    });
  }
  if (lp.depositYieldTxSignature) {
    rows.push({
      kind: "deposit_yield",
      at: (lp.exitedAt as Date | null) ?? null,
      signature: lp.depositYieldTxSignature as string,
      lamports: (lp.exitedLamports as number | null) ?? null,
      notes: `principal + yield → vault (realized yield: ${lp.realizedYieldLamports ?? 0})`,
    });
  }

  if (room.closeTxSignature) {
    rows.push({
      kind: "close_room",
      at: null,
      signature: room.closeTxSignature,
      notes: "30% protocol share extracted",
    });
  }

  for (const p of room.players ?? []) {
    if ((p.returned as boolean) === true) {
      rows.push({
        kind: "return_principal",
        at: (p.returnedAt as Date | null) ?? null,
        signature: (p.returnTxSignature as string | null) ?? null,
        wallet: (p.walletAddress as string) ?? null,
        lamports: Math.round(((p.deposit as number) ?? 0) * 1e9),
      });
    }
  }

  if (room.finalizeTxSignature) {
    rows.push({
      kind: "finalize_room",
      at: null,
      signature: room.finalizeTxSignature,
      notes: "vault closed",
    });
  }

  return rows.sort((a, b) => {
    const aT = a.at ? a.at.getTime() : Number.POSITIVE_INFINITY;
    const bT = b.at ? b.at.getTime() : Number.POSITIVE_INFINITY;
    return aT - bT;
  });
}

export const adminRoomsRouter = router({
  list: adminSessionProcedure
    .input(
      z.object({
        phase: z.enum(PHASE_VALUES).optional(),
        search: z.string().trim().optional(),
        page: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(100).default(25),
      }),
    )
    .query(async ({ input }) => {
      const filter: Record<string, unknown> = {};
      if (input.phase) filter.phase = input.phase;
      if (input.search) {
        const re = new RegExp(
          input.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "i",
        );
        filter.$or = [
          { roomId: re },
          { onChainPoolAddress: re },
          { onChainPoolId: re },
          { "players.walletAddress": re },
          { createdByAdmin: re },
        ];
      }

      const [items, totalCount] = await Promise.all([
        Room.find(filter)
          .sort({ createdAt: -1 })
          .skip((input.page - 1) * input.limit)
          .limit(input.limit)
          .lean(),
        Room.countDocuments(filter),
      ]);

      return {
        items: items.map((r) => ({
          roomId: r.roomId,
          phase: r.phase,
          createdAt: r.createdAt,
          entryClosesAt: r.entryClosesAt,
          closesAt: r.closesAt,
          capacitySol: r.capacitySol,
          maxPlayers: r.maxPlayers,
          depositedSol: r.depositedSol,
          realPlayerCount: r.realPlayerCount,
          onChainPoolId: r.onChainPoolId,
          onChainPoolAddress: r.onChainPoolAddress,
          totalYieldSol: r.totalYieldSol,
          lpStatus: (r.lp as { status?: string } | undefined)?.status ?? null,
          createdByAdmin: r.createdByAdmin,
          overflowTriggered: r.overflowTriggered ?? false,
        })),
        totalCount,
        page: input.page,
        limit: input.limit,
      };
    }),

  get: adminSessionProcedure
    .input(z.object({ roomId: z.string().min(1) }))
    .query(async ({ input }) => {
      const doc = await Room.findOne({ roomId: input.roomId }).lean();
      if (!doc) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Room ${input.roomId} not found`,
        });
      }
      const room = doc as unknown as LeanRoom;

      const lp = (room.lp ?? null) as null | {
        status?: string | null;
        positionPubkey?: string | null;
        deployedLamports?: number | null;
        deployedAt?: Date | string | null;
        deployTxSignature?: string | null;
        exitedLamports?: number | null;
        exitedAt?: Date | string | null;
        feesLamports?: number | null;
        swapSlippageLamports?: number | null;
        realizedYieldLamports?: number | null;
        bufferTopUpLamports?: number | null;
        lastError?: string | null;
        withdrawTxSignature?: string | null;
        swapInTxSignature?: string | null;
        swapInSolLamports?: number | null;
        swapInUsdcRaw?: string | null;
        addLiquidityTxSignature?: string | null;
        removeLiquidityTxSignature?: string | null;
        removeLiquidityUsdcRaw?: string | null;
        removeLiquiditySolLamports?: number | null;
        swapOutTxSignature?: string | null;
        swapOutUsdcRaw?: string | null;
        swapOutSolLamports?: number | null;
        depositYieldTxSignature?: string | null;
      };

      const players = ((room.players ?? []) as Array<{
        walletAddress: string;
        deposit: number;
        depositTxSignature: string;
        depositedAt: Date;
        returned: boolean;
        returnTxSignature: string | null;
        returnedAt: Date | null;
      }>).map((p) => ({
        walletAddress: p.walletAddress,
        deposit: p.deposit,
        depositTxSignature: p.depositTxSignature,
        depositedAt: p.depositedAt,
        returned: p.returned,
        returnTxSignature: p.returnTxSignature ?? null,
        returnedAt: p.returnedAt ?? null,
      }));

      const winners = ((room.winners ?? []) as Array<{
        rank: number;
        walletAddress: string;
        displayName: string;
        prizeSol: number;
      }>).map((w) => ({
        rank: w.rank,
        walletAddress: w.walletAddress,
        displayName: w.displayName,
        prizeSol: w.prizeSol,
      }));

      let onChainRoom: unknown = null;
      let onChainEntries: unknown[] = [];
      let onChainError: string | null = null;
      try {
        const loaded = getRoomsProgram();
        if (!loaded || !room.onChainPoolId) {
          onChainError = !loaded
            ? "TREASURY_KEYPAIR not configured"
            : "no on-chain pool id";
        } else {
          const roomPda = getRoomPda(BigInt(room.onChainPoolId));
          onChainRoom = await loaded.program.account.room.fetchNullable(
            roomPda,
          );
          if (!onChainRoom) {
            onChainError = "on-chain room account missing";
          } else {
            const entries = await loaded.program.account.roomEntry.all([
              { memcmp: { offset: 8, bytes: roomPda.toBase58() } },
            ]);
            onChainEntries = entries.map((e) => ({
              pubkey: e.publicKey.toBase58(),
              account: JSON.parse(
                JSON.stringify(e.account, (_, v) =>
                  typeof v === "bigint" ? v.toString() : v,
                ),
              ),
            }));
          }
        }
      } catch (err) {
        onChainError = (err as Error).message;
      }

      const txTrail = buildTxTrail(room);

      // Score bridge txs: each player's session writes a memo to
      // hooked_rooms.update_room_entry_score after commit. Surface them
      // alongside the room so admins can confirm scores landed on-chain.
      const playerWallets = players.map((p) => p.walletAddress);
      const scoreBridges = playerWallets.length
        ? await FishingSession.find({
            walletAddress: { $in: playerWallets },
            chainScoreTxSignature: { $ne: null },
          })
            .sort({ chainScoreBridgedAt: -1 })
            .limit(200)
            .select({
              walletAddress: 1,
              dateKey: 1,
              window: 1,
              sessionScore: 1,
              chainScoreTxSignature: 1,
              chainScoreBridgedAt: 1,
            })
            .lean()
        : [];

      return {
        db: {
          roomId: room.roomId,
          phase: room.phase,
          createdAt: room.createdAt,
          entryClosesAt: room.entryClosesAt,
          closesAt: room.closesAt,
          capacitySol: room.capacitySol,
          maxPlayers: room.maxPlayers,
          depositedSol: room.depositedSol,
          realPlayerCount: room.realPlayerCount,
          onChainPoolId: room.onChainPoolId,
          onChainPoolAddress: room.onChainPoolAddress,
          totalYieldSol: room.totalYieldSol,
          createdByAdmin: room.createdByAdmin,
          overflowTriggered: room.overflowTriggered ?? false,
          createTxSignature: room.createTxSignature ?? null,
          closeTxSignature: room.closeTxSignature ?? null,
          finalizeTxSignature: room.finalizeTxSignature ?? null,
          lp,
          players,
          winners,
        },
        scoreBridges: scoreBridges.map((s) => ({
          walletAddress: s.walletAddress,
          dateKey: s.dateKey,
          window: s.window,
          sessionScore: s.sessionScore,
          chainScoreTxSignature: s.chainScoreTxSignature,
          chainScoreBridgedAt: s.chainScoreBridgedAt,
        })),
        onChain: {
          room: onChainRoom
            ? JSON.parse(
                JSON.stringify(onChainRoom, (_, v) =>
                  typeof v === "bigint"
                    ? v.toString()
                    : v?.toBase58 && typeof v.toBase58 === "function"
                      ? v.toBase58()
                      : v,
                ),
              )
            : null,
          entries: onChainEntries,
          error: onChainError,
        },
        txTrail,
      };
    }),
});

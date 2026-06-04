import { z } from "zod";
import { adminSessionProcedure, router } from "../trpc.js";
import { FishingSession, Player, Room } from "../../db/schema.js";
import { NotFoundError, mapAppErrorToTRPC } from "../../errors/AppError.js";
import {
  getRoomsProgram,
  getRoomPda,
  getRoomVaultPda,
} from "../../solana/roomsProgram.js";

const PHASE_VALUES = ["entry", "active", "settling", "closed"] as const;
const LP_STATUS_VALUES = [
  "pending",
  "deployed",
  "exited",
  "failed",
  "skipped",
] as const;

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
  walletName?: string | null;
  lamports?: number | null;
  notes?: string | null;
};

const DEFAULT_PUBKEY = "11111111111111111111111111111111";
const WINNER_YIELD_BPS = [4000, 2000, 1000] as const;
const BPS_SCALE = 10_000;

function asBase58(value: unknown): string | null {
  if (!value) return null;
  if (
    typeof (value as { toBase58?: () => string }).toBase58 === "function"
  ) {
    return (value as { toBase58: () => string }).toBase58();
  }
  if (typeof value === "string") return value;
  return null;
}

function asLamportsNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof (value as { toString?: () => string }).toString === "function") {
    const n = Number((value as { toString: () => string }).toString());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function serializeAnchorAccount(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_, v) =>
      typeof v === "bigint"
        ? v.toString()
        : v?.toBase58 && typeof v.toBase58 === "function"
          ? v.toBase58()
          : v,
    ),
  );
}

function playerDisplayName(wallet: string, namesByWallet: Map<string, string>) {
  return namesByWallet.get(wallet) ?? "Anonymous";
}

function buildTxTrail(
  room: LeanRoom,
  playersOverride?: Array<Record<string, unknown>>,
): TxRow[] {
  const rows: TxRow[] = [];
  const lp = (room.lp ?? {}) as Record<string, unknown>;
  const players = playersOverride ?? room.players ?? [];

  rows.push({
    kind: "create_room",
    at: room.createdAt,
    signature: (room.createTxSignature as string | null | undefined) ?? null,
    wallet: room.createdByAdmin,
    lamports: null,
    notes: `room ${room.roomId} created`,
  });

  for (const p of players) {
    rows.push({
      kind: "deposit",
      at: (p.depositedAt as Date | null) ?? null,
      signature: (p.depositTxSignature as string | null) ?? null,
      wallet: (p.walletAddress as string) ?? null,
      walletName: (p.displayName as string | null) ?? null,
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
    const deployedLamports = asLamportsNumber(lp.deployedLamports);
    const realizedYieldLamports = asLamportsNumber(lp.realizedYieldLamports) ?? 0;
    const vaultReturnLamports =
      deployedLamports !== null
        ? deployedLamports + realizedYieldLamports
        : asLamportsNumber(lp.exitedLamports);
    rows.push({
      kind: "deposit_yield",
      at: (lp.exitedAt as Date | null) ?? null,
      signature: lp.depositYieldTxSignature as string,
      lamports: vaultReturnLamports,
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

  for (const p of players) {
    if ((p.returned as boolean) === true) {
      const principalLamports = Math.round(((p.deposit as number) ?? 0) * 1e9);
      const yieldAwardedLamports =
        asLamportsNumber(p.yieldAwardedLamports) ?? 0;
      rows.push({
        kind: "return_principal",
        at: (p.returnedAt as Date | null) ?? null,
        signature: (p.returnTxSignature as string | null) ?? null,
        wallet: (p.walletAddress as string) ?? null,
        walletName: (p.displayName as string | null) ?? null,
        lamports: principalLamports + yieldAwardedLamports,
        notes:
          yieldAwardedLamports > 0
            ? `principal + yield (${yieldAwardedLamports} lamports)`
            : "principal",
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
        // Filter rooms by `lp.status`. Combine with phase if needed.
        lpStatus: z.enum(LP_STATUS_VALUES).optional(),
        // Only rooms with an unreturned principal; implies phase=closed (return happens after settling).
        stuckReturns: z.boolean().optional(),
        search: z.string().trim().optional(),
        page: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(100).default(25),
      }).strict(),
    )
    .query(async ({ input }) => {
      const filter: Record<string, unknown> = {};
      if (input.phase) filter.phase = input.phase;
      if (input.lpStatus) filter["lp.status"] = input.lpStatus;
      if (input.stuckReturns) {
        filter.phase = "closed";
        filter["players.returned"] = false;
      }
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
        items: items.map((r) => {
          const players = (r.players ?? []) as Array<{
            deposit?: number;
            returned?: boolean;
          }>;
          const unreturned = players.filter((p) => p.returned === false);
          const unreturnedSol = unreturned.reduce(
            (sum, p) => sum + (p.deposit ?? 0),
            0,
          );
          return {
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
            unreturnedCount: unreturned.length,
            unreturnedSol,
          };
        }),
        totalCount,
        page: input.page,
        limit: input.limit,
      };
    }),

  get: adminSessionProcedure
    .input(z.object({ roomId: z.string().min(1) }).strict())
    .query(async ({ input }) => {
      try {
      const doc = await Room.findOne({ roomId: input.roomId }).lean();
      if (!doc) {
        throw new NotFoundError(`Room ${input.roomId} not found`);
      }
      const room = doc as unknown as LeanRoom;

      const rawPlayers = (room.players ?? []) as Array<{
        walletAddress: string;
        deposit: number;
        depositTxSignature: string;
        depositedAt: Date;
        returned: boolean;
        returnTxSignature: string | null;
        returnedAt: Date | null;
      }>;
      const playerWallets = rawPlayers.map((p) => p.walletAddress);

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

      let onChainRoom: unknown = null;
      let onChainEntries: unknown[] = [];
      const onChainEntriesByWallet = new Map<string, Record<string, unknown>>();
      let onChainError: string | null = null;
      let roomVaultAddress: string | null = null;
      try {
        const roomPda = room.onChainPoolId
          ? getRoomPda(BigInt(room.onChainPoolId))
          : null;
        if (roomPda) {
          roomVaultAddress = getRoomVaultPda(roomPda).toBase58();
        }

        const loaded = getRoomsProgram();
        if (!loaded || !roomPda) {
          onChainError = !loaded
            ? "TREASURY_KEYPAIR not configured"
            : "no on-chain pool id";
        } else {
          const fetchedRoom = await loaded.program.account.room.fetchNullable(
            roomPda,
          );
          onChainRoom = fetchedRoom
            ? serializeAnchorAccount(fetchedRoom)
            : null;
          if (!fetchedRoom) {
            onChainError = "on-chain room account missing";
          } else {
            const entries = await loaded.program.account.roomEntry.all([
              { memcmp: { offset: 9, bytes: roomPda.toBase58() } },
            ]);
            onChainEntries = entries.map((e) => ({
              pubkey: e.publicKey.toBase58(),
              account: serializeAnchorAccount(e.account),
            }));
            for (const e of onChainEntries as Array<{
              account?: Record<string, unknown>;
            }>) {
              const authority = asBase58(e.account?.authority);
              if (authority && e.account) {
                onChainEntriesByWallet.set(authority, e.account);
              }
            }
          }
        }
      } catch (err) {
        onChainError = (err as Error).message;
      }

      const playerDocs = playerWallets.length
        ? await Player.find(
            { walletAddress: { $in: playerWallets } },
            { walletAddress: 1, nickname: 1 },
          ).lean()
        : [];
      const namesByWallet = new Map(
        playerDocs.map((p) => [
          p.walletAddress,
          (p.nickname as string | null) ?? "Anonymous",
        ]),
      );

      const players = rawPlayers.map((p) => {
        const entry = onChainEntriesByWallet.get(p.walletAddress);
        return {
          walletAddress: p.walletAddress,
          displayName: playerDisplayName(p.walletAddress, namesByWallet),
          deposit: p.deposit,
          depositTxSignature: p.depositTxSignature,
          depositedAt: p.depositedAt,
          returned: p.returned,
          returnTxSignature: p.returnTxSignature ?? null,
          returnedAt: p.returnedAt ?? null,
          finalScore: asLamportsNumber(entry?.finalScore),
          finalRank: asLamportsNumber(entry?.finalRank),
          yieldAwardedLamports: asLamportsNumber(entry?.yieldAwardedLamports),
        };
      });

      const dbWinners = ((room.winners ?? []) as Array<{
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
      const onChainWinners =
        dbWinners.length === 0 && onChainRoom
          ? [
              (onChainRoom as Record<string, unknown>).firstPlace,
              (onChainRoom as Record<string, unknown>).secondPlace,
              (onChainRoom as Record<string, unknown>).thirdPlace,
            ]
              .map(asBase58)
              .map((walletAddress, i) => {
                if (!walletAddress || walletAddress === DEFAULT_PUBKEY) {
                  return null;
                }
                const totalYieldLamports =
                  asLamportsNumber(
                    (onChainRoom as Record<string, unknown>).yieldLamports,
                  ) ?? lp?.realizedYieldLamports ?? 0;
                const prizeLamports = Math.floor(
                  (totalYieldLamports * WINNER_YIELD_BPS[i]) / BPS_SCALE,
                );
                return {
                  rank: i + 1,
                  walletAddress,
                  displayName: playerDisplayName(walletAddress, namesByWallet),
                  prizeSol: prizeLamports / 1e9,
                };
              })
              .filter((w): w is NonNullable<typeof w> => w !== null)
          : [];
      const winners = dbWinners.length > 0 ? dbWinners : onChainWinners;

      const txTrail = buildTxTrail(room, players);

      // Score-bridge txs: each session memos update_room_entry_score after commit; surfaced so admins can confirm on-chain.
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
          roomVaultAddress,
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
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),
});

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import BN from "bn.js";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  ROOM_CAPACITY_SOL,
  VALID_DEPOSIT_AMOUNTS,
  derivePhase,
  isRoomJoinable,
  isValidDepositAmount,
  nextRoomOpensAt,
} from "@hooked/shared";
import {
  router,
  publicProcedure,
  protectedProcedure,
  adminSignedProcedure,
} from "./trpc.js";
import { FishingSession, Player, Room } from "../db/schema.js";
import {
  getRoomsProgram,
  getRoomPda,
  getRoomEntryPda,
} from "../solana/roomsProgram.js";
import { createRoomOnChainAndDb } from "../services/roomFactory.js";
import { settleRoom } from "../services/roomKeeper.js";
import * as lb from "../services/leaderboard.js";
import { assignWindow } from "../services/fishing/window.js";
import { bindWalletToRoom } from "../ws/gateway.js";

/**
 * Abandon any active FishingSession the player has for the current
 * (dateKey, window) that belongs to a different room. Called on every
 * successful `recoverEntry` so that depositing into a new room mid-window
 * doesn't reuse the prior session's bait counter / castCount / pity /
 * merkle root. The fresh session is lazy-created on first cast by
 * `ensureActiveSession` (services/fishing/wsExecutor.ts) and tagged with
 * the new roomId.
 *
 * Idempotent for same-room re-recovery (page reloads): the
 * `roomId: { $ne }` filter makes it a no-op when the player is already
 * tied to this room.
 */
async function markPriorSessionAbandoned(
  walletAddress: string,
  roomId: string,
): Promise<void> {
  const player = await Player.findOne({ walletAddress }, { _id: 1 }).lean();
  if (!player) return;
  const { dateKey, window } = assignWindow(new Date());
  // updateMany rather than updateOne — defense against any historical
  // duplicates that pre-date the partial unique index.
  await FishingSession.updateMany(
    {
      playerId: player._id,
      dateKey,
      window,
      status: "active",
      roomId: { $ne: roomId },
    },
    { $set: { status: "abandoned" } },
  );
}

async function maybeTriggerCapacityOverflow(roomId: string): Promise<void> {
  const claim = await Room.findOneAndUpdate(
    {
      roomId,
      phase: "entry",
      depositedSol: { $gte: ROOM_CAPACITY_SOL },
      overflowTriggered: { $ne: true },
    },
    { $set: { overflowTriggered: true } },
    { new: true }
  ).lean();
  if (!claim) return;

  const result = await createRoomOnChainAndDb({
    createdBy: "system:capacity",
    trigger: "system:capacity",
  });
  if (result.ok) {
    console.log(
      `[capacity-overflow] ${roomId} filled — spawned ${result.roomId}`
    );
  } else {
    console.log(
      `[capacity-overflow] ${roomId} filled — skipped new room (${result.reason})`
    );
  }
}

const roomIdInput = z.object({
  roomId: z.string().regex(/^R-\d{8}-[0-9a-f]{6}$/),
});

export const roomRouter = router({
  list: publicProcedure.query(async () => {
    const rooms = await Room.find({ phase: { $in: ["entry", "active"] } })
      .sort({ closesAt: 1 })
      .lean();

    const now = new Date();
    return rooms.map((r) => ({
      roomId: r.roomId,
      phase: derivePhase(
        {
          entryClosesAt: r.entryClosesAt,
          closesAt: r.closesAt,
          phase: r.phase as any,
        },
        now,
      ),
      createdAt: r.createdAt.toISOString(),
      entryClosesAt: r.entryClosesAt.toISOString(),
      closesAt: r.closesAt.toISOString(),
      capacitySol: r.capacitySol,
      depositedSol: r.depositedSol,
      maxPlayers: r.maxPlayers,
      realPlayerCount: r.realPlayerCount,
      joinable: isRoomJoinable({
        phase: r.phase as any,
        depositedSol: r.depositedSol,
        capacitySol: r.capacitySol,
        players: r.players,
        maxPlayers: r.maxPlayers,
      }),
    }));
  }),

  info: publicProcedure.input(roomIdInput).query(async ({ input }) => {
    const room = await Room.findOne({ roomId: input.roomId }).lean();
    if (!room)
      throw new TRPCError({ code: "NOT_FOUND", message: "Room not found" });

    return {
      roomId: room.roomId,
      phase: room.phase,
      createdAt: room.createdAt.toISOString(),
      entryClosesAt: room.entryClosesAt.toISOString(),
      closesAt: room.closesAt.toISOString(),
      capacitySol: room.capacitySol,
      depositedSol: room.depositedSol,
      maxPlayers: room.maxPlayers,
      realPlayerCount: room.realPlayerCount,
      onChainPoolId: room.onChainPoolId,
      onChainPoolAddress: room.onChainPoolAddress,
      totalYieldSol: room.totalYieldSol,
      winners: room.winners,
    };
  }),

  active: publicProcedure.query(async () => {
    const now = new Date();
    // Open = entry phase, on-chain backed, not full, entry window not expired.
    const room = await Room.findOne({
      phase: "entry",
      onChainPoolId: { $ne: null },
      entryClosesAt: { $gt: now },
      $expr: { $lt: ["$realPlayerCount", "$maxPlayers"] },
    })
      .sort({ closesAt: 1 })
      .lean();
    if (!room) {
      return {
        status: "closed" as const,
        nextOpensAt: nextRoomOpensAt(now).toISOString(),
      };
    }
    return {
      status: "open" as const,
      room: {
        roomId: room.roomId,
        onChainRoomId: room.onChainPoolId,
        onChainRoomAddress: room.onChainPoolAddress,
        capacitySol: room.capacitySol,
        depositedSol: room.depositedSol,
        maxPlayers: room.maxPlayers,
        realPlayerCount: room.realPlayerCount,
        entryClosesAt: room.entryClosesAt.toISOString(),
        closesAt: room.closesAt.toISOString(),
      },
    };
  }),

  recoverEntry: protectedProcedure
    .input(
      z.object({
        onChainRoomId: z.string().regex(/^\d+$/),
        txSignature: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const player = await Player.findOne({
        walletAddress: ctx.walletAddress,
      }).lean();
      if (!player || !player.nickname) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Complete onboarding first",
        });
      }

      const roomDoc = await Room.findOne({
        onChainPoolId: input.onChainRoomId,
      }).lean();
      if (!roomDoc) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Room not found" });
      }

      // Show the player on the room leaderboard the moment they join, with
      // score 0 until their first catch. NX-flagged so a re-recovery never
      // resets an already-credited score. Doing this for both branches below
      // (alreadyRecorded and new-deposit) ensures historical depositors who
      // joined before this code shipped also self-heal onto the LB.
      const playerIdStr = player._id.toString();
      await lb
        .seedRoomMember(ctx.redis, roomDoc.roomId, playerIdStr)
        .catch((err) =>
          console.error(
            "[lb] seedRoomMember failed:",
            (err as Error).message,
          ),
        );

      // Active = SOL still on-chain (keeper hasn't run `return_principal`).
      // Window expiry is tracked separately via `expiresAt` and must NOT
      // short-circuit this lookup.
      const active = player.deposits?.find((d) => !d.returned);
      if (active) {
        await markPriorSessionAbandoned(ctx.walletAddress, roomDoc.roomId);
        // Bind any open WS sockets for this wallet to the room so room-
        // scoped broadcasts (leaderboard updates) reach them without a
        // reconnect. Safe no-op if no sockets are open.
        bindWalletToRoom(ctx.walletAddress, roomDoc.roomId);
        return {
          depositAmount: active.amount,
          roomId: roomDoc.roomId,
          alreadyRecorded: true,
        };
      }

      const loaded = getRoomsProgram();
      if (!loaded) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Rooms program unavailable — treasury keypair missing",
        });
      }

      const roomPda = getRoomPda(BigInt(input.onChainRoomId));
      const authorityKey = new PublicKey(ctx.walletAddress);
      const entryPda = getRoomEntryPda(roomPda, authorityKey);

      let entryAccount =
        await loaded.program.account.roomEntry.fetchNullable(entryPda);
      // Client may call us right after deposit tx lands at 'processed' — our
      // RPC may not yet see it at 'confirmed', so poll briefly.
      for (let i = 0; i < 6 && !entryAccount; i++) {
        await new Promise((r) => setTimeout(r, 500));
        entryAccount =
          await loaded.program.account.roomEntry.fetchNullable(entryPda);
      }
      if (!entryAccount) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No on-chain deposit found for this wallet in this room",
        });
      }

      const depositSol =
        Number((entryAccount.depositLamports as BN).toString()) /
        LAMPORTS_PER_SOL;
      if (!isValidDepositAmount(depositSol)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `On-chain deposit ${depositSol} SOL not in [${VALID_DEPOSIT_AMOUNTS.join(", ")}]`,
        });
      }

      const joinedAtMs =
        Number((entryAccount.joinedAt as BN).toString()) * 1000;
      const depositedAt = new Date(joinedAtMs);
      const activeMonth = depositedAt.toISOString().slice(0, 7);
      const txSignature =
        input.txSignature ?? `recovered:${entryPda.toBase58()}`;

      await Player.updateOne(
        { walletAddress: ctx.walletAddress },
        {
          $push: {
            deposits: {
              poolId: roomDoc.roomId,
              amount: depositSol,
              depositTxSignature: txSignature,
              activeMonth,
              depositedAt,
              expiresAt: roomDoc.closesAt,
              returned: false,
            },
          },
          $set: { currentPoolId: roomDoc.roomId },
        },
      );

      // Atomic room update: refuse if the room is no longer in entry phase,
      // if this wallet is already recorded, if the deposit would exceed
      // capacity, or if max players has been reached. The on-chain program is
      // the source of truth for capacity, but we enforce here so DB state
      // can't drift past the invariant even under concurrent recoverEntry
      // calls or manual data fixes.
      const roomUpdate = await Room.updateOne(
        {
          roomId: roomDoc.roomId,
          phase: "entry",
          "players.walletAddress": { $ne: ctx.walletAddress },
          depositedSol: { $lte: roomDoc.capacitySol - depositSol },
          $expr: { $lt: [{ $size: "$players" }, "$maxPlayers"] },
        },
        {
          $push: {
            players: {
              walletAddress: ctx.walletAddress,
              deposit: depositSol,
              depositTxSignature: txSignature,
              depositedAt,
              returned: false,
            },
          },
          $inc: { realPlayerCount: 1, depositedSol: depositSol },
        },
      );

      await markPriorSessionAbandoned(ctx.walletAddress, roomDoc.roomId);

      // Bind any open WS sockets for this wallet to the new room. The auth-
      // time hydration only runs once per connection; players who deposit
      // mid-session need this to start receiving room broadcasts without a
      // reconnect.
      bindWalletToRoom(ctx.walletAddress, roomDoc.roomId);

      try {
        await maybeTriggerCapacityOverflow(roomDoc.roomId);
      } catch (err) {
        console.error("[capacity-overflow] room creation failed", err);
      }

      return {
        depositAmount: depositSol,
        roomId: roomDoc.roomId,
        alreadyRecorded: false,
        roomUpdated: roomUpdate.modifiedCount > 0,
      };
    }),

  retryBaitIssue: adminSignedProcedure
    .input(
      z.object({
        targetWallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const target = input.targetWallet;
      const player = await Player.findOne({ walletAddress: target }).lean();
      if (!player) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Player not found" });
      }
      // Match the rest of the codebase: a deposit is active while SOL is
      // still on-chain (`!returned`). Window expiry is informational only.
      const active = player.deposits?.find((d) => !d.returned);
      if (!active) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No active deposit — cannot issue bait",
        });
      }
      await markPriorSessionAbandoned(target, active.poolId);
      return { ok: true, targetWallet: target };
    }),

  createRoom: adminSignedProcedure.mutation(async ({ ctx }) => {
    let result;
    try {
      result = await createRoomOnChainAndDb({
        createdBy: ctx.adminWallet,
        trigger: "admin",
      });
    } catch (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `On-chain create_room failed: ${(err as Error).message}`,
      });
    }
    if (!result.ok) {
      if (result.reason === "treasury-missing") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "TREASURY_KEYPAIR not configured — cannot sign on-chain create_room",
        });
      }
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Room creation skipped: ${result.reason}`,
      });
    }
    return {
      roomId: result.roomId,
      createdAt: result.createdAt.toISOString(),
      entryClosesAt: result.entryClosesAt.toISOString(),
      closesAt: result.closesAt.toISOString(),
      phase: result.phase,
      onChainRoomId: result.onChainRoomId,
      onChainRoomAddress: result.onChainRoomAddress,
      txSignature: result.txSignature,
    };
  }),

  leaderboard: publicProcedure
    .input(
      z.object({
        roomId: z.string(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Self-heal: reflect every depositor in `room.players[]` into the
      // Redis sorted set with score 0 (NX-flagged so existing scores are
      // preserved). Covers depositors who joined before per-join seeding
      // shipped and any case where a Redis hiccup dropped the seed write.
      const roomDoc = await Room.findOne(
        { roomId: input.roomId },
        { players: 1 },
      ).lean();
      if (roomDoc?.players?.length) {
        const wallets = roomDoc.players.map((p) => p.walletAddress);
        const players = await Player.find(
          { walletAddress: { $in: wallets } },
          { _id: 1 },
        ).lean();
        if (players.length > 0) {
          await lb
            .seedRoomMembers(
              ctx.redis,
              input.roomId,
              players.map((p) => p._id.toString()),
            )
            .catch((err) =>
              console.error(
                "[lb] seedRoomMembers failed:",
                (err as Error).message,
              ),
            );
        }
      }

      const entries = await lb.getRoomLeaderboard(
        ctx.redis,
        input.roomId,
        input.offset,
        input.limit,
      );

      const memberIds = entries.map((e) => e.member);
      const realPlayerIds = memberIds;

      const [players, topCatches] = await Promise.all([
        realPlayerIds.length > 0
          ? Player.find(
              { _id: { $in: realPlayerIds } },
              { _id: 1, nickname: 1 },
            ).lean()
          : Promise.resolve([]),
        lb.getRoomTopCatches(ctx.redis, input.roomId, memberIds),
      ]);

      const playerMap = new Map(
        players.map((p) => [p._id.toString(), p.nickname ?? "Anonymous"]),
      );

      const leaderboardEntries = entries.map((e, index) => ({
        rank: input.offset + index + 1,
        displayName: playerMap.get(e.member) ?? "Anonymous",
        dailyScore: e.score,
        topCatch: topCatches.get(e.member) ?? null,
      }));

      let playerRank: number | null = null;
      let playerScore: number | null = null;
      if (ctx.walletAddress) {
        const player = await Player.findOne(
          { walletAddress: ctx.walletAddress },
          { _id: 1 },
        ).lean();
        if (player) {
          const pid = player._id.toString();
          const [rank, score] = await Promise.all([
            lb.getRoomPlayerRank(ctx.redis, input.roomId, pid),
            lb.getRoomPlayerScore(ctx.redis, input.roomId, pid),
          ]);
          playerRank = rank !== null ? rank + 1 : null;
          playerScore = score;
        }
      }

      const totalEntries = await lb.getRoomEntryCount(ctx.redis, input.roomId);

      return {
        entries: leaderboardEntries,
        playerRank,
        playerScore,
        totalEntries,
      };
    }),

  settleRoomNow: adminSignedProcedure
    .input(z.object({ roomId: z.string() }))
    .mutation(async ({ input }) => {
      try {
        return await settleRoom(input.roomId);
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `settleRoom failed: ${(err as Error).message}`,
        });
      }
    }),

  reconcilePlayerDeposits: adminSignedProcedure
    .input(
      z.object({
        walletAddress: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
      }),
    )
    .mutation(async ({ input }) => {
      const loaded = getRoomsProgram();
      if (!loaded) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Rooms program unavailable — treasury keypair missing",
        });
      }

      const player = await Player.findOne({
        walletAddress: input.walletAddress,
      }).lean();
      if (!player) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Player not found" });
      }

      const results: Array<{
        poolId: string;
        action: "reconciled" | "on-chain-not-returned" | "on-chain-missing" | "room-missing";
      }> = [];

      const wallet = new PublicKey(input.walletAddress);

      for (const deposit of player.deposits ?? []) {
        if (deposit.returned) continue;

        const room = await Room.findOne({ roomId: deposit.poolId }).lean();
        if (!room || !room.onChainPoolId) {
          results.push({ poolId: deposit.poolId, action: "room-missing" });
          continue;
        }

        const roomPda = getRoomPda(BigInt(room.onChainPoolId));
        const entryPda = getRoomEntryPda(roomPda, wallet);
        const entry =
          await loaded.program.account.roomEntry.fetchNullable(entryPda);
        if (!entry) {
          results.push({ poolId: deposit.poolId, action: "on-chain-missing" });
          continue;
        }
        if (!entry.returned) {
          results.push({
            poolId: deposit.poolId,
            action: "on-chain-not-returned",
          });
          continue;
        }

        const returnedAtMs = Number((entry.returnedAt as BN).toString()) * 1000;
        const returnedAt =
          returnedAtMs > 0 ? new Date(returnedAtMs) : new Date();

        await Promise.all([
          Room.updateOne(
            {
              roomId: deposit.poolId,
              "players.walletAddress": input.walletAddress,
            },
            {
              $set: {
                "players.$.returned": true,
                "players.$.returnTxSignature": null,
                "players.$.returnedAt": returnedAt,
              },
            },
          ),
          Player.updateOne(
            {
              walletAddress: input.walletAddress,
              deposits: {
                $elemMatch: { poolId: deposit.poolId, returned: false },
              },
            },
            {
              $set: {
                "deposits.$.returned": true,
                "deposits.$.returnTxSignature": null,
                "deposits.$.returnedAt": returnedAt,
              },
            },
          ),
        ]);
        results.push({ poolId: deposit.poolId, action: "reconciled" });
      }

      return { walletAddress: input.walletAddress, results };
    }),
});

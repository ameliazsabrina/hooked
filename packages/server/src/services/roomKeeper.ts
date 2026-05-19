import BN from "bn.js";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import type Redis from "ioredis";
import {
  getRoomsProgram,
  getRoomPda,
  getRoomVaultPda,
  getRoomEntryPda,
  getProgramConfigPda,
  loadKeeperKeypair,
} from "../solana/roomsProgram.js";
import { isProgramPaused } from "../solana/configCache.js";
import { Player, Room } from "../db/schema.js";
import { shareForRecipient } from "./yieldShare.js";
import { formatSolanaError } from "../solana/formatError.js";
import { finalizeRoomLeaderboardOnChain } from "./roomLeaderboardFinalize.js";

type SettleResult = {
  roomId: string;
  status: "ok" | "skipped" | "error";
  message?: string;
  returned?: number;
  reconciled?: number;
  failed?: number;
};

type Logger = {
  info: (msg: string) => void;
  error: (msg: string) => void;
};

const defaultLogger: Logger = {
  info: (msg) => console.log(`[roomKeeper] ${msg}`),
  error: (msg) => console.error(`[roomKeeper] ${msg}`),
};

async function markReturnedInDb(opts: {
  roomId: string;
  walletAddress: string;
  txSignature: string | null;
  returnedAt: Date;
}): Promise<void> {
  const { roomId, walletAddress, txSignature, returnedAt } = opts;
  await Promise.all([
    Room.updateOne(
      { roomId, "players.walletAddress": walletAddress },
      {
        $set: {
          "players.$.returned": true,
          "players.$.returnTxSignature": txSignature,
          "players.$.returnedAt": returnedAt,
        },
      },
    ),
    Player.updateOne(
      {
        walletAddress,
        deposits: {
          $elemMatch: { poolId: roomId, returned: false },
        },
      },
      {
        $set: {
          "deposits.$.returned": true,
          "deposits.$.returnTxSignature": txSignature,
          "deposits.$.returnedAt": returnedAt,
        },
      },
    ),
  ]);
}

export interface SettleDeps {
  /** Null skips on-chain top-3 patch; settlement still proceeds. */
  redis?: Redis | null;
}

export async function settleAllReadyRooms(
  logger: Logger = defaultLogger,
  deps: SettleDeps = {},
): Promise<SettleResult[]> {
  const rooms = await Room.find({
    phase: "settling",
    onChainPoolId: { $ne: null },
  }).lean();

  const results: SettleResult[] = [];
  for (const room of rooms) {
    try {
      const result = await settleRoom(room.roomId, logger, deps);
      results.push(result);
    } catch (err) {
      results.push({
        roomId: room.roomId,
        status: "error",
        message: (err as Error).message,
      });
    }
  }
  return results;
}

export async function settleRoom(
  roomId: string,
  logger: Logger = defaultLogger,
  deps: SettleDeps = {},
): Promise<SettleResult> {
  const doc = await Room.findOne({ roomId });
  if (!doc) return { roomId, status: "skipped", message: "not found" };
  if (!doc.onChainPoolId) {
    return { roomId, status: "skipped", message: "no on-chain room id" };
  }

  const loaded = getRoomsProgram();
  if (!loaded) {
    return {
      roomId,
      status: "skipped",
      message: "TREASURY_KEYPAIR not configured",
    };
  }
  const { program, signer } = loaded;

  // Skip when paused — avoids mid-loop failures on stale on-chain state.
  if (await isProgramPaused()) {
    logger.info(`settleRoom skipped — program paused (room=${roomId})`);
    return { roomId, status: "skipped", message: "program paused" };
  }

  const onChainRoomId = BigInt(doc.onChainPoolId);
  const roomPda = getRoomPda(onChainRoomId);
  const roomVaultPda = getRoomVaultPda(roomPda);
  const configPda = getProgramConfigPda();

  const onChainRoom = await program.account.room.fetchNullable(roomPda);
  if (!onChainRoom) {
    return { roomId, status: "skipped", message: "on-chain room missing" };
  }

  const status = onChainRoom.status;

  // 0 when LP disabled or cycle incomplete — degrades to principal-only return.
  const realizedYieldLamports = BigInt(
    doc.lp?.realizedYieldLamports ?? 0,
  );

  // RoomEntry layout: [8 disc][1 version][32 room]… room pubkey at byte 9.
  // Fetched BEFORE close_room so the precondition below can sum unreturned
  // principal; entries are immutable across close_room.
  const entries = await program.account.roomEntry.all([
    {
      memcmp: { offset: 9, bytes: roomPda.toBase58() },
    },
  ]);

  // B2 precondition: refuse close_room if vault can't cover every unreturned
  // entry + yield + rent-exempt. finalize_room closes the vault permanently,
  // so a drained vault past finalize is unrecoverable. Required = unreturned
  // deposits + full yield (30% protocol share leaves at close, 70% distributed
  // via return_principal) + rent-exempt.
  const connection = program.provider.connection;
  const unreturnedPrincipal = entries
    .filter(({ account }) => !account.returned)
    .reduce(
      (s, { account }) => s + BigInt(account.depositLamports.toString()),
      0n,
    );
  const vaultBalance = BigInt(await connection.getBalance(roomVaultPda));
  const rentExempt = BigInt(
    await connection.getMinimumBalanceForRentExemption(0),
  );
  const vaultRequired =
    unreturnedPrincipal + realizedYieldLamports + rentExempt;

  if (status < 2) {
    if (vaultBalance < vaultRequired) {
      logger.error(
        `room=${roomId} close_room precondition failed: vault holds ` +
          `${vaultBalance.toString()} lamports but needs ` +
          `${vaultRequired.toString()} (unreturnedPrincipal=` +
          `${unreturnedPrincipal.toString()}, yield=` +
          `${realizedYieldLamports.toString()}, rentExempt=` +
          `${rentExempt.toString()}). Skipping close_room — room stays in ` +
          `'settling'. Top up the vault PDA, then the next tick will retry.`,
      );
      return {
        roomId,
        status: "skipped",
        message:
          `vault insufficient before close_room ` +
          `(${vaultBalance.toString()} < ${vaultRequired.toString()})`,
        returned: 0,
        reconciled: 0,
        failed: 0,
      };
    }

    // B10: patch on-chain top-3 from Redis before close_room reads it.
    // Without this, a broken score-bridge worker leaves top-3 default and
    // locks in zero yield share. Idempotent + best-effort.
    try {
      const finalizeResult = await finalizeRoomLeaderboardOnChain({
        redis: deps.redis ?? null,
        program,
        keeper: loadKeeperKeypair(),
        roomId,
        roomPda,
        logger,
      });
      if (finalizeResult.detectedScoreBridgeGap) {
        await Room.updateOne(
          { roomId },
          {
            $set: {
              scoreBridgeGapDetected: true,
              scoreBridgeGapAt: new Date(),
              scoreBridgeGapPushed: finalizeResult.pushed,
            },
          },
        );
      }
    } catch (err) {
      // Soft-failure: better than blocking settlement on a Redis blip.
      logger.error(
        `room=${roomId} finalizeRoomLeaderboardOnChain threw: ${formatSolanaError(err)}`,
      );
    }

    // close_room transfers 30% protocol share to treasury and stores yield
    // on the room for downstream return_principal calls.
    const closeTxSig = await program.methods
      .closeRoom(new BN(realizedYieldLamports.toString()))
      .accounts({
        room: roomPda,
        config: configPda,
        roomVault: roomVaultPda,
        treasury: signer.publicKey,
        admin: signer.publicKey,
        systemProgram: SystemProgram.programId,
      } as never)
      .rpc();
    await Room.updateOne({ roomId }, { $set: { closeTxSignature: closeTxSig } });
  }

  // Re-fetch for canonical on-chain leaderboard after close_room.
  const settledRoom = await program.account.room.fetch(roomPda);
  const topThree = {
    first: settledRoom.firstPlace as PublicKey,
    second: settledRoom.secondPlace as PublicKey,
    third: settledRoom.thirdPlace as PublicKey,
  };

  let returned = 0;
  let reconciled = 0;
  let failed = 0;
  let humanCount = 0;

  for (const { account } of entries) {
    humanCount += 1;

    const recipient = account.authority;
    const recipientStr = recipient.toBase58();

    // Self-healing: on-chain returned but DB stale from prior partial failure.
    if (account.returned) {
      try {
        await markReturnedInDb({
          roomId,
          walletAddress: recipientStr,
          txSignature: null,
          returnedAt: new Date(),
        });
        reconciled += 1;
      } catch (err) {
        failed += 1;
        logger.error(
          `room=${roomId} reconcile failed for ${recipientStr}: ${(err as Error).message}`,
        );
      }
      continue;
    }

    const entryPda = getRoomEntryPda(roomPda, recipient);
    const yieldShare = shareForRecipient(
      recipient,
      realizedYieldLamports,
      topThree,
    );

    try {
      const txSig = await program.methods
        .returnPrincipal(new BN(yieldShare.toString()))
        .accounts({
          room: roomPda,
          roomVault: roomVaultPda,
          entry: entryPda,
          recipient,
          admin: signer.publicKey,
          systemProgram: SystemProgram.programId,
        } as never)
        .rpc();

      try {
        await markReturnedInDb({
          roomId,
          walletAddress: recipientStr,
          txSignature: txSig,
          returnedAt: new Date(),
        });
        returned += 1;
        logger.info(
          `room=${roomId} returned ${recipientStr} tx=${txSig}`,
        );
      } catch (dbErr) {
        // Next pass will reconcile via the branch above.
        failed += 1;
        logger.error(
          `room=${roomId} on-chain returned ${recipientStr} tx=${txSig} but DB write failed: ${(dbErr as Error).message}`,
        );
      }
    } catch (rpcErr) {
      failed += 1;
      // B8: include program logs so reverts are visible without explorer.
      logger.error(
        `room=${roomId} return_principal RPC failed for ${recipientStr}: ${formatSolanaError(rpcErr)}`,
      );
    }
  }

  logger.info(
    `room=${roomId} settlement summary: ${returned}/${humanCount} returned, ${reconciled} reconciled, ${failed} failed`,
  );

  const latest = await program.account.room.fetch(roomPda);

  // B1 finalize gate: finalize_room closes the vault permanently. Only
  // finalize when every entry has been settled (failed === 0 and
  // returned + reconciled === humanCount). Otherwise the room stays in
  // 'settling' so transient failures retry next tick.
  const allSettled = failed === 0 && returned + reconciled === humanCount;
  if (latest.status === 2 && allSettled) {
    try {
      const finalizeTxSig = await program.methods
        .finalizeRoom()
        .accounts({
          room: roomPda,
          config: configPda,
          roomVault: roomVaultPda,
          treasury: signer.publicKey,
          admin: signer.publicKey,
          systemProgram: SystemProgram.programId,
        } as never)
        .rpc();
      await Room.updateOne(
        { roomId },
        { $set: { phase: "closed", finalizeTxSignature: finalizeTxSig } },
      );
    } catch (err) {
      return {
        roomId,
        status: "error",
        message: `finalize_room failed: ${formatSolanaError(err)}`,
        returned,
        reconciled,
        failed,
      };
    }
  } else if (latest.status === 2 && !allSettled) {
    logger.error(
      `room=${roomId} finalize_room SKIPPED: ${returned}/${humanCount} returned, ` +
        `${reconciled} reconciled, ${failed} failed. Room stays in 'settling' ` +
        `so unpaid entries can retry next tick. Investigate persistent failures ` +
        `before the next tick or vault state may degrade.`,
    );
  } else if (latest.status === 3) {
    // Already finalized — sync DB so the room exits the settling query.
    await Room.updateOne({ roomId }, { $set: { phase: "closed" } });
  }

  return { roomId, status: "ok", returned, reconciled, failed };
}

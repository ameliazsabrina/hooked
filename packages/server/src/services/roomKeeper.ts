import BN from "bn.js";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  getRoomsProgram,
  getRoomPda,
  getRoomVaultPda,
  getRoomEntryPda,
  getProgramConfigPda,
} from "../solana/roomsProgram.js";
import { isProgramPaused } from "../solana/configCache.js";
import { Player, Room } from "../db/schema.js";
import { shareForRecipient } from "./yieldShare.js";

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

export async function settleAllReadyRooms(
  logger: Logger = defaultLogger,
): Promise<SettleResult[]> {
  const rooms = await Room.find({
    phase: "settling",
    onChainPoolId: { $ne: null },
  }).lean();

  const results: SettleResult[] = [];
  for (const room of rooms) {
    try {
      const result = await settleRoom(room.roomId, logger);
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

  // settle_room calls close + return + finalize, all gated by paused.
  // Skip the whole batch if paused so we don't fire 1-N principal returns
  // and have them all fail mid-loop with stale on-chain state.
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

  // Yield comes from the off-chain LP cycle (lpExit job writes
  // `room.lp.realizedYieldLamports` when it's done). When LP is disabled or
  // the cycle hasn't completed, this is 0 and the keeper degrades gracefully
  // to "principal-only return" — exactly the prior behavior.
  const realizedYieldLamports = BigInt(
    doc.lp?.realizedYieldLamports ?? 0,
  );

  if (status < 2) {
    // close_room reads the on-chain top-3 cache (populated by
    // update_room_entry_score). It extracts 30% × yield as protocol share
    // to `treasury` and stores `yield_lamports` on the room for downstream
    // return_principal calls to read.
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

  // Re-fetch after close_room so we have the canonical on-chain leaderboard
  // even if the local copy was stale.
  const settledRoom = await program.account.room.fetch(roomPda);
  const topThree = {
    first: settledRoom.firstPlace as PublicKey,
    second: settledRoom.secondPlace as PublicKey,
    third: settledRoom.thirdPlace as PublicKey,
  };

  // RoomEntry layout: [8 disc][1 version][32 room]…  so the room pubkey
  // sits at byte 9, not 8. Filtering at offset 8 was matching the version
  // byte against the first byte of roomPda, which never hits.
  const entries = await program.account.roomEntry.all([
    {
      memcmp: { offset: 9, bytes: roomPda.toBase58() },
    },
  ]);

  let returned = 0;
  let reconciled = 0;
  let failed = 0;
  let humanCount = 0;

  for (const { account } of entries) {
    humanCount += 1;

    const recipient = account.authority;
    const recipientStr = recipient.toBase58();

    // Self-healing: on-chain says returned but DB might be lagging from a
    // prior partial failure (RPC succeeded, Mongo write failed). Idempotent
    // reflow heals both collections.
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
        // On-chain succeeded but DB write failed — flag loudly. The next
        // settleRoom pass will hit the reconciliation branch above and heal.
        failed += 1;
        logger.error(
          `room=${roomId} on-chain returned ${recipientStr} tx=${txSig} but DB write failed: ${(dbErr as Error).message}`,
        );
      }
    } catch (rpcErr) {
      failed += 1;
      logger.error(
        `room=${roomId} return_principal RPC failed for ${recipientStr}: ${(rpcErr as Error).message}`,
      );
    }
  }

  logger.info(
    `room=${roomId} settlement summary: ${returned}/${humanCount} returned, ${reconciled} reconciled, ${failed} failed`,
  );

  const latest = await program.account.room.fetch(roomPda);
  if (latest.status === 2) {
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
        message: `finalize_room failed: ${(err as Error).message}`,
        returned,
        reconciled,
        failed,
      };
    }
  } else if (latest.status === 3) {
    await Room.updateOne({ roomId }, { $set: { phase: "closed" } });
  }

  return { roomId, status: "ok", returned, reconciled, failed };
}

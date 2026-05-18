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
  /** Redis client used for the B10 finalizeRoomLeaderboardOnChain step.
   *  Pass null to skip the on-chain top-3 patch — settlement still
   *  proceeds (yield distribution falls back to whatever top-3 was
   *  populated by score-bridge per session commits). */
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

  // RoomEntry layout: [8 disc][1 version][32 room]…  so the room pubkey
  // sits at byte 9, not 8. Filtering at offset 8 was matching the version
  // byte against the first byte of roomPda, which never hits.
  //
  // We fetch entries BEFORE close_room so the precondition check below
  // can sum unreturned principal against the live vault balance. Entries
  // are immutable across close_room — close_room only mutates the room
  // status and protocol-share transfer, not the entry accounts — so the
  // single fetch is correct for the whole tick.
  const entries = await program.account.roomEntry.all([
    {
      memcmp: { offset: 9, bytes: roomPda.toBase58() },
    },
  ]);

  // B2 precondition (post-2026-05-18 incident): refuse to advance past
  // close_room if the vault doesn't hold enough lamports to cover every
  // unreturned entry. The chain's `finalize_room` closes the vault
  // permanently, so if we run close_room → return_principal × N on a
  // drained vault, every return_principal reverts with VaultInsufficientFunds,
  // then B1's finalize gate would skip finalize (good) — but if any prior
  // bug or admin action let finalize through, the vault is gone forever
  // and recovery requires manual out-of-band transfers (what the incident
  // forced). Failing closed at the close_room step keeps the room in
  // `settling` indefinitely, recoverable by refunding the vault.
  //
  // Required balance: sum of unreturned depositLamports + full yield (the
  // 30% protocol share leaves the vault during close_room; the remaining
  // 70% is distributed by return_principal per top-3 share) + rent-exempt
  // floor for the vault SystemAccount.
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

    // B10 (post-2026-05-18 incident): patch the on-chain top-3 cache
    // from Redis BEFORE close_room reads it. Without this, a silently
    // broken score-bridge worker (KEEPER_KEYPAIR missing in env, queue
    // backed up, etc.) leaves first/second/thirdPlace as default pubkey
    // — close_room then locks in zero yield share for everyone. This
    // step is idempotent + best-effort: when redis is missing or the
    // top-3 is already current, it no-ops. The keeper keypair is
    // optional; if absent the function logs the degradation and
    // settlement continues with whatever top-3 was already on chain.
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
      // Treat as soft-failure: log loudly, let close_room proceed.
      // Falling back to default top-3 is still better than blocking
      // settlement on a Redis blip.
      logger.error(
        `room=${roomId} finalizeRoomLeaderboardOnChain threw: ${formatSolanaError(err)}`,
      );
    }

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
      // B8: include program logs / anchor breakdown so the cause of a
      // VaultInsufficientFunds (or any other revert) is visible without
      // a separate explorer round-trip.
      logger.error(
        `room=${roomId} return_principal RPC failed for ${recipientStr}: ${formatSolanaError(rpcErr)}`,
      );
    }
  }

  logger.info(
    `room=${roomId} settlement summary: ${returned}/${humanCount} returned, ${reconciled} reconciled, ${failed} failed`,
  );

  const latest = await program.account.room.fetch(roomPda);

  // B1 finalize gate (post-2026-05-18 incident): `finalize_room` closes
  // the vault account on-chain, which is irreversible — after that,
  // `return_principal` reverts with "vault not initialized" forever and
  // any remaining unpaid players have to be reimbursed manually. The OLD
  // code finalized as soon as `status === 2`, regardless of whether a
  // single return_principal succeeded; that's exactly how the incident
  // turned a recoverable "vault is empty, retry next tick" into an
  // unrecoverable "vault is closed, manual payout required" state.
  //
  // Only finalize when every entry has been settled. Specifically:
  //   - `failed === 0`: no return_principal failures THIS tick.
  //   - `returned + reconciled === humanCount`: every on-chain entry is
  //     marked returned, either from a fresh transfer or the reconcile
  //     path that heals stale DB writes.
  //
  // When the gate doesn't open, the room stays in `phase: "settling"`.
  // The next lifecycle tick re-runs settleAllReadyRooms; transient
  // failures (RPC blips, blockhash expiry) retry automatically, and the
  // operator has time to investigate persistent failures before the
  // vault disappears.
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
    // Status already 3 means a previous tick (or out-of-band action)
    // already finalized — sync the DB so the room exits the settling
    // query on the next tick.
    await Room.updateOne({ roomId }, { $set: { phase: "closed" } });
  }

  return { roomId, status: "ok", returned, reconciled, failed };
}

import BN from "bn.js";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import type Redis from "ioredis";
import { getRoomEntryPda } from "../solana/roomsProgram.js";
import type { HookedRooms } from "../idl/hooked_rooms_types.js";
import { Player } from "../db/schema.js";
import { getRoomLeaderboard } from "./leaderboard.js";
import { formatSolanaError } from "../solana/formatError.js";

/**
 * Belt-and-suspenders for the on-chain top-3 cache (B10 — post-2026-05-18
 * incident).
 *
 * The score-bridge worker pushes per-session scores via
 * `update_room_entry_score` after each session commit, which keeps the
 * on-chain `RoomEntry.score` and the room's top-3 cache
 * (`firstPlace`/`secondPlace`/`thirdPlace`) up to date. But that worker
 * silently degrades when `KEEPER_KEYPAIR` isn't set in the environment —
 * it writes a `skipped:no-keeper` sentinel to the session and moves on,
 * with no top-level alarm. Result: rooms close with default-pubkey
 * top-3, and `shareForRecipient` returns 0 for everyone, so the 70%
 * yield split never reaches winners even when yield is realized.
 *
 * This function is called from `settleRoom` right before `close_room`
 * (which reads the top-3 cache). It:
 *
 *   1. Reads top-3 from the Redis room leaderboard (the source of truth
 *      for off-chain score).
 *   2. Maps playerIds → wallets.
 *   3. For each top-3 wallet, fetches the on-chain `RoomEntry` and
 *      computes `delta = redisScore - entry.score`.
 *   4. If `delta > 0`, calls `update_room_entry_score(delta)` so the
 *      on-chain account catches up. `update_room_entry_score` itself
 *      maintains the top-3 cache on the room as a side effect of
 *      sorting on score updates.
 *
 * Best-effort: if anything fails (no keeper, no Redis, RPC blip), we
 * log loudly and let settlement proceed. The room still closes; the
 * yield share for any miss-bridged winner just defaults to 0 — same
 * as today's behavior, no worse. The `detectedScoreBridgeGap` flag in
 * the result lets the caller surface "score-bridge has been silently
 * broken for this room" as an operational alert.
 */

export type FinalizeLeaderboardResult = {
  /** Number of `update_room_entry_score` txs sent this run. */
  pushed: number;
  /** Top-3 wallets whose on-chain score already matched Redis. */
  alreadyCurrent: number;
  /** Top-3 entries we couldn't push (wallet missing, no on-chain entry,
   *  RPC error, etc.). Settlement still proceeds. */
  skipped: number;
  errors: string[];
  /** True when at least one top-3 entry had Redis ahead of chain.
   *  Indicates score-bridge has been silently broken for this room. */
  detectedScoreBridgeGap: boolean;
};

export async function finalizeRoomLeaderboardOnChain(opts: {
  /** Redis client. When null, the function logs and returns a no-op
   *  result — caller's job to decide whether to alert. */
  redis: Redis | null;
  program: Program<HookedRooms>;
  /** When null (KEEPER_KEYPAIR not set), the function logs the
   *  degradation and returns without pushing. Settlement proceeds with
   *  whatever top-3 was already on chain. */
  keeper: Keypair | null;
  /** DB roomId (string), used for the Redis leaderboard key. */
  roomId: string;
  roomPda: PublicKey;
  logger: { info: (s: string) => void; error: (s: string) => void };
}): Promise<FinalizeLeaderboardResult> {
  const result: FinalizeLeaderboardResult = {
    pushed: 0,
    alreadyCurrent: 0,
    skipped: 0,
    errors: [],
    detectedScoreBridgeGap: false,
  };

  if (!opts.redis) {
    opts.logger.info(
      `room=${opts.roomId} finalizeLeaderboard skipped — no redis client`,
    );
    return result;
  }
  if (!opts.keeper) {
    opts.logger.error(
      `room=${opts.roomId} finalizeLeaderboard skipped — KEEPER_KEYPAIR not set. ` +
        `Top-3 cache may be stale and yield distribution will go to default-pubkey ` +
        `winners (effectively burned). Set KEEPER_KEYPAIR in the worker env.`,
    );
    return result;
  }

  // Read top-3 from Redis. Members are Mongo playerId hex strings.
  const top = await opts.redis
    ? await getRoomLeaderboard(opts.redis, opts.roomId, 0, 3).catch((err) => {
        result.errors.push(`redis-read: ${(err as Error).message}`);
        return [] as { member: string; score: number }[];
      })
    : [];
  if (top.length === 0) {
    opts.logger.info(
      `room=${opts.roomId} finalizeLeaderboard: no entries in redis leaderboard`,
    );
    return result;
  }

  const players = await Player.find(
    { _id: { $in: top.map((t) => t.member) } },
    { _id: 1, walletAddress: 1 },
  ).lean();
  const walletByPlayerId = new Map(
    players.map((p) => [String(p._id), p.walletAddress]),
  );

  const connection = opts.program.provider.connection;
  for (const { member, score: redisScore } of top) {
    const wallet = walletByPlayerId.get(member);
    if (!wallet) {
      result.skipped += 1;
      opts.logger.info(
        `  finalizeLeaderboard: no wallet for playerId=${member}`,
      );
      continue;
    }

    let authority: PublicKey;
    try {
      authority = new PublicKey(wallet);
    } catch (err) {
      result.skipped += 1;
      result.errors.push(`bad-wallet ${wallet}: ${(err as Error).message}`);
      continue;
    }

    const entryPda = getRoomEntryPda(opts.roomPda, authority);
    const entry = await opts.program.account.roomEntry
      .fetchNullable(entryPda)
      .catch(() => null);
    if (!entry) {
      result.skipped += 1;
      opts.logger.info(
        `  finalizeLeaderboard: no on-chain entry for ${wallet}`,
      );
      continue;
    }

    // entry.score may be a BN, a bigint, or absent depending on IDL
    // version. Normalize defensively.
    const onChainScore = (() => {
      const raw = (entry as { score?: unknown }).score;
      if (raw === undefined || raw === null) return 0n;
      if (typeof raw === "bigint") return raw;
      if (typeof raw === "number") return BigInt(raw);
      if (typeof (raw as { toString?: () => string }).toString === "function") {
        return BigInt((raw as { toString: () => string }).toString());
      }
      return 0n;
    })();

    const target = BigInt(Math.max(0, Math.round(redisScore)));
    const delta = target - onChainScore;
    if (delta <= 0n) {
      result.alreadyCurrent += 1;
      continue;
    }

    result.detectedScoreBridgeGap = true;

    try {
      const updateIx = await opts.program.methods
        .updateRoomEntryScore(new BN(delta.toString()))
        .accountsPartial({
          room: opts.roomPda,
          entry: entryPda,
          keeper: opts.keeper.publicKey,
        })
        .instruction();
      const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 1_000,
      });
      const tx = new Transaction().add(priorityIx, updateIx);
      tx.feePayer = opts.keeper.publicKey;
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.sign(opts.keeper);
      const sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      result.pushed += 1;
      opts.logger.info(
        `room=${opts.roomId} finalizeLeaderboard pushed delta=${delta} for ${wallet} tx=${sig}`,
      );
    } catch (err) {
      result.errors.push(`push ${wallet}: ${(err as Error).message}`);
      opts.logger.error(
        `room=${opts.roomId} finalizeLeaderboard push failed for ${wallet}: ${formatSolanaError(err)}`,
      );
    }
  }

  if (result.detectedScoreBridgeGap) {
    opts.logger.error(
      `room=${opts.roomId} SCORE-BRIDGE GAP detected — pushed ${result.pushed} ` +
        `update_room_entry_score at settlement (alreadyCurrent=${result.alreadyCurrent}, ` +
        `skipped=${result.skipped}, errors=${result.errors.length}). ` +
        `The per-session scoreBridge worker is not keeping up. Investigate KEEPER_KEYPAIR ` +
        `env, BullMQ scoreBridge queue depth, or scoreBridge worker failure logs.`,
    );
  }

  return result;
}

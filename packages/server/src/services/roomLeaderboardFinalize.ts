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

// B10: belt-and-suspenders before close_room. Patches on-chain top-3
// from Redis when score-bridge silently degraded (no KEEPER_KEYPAIR in env,
// queue stalled, etc.) — otherwise winners get yield share = 0.

export type FinalizeLeaderboardResult = {
  pushed: number;
  alreadyCurrent: number;
  /** Wallet missing / no on-chain entry / RPC error — settlement still runs. */
  skipped: number;
  errors: string[];
  /** True when Redis was ahead of chain on any top-3 entry. */
  detectedScoreBridgeGap: boolean;
};

export async function finalizeRoomLeaderboardOnChain(opts: {
  redis: Redis | null;
  program: Program<HookedRooms>;
  keeper: Keypair | null;
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

  // Members are Mongo playerId hex strings.
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

    // BN / bigint / undefined across IDL versions.
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

import { Worker, type ConnectionOptions, type Job } from "bullmq";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import { PoolTier } from "../db/schema.js";
import { env } from "../config/env.js";
import { loadTreasuryKeypair } from "../solana/roomsProgram.js";

interface PoolPayoutData {
  playerId: string;
  walletAddress: string;
  prizeSOL: number;
  poolId: string;
  poolDocId: string;
  rank: number;
}

const FEE_BUFFER_LAMPORTS = 10_000;

export async function processPoolPayout(job: Job<PoolPayoutData>) {
  const { walletAddress, prizeSOL, poolId, poolDocId, rank } = job.data;

  if (prizeSOL <= 0) {
    job.log(`Skipping zero-prize payout: pool=${poolId} rank=${rank}`);
    return;
  }

  const treasury = loadTreasuryKeypair();
  if (!treasury) {
    console.warn(
      `[PAYOUT STUB] Pool ${poolId}, Rank #${rank}: ${walletAddress} → ${prizeSOL} SOL (no treasury keypair configured)`,
    );
    return;
  }

  const winnerFilter = {
    _id: poolDocId,
    "winners.rank": rank,
    "winners.walletAddress": walletAddress,
  };

  const pool = await PoolTier.findOne(winnerFilter).lean();
  if (!pool) {
    throw new Error(
      `Pool ${poolDocId} has no winner rank=${rank} wallet=${walletAddress}`,
    );
  }

  const winner = (pool.winners ?? []).find(
    (w) => w.rank === rank && w.walletAddress === walletAddress,
  );
  if (!winner) {
    throw new Error(
      `Winner rank=${rank} wallet=${walletAddress} missing from pool ${poolDocId}`,
    );
  }
  if (winner.paid) {
    job.log(
      `Already paid: pool=${poolId} rank=${rank} sig=${winner.signature ?? "n/a"}`,
    );
    return;
  }

  const connection = new Connection(env.SOLANA_RPC_URL, "confirmed");
  const lamports = Math.floor(prizeSOL * LAMPORTS_PER_SOL);
  const recipient = new PublicKey(walletAddress);

  // If a previous attempt already sent a tx, check whether it landed before
  // signing a new one — resending is the double-pay hazard.
  if (winner.signature) {
    const status = await connection.getSignatureStatus(winner.signature, {
      searchTransactionHistory: true,
    });
    const landed =
      status.value?.confirmationStatus === "confirmed" ||
      status.value?.confirmationStatus === "finalized";
    if (landed && !status.value?.err) {
      await PoolTier.updateOne(winnerFilter, {
        $set: {
          "winners.$.paid": true,
          "winners.$.paidAt": new Date(),
          "winners.$.lastError": null,
        },
      });
      job.log(
        `Prior tx confirmed on-chain: pool=${poolId} rank=${rank} sig=${winner.signature}`,
      );
      return;
    }
    // Not confirmed — refuse to blindly resend. Surfacing this loudly is the
    // safer default; an operator can clear the signature to authorize a
    // fresh attempt once they've verified on-chain.
    if (status.value?.err) {
      job.log(
        `Prior tx failed on-chain (${JSON.stringify(status.value.err)}) — clearing signature to retry`,
      );
      await PoolTier.updateOne(winnerFilter, {
        $set: { "winners.$.signature": null },
      });
    } else {
      throw new Error(
        `Prior signature ${winner.signature} unresolved; manual review required`,
      );
    }
  }

  const balance = await connection.getBalance(treasury.publicKey);
  if (balance < lamports + FEE_BUFFER_LAMPORTS) {
    throw new Error(
      `Treasury balance too low: ${balance / LAMPORTS_PER_SOL} SOL, ` +
        `need ${prizeSOL} SOL + fees`,
    );
  }

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: treasury.publicKey,
      toPubkey: recipient,
      lamports,
    }),
  );
  tx.recentBlockhash = blockhash;
  tx.feePayer = treasury.publicKey;
  tx.sign(treasury);

  if (!tx.signature) {
    throw new Error("Failed to sign transaction");
  }
  const sig = bs58.encode(tx.signature);

  // Persist the signature BEFORE sending so a process crash between send and
  // the post-confirm DB write cannot cause a second transaction to be signed.
  await PoolTier.updateOne(winnerFilter, {
    $set: { "winners.$.signature": sig, "winners.$.lastError": null },
    $inc: { "winners.$.attempts": 1 },
  });

  try {
    await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
    });
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await PoolTier.updateOne(winnerFilter, {
      $set: { "winners.$.lastError": message },
    });
    throw err;
  }

  await PoolTier.updateOne(winnerFilter, {
    $set: {
      "winners.$.paid": true,
      "winners.$.paidAt": new Date(),
      "winners.$.lastError": null,
    },
  });

  job.log(
    `Paid: pool=${poolId} rank=${rank} wallet=${walletAddress} prize=${prizeSOL} sig=${sig}`,
  );
}

export function createPayoutWorker(connection: ConnectionOptions) {
  const worker = new Worker("payout", processPoolPayout, {
    connection,
    concurrency: 1,
  });

  worker.on("completed", (job) => {
    console.log(`Pool payout completed: ${job.id}`);
  });

  worker.on("failed", (job, err) => {
    console.error(`Pool payout failed: ${job?.id}`, err);
  });

  return worker;
}

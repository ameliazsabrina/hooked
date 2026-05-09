import { Worker, type ConnectionOptions, type Job } from "bullmq";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { env } from "../config/env.js";
import { PlayerBountyProgress } from "../db/schema.js";
import { loadKeeperKeypair } from "../solana/keypairs.js";
import { getRoomsConnection } from "../solana/roomsProgram.js";
import { isDevnet } from "../bounties/period.js";

type Payload = {
  progressId: string;
  walletAddress: string;
  lamports: number;
};

function parseKeypair(raw: string): Keypair | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const bytes = JSON.parse(trimmed) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(bytes));
    } catch {
      return null;
    }
  }
  try {
    const bytes = bs58.decode(trimmed);
    if (bytes.length !== 64) return null;
    return Keypair.fromSecretKey(bytes);
  } catch {
    return null;
  }
}

function loadTreasuryKeypair(): Keypair | null {
  if (!env.TREASURY_KEYPAIR) return null;
  return parseKeypair(env.TREASURY_KEYPAIR);
}

async function markFailed(progressId: string, reason: string) {
  console.error(`[bounty-sol-payout] ${reason}`, { progressId });
  await PlayerBountyProgress.updateOne(
    { _id: progressId },
    { $set: { rewardSolPayoutStatus: "failed" } }
  );
}

async function processPayout(job: Job<Payload>) {
  const { progressId, walletAddress, lamports } = job.data;

  if (!isDevnet()) {
    await markFailed(
      progressId,
      "refusing SOL payout on non-devnet RPC (set SOLANA_RPC_URL to a devnet endpoint)"
    );
    return;
  }

  const progress = await PlayerBountyProgress.findById(progressId).lean();
  if (!progress) {
    console.warn("[bounty-sol-payout] progress row missing", { progressId });
    return;
  }
  if (progress.rewardSolPayoutStatus === "sent") return;
  if (progress.rewardTxSignature) return;

  const signer = loadTreasuryKeypair() ?? loadKeeperKeypair();
  if (!signer) {
    await markFailed(
      progressId,
      "no TREASURY_KEYPAIR or KEEPER_KEYPAIR configured"
    );
    return;
  }

  let recipient: PublicKey;
  try {
    recipient = new PublicKey(walletAddress);
  } catch {
    await markFailed(progressId, `invalid recipient wallet: ${walletAddress}`);
    return;
  }

  const connection = getRoomsConnection();
  const balance = await connection.getBalance(signer.publicKey);
  if (balance < lamports + 5_000) {
    await markFailed(
      progressId,
      `signer ${signer.publicKey.toBase58()} has insufficient balance (${balance} < ${lamports + 5000})`
    );
    return;
  }

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: recipient,
      lamports,
    })
  );
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;
  tx.sign(signer);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });

  try {
    await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed"
    );
  } catch (err) {
    await markFailed(
      progressId,
      `confirmation failed for ${signature}: ${(err as Error).message}`
    );
    throw err;
  }

  await PlayerBountyProgress.updateOne(
    { _id: progressId },
    {
      $set: {
        rewardSolPayoutStatus: "sent",
        rewardTxSignature: signature,
      },
    }
  );
  job.log(`sent ${lamports} lamports to ${walletAddress}: ${signature}`);
}

export function createBountySolPayoutWorker(connection: ConnectionOptions) {
  const worker = new Worker<Payload>("bounty-sol-payout", processPayout, {
    connection,
    concurrency: 1,
  });
  worker.on("failed", (job, err) => {
    console.error(`bounty-sol-payout failed: ${job?.id}`, err);
  });
  return worker;
}

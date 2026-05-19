import { Worker, type ConnectionOptions, type Job } from "bullmq";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  type Connection,
} from "@solana/web3.js";
import { BN } from "bn.js";

import { FishingSession, Player, Room } from "../db/schema.js";
import { encodeScoreBridgeMemo, buildMemoInstruction } from "../services/fishing/memo.js";
import {
  getRoomEntryPda,
  getRoomPda,
  getRoomsConnection,
  getRoomsProgram,
} from "../solana/roomsProgram.js";
import { loadKeeperKeypair } from "../solana/keypairs.js";

export const SCORE_BRIDGE_QUEUE_NAME = "score-bridge";

export interface ScoreBridgeJobData {
  sessionId: string;
}

/** Persisted to chainScoreTxSignature on intentional skip — non-null = don't retry. */
const SKIP_SENTINEL_PREFIX = "skipped:";

export interface ScoreBridgeOutcome {
  status: "submitted" | "skipped" | "already-bridged";
  signature: string | null;
  reason: string | null;
}

/** Injection seam — prod uses submitOnChain. */
export interface ScoreBridgeSubmitter {
  submit(input: {
    keeper: Keypair;
    roomPda: PublicKey;
    entryPda: PublicKey;
    authority: PublicKey;
    scoreDelta: bigint;
    memo: string;
  }): Promise<string>;
}

/** Memo + score update in one tx so audit context commits atomically. */
export const submitOnChain: ScoreBridgeSubmitter = {
  async submit(input) {
    const programResult = getRoomsProgram(input.keeper);
    if (!programResult) {
      throw new Error("getRoomsProgram returned null — keeper keypair invalid");
    }
    const { program } = programResult;
    const connection: Connection = getRoomsConnection();

    const updateIx = await program.methods
      .updateRoomEntryScore(new BN(input.scoreDelta.toString()))
      .accountsPartial({
        room: input.roomPda,
        entry: input.entryPda,
        keeper: input.keeper.publicKey,
      })
      .instruction();

    const memoIx = buildMemoInstruction(input.memo, input.keeper.publicKey);
    const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 1_000,
    });

    const tx = new Transaction().add(priorityIx, updateIx, memoIx);
    tx.feePayer = input.keeper.publicKey;
    const blockhash = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash.blockhash;
    tx.sign(input.keeper);

    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await connection.confirmTransaction(
      {
        signature,
        blockhash: blockhash.blockhash,
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
      },
      "confirmed",
    );
    return signature;
  },
};

export interface ProcessScoreBridgeDeps {
  submitter?: ScoreBridgeSubmitter;
  /** Injected to bypass loadKeeperKeypair's stale module-level cache in tests. */
  keeperLoader?: () => Keypair | null;
}

/** Idempotent: non-null chainScoreTxSignature short-circuits with already-bridged. */
export async function processScoreBridge(
  sessionId: string,
  deps: ProcessScoreBridgeDeps = {},
): Promise<ScoreBridgeOutcome> {
  const submitter = deps.submitter ?? submitOnChain;
  const keeperLoader = deps.keeperLoader ?? loadKeeperKeypair;
  const session = await FishingSession.findById(sessionId);
  if (!session) {
    return { status: "skipped", signature: null, reason: "session-not-found" };
  }
  if (session.chainScoreTxSignature) {
    return {
      status: "already-bridged",
      signature: session.chainScoreTxSignature,
      reason: null,
    };
  }
  if (session.status !== "committed") {
    return {
      status: "skipped",
      signature: null,
      reason: `session-status-${session.status}`,
    };
  }

  if (session.sessionScore === 0) {
    const sentinel = `${SKIP_SENTINEL_PREFIX}zero-score`;
    await FishingSession.updateOne(
      { _id: session._id, chainScoreTxSignature: null },
      { $set: { chainScoreTxSignature: sentinel, chainScoreBridgedAt: new Date() } },
    );
    return { status: "skipped", signature: sentinel, reason: "zero-score" };
  }

  const player = await Player.findById(session.playerId).lean();
  if (!player) {
    return { status: "skipped", signature: null, reason: "player-not-found" };
  }
  const activeDeposit = (player.deposits ?? [])
    .filter((d) => !d.returned)
    .sort((a, b) => b.depositedAt.getTime() - a.depositedAt.getTime())[0];
  if (!activeDeposit) {
    return { status: "skipped", signature: null, reason: "no-active-deposit" };
  }

  const room = await Room.findOne({ roomId: activeDeposit.poolId }).lean();
  if (!room || !room.onChainPoolId) {
    return { status: "skipped", signature: null, reason: "room-not-on-chain" };
  }

  const keeper = keeperLoader();
  if (!keeper) {
    const sentinel = `${SKIP_SENTINEL_PREFIX}no-keeper`;
    await FishingSession.updateOne(
      { _id: session._id, chainScoreTxSignature: null },
      { $set: { chainScoreTxSignature: sentinel, chainScoreBridgedAt: new Date() } },
    );
    return { status: "skipped", signature: sentinel, reason: "no-keeper-keypair" };
  }

  let authority: PublicKey;
  let roomPda: PublicKey;
  try {
    authority = new PublicKey(session.walletAddress);
    roomPda = getRoomPda(BigInt(room.onChainPoolId));
  } catch (err) {
    return {
      status: "skipped",
      signature: null,
      reason: `pubkey-derive-failed:${(err as Error).message}`,
    };
  }
  const entryPda = getRoomEntryPda(roomPda, authority);

  if (!session.merkleRoot) {
    return { status: "skipped", signature: null, reason: "missing-merkle-root" };
  }
  const memo = encodeScoreBridgeMemo({
    sessionId: String(session._id),
    merkleRoot: Buffer.from(session.merkleRoot),
  });

  const signature = await submitter.submit({
    keeper,
    roomPda,
    entryPda,
    authority,
    scoreDelta: BigInt(session.sessionScore),
    memo,
  });

  // Prevents double-credit on parallel-worker chain races.
  const persisted = await FishingSession.findOneAndUpdate(
    { _id: session._id, chainScoreTxSignature: null },
    {
      $set: {
        chainScoreTxSignature: signature,
        chainScoreBridgedAt: new Date(),
      },
    },
    { new: true },
  );
  if (!persisted) {
    return {
      status: "already-bridged",
      signature: (await FishingSession.findById(session._id))?.chainScoreTxSignature ?? null,
      reason: "concurrent-bridge",
    };
  }
  return { status: "submitted", signature, reason: null };
}

/** Job key = sessionId for natural dedupe. */
export function createScoreBridgeWorker(connection: ConnectionOptions): Worker {
  const worker = new Worker<ScoreBridgeJobData>(
    SCORE_BRIDGE_QUEUE_NAME,
    async (job: Job<ScoreBridgeJobData>) => {
      const { sessionId } = job.data;
      job.log(`processing scoreBridge for session=${sessionId}`);
      const outcome = await processScoreBridge(sessionId);
      job.log(`outcome=${outcome.status} reason=${outcome.reason ?? "ok"}`);
      return outcome;
    },
    {
      connection,
      concurrency: 4,
    },
  );
  worker.on("failed", (job, err) => {
    console.error(
      `[scoreBridge] failed job=${job?.id} session=${job?.data.sessionId}: ${err.message}`,
    );
  });
  return worker;
}

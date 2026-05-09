import mongoose from "mongoose";
import { PublicKey } from "@solana/web3.js";
import { env } from "../config/env.js";
import { Player, Room } from "../db/schema.js";
import {
  getRoomsProgram,
  getRoomPda,
  getRoomEntryPda,
} from "../solana/roomsProgram.js";

/**
 * One-off recovery for stuck deposits. When the keeper successfully called
 * return_principal on-chain but the Mongo write failed (or was missed
 * entirely, as was the case before the keeper was fixed to also write
 * Player.deposits.$.returned), the user is permanently locked out of
 * depositing into a new room.
 *
 * Usage:
 *   pnpm tsx src/cli/reconcileReturns.ts [--wallet <addr>] [--dry-run]
 */

type Stats = {
  playersScanned: number;
  depositsScanned: number;
  reconciled: number;
  onChainNotReturned: number;
  onChainMissing: number;
  roomNotFound: number;
};

type LoadedProgram = NonNullable<ReturnType<typeof getRoomsProgram>>;

async function reconcileWallet(
  walletAddress: string,
  loaded: LoadedProgram,
  dryRun: boolean,
  stats: Stats,
): Promise<void> {
  const player = await Player.findOne({ walletAddress }).lean();
  if (!player) return;
  stats.playersScanned += 1;

  for (const deposit of player.deposits ?? []) {
    if (deposit.returned) continue;
    stats.depositsScanned += 1;

    const room = await Room.findOne({ roomId: deposit.poolId }).lean();
    if (!room || !room.onChainPoolId) {
      stats.roomNotFound += 1;
      console.log(
        `[skip] wallet=${walletAddress} poolId=${deposit.poolId} no on-chain room id`,
      );
      continue;
    }

    let walletKey: PublicKey;
    try {
      walletKey = new PublicKey(walletAddress);
    } catch {
      console.log(`[skip] wallet=${walletAddress} invalid pubkey`);
      continue;
    }

    const roomPda = getRoomPda(BigInt(room.onChainPoolId));
    const entryPda = getRoomEntryPda(roomPda, walletKey);
    const entry = await loaded.program.account.roomEntry.fetchNullable(
      entryPda,
    );

    if (!entry) {
      stats.onChainMissing += 1;
      console.log(
        `[skip] wallet=${walletAddress} room=${deposit.poolId} no on-chain entry`,
      );
      continue;
    }

    if (!entry.returned) {
      stats.onChainNotReturned += 1;
      console.log(
        `[skip] wallet=${walletAddress} room=${deposit.poolId} on-chain not yet returned`,
      );
      continue;
    }

    const returnedAtMs = entry.returnedAt
      ? Number(entry.returnedAt.toString()) * 1000
      : Date.now();
    const returnedAt =
      returnedAtMs > 0 ? new Date(returnedAtMs) : new Date();

    console.log(
      `${dryRun ? "[dry-run] " : ""}reconcile wallet=${walletAddress} room=${deposit.poolId} returnedAt=${returnedAt.toISOString()}`,
    );

    if (!dryRun) {
      await Promise.all([
        Room.updateOne(
          { roomId: deposit.poolId, "players.walletAddress": walletAddress },
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
            walletAddress,
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
    }
    stats.reconciled += 1;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const walletIdx = args.indexOf("--wallet");
  const targetWallet = walletIdx >= 0 ? args[walletIdx + 1] : null;

  await mongoose.connect(env.MONGODB_URI);
  console.log(`connected to ${env.MONGODB_URI}`);

  const loaded = getRoomsProgram();
  if (!loaded) {
    console.error(
      "TREASURY_KEYPAIR not configured — cannot read on-chain state",
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  const stats: Stats = {
    playersScanned: 0,
    depositsScanned: 0,
    reconciled: 0,
    onChainNotReturned: 0,
    onChainMissing: 0,
    roomNotFound: 0,
  };

  if (targetWallet) {
    await reconcileWallet(targetWallet, loaded, dryRun, stats);
  } else {
    const cursor = Player.find({
      "deposits.returned": false,
    }).cursor();
    for await (const player of cursor) {
      await reconcileWallet(player.walletAddress, loaded, dryRun, stats);
    }
  }

  console.log(
    `${dryRun ? "[dry-run] " : ""}done: ${JSON.stringify(stats)}`,
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

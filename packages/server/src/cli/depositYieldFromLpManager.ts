import {
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { Room } from "../db/schema.js";
import {
  getRoomPda,
  getRoomVaultPda,
  getRoomsConnection,
  loadLpManagerKeypair,
} from "../solana/roomsProgram.js";

/**
 * Rescue CLI: SystemProgram.transfer LP_MANAGER → room_vault PDA, with
 * optional yield tagging. Symmetric to withdrawToLpManager.ts.
 *
 * Usage: pnpm tsx src/cli/depositYieldFromLpManager.ts <roomId|onChainPoolId> [yieldLamports]
 * Run with CONFIRM=yes for a real transfer; otherwise dry-run.
 *
 * WARNING: do NOT run if finalize_room has closed the vault account.
 * SOL sent there is unreachable; pay players directly with SystemProgram.transfer.
 */
async function main() {
  const idArg = process.argv[2];
  const yieldArg = process.argv[3];
  if (!idArg) {
    console.error(
      "usage: pnpm tsx src/cli/depositYieldFromLpManager.ts <roomId|onChainPoolId> [yieldLamports]",
    );
    process.exit(1);
  }

  let onChainPoolId: bigint;
  let dbRoomId: string | null = null;
  const numericArg = /^[0-9]+$/.test(idArg);
  await mongoose.connect(env.MONGODB_URI);
  if (numericArg) {
    onChainPoolId = BigInt(idArg);
    const dbRoom = await Room.findOne(
      { onChainPoolId: idArg },
      { roomId: 1 },
    ).lean();
    dbRoomId = dbRoom?.roomId ?? null;
  } else {
    const dbRoom = await Room.findOne(
      { roomId: idArg },
      { onChainPoolId: 1, roomId: 1 },
    ).lean();
    if (!dbRoom || !dbRoom.onChainPoolId) {
      console.error(
        `Room "${idArg}" not found in DB or has no onChainPoolId.`,
      );
      await mongoose.disconnect();
      process.exit(1);
    }
    onChainPoolId = BigInt(dbRoom.onChainPoolId);
    dbRoomId = dbRoom.roomId;
    console.log(
      `Resolved DB roomId="${idArg}" → onChainPoolId=${onChainPoolId}`,
    );
  }

  const yieldLamports = yieldArg ? BigInt(yieldArg) : 0n;
  if (yieldArg && yieldLamports < 0n) {
    console.error(`yieldLamports must be >= 0; got ${yieldArg}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const lpManager = loadLpManagerKeypair();
  if (!lpManager) {
    console.error("LP_MANAGER_KEYPAIR not set — required as the tx signer.");
    await mongoose.disconnect();
    process.exit(1);
  }

  const connection = getRoomsConnection();
  const roomPda = getRoomPda(onChainPoolId);
  const vaultPda = getRoomVaultPda(roomPda);

  const vaultInfo = await connection.getAccountInfo(vaultPda);
  const vaultBalanceBefore = vaultInfo ? BigInt(vaultInfo.lamports) : 0n;
  if (!vaultInfo) {
    console.error(
      `\n⚠  WARNING: room_vault PDA ${vaultPda.toBase58()} does NOT exist ` +
        `on-chain. This usually means finalize_room has already run and the ` +
        `vault account has been closed. SOL sent to this address will not ` +
        `flow to players via return_principal — they're unreachable on-chain.\n` +
        `Do NOT proceed unless you've verified the room is recoverable via ` +
        `the keeper. Pay players directly with SystemProgram.transfer instead.\n`,
    );
  }

  const dbRoom = dbRoomId
    ? await Room.findOne({ roomId: dbRoomId }, { lp: 1, phase: 1 }).lean()
    : null;

  // Direct read for operator sanity check. Layout (after disc): version u8,
  // admin 32, roomId u64, createdAt u64, entryClosesAt u64, closesAt u64,
  // lpDeployAt u64, depositedLamports@81, lpDeployedLamports@89.
  let deployedLamports = BigInt(dbRoom?.lp?.deployedLamports ?? 0);
  let depositedLamports = 0n;
  const roomAccountInfo = await connection.getAccountInfo(roomPda);
  if (roomAccountInfo) {
    try {
      const data = roomAccountInfo.data;
      depositedLamports = data.readBigUInt64LE(81);
      const lpDeployedFromChain = data.readBigUInt64LE(89);
      if (lpDeployedFromChain > deployedLamports)
        deployedLamports = lpDeployedFromChain;
    } catch {
      // Layout drift — fall back to DB.
    }
  }

  const transferAmount = deployedLamports + yieldLamports;

  const lpBalance = BigInt(await connection.getBalance(lpManager.publicKey));
  const txFeeReserve = 100_000n;

  console.log("─── plan ─────────────────────────────────────");
  console.log(`db roomId            ${dbRoomId ?? "(unknown — used numeric)"}`);
  console.log(`onChainPoolId        ${onChainPoolId}`);
  console.log(`room PDA             ${roomPda.toBase58()}`);
  console.log(`room_vault PDA       ${vaultPda.toBase58()}`);
  console.log(
    `vault account        ${vaultInfo ? "exists (owner: " + roomAccountInfo?.owner.toBase58().slice(0, 12) + "…)" : "DOES NOT EXIST"}`,
  );
  console.log(
    `vault balance now    ${vaultBalanceBefore} lamports (${(Number(vaultBalanceBefore) / 1e9).toFixed(9)} SOL)`,
  );
  console.log(
    `room.depositedLam    ${depositedLamports} (${(Number(depositedLamports) / 1e9).toFixed(9)} SOL)`,
  );
  console.log(
    `room.lpDeployedLam   ${deployedLamports} (${(Number(deployedLamports) / 1e9).toFixed(9)} SOL)`,
  );
  console.log(
    `db lp.status         ${dbRoom?.lp?.status ?? "(no lp doc)"}`,
  );
  console.log(`db phase             ${dbRoom?.phase ?? "(missing)"}`);
  console.log(`lp_manager (src)     ${lpManager.publicKey.toBase58()}`);
  console.log(
    `lp_manager balance   ${lpBalance} (${(Number(lpBalance) / 1e9).toFixed(9)} SOL)`,
  );
  console.log(
    `transfer principal   ${deployedLamports} (${(Number(deployedLamports) / 1e9).toFixed(9)} SOL)`,
  );
  console.log(
    `transfer yield       ${yieldLamports} (${(Number(yieldLamports) / 1e9).toFixed(9)} SOL)`,
  );
  console.log(
    `transfer total       ${transferAmount} (${(Number(transferAmount) / 1e9).toFixed(9)} SOL)`,
  );
  console.log("──────────────────────────────────────────────");

  if (transferAmount === 0n) {
    console.error(
      "Refusing: transfer amount is 0. Pass an onChainPoolId with a non-zero " +
        "lpDeployedLamports, or pass yieldLamports as a second positional arg.",
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  if (lpBalance < transferAmount + txFeeReserve) {
    console.error(
      `Refusing: LP_MANAGER short. needs ${transferAmount + txFeeReserve}, has ${lpBalance}.`,
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  if (process.env.CONFIRM !== "yes") {
    console.log(
      "\nDry run. Re-run with CONFIRM=yes to actually send the tx + DB write:",
    );
    console.log(
      `  CONFIRM=yes pnpm tsx src/cli/depositYieldFromLpManager.ts ${idArg}${
        yieldArg ? " " + yieldArg : ""
      }`,
    );
    await mongoose.disconnect();
    return;
  }

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: lpManager.publicKey,
      toPubkey: new PublicKey(vaultPda),
      lamports: Number(transferAmount),
    }),
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [lpManager], {
    commitment: "confirmed",
  });
  console.log("\n✓ deposit_back tx:", sig);
  console.log(`  https://solscan.io/tx/${sig}`);

  if (dbRoomId) {
    const update = {
      "lp.status": "exited" as const,
      "lp.exitedLamports": Number(transferAmount),
      "lp.exitedAt": new Date(),
      "lp.realizedYieldLamports": Number(yieldLamports),
      "lp.depositYieldTxSignature": sig,
      "lp.lastError": "manual rescue via depositYieldFromLpManager",
    };
    const res = await Room.updateOne({ roomId: dbRoomId }, { $set: update });
    console.log(
      `✓ DB: Room.lp.* updated for roomId=${dbRoomId} (matched=${res.matchedCount}, modified=${res.modifiedCount})`,
    );
  } else {
    console.warn(
      "⚠  No DB roomId resolved — `lp.*` fields were NOT updated. " +
        "If this room has a DB row, run an additional Mongo update by hand:\n" +
        `  db.rooms.updateOne({ onChainPoolId: "${onChainPoolId}" }, ` +
        `{ $set: { "lp.status": "exited", "lp.realizedYieldLamports": ${yieldLamports}, ` +
        `"lp.depositYieldTxSignature": "${sig}" } })`,
    );
  }

  const vaultBalanceAfter = BigInt(await connection.getBalance(vaultPda));
  console.log(
    `\nVault balance: ${vaultBalanceBefore} → ${vaultBalanceAfter} (+${vaultBalanceAfter - vaultBalanceBefore})`,
  );
  console.log(
    "\nNext: the room-lifecycle keeper (15-min cron) will pick up the room " +
      "on its next tick, verify the vault precondition passes, and call " +
      "close_room → return_principal × N. Watch logs for the room id.",
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("depositYieldFromLpManager failed:", err);
  process.exit(1);
});

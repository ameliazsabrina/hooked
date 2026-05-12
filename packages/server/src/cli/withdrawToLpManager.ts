import BN from "bn.js";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { Room } from "../db/schema.js";
import {
  getProgramConfigPda,
  getRoomPda,
  getRoomVaultPda,
  getRoomsProgram,
  loadLpManagerKeypair,
  loadTreasuryKeypair,
} from "../solana/roomsProgram.js";

/**
 * One-off withdraw of a single room's vault balance to LP_MANAGER.
 *
 * Bypasses the lifecycle cron (which also runs the Meteora deploy) so this
 * tool is safe to use when LP is disabled and you just want the SOL out of
 * the program-controlled room_vault PDA.
 *
 *   pnpm tsx src/cli/withdrawToLpManager.ts <roomId|onChainPoolId>
 *
 * Accepts either the DB roomId (e.g. "R-20260511-09be80") or the on-chain
 * numeric pool ID. With a DB roomId, looks up onChainPoolId from MongoDB.
 *
 * The amount withdrawn is `min(room.deposited_lamports, vault_balance)` so
 * mismatches between DB-tracked deposits and on-chain state don't matter.
 * The program will refuse if amount > deposited_lamports.
 */
async function main() {
  const idArg = process.argv[2];
  if (!idArg) {
    console.error(
      "usage: pnpm tsx src/cli/withdrawToLpManager.ts <roomId|onChainPoolId>",
    );
    process.exit(1);
  }

  // If arg parses cleanly as a number, treat as on-chain pool ID. Otherwise
  // treat as a DB roomId string and look up the on-chain ID from MongoDB.
  let roomId: bigint;
  const numericArg = /^[0-9]+$/.test(idArg);
  if (numericArg) {
    roomId = BigInt(idArg);
  } else {
    await mongoose.connect(env.MONGODB_URI);
    const dbRoom = await Room.findOne(
      { roomId: idArg },
      { onChainPoolId: 1 },
    ).lean();
    await mongoose.disconnect();
    if (!dbRoom) {
      console.error(`Room "${idArg}" not found in DB.`);
      process.exit(1);
    }
    if (!dbRoom.onChainPoolId) {
      console.error(
        `Room "${idArg}" has no onChainPoolId — was it actually created on-chain?`,
      );
      process.exit(1);
    }
    roomId = BigInt(dbRoom.onChainPoolId);
    console.log(`Resolved DB roomId="${idArg}" → onChainPoolId=${roomId}`);
  }

  const treasury = loadTreasuryKeypair();
  if (!treasury) {
    console.error("TREASURY_KEYPAIR not set — required as tx signer (room admin).");
    process.exit(1);
  }
  const lpManager = loadLpManagerKeypair();
  if (!lpManager) {
    console.error("LP_MANAGER_KEYPAIR not set — needed only to verify the destination pubkey matches config.lp_manager.");
    process.exit(1);
  }

  const loaded = getRoomsProgram(treasury);
  if (!loaded) {
    console.error("Could not build Anchor program (check SOLANA_RPC_URL).");
    process.exit(1);
  }
  const { program } = loaded;

  const roomPda = getRoomPda(roomId);
  const roomVaultPda = getRoomVaultPda(roomPda);
  const configPda = getProgramConfigPda();

  const config = await program.account.programConfig.fetchNullable(configPda);
  if (!config) {
    console.error("ProgramConfig not initialized.");
    process.exit(1);
  }
  if (!config.lpManager.equals(lpManager.publicKey)) {
    console.error(
      `LP_MANAGER_KEYPAIR (${lpManager.publicKey.toBase58()}) does not match config.lp_manager (${config.lpManager.toBase58()}). The on-chain constraint will reject this tx.`,
    );
    process.exit(1);
  }

  const room = await program.account.room.fetchNullable(roomPda);
  if (!room) {
    console.error(`Room ${roomId} does not exist on-chain.`);
    process.exit(1);
  }
  if (!room.admin.equals(treasury.publicKey)) {
    console.error(
      `TREASURY_KEYPAIR (${treasury.publicKey.toBase58()}) is not the admin of room ${roomId} (admin: ${room.admin.toBase58()}).`,
    );
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  const lpDeployAt = room.lpDeployAt.toNumber();
  const closesAt = room.closesAt.toNumber();
  if (now < lpDeployAt) {
    console.error(
      `Room not yet in LP window. now=${now} lpDeployAt=${lpDeployAt} (opens in ${lpDeployAt - now}s)`,
    );
    process.exit(1);
  }
  if (now >= closesAt) {
    console.error(
      `LP window already closed. now=${now} closesAt=${closesAt}. Wait for close_room → return_principal instead.`,
    );
    process.exit(1);
  }
  if (!room.lpDeployedLamports.isZero()) {
    console.error(
      `Already deployed: room.lpDeployedLamports=${room.lpDeployedLamports.toString()}. Nothing to withdraw.`,
    );
    process.exit(1);
  }

  const connection = program.provider.connection;
  const vaultBalance = await connection.getBalance(roomVaultPda);
  const deposited = BigInt(room.depositedLamports.toString());
  const amount = deposited < BigInt(vaultBalance) ? deposited : BigInt(vaultBalance);

  console.log("─── plan ─────────────────────────────────────");
  console.log(`room                ${roomPda.toBase58()}`);
  console.log(`room_vault          ${roomVaultPda.toBase58()}`);
  console.log(`vault balance       ${vaultBalance} lamports (${vaultBalance / 1e9} SOL)`);
  console.log(`room.deposited      ${deposited} lamports (${Number(deposited) / 1e9} SOL)`);
  console.log(`lp_manager (dst)    ${lpManager.publicKey.toBase58()}`);
  console.log(`amount to withdraw  ${amount} lamports (${Number(amount) / 1e9} SOL)`);
  console.log("──────────────────────────────────────────────");

  if (amount === 0n) {
    console.error("Nothing to withdraw (amount is 0).");
    process.exit(1);
  }

  if (process.env.CONFIRM !== "yes") {
    console.log('\nDry run. Re-run with CONFIRM=yes to actually send the tx:');
    console.log(`  CONFIRM=yes pnpm tsx src/cli/withdrawToLpManager.ts ${roomIdArg}`);
    return;
  }

  const sig = await program.methods
    .withdrawToLpManager(new BN(amount.toString()))
    .accounts({
      room: roomPda,
      config: configPda,
      roomVault: roomVaultPda,
      lpManager: lpManager.publicKey,
      admin: treasury.publicKey,
    } as never)
    .rpc();

  console.log("\n✓ withdraw_to_lp_manager tx:", sig);
  console.log(`https://solscan.io/tx/${sig}`);
}

main().catch((err) => {
  console.error("withdrawToLpManager failed:", err);
  process.exit(1);
});

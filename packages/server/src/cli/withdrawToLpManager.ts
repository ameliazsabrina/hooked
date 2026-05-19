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
 * Withdraws min(room.deposited_lamports, vault_balance) → LP_MANAGER.
 * Usage: pnpm tsx src/cli/withdrawToLpManager.ts <roomId|onChainPoolId>
 */
async function main() {
  const idArg = process.argv[2];
  if (!idArg) {
    console.error(
      "usage: pnpm tsx src/cli/withdrawToLpManager.ts <roomId|onChainPoolId>",
    );
    process.exit(1);
  }

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
  const vaultBalance = BigInt(await connection.getBalance(roomVaultPda));
  const deposited = BigInt(room.depositedLamports.toString());

  // Vault must end at 0 (reaped) or ≥ rentMin, else runtime rejects.
  const rentMin = BigInt(
    await connection.getMinimumBalanceForRentExemption(0),
  );

  let amount = deposited < vaultBalance ? deposited : vaultBalance;
  let remainder = vaultBalance - amount;

  // Shrink withdraw so the remainder is exactly rent-exempt; stray rent
  // is reclaimed at close_room.
  if (remainder > 0n && remainder < rentMin) {
    amount = vaultBalance - rentMin;
    remainder = rentMin;
  }

  console.log("─── plan ─────────────────────────────────────");
  console.log(`room                ${roomPda.toBase58()}`);
  console.log(`room_vault          ${roomVaultPda.toBase58()}`);
  console.log(`vault balance       ${vaultBalance} lamports (${Number(vaultBalance) / 1e9} SOL)`);
  console.log(`room.deposited      ${deposited} lamports (${Number(deposited) / 1e9} SOL)`);
  console.log(`rent-exempt min     ${rentMin} lamports`);
  console.log(`lp_manager (dst)    ${lpManager.publicKey.toBase58()}`);
  console.log(`amount to withdraw  ${amount} lamports (${Number(amount) / 1e9} SOL)`);
  console.log(`vault remainder     ${remainder} lamports (${Number(remainder) / 1e9} SOL)`);
  console.log("──────────────────────────────────────────────");

  if (amount === 0n) {
    console.error("Nothing to withdraw (amount is 0).");
    process.exit(1);
  }

  if (process.env.CONFIRM !== "yes") {
    console.log('\nDry run. Re-run with CONFIRM=yes to actually send the tx:');
    console.log(`  CONFIRM=yes pnpm tsx src/cli/withdrawToLpManager.ts ${idArg}`);
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

import BN from "bn.js";
import mongoose from "mongoose";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { env } from "../config/env.js";
import { Room } from "../db/schema.js";
import {
  getRoomsProgram,
  getRoomPda,
  getRoomVaultPda,
  getProgramConfigPda,
} from "../solana/roomsProgram.js";
import { settleRoom } from "../services/roomKeeper.js";

/**
 * DEV ONLY — fast-forward a room past its 7-day window and run the full
 * settlement flow (close_room → return_principal × N → finalize_room) so
 * principal-return + winner-yield-share payouts can be exercised in
 * minutes instead of waiting a week.
 *
 * What it does:
 *   1. Calls the on-chain `dev_force_close_at` instruction to overwrite
 *      the room's `closes_at` (and `entry_closes_at`) to a past timestamp.
 *      That's the only on-chain change — `close_room`'s `now >= closes_at`
 *      check is what was blocking the test path.
 *   2. Mirrors that into Mongo (entryClosesAt, closesAt, phase=settling).
 *   3. Optionally seeds `room.lp.realizedYieldLamports` so the keeper has
 *      a non-zero yield to split — protocol share to treasury, the rest
 *      distributed 50/30/20 to top-3 winners via `return_principal`.
 *   4. Runs `settleRoom(roomId)` end-to-end, printing each tx signature.
 *
 * Usage:
 *   pnpm tsx src/cli/devForceCloseRoom.ts <roomId> [yieldLamports]
 *
 *   roomId         R-YYYYMMDD-xxxxxx (the Mongo room id, NOT the on-chain pda)
 *   yieldLamports  optional; defaults to 0 (principal-only return). Pass e.g.
 *                  100000000 (= 0.1 SOL) to test winner payouts. The keeper
 *                  will require the room vault to actually hold this much,
 *                  so for non-LP testing pre-fund the vault or keep it small.
 *
 * Example:
 *   pnpm tsx src/cli/devForceCloseRoom.ts R-20260510-5879f3 50000000
 */
async function main() {
  const [, , roomIdArg, yieldArg] = process.argv;
  if (!roomIdArg) {
    console.error("Usage: pnpm tsx src/cli/devForceCloseRoom.ts <roomId> [yieldLamports]");
    process.exit(1);
  }

  const yieldLamports = yieldArg ? BigInt(yieldArg) : 0n;

  await mongoose.connect(env.MONGODB_URI);

  const roomDoc = await Room.findOne({ roomId: roomIdArg });
  if (!roomDoc) {
    console.error(`Room ${roomIdArg} not found in Mongo`);
    process.exit(1);
  }
  if (!roomDoc.onChainPoolId) {
    console.error(`Room ${roomIdArg} has no onChainPoolId — nothing to settle`);
    process.exit(1);
  }
  if (roomDoc.phase === "closed") {
    console.error(`Room ${roomIdArg} is already closed`);
    process.exit(1);
  }

  const loaded = getRoomsProgram();
  if (!loaded) {
    console.error("TREASURY_KEYPAIR not configured — cannot sign on-chain tx");
    process.exit(1);
  }
  const { program, signer } = loaded;

  const onChainRoomId = BigInt(roomDoc.onChainPoolId);
  const roomPda = getRoomPda(onChainRoomId);
  const roomVaultPda = getRoomVaultPda(roomPda);
  const configPda = getProgramConfigPda();

  // Show where the SOL actually lives on-chain. This is the diagnostic
  // for "wait, is the money in the treasury or the vault?" — deposits go
  // straight into room_vault (a system-owned PDA per room), not treasury.
  const config = await program.account.programConfig.fetch(configPda);
  const [vaultLamports, treasuryLamports] = await Promise.all([
    program.provider.connection.getBalance(roomVaultPda),
    program.provider.connection.getBalance(config.treasury),
  ]);
  console.log("On-chain balances:");
  console.log(
    `  room_vault  (${roomVaultPda.toBase58()}) = ${vaultLamports} lamports (${vaultLamports / LAMPORTS_PER_SOL} SOL)`,
  );
  console.log(
    `  treasury    (${config.treasury.toBase58()}) = ${treasuryLamports} lamports (${treasuryLamports / LAMPORTS_PER_SOL} SOL)`,
  );

  // Pull the on-chain Room before / after so the user can see what changed.
  const before = await program.account.room.fetch(roomPda);
  console.log("Before:");
  console.log(
    "  entry_closes_at =",
    new Date(Number(before.entryClosesAt) * 1000).toISOString(),
  );
  console.log(
    "  closes_at       =",
    new Date(Number(before.closesAt) * 1000).toISOString(),
  );

  // Force closes_at to "now - 60s" so it's safely in the past relative to
  // the validator clock. dev_force_close_at clamps entry_closes_at down too.
  const newClosesAt = BigInt(Math.floor(Date.now() / 1000) - 60);

  console.log(
    `\nCalling dev_force_close_at(${newClosesAt}) on ${roomPda.toBase58()}…`,
  );
  // `as any` because the IDL might be on a build that pre-dates
  // dev_force_close_at — once `anchor build` + IDL copy lands on the
  // client/server, this cast becomes redundant but harmless.
  const forceTxSig = await (program.methods as any)
    .devForceCloseAt(new BN(newClosesAt.toString()))
    .accounts({
      room: roomPda,
      config: configPda,
      admin: signer.publicKey,
    })
    .rpc();
  console.log("  tx =", forceTxSig);

  const after = await program.account.room.fetch(roomPda);
  console.log("After:");
  console.log(
    "  entry_closes_at =",
    new Date(Number(after.entryClosesAt) * 1000).toISOString(),
  );
  console.log(
    "  closes_at       =",
    new Date(Number(after.closesAt) * 1000).toISOString(),
  );

  // Mirror into Mongo. Setting phase=settling so the keeper picks it up;
  // the lifecycle worker would do this on its next 15-min tick anyway,
  // but we don't want the user waiting.
  const newClosesAtDate = new Date(Number(newClosesAt) * 1000);
  const newEntryClosesAtDate =
    roomDoc.entryClosesAt > newClosesAtDate
      ? newClosesAtDate
      : roomDoc.entryClosesAt;

  const dbUpdate: Record<string, unknown> = {
    closesAt: newClosesAtDate,
    entryClosesAt: newEntryClosesAtDate,
    phase: "settling",
  };
  if (yieldLamports > 0n) {
    // settleRoom reads lp.realizedYieldLamports and passes it to close_room.
    // Setting it directly here lets us test the winner-payout path without
    // standing up a real LP cycle.
    dbUpdate["lp.realizedYieldLamports"] = Number(yieldLamports);
    console.log(
      `\nSeeding lp.realizedYieldLamports = ${yieldLamports} (will be split: 30% to treasury, 50/30/20 of remainder to top-3 winners)`,
    );
  }
  await Room.updateOne({ roomId: roomIdArg }, { $set: dbUpdate });

  console.log(`\nRunning settleRoom(${roomIdArg})…`);
  const result = await settleRoom(roomIdArg);
  console.log("\nResult:", JSON.stringify(result, null, 2));

  const final = await Room.findOne({ roomId: roomIdArg }, {
    phase: 1,
    closeTxSignature: 1,
    finalizeTxSignature: 1,
    "players.walletAddress": 1,
    "players.returned": 1,
    "players.returnTxSignature": 1,
  }).lean();
  console.log("\nFinal Mongo state:", JSON.stringify(final, null, 2));

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

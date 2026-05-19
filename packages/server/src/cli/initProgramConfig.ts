import {
  getProgramConfigPda,
  getRoomsProgram,
  loadAdminKeypair,
  loadLpManagerKeypair,
  loadTreasuryKeypair,
} from "../solana/roomsProgram.js";

/**
 * One-time init of ProgramConfig PDA. Idempotent; ADMIN must be distinct
 * from TREASURY so a treasury compromise doesn't become admin compromise.
 * Usage: pnpm tsx src/cli/initProgramConfig.ts
 */
async function main() {
  const admin = loadAdminKeypair();
  if (!admin) {
    console.error(
      "ADMIN_KEYPAIR is not set. Set it in .env to a freshly-generated keypair (separate from TREASURY_KEYPAIR).",
    );
    process.exit(1);
  }

  const treasury = loadTreasuryKeypair();
  if (!treasury) {
    console.error("TREASURY_KEYPAIR is not set.");
    process.exit(1);
  }

  const lpManager = loadLpManagerKeypair();
  if (!lpManager) {
    console.error(
      "LP_MANAGER_KEYPAIR is not set. Set it before initializing config — withdraw_to_lp_manager will pin to this pubkey.",
    );
    process.exit(1);
  }

  if (admin.publicKey.equals(treasury.publicKey)) {
    console.error(
      "ADMIN_KEYPAIR == TREASURY_KEYPAIR. The whole point of the H-1 fix is separating these — use a distinct cold key for admin.",
    );
    process.exit(1);
  }

  const loaded = getRoomsProgram(admin);
  if (!loaded) {
    console.error("Could not build Anchor program (check SOLANA_RPC_URL).");
    process.exit(1);
  }
  const { program } = loaded;

  const configPda = getProgramConfigPda();
  const existing = await program.account.programConfig.fetchNullable(configPda);
  if (existing) {
    console.log("ProgramConfig already exists at", configPda.toBase58());
    console.log({
      admin: existing.admin.toBase58(),
      treasury: existing.treasury.toBase58(),
      lpManager: existing.lpManager.toBase58(),
    });
    return;
  }

  console.log("Initializing ProgramConfig:");
  console.log("  pda        =", configPda.toBase58());
  console.log("  admin      =", admin.publicKey.toBase58());
  console.log("  treasury   =", treasury.publicKey.toBase58());
  console.log("  lp_manager =", lpManager.publicKey.toBase58());

  const sig = await program.methods
    .initProgramConfig(treasury.publicKey, lpManager.publicKey)
    .accounts({ admin: admin.publicKey } as never)
    .rpc();
  console.log("tx", sig);

  const fresh = await program.account.programConfig.fetch(configPda);
  console.log("Final state:", {
    admin: fresh.admin.toBase58(),
    treasury: fresh.treasury.toBase58(),
    lpManager: fresh.lpManager.toBase58(),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

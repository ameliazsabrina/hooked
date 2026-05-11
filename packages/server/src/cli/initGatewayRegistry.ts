import {
  getGatewayRegistryPda,
  getRoomsProgram,
  loadAdminKeypair,
  loadKeeperKeypair,
} from "../solana/roomsProgram.js";

/**
 * Initialize the on-chain GatewayRegistry PDA. Required ONCE per cluster after
 * deploying the program. Idempotent: if the PDA already exists, prints the
 * current state and exits without sending a tx.
 *
 * Required env vars:
 *   ADMIN_KEYPAIR   — payer and registry admin; must match ProgramConfig.admin
 *   KEEPER_KEYPAIR  — its pubkey becomes the first authorized score-update signer
 *
 * Usage:
 *   pnpm tsx src/cli/initGatewayRegistry.ts
 */
async function main() {
  const admin = loadAdminKeypair();
  if (!admin) {
    console.error("ADMIN_KEYPAIR is not set.");
    process.exit(1);
  }

  const keeper = loadKeeperKeypair();
  if (!keeper) {
    console.error("KEEPER_KEYPAIR is not set.");
    process.exit(1);
  }

  const loaded = getRoomsProgram(admin);
  if (!loaded) {
    console.error("Could not build Anchor program (check SOLANA_RPC_URL).");
    process.exit(1);
  }
  const { program } = loaded;

  const registryPda = getGatewayRegistryPda();
  const existing = await program.account.gatewayRegistry.fetchNullable(registryPda);
  if (existing) {
    console.log("GatewayRegistry already exists at", registryPda.toBase58());
    console.log({
      admin: existing.admin.toBase58(),
      keyCount: existing.keyCount,
      keys: existing.keys
        .slice(0, existing.keyCount)
        .map((k: { toBase58: () => string }) => k.toBase58()),
    });
    return;
  }

  console.log("Initializing GatewayRegistry:");
  console.log("  pda            =", registryPda.toBase58());
  console.log("  admin          =", admin.publicKey.toBase58());
  console.log("  initial_keeper =", keeper.publicKey.toBase58());

  const sig = await program.methods
    .initGatewayRegistry(keeper.publicKey)
    .accounts({ admin: admin.publicKey } as never)
    .rpc();
  console.log("tx", sig);

  const fresh = await program.account.gatewayRegistry.fetch(registryPda);
  console.log("Final state:", {
    admin: fresh.admin.toBase58(),
    keyCount: fresh.keyCount,
    keys: fresh.keys
      .slice(0, fresh.keyCount)
      .map((k: { toBase58: () => string }) => k.toBase58()),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

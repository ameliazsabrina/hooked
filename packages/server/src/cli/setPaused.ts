import {
  getProgramConfigPda,
  getRoomsProgram,
  loadAdminKeypair,
} from "../solana/roomsProgram.js";
import { invalidateConfigCache } from "../solana/configCache.js";

/**
 * Flip ProgramConfig.paused on the configured cluster. Admin-only —
 * ADMIN_KEYPAIR's pubkey must equal ProgramConfig.admin or the on-chain
 * constraint rejects the tx. The CLI checks this and exits early with a
 * clear message rather than burning a tx.
 *
 *   pnpm tsx src/cli/setPaused.ts true   # pause (blocks every state-changing ix)
 *   pnpm tsx src/cli/setPaused.ts false  # unpause
 */
async function main() {
  const arg = process.argv[2];
  if (arg !== "true" && arg !== "false") {
    console.error(
      "usage: pnpm tsx src/cli/setPaused.ts <true|false>",
    );
    process.exit(1);
  }
  const desired = arg === "true";

  const admin = loadAdminKeypair();
  if (!admin) {
    console.error("ADMIN_KEYPAIR not set in env");
    process.exit(1);
  }

  const loaded = getRoomsProgram(admin);
  if (!loaded) {
    console.error("Could not build Anchor program (check SOLANA_RPC_URL).");
    process.exit(1);
  }
  const { program } = loaded;

  const configPda = getProgramConfigPda();
  const before = await program.account.programConfig.fetchNullable(configPda);
  if (!before) {
    console.error(
      "ProgramConfig is not initialized. Run initProgramConfig first.",
    );
    process.exit(1);
  }
  if (!before.admin.equals(admin.publicKey)) {
    console.error(
      `ADMIN_KEYPAIR (${admin.publicKey.toBase58()}) does not match ProgramConfig.admin (${before.admin.toBase58()}). The on-chain constraint will reject this tx.`,
    );
    process.exit(1);
  }

  console.log(`paused: ${before.paused} → ${desired}`);
  if (before.paused === desired) {
    console.log("(no-op — already in desired state)");
    return;
  }

  const sig = await program.methods
    .setPaused(desired)
    .accounts({ admin: admin.publicKey } as never)
    .rpc();
  console.log("tx", sig);

  invalidateConfigCache();
  const after = await program.account.programConfig.fetch(configPda);
  console.log(`paused now: ${after.paused}`);
}

main().catch((err) => {
  console.error("setPaused failed:", err);
  process.exit(1);
});

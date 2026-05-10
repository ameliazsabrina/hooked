import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { HookedRooms } from "../idl/hooked_rooms_types.js";
import roomsIdl from "../idl/hooked_rooms.json" with { type: "json" };

/**
 * Read-only diagnostic. Prints whether ProgramConfig + GatewayRegistry exist
 * on the configured cluster and what's in them. Useful before/after a deploy
 * to confirm the on-chain state matches what the server expects.
 *
 *   SOLANA_RPC_URL=https://api.devnet.solana.com pnpm tsx src/cli/inspectProgramConfig.ts
 */
async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const programIdStr = process.env.HOOKED_ROOMS_PROGRAM_ID
    ?? "4ERUTWVN3aJP5tghEcZNd555NGcK3Jr8B21mnBB8JSMg";

  const conn = new Connection(rpcUrl, "confirmed");
  const programId = new PublicKey(programIdStr);

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    programId,
  );
  const [registryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("gateway_registry")],
    programId,
  );

  // Read-only: anchor's Program needs a "wallet", but no signing happens.
  const dummy = Keypair.generate();
  const wallet = {
    publicKey: dummy.publicKey,
    signTransaction: async (t: anchor.web3.Transaction) => t,
    signAllTransactions: async (t: anchor.web3.Transaction[]) => t,
  };
  const provider = new anchor.AnchorProvider(conn, wallet as never, {});
  const program = new anchor.Program<HookedRooms>(
    roomsIdl as HookedRooms,
    provider,
  );

  console.log("rpc:       ", rpcUrl);
  console.log("programId: ", programId.toBase58());
  console.log("configPda: ", configPda.toBase58());
  console.log("registryPda:", registryPda.toBase58());
  console.log();

  const cfg = await program.account.programConfig.fetchNullable(configPda);
  if (!cfg) {
    console.log("ProgramConfig: NOT INITIALIZED");
  } else {
    console.log("ProgramConfig:");
    console.log("  version    =", cfg.version);
    console.log("  admin      =", cfg.admin.toBase58());
    console.log("  treasury   =", cfg.treasury.toBase58());
    console.log("  lp_manager =", cfg.lpManager.toBase58());
    console.log("  paused     =", cfg.paused);
  }
  console.log();

  const reg = await program.account.gatewayRegistry.fetchNullable(registryPda);
  if (!reg) {
    console.log("GatewayRegistry: NOT INITIALIZED");
  } else {
    const keys = (reg.keys as PublicKey[])
      .slice(0, reg.keyCount)
      .map((k) => k.toBase58());
    console.log("GatewayRegistry:");
    console.log("  version =", reg.version);
    console.log("  admin   =", reg.admin.toBase58());
    console.log("  keys    =", keys);
  }
}

main().catch((err) => {
  console.error("inspect failed:", err);
  process.exit(1);
});

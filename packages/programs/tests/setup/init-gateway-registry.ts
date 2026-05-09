import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HookedRooms } from "../../target/types/hooked_rooms.js";
import roomsIdl from "../../target/idl/hooked_rooms.json" with { type: "json" };

function loadLocalKeypair(): Keypair {
  const raw = fs.readFileSync(
    path.join(os.homedir(), ".config/solana/id.json"),
    "utf8",
  );
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
}

async function main() {
  const rpcUrl =
    process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
  const admin = loadLocalKeypair();
  const connection = new Connection(rpcUrl, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(admin), {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = new Program<HookedRooms>(roomsIdl as HookedRooms, provider);

  const [registry] = PublicKey.findProgramAddressSync(
    [Buffer.from("gateway_registry")],
    program.programId,
  );

  const existing = await connection.getAccountInfo(registry);
  const initialKeeper = new PublicKey(
    process.env.INITIAL_KEEPER ?? admin.publicKey.toBase58(),
  );

  if (existing) {
    console.log(`Registry already exists at ${registry.toBase58()}`);
    const acct = await program.account.gatewayRegistry.fetch(registry);
    const keys = (acct.keys as PublicKey[])
      .slice(0, acct.keyCount as number)
      .map((k) => k.toBase58());
    console.log(`admin: ${(acct.admin as PublicKey).toBase58()}`);
    console.log(`keys (${acct.keyCount}): ${JSON.stringify(keys)}`);
    if (!keys.includes(initialKeeper.toBase58())) {
      console.log(`Adding ${initialKeeper.toBase58()} via add_gateway_key...`);
      const sig = await program.methods
        .addGatewayKey(initialKeeper)
        .accounts({
          registry,
          admin: admin.publicKey,
        } as never)
        .rpc();
      console.log(`ok: ${sig}`);
    }
    return;
  }

  console.log(`Initializing registry at ${registry.toBase58()}`);
  console.log(`admin = ${admin.publicKey.toBase58()}`);
  console.log(`initial keeper = ${initialKeeper.toBase58()}`);

  const sig = await program.methods
    .initGatewayRegistry(initialKeeper)
    .accounts({
      registry,
      admin: admin.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    } as never)
    .rpc();

  console.log(`init_gateway_registry → ${sig}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

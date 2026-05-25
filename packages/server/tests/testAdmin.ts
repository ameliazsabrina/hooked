import { Keypair } from "@solana/web3.js";

const TEST_ADMIN_SEED = new Uint8Array(32).fill(7);

export const TEST_ADMIN_KEYPAIR = Keypair.fromSeed(TEST_ADMIN_SEED);
export const TEST_ADMIN_PUBKEY = TEST_ADMIN_KEYPAIR.publicKey.toBase58();

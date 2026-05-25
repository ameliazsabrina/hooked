import { Keypair } from "@solana/web3.js";

process.env.MONGODB_URI ??= "mongodb://localhost:27017/hooked_test";
process.env.APP_ENV ??= "development";
process.env.ER_WEBHOOK_SECRET ??= "test-secret";
process.env.FISHING_DAILY_SEED_HEX ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const testAdminPubkey = Keypair.fromSeed(new Uint8Array(32).fill(7))
  .publicKey.toBase58();
process.env.ADMIN_WALLETS ??= testAdminPubkey;

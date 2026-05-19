import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import { env } from "../config/env.js";

/** Accepts JSON byte array or base58 64-byte secret key. */
export function parseKeypair(raw: string): Keypair | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const bytes = JSON.parse(trimmed) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(bytes));
    } catch {
      return null;
    }
  }
  try {
    const bytes = bs58.decode(trimmed);
    if (bytes.length !== 64) return null;
    return Keypair.fromSecretKey(bytes);
  } catch {
    return null;
  }
}

let cachedKeeper: Keypair | null | undefined;
let cachedAdmin: Keypair | null | undefined;

/** Wallet must be in the on-chain GatewayRegistry. */
export function loadKeeperKeypair(): Keypair | null {
  if (cachedKeeper !== undefined) return cachedKeeper;
  if (!env.KEEPER_KEYPAIR) {
    cachedKeeper = null;
    return null;
  }
  const kp = parseKeypair(env.KEEPER_KEYPAIR);
  if (!kp) console.error("[keypairs] Invalid KEEPER_KEYPAIR");
  cachedKeeper = kp;
  return kp;
}

export function loadAdminKeypair(): Keypair | null {
  if (cachedAdmin !== undefined) return cachedAdmin;
  if (!env.ADMIN_KEYPAIR) {
    cachedAdmin = null;
    return null;
  }
  const kp = parseKeypair(env.ADMIN_KEYPAIR);
  if (!kp) console.error("[keypairs] Invalid ADMIN_KEYPAIR");
  cachedAdmin = kp;
  return kp;
}

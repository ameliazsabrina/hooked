import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import { env } from "../config/env.js";

/**
 * Parse a wallet keypair from either of the two formats Solana tooling emits:
 *   - JSON byte array (e.g. `[12, 34, ...]` from `solana-keygen new --outfile`)
 *   - base58 64-byte secret key
 * Returns null on any decode failure.
 */
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

/**
 * Keeper keypair — signs the score-bridge tx that posts session scores to
 * `hooked_rooms.update_room_entry_score` and the bounty payout tx. The wallet
 * must be in the on-chain `GatewayRegistry` for the bridge to succeed.
 */
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

/**
 * Admin keypair — currently unused after the on-chain `set_event` admin
 * route was retired (Phase 6). Retained as a loader so admin-signed flows
 * we add later (e.g. emergency room close) don't have to re-implement the
 * env decoding path.
 */
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

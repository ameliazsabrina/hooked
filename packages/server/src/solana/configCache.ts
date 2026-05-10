import {
  getProgramConfigPda,
  getRoomsProgram,
  loadAdminKeypair,
} from "./roomsProgram.js";

/**
 * Tiny TTL cache around `ProgramConfig`. Used by keeper/lifecycle services
 * to skip work when the program is paused, without hammering the RPC.
 *
 * 5-second TTL is the smallest window that meaningfully reduces RPC load
 * (a busy keeper fires multiple times per slot) while still letting an
 * emergency `set_paused(true)` propagate within seconds.
 *
 * The cache is module-global on purpose: every service should observe the
 * same paused state in any given window, so a single shared cache also
 * doubles as a coherence guarantee.
 */
type CachedConfig = {
  paused: boolean;
  admin: string;
  treasury: string;
  lpManager: string;
  version: number;
};

let cached: CachedConfig | null = null;
let cachedAt = 0;
const TTL_MS = 5_000;

/**
 * Force the next call to refetch. Use after sending a `set_paused` tx so
 * the next preflight sees the new state without waiting for TTL.
 */
export function invalidateConfigCache(): void {
  cached = null;
  cachedAt = 0;
}

/**
 * Returns the current ProgramConfig snapshot, fetching at most once per
 * TTL_MS. Returns null if the program signer is not available (no
 * ADMIN_KEYPAIR / TREASURY_KEYPAIR set) — in that case there's no useful
 * preflight to do anyway, since the caller can't sign.
 *
 * Read-only: never mutates on-chain state. Safe to call before each ix.
 */
export async function getProgramConfigCached(): Promise<CachedConfig | null> {
  const now = Date.now();
  if (cached && now - cachedAt < TTL_MS) return cached;

  // Anchor's Program needs a wallet; we never sign here, so any keypair
  // works. Prefer ADMIN since it's the role most likely to be wired up
  // in environments where this code runs.
  const signer = loadAdminKeypair();
  const loaded = signer ? getRoomsProgram(signer) : getRoomsProgram();
  if (!loaded) return null;

  const acct = await loaded.program.account.programConfig.fetchNullable(
    getProgramConfigPda(),
  );
  if (!acct) {
    // Config isn't initialized yet — treat as "not paused" so the caller
    // doesn't block on a missing account. Other ix will fail with a clear
    // error if they actually need config.
    return null;
  }

  cached = {
    paused: acct.paused,
    admin: acct.admin.toBase58(),
    treasury: acct.treasury.toBase58(),
    lpManager: acct.lpManager.toBase58(),
    version: acct.version,
  };
  cachedAt = now;
  return cached;
}

/**
 * Convenience: returns true if the program is currently paused.
 * Returns false on cache miss / config-not-initialized — i.e. fail-open
 * for read paths, fail-closed (via on-chain enforcement) for writes.
 */
export async function isProgramPaused(): Promise<boolean> {
  const cfg = await getProgramConfigCached();
  return cfg?.paused === true;
}

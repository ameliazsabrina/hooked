import {
  getProgramConfigPda,
  getRoomsProgram,
  loadAdminKeypair,
} from "./roomsProgram.js";

// 5s TTL: lets emergency `set_paused(true)` propagate quickly while
// absorbing busy-keeper RPC traffic. Module-global for coherence.
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

export function invalidateConfigCache(): void {
  cached = null;
  cachedAt = 0;
}

/** Null when no signer is configured — caller can't sign anyway. */
export async function getProgramConfigCached(): Promise<CachedConfig | null> {
  const now = Date.now();
  if (cached && now - cachedAt < TTL_MS) return cached;

  // Anchor needs a wallet; we never sign here. ADMIN is the most-wired role.
  const signer = loadAdminKeypair();
  const loaded = signer ? getRoomsProgram(signer) : getRoomsProgram();
  if (!loaded) return null;

  const acct = await loaded.program.account.programConfig.fetchNullable(
    getProgramConfigPda(),
  );
  if (!acct) {
    // Uninitialized config reads as "not paused" — other ix will fail clearly.
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

/** Fail-open on cache miss; writes still fail-closed via on-chain enforcement. */
export async function isProgramPaused(): Promise<boolean> {
  const cfg = await getProgramConfigCached();
  return cfg?.paused === true;
}

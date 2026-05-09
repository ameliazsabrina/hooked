import type Redis from "ioredis";

const CLAIM_TTL_SEC = 5 * 60;

function key(wallet: string, date: number, window: number): string {
  return `bait-issue:${wallet}:${date}:${window}`;
}

/**
 * Reserve the bait-issuance step for a given (wallet, date, window). Returns
 * true if this caller won the claim and should proceed; false if another
 * path (recoverEntry, retryBaitIssue, or sessionLifecycle) already owns it.
 *
 * The on-chain `issue_bait` uses checked_add, so without a claim two paths
 * racing to service the same player can double-credit the bait counter
 * (e.g. 10 → 20) even though both see the session as "not yet initialized"
 * when they check in parallel.
 */
export async function claimBaitIssuance(
  redis: Redis,
  wallet: string,
  date: number,
  window: number,
): Promise<boolean> {
  const result = await redis.set(
    key(wallet, date, window),
    "1",
    "EX",
    CLAIM_TTL_SEC,
    "NX",
  );
  return result === "OK";
}

/**
 * Release a claim on failure so another path can retry. Only call this when
 * the claim holder confirmed no on-chain bait was actually issued.
 */
export async function releaseBaitIssuance(
  redis: Redis,
  wallet: string,
  date: number,
  window: number,
): Promise<void> {
  await redis.del(key(wallet, date, window));
}

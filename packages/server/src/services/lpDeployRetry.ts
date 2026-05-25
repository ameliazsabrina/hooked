/**
 * Failure classification + retry policy for the LP deploy/exit keeper.
 *
 * Background: a single failure used to set lp.status="failed" forever, and the
 * keeper only re-selected "pending" rooms — so one transient RPC blip stranded
 * a room for its whole window. This module decides, from an error message and
 * attempt count, whether a failure is worth retrying and what status to persist.
 */

export type DeployErrorKind = "transient" | "terminal";

/**
 * Substrings that mark an error as TERMINAL — re-running with the same inputs
 * will fail the same way, so don't waste attempts; fail fast to permanent.
 */
const TERMINAL_SIGNATURES: readonly string[] = [
  "insufficient funds", // wallet/vault can't cover the transfer (bad sizing)
  "insufficient lamports",
  "lpdeploywindownotopen", // on-chain window guard
  "lpalreadydeployed",
  "lpamountexceedsdeposited",
  "lpmanagermismatch",
  "unauthorized",
  "invalid public key",
  "could not resolve", // Jupiter LUT not resolvable — config/route issue
  "is not a valid meteora strategytype",
  "account not found", // missing config/pool — not self-healing
  "0x1771", // DLMM slippage exceeded (deterministic for given params)
  "refusing to open", // double-deploy guard tripped — needs manual reconcile
];

/**
 * Substrings that mark an error as clearly TRANSIENT — safe to retry with a
 * fresh blockhash/state on the next tick.
 */
const TRANSIENT_SIGNATURES: readonly string[] = [
  "blockhash not found",
  "block height exceeded",
  "transactionexpired",
  "node is behind",
  "timed out",
  "timeout",
  "etimedout",
  "econnreset",
  "econnrefused",
  "enotfound",
  "socket hang up",
  "fetch failed",
  "rate limit",
  "429",
  "502",
  "503",
  "504",
  "service unavailable",
  "too many requests",
  "unable to confirm",
];

/**
 * Classify a deploy/exit error. Unknown errors default to TRANSIENT so a room
 * gets a few bounded retries rather than being stranded on the first blip — the
 * attempt cap (see shouldAttemptDeploy) limits the blast radius either way.
 */
export function classifyDeployError(message: string): DeployErrorKind {
  const m = message.toLowerCase();
  for (const sig of TERMINAL_SIGNATURES) {
    if (m.includes(sig)) return "terminal";
  }
  for (const sig of TRANSIENT_SIGNATURES) {
    if (m.includes(sig)) return "transient";
  }
  return "transient";
}

/**
 * Status to persist after a failed attempt.
 * - terminal error → "failed_permanent" (alert, never auto-retried)
 * - attempts exhausted → "failed_permanent"
 * - otherwise → "failed" (eligible for the next tick's retry)
 */
export function nextStatusOnFailure(opts: {
  message: string;
  attempts: number;
  maxAttempts: number;
}): "failed" | "failed_permanent" {
  const kind = classifyDeployError(opts.message);
  if (kind === "terminal") return "failed_permanent";
  if (opts.attempts >= opts.maxAttempts) return "failed_permanent";
  return "failed";
}

/**
 * Whether a room is eligible for a (re)deploy attempt this tick. "pending" is
 * the first attempt; "failed" is a transient retry still under the cap.
 * "failed_permanent", "deployed", "exited", "skipped" are never picked up here.
 */
export function shouldAttemptDeploy(opts: {
  status: string;
  attempts: number;
  maxAttempts: number;
}): boolean {
  if (opts.attempts >= opts.maxAttempts) return false;
  return opts.status === "pending" || opts.status === "failed";
}

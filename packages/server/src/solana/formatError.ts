/**
 * Format a Solana / Anchor error into a single multi-line string with
 * enough context to actually triage from logs alone.
 *
 * Anchor's `AnchorError`, web3.js's `SendTransactionError`, and the
 * various TransactionExpired* errors all hide useful fields behind
 * `.logs`, `.programLogs`, `.transactionMessage`, `.error.errorCode`,
 * etc. Calling `(err as Error).message` only surfaces the top-line —
 * which is how we ended up with the 2026-05-18 watchdog log saying
 * "Simulation failed." with no further detail and a tick-every-15-min
 * mystery to debug.
 *
 * This helper walks the known fields and assembles a flat string. Cheap,
 * defensive, never throws, never assumes structure beyond `typeof` checks
 * so a future @solana/web3.js or @coral-xyz/anchor minor that renames a
 * field just falls back to the next slot.
 *
 * Output shape (each section optional, separator = newline):
 *
 *   <top-line message>
 *   programLogs: [Program ... invoke …, Program log: ..., ...]
 *   anchor: code=AccountNotInitialized (3012) "..."
 *   cause: <recursive format of err.cause>
 */
export function formatSolanaError(err: unknown): string {
  if (err === null || err === undefined) return "(no error)";

  const top =
    err instanceof Error
      ? err.message || err.name || String(err)
      : typeof err === "string"
        ? err
        : (() => {
            try {
              return JSON.stringify(err);
            } catch {
              return String(err);
            }
          })();

  const parts: string[] = [top];
  if (!(err instanceof Object)) return parts.join("\n");

  const e = err as Record<string, unknown> & { logs?: unknown };

  // 1. Program logs (SendTransactionError, Anchor's translated errors).
  //    Both store a `string[]` at `.logs`. Some versions also expose
  //    `.transactionLogs` or `.programLogs`. Pick the first array we
  //    find and cap at ~30 lines to avoid log explosions.
  const logCandidates: unknown[] = [
    e.logs,
    (e as { transactionLogs?: unknown }).transactionLogs,
    (e as { programLogs?: unknown }).programLogs,
  ];
  for (const cand of logCandidates) {
    if (Array.isArray(cand) && cand.length > 0) {
      const lines = (cand as unknown[]).slice(0, 30).map(String);
      const truncated = cand.length > 30 ? ` (+${cand.length - 30} more)` : "";
      parts.push(`programLogs:${truncated}\n  ${lines.join("\n  ")}`);
      break;
    }
  }

  // 2. Anchor error breakdown — `error: { errorCode: { code, number },
  //    errorMessage, origin? }`. AnchorError instances expose this; some
  //    error subclasses also stash `errorLogs`.
  const anchorErr = (e as { error?: unknown }).error;
  if (anchorErr && typeof anchorErr === "object") {
    const a = anchorErr as {
      errorCode?: { code?: string; number?: number };
      errorMessage?: string;
      origin?: string;
    };
    const code = a.errorCode?.code ?? "(no code)";
    const num = a.errorCode?.number ?? "(no number)";
    const msg = a.errorMessage ?? "";
    const origin = a.origin ? ` origin=${a.origin}` : "";
    parts.push(`anchor: code=${code} (${num})${origin} "${msg}"`);
  }

  // 3. `transactionMessage` from SendTransactionError — the human-readable
  //    pre-logs message (sometimes more specific than the top-line).
  const txMsg = (e as { transactionMessage?: unknown }).transactionMessage;
  if (typeof txMsg === "string" && txMsg && txMsg !== top) {
    parts.push(`transactionMessage: ${txMsg}`);
  }

  // 4. signature, if present (helps cross-reference against the explorer).
  const sig =
    (e as { signature?: unknown }).signature ??
    (e as { txid?: unknown }).txid;
  if (typeof sig === "string" && sig) {
    parts.push(`signature: ${sig}`);
  }

  // 5. cause chain — recurse once. AnchorError wraps the underlying
  //    SendTransactionError under .cause; without this the program logs
  //    only show up if the top-level was the send error itself.
  const cause = (e as { cause?: unknown }).cause;
  if (cause && cause !== err) {
    parts.push(`cause: ${formatSolanaError(cause)}`);
  }

  return parts.join("\n");
}

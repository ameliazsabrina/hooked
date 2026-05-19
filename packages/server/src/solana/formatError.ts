/**
 * Walks Solana/Anchor error fields (.logs, .error.errorCode,
 * .transactionMessage, .cause) into a flat triage-friendly string.
 * Cheap, defensive, never throws.
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

  // Pick the first available log array; cap at 30 lines.
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

  const txMsg = (e as { transactionMessage?: unknown }).transactionMessage;
  if (typeof txMsg === "string" && txMsg && txMsg !== top) {
    parts.push(`transactionMessage: ${txMsg}`);
  }

  const sig =
    (e as { signature?: unknown }).signature ??
    (e as { txid?: unknown }).txid;
  if (typeof sig === "string" && sig) {
    parts.push(`signature: ${sig}`);
  }

  // Recurse — AnchorError wraps SendTransactionError under .cause.
  const cause = (e as { cause?: unknown }).cause;
  if (cause && cause !== err) {
    parts.push(`cause: ${formatSolanaError(cause)}`);
  }

  return parts.join("\n");
}

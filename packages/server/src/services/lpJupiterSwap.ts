import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { env } from "../config/env.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

type JupiterQuote = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
};

type JupiterSwapResponse = {
  swapTransaction: string;
};

/** Add new kinds here so isRetryableKind stays a decision table. */
export type JupiterSwapErrorKind =
  | "http_rate_limit" //   429
  | "http_server_error" // 5xx
  | "http_bad_request" //  400/422 — typically unrecoverable (bad input / no route)
  | "http_not_found" //    404 — no route or bad mint pair
  | "http_other_4xx" //    other 4xx — fail fast
  | "network" //           fetch threw (ECONNRESET, ETIMEDOUT, abort, etc.)
  | "timeout" //           per-call timeout fired (AbortController)
  | "invalid_response" //  200 but body unparseable or missing fields
  | "send_failed" //       sendRawTransaction threw (RPC, blockhash, sim)
  | "confirm_failed" //    confirmTransaction returned err or threw
  | "invalid_input"; //    caller-side bug (e.g. zero amount). Never retried.

export class JupiterSwapError extends Error {
  public readonly kind: JupiterSwapErrorKind;
  public readonly retryable: boolean;
  public readonly httpStatus: number | undefined;
  public readonly attempt: number;
  public readonly body: string | undefined;

  /** Instance field (not Error.cause) for compat with pre-ES2022 consumers. */
  public readonly cause?: unknown;

  constructor(opts: {
    kind: JupiterSwapErrorKind;
    message: string;
    attempt: number;
    httpStatus?: number;
    body?: string;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "JupiterSwapError";
    this.kind = opts.kind;
    this.retryable = isRetryableKind(opts.kind);
    this.httpStatus = opts.httpStatus;
    this.attempt = opts.attempt;
    this.body = opts.body;
    this.cause = opts.cause;
  }
}

function isRetryableKind(kind: JupiterSwapErrorKind): boolean {
  switch (kind) {
    case "http_rate_limit":
    case "http_server_error":
    case "network":
    case "timeout":
      return true;
    case "http_bad_request":
    case "http_not_found":
    case "http_other_4xx":
    case "invalid_response":
    case "send_failed":
    case "confirm_failed":
    case "invalid_input":
      return false;
  }
}

function classifyHttpStatus(status: number): JupiterSwapErrorKind {
  if (status === 429) return "http_rate_limit";
  if (status >= 500) return "http_server_error";
  if (status === 400 || status === 422) return "http_bad_request";
  if (status === 404) return "http_not_found";
  return "http_other_4xx";
}

function classifyFetchError(err: unknown): JupiterSwapErrorKind {
  if (!(err instanceof Error)) return "network";
  const name = err.name?.toLowerCase() ?? "";
  if (name === "aborterror" || name === "timeouterror") return "timeout";
  const msg = (err.message ?? "").toLowerCase();
  // Walk cause chain without forcing ES2022 lib.
  const rawCause = (err as Error & { cause?: unknown }).cause;
  const causeMsg =
    rawCause instanceof Error ? (rawCause.message ?? "").toLowerCase() : "";
  const all = `${msg} ${causeMsg}`;
  if (all.includes("aborted") || all.includes("timed out")) return "timeout";
  if (
    all.includes("econnreset") ||
    all.includes("etimedout") ||
    all.includes("econnrefused") ||
    all.includes("enotfound") ||
    all.includes("socket hang up") ||
    all.includes("fetch failed") ||
    all.includes("network")
  )
    return "network";
  return "network";
}

/** Retries only JupiterSwapError with retryable=true; exponential backoff with jitter. */
async function withRetry<T>(
  op: (attempt: number) => Promise<T>,
): Promise<T> {
  const maxAttempts = env.LP_JUPITER_RETRY_ATTEMPTS;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await op(attempt);
    } catch (err) {
      lastErr = err;
      const retryable =
        err instanceof JupiterSwapError ? err.retryable : false;
      if (!retryable || attempt === maxAttempts) throw err;
      const base = Math.min(
        env.LP_JUPITER_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
        env.LP_JUPITER_RETRY_MAX_DELAY_MS,
      );
      const jitter =
        base * env.LP_JUPITER_RETRY_JITTER_PCT * (Math.random() * 2 - 1);
      const delay = Math.max(0, Math.round(base + jitter));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchQuote(opts: {
  inputMint: string;
  outputMint: string;
  amountLamports: bigint;
  slippageBps: number;
}): Promise<JupiterQuote> {
  return withRetry(async (attempt) => {
    const url = new URL(`${env.JUPITER_API_URL}/quote`);
    url.searchParams.set("inputMint", opts.inputMint);
    url.searchParams.set("outputMint", opts.outputMint);
    url.searchParams.set("amount", opts.amountLamports.toString());
    url.searchParams.set("slippageBps", String(opts.slippageBps));
    url.searchParams.set("onlyDirectRoutes", "false");

    let res: Response;
    try {
      res = await fetchWithTimeout(
        url,
        { method: "GET" },
        env.LP_JUPITER_TIMEOUT_MS,
      );
    } catch (err) {
      throw new JupiterSwapError({
        kind: classifyFetchError(err),
        message: `[lpJupiterSwap] quote fetch error (attempt ${attempt}): ${(err as Error).message}`,
        attempt,
        cause: err,
      });
    }

    if (!res.ok) {
      const body = (await res.text().catch(() => "")) ?? "";
      throw new JupiterSwapError({
        kind: classifyHttpStatus(res.status),
        message: `[lpJupiterSwap] quote failed (attempt ${attempt}, ${res.status}): ${body.slice(0, 200)}`,
        attempt,
        httpStatus: res.status,
        body,
      });
    }

    let parsed: JupiterQuote;
    try {
      parsed = (await res.json()) as JupiterQuote;
    } catch (err) {
      throw new JupiterSwapError({
        kind: "invalid_response",
        message: `[lpJupiterSwap] quote body unparseable: ${(err as Error).message}`,
        attempt,
        cause: err,
      });
    }
    if (!parsed.outAmount || !parsed.otherAmountThreshold) {
      throw new JupiterSwapError({
        kind: "invalid_response",
        message: `[lpJupiterSwap] quote missing outAmount/otherAmountThreshold`,
        attempt,
      });
    }
    return parsed;
  });
}

async function fetchSwapTx(opts: {
  quote: JupiterQuote;
  userPublicKey: PublicKey;
}): Promise<VersionedTransaction> {
  return withRetry(async (attempt) => {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${env.JUPITER_API_URL}/swap`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            quoteResponse: opts.quote,
            userPublicKey: opts.userPublicKey.toBase58(),
            wrapAndUnwrapSol: true,
            asLegacyTransaction: false,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: "auto",
          }),
        },
        env.LP_JUPITER_TIMEOUT_MS,
      );
    } catch (err) {
      throw new JupiterSwapError({
        kind: classifyFetchError(err),
        message: `[lpJupiterSwap] swap build fetch error (attempt ${attempt}): ${(err as Error).message}`,
        attempt,
        cause: err,
      });
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => "")) ?? "";
      throw new JupiterSwapError({
        kind: classifyHttpStatus(res.status),
        message: `[lpJupiterSwap] swap build failed (attempt ${attempt}, ${res.status}): ${body.slice(0, 200)}`,
        attempt,
        httpStatus: res.status,
        body,
      });
    }
    let json: JupiterSwapResponse;
    try {
      json = (await res.json()) as JupiterSwapResponse;
    } catch (err) {
      throw new JupiterSwapError({
        kind: "invalid_response",
        message: `[lpJupiterSwap] swap body unparseable: ${(err as Error).message}`,
        attempt,
        cause: err,
      });
    }
    if (!json.swapTransaction) {
      throw new JupiterSwapError({
        kind: "invalid_response",
        message: `[lpJupiterSwap] swap body missing swapTransaction`,
        attempt,
      });
    }
    const buf = Buffer.from(json.swapTransaction, "base64");
    return VersionedTransaction.deserialize(buf);
  });
}

export type SwapResult = {
  signature: string;
  inLamports: bigint;
  outLamports: bigint;
  slippageLamports: bigint;
};

async function executeSwap(opts: {
  connection: Connection;
  signer: Keypair;
  inputMint: string;
  outputMint: string;
  amountLamports: bigint;
  slippageBps: number;
}): Promise<SwapResult> {
  if (opts.amountLamports <= 0n) {
    throw new JupiterSwapError({
      kind: "invalid_input",
      message: "[lpJupiterSwap] amount must be positive",
      attempt: 0,
    });
  }
  const quote = await fetchQuote({
    inputMint: opts.inputMint,
    outputMint: opts.outputMint,
    amountLamports: opts.amountLamports,
    slippageBps: opts.slippageBps,
  });
  const expectedOut = BigInt(quote.outAmount);
  const minOut = BigInt(quote.otherAmountThreshold);

  const tx = await fetchSwapTx({
    quote,
    userPublicKey: opts.signer.publicKey,
  });
  tx.sign([opts.signer]);

  // Single-attempt: re-sending after a signature is issued risks double-spend.
  // Callers retry only `send_failed` (no signature returned).
  let signature: string;
  try {
    signature = await opts.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
  } catch (err) {
    throw new JupiterSwapError({
      kind: "send_failed",
      message: `[lpJupiterSwap] sendRawTransaction failed: ${(err as Error).message}`,
      attempt: 1,
      cause: err,
    });
  }

  try {
    const conf = await opts.connection.confirmTransaction(
      signature,
      "confirmed",
    );
    if (
      conf &&
      typeof conf === "object" &&
      "value" in conf &&
      conf.value &&
      typeof conf.value === "object" &&
      "err" in conf.value &&
      conf.value.err
    ) {
      throw new JupiterSwapError({
        kind: "confirm_failed",
        message: `[lpJupiterSwap] tx ${signature} confirmed with err: ${JSON.stringify(conf.value.err)}`,
        attempt: 1,
        cause: conf.value.err,
      });
    }
  } catch (err) {
    if (err instanceof JupiterSwapError) throw err;
    throw new JupiterSwapError({
      kind: "confirm_failed",
      message: `[lpJupiterSwap] confirmTransaction failed for ${signature}: ${(err as Error).message}`,
      attempt: 1,
      cause: err,
    });
  }

  return {
    signature,
    inLamports: opts.amountLamports,
    outLamports: expectedOut,
    slippageLamports: expectedOut - minOut,
  };
}

/** Swap native SOL → USDC. */
export function swapSolToUsdc(opts: {
  connection: Connection;
  signer: Keypair;
  amountLamports: bigint;
  slippageBps?: number;
}): Promise<SwapResult> {
  return executeSwap({
    ...opts,
    inputMint: SOL_MINT,
    outputMint: env.USDC_MINT_ADDRESS,
    slippageBps: opts.slippageBps ?? env.LP_SWAP_SLIPPAGE_BPS,
  });
}

/** Swap USDC → native SOL. amountLamports here is USDC base units (6 decimals). */
export function swapUsdcToSol(opts: {
  connection: Connection;
  signer: Keypair;
  amountLamports: bigint;
  slippageBps?: number;
}): Promise<SwapResult> {
  return executeSwap({
    ...opts,
    inputMint: env.USDC_MINT_ADDRESS,
    outputMint: SOL_MINT,
    slippageBps: opts.slippageBps ?? env.LP_SWAP_SLIPPAGE_BPS,
  });
}

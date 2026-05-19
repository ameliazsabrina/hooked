import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { env } from "../config/env.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

type JupiterIx = {
  programId: string;
  accounts: Array<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
  data: string; // base64
};

export type JupiterBuildResponse = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string;
  computeBudgetInstructions?: JupiterIx[];
  setupInstructions?: JupiterIx[];
  swapInstruction: JupiterIx;
  cleanupInstruction?: JupiterIx | null;
  otherInstructions?: JupiterIx[];
  addressesByLookupTableAddress?: Record<string, string[]>;
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

function jupiterHeaders(): Record<string, string> {
  const h: Record<string, string> = { accept: "application/json" };
  if (env.JUPITER_API_KEY) h["x-api-key"] = env.JUPITER_API_KEY;
  return h;
}

// v2 ExactIn quote-and-build in one call. Replaces v6's /quote + /swap.
// `taker` is the v2 rename of v6's `userPublicKey`.
async function fetchSwapBuild(opts: {
  inputMint: string;
  outputMint: string;
  amountLamports: bigint;
  slippageBps: number;
  taker: PublicKey;
}): Promise<JupiterBuildResponse> {
  return withRetry(async (attempt) => {
    const url = new URL(`${env.JUPITER_API_URL}/build`);
    url.searchParams.set("inputMint", opts.inputMint);
    url.searchParams.set("outputMint", opts.outputMint);
    url.searchParams.set("amount", opts.amountLamports.toString());
    url.searchParams.set("slippageBps", String(opts.slippageBps));
    url.searchParams.set("taker", opts.taker.toBase58());
    if (env.JUPITER_EXCLUDE_DEXES.trim().length > 0) {
      url.searchParams.set("excludeDexes", env.JUPITER_EXCLUDE_DEXES);
    }
    if (env.JUPITER_DEXES.trim().length > 0) {
      url.searchParams.set("dexes", env.JUPITER_DEXES);
    }

    let res: Response;
    try {
      res = await fetchWithTimeout(
        url,
        { method: "GET", headers: jupiterHeaders() },
        env.LP_JUPITER_TIMEOUT_MS,
      );
    } catch (err) {
      throw new JupiterSwapError({
        kind: classifyFetchError(err),
        message: `[lpJupiterSwap] build fetch error (attempt ${attempt}): ${(err as Error).message}`,
        attempt,
        cause: err,
      });
    }

    if (!res.ok) {
      const body = (await res.text().catch(() => "")) ?? "";
      throw new JupiterSwapError({
        kind: classifyHttpStatus(res.status),
        message: `[lpJupiterSwap] build failed (attempt ${attempt}, ${res.status}): ${body.slice(0, 200)}`,
        attempt,
        httpStatus: res.status,
        body,
      });
    }

    let parsed: JupiterBuildResponse;
    try {
      parsed = (await res.json()) as JupiterBuildResponse;
    } catch (err) {
      throw new JupiterSwapError({
        kind: "invalid_response",
        message: `[lpJupiterSwap] build body unparseable: ${(err as Error).message}`,
        attempt,
        cause: err,
      });
    }
    if (
      !parsed.swapInstruction ||
      !parsed.outAmount ||
      !parsed.otherAmountThreshold
    ) {
      throw new JupiterSwapError({
        kind: "invalid_response",
        message: `[lpJupiterSwap] build missing swapInstruction/outAmount/otherAmountThreshold`,
        attempt,
      });
    }
    return parsed;
  });
}

function toTransactionInstruction(ix: JupiterIx): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, "base64"),
  });
}

async function fetchLookupTables(
  connection: Connection,
  addrs: string[],
): Promise<AddressLookupTableAccount[]> {
  if (addrs.length === 0) return [];
  const results = await Promise.all(
    addrs.map(async (a) => {
      const r = await connection.getAddressLookupTable(new PublicKey(a));
      return { addr: a, lut: r.value };
    }),
  );
  // If Jupiter said we need a LUT and the chain can't return it, fail
  // loudly — silently inlining the keys produces a >1232-byte tx that
  // gets rejected at simulation with a less-obvious error. Surfpool
  // forks frequently can't resolve LUTs created post-snapshot.
  const missing = results.filter((r) => !r.lut).map((r) => r.addr);
  if (missing.length > 0) {
    throw new JupiterSwapError({
      kind: "invalid_response",
      message:
        `[lpJupiterSwap] could not resolve ${missing.length} address lookup ` +
        `table(s) from chain: ${missing.join(", ")}. On a surfpool fork this ` +
        `usually means the LUT account didn't lazy-clone. Constrain Jupiter ` +
        `via JUPITER_DEXES to AMMs that don't need LUTs (e.g. "Raydium"), ` +
        `or run the e2e against mainnet directly.`,
      attempt: 1,
    });
  }
  return results.map((r) => r.lut as AddressLookupTableAccount);
}

async function assembleSwapTransaction(opts: {
  connection: Connection;
  payer: PublicKey;
  build: JupiterBuildResponse;
}): Promise<VersionedTransaction> {
  const { build, connection, payer } = opts;
  const instructions: TransactionInstruction[] = [
    ...(build.computeBudgetInstructions ?? []),
    ...(build.setupInstructions ?? []),
    build.swapInstruction,
    ...(build.cleanupInstruction ? [build.cleanupInstruction] : []),
    ...(build.otherInstructions ?? []),
  ].map(toTransactionInstruction);

  const lutAddrs = Object.keys(build.addressesByLookupTableAddress ?? {});
  const luts = await fetchLookupTables(connection, lutAddrs);

  // Fetch a fresh blockhash rather than trusting build's — by the time we
  // sign and send, the API-supplied one may already be stale.
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(luts);

  return new VersionedTransaction(msg);
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
  const build = await fetchSwapBuild({
    inputMint: opts.inputMint,
    outputMint: opts.outputMint,
    amountLamports: opts.amountLamports,
    slippageBps: opts.slippageBps,
    taker: opts.signer.publicKey,
  });
  const expectedOut = BigInt(build.outAmount);
  const minOut = BigInt(build.otherAmountThreshold);

  const tx = await assembleSwapTransaction({
    connection: opts.connection,
    payer: opts.signer.publicKey,
    build,
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

/**
 * Test-only exports. Not part of the service's public surface — consumed
 * by the cassette test in `tests/integration/jupiterSwapAssembly.test.ts`
 * to replay real captured /build responses through the assembly path.
 */
export const __testing = {
  toTransactionInstruction,
  fetchLookupTables,
  assembleSwapTransaction,
};

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

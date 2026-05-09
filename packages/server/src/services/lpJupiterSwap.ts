import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { env } from "../config/env.js";

// Native SOL mint placeholder used by Jupiter for SOL swaps.
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

async function fetchQuote(opts: {
  inputMint: string;
  outputMint: string;
  amountLamports: bigint;
  slippageBps: number;
}): Promise<JupiterQuote> {
  const url = new URL(`${env.JUPITER_API_URL}/quote`);
  url.searchParams.set("inputMint", opts.inputMint);
  url.searchParams.set("outputMint", opts.outputMint);
  url.searchParams.set("amount", opts.amountLamports.toString());
  url.searchParams.set("slippageBps", String(opts.slippageBps));
  url.searchParams.set("onlyDirectRoutes", "false");

  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    throw new Error(
      `[lpJupiterSwap] quote failed (${res.status}): ${await res.text()}`,
    );
  }
  return (await res.json()) as JupiterQuote;
}

async function fetchSwapTx(opts: {
  quote: JupiterQuote;
  userPublicKey: PublicKey;
}): Promise<VersionedTransaction> {
  const res = await fetch(`${env.JUPITER_API_URL}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: opts.quote,
      userPublicKey: opts.userPublicKey.toBase58(),
      wrapAndUnwrapSol: true,
      // Avoid auto-creating ATAs in the swap tx — caller can control.
      asLegacyTransaction: false,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  if (!res.ok) {
    throw new Error(
      `[lpJupiterSwap] swap build failed (${res.status}): ${await res.text()}`,
    );
  }
  const json = (await res.json()) as JupiterSwapResponse;
  const buf = Buffer.from(json.swapTransaction, "base64");
  return VersionedTransaction.deserialize(buf);
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
    throw new Error("[lpJupiterSwap] amount must be positive");
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

  const signature = await opts.connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await opts.connection.confirmTransaction(signature, "confirmed");

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

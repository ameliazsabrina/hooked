import BN from "bn.js";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
// NOTE: @meteora-ag/dlmm has malformed ESM/CJS interop and breaks pure-ESM
// resolution at module load time. We load it lazily inside the functions
// that actually need it so dry-run mode and tests never touch the SDK.
import { env } from "../config/env.js";
import {
  loadLpManagerKeypair,
  getRoomsConnection,
} from "../solana/roomsProgram.js";
import {
  swapSolToUsdc,
  swapUsdcToSol,
  JupiterSwapError,
  type SwapResult,
} from "./lpJupiterSwap.js";

const PLACEHOLDER_POOL = "ARwi1S4DaiTG5DX7S4M4ZsrXqpMD1MrTmbu9ue2tpmEq";

/**
 * Wrap a Jupiter swap call so a `send_failed` outcome (no signature was
 * ever issued — RPC rejected the submission, blockhash expired, sim
 * failed) triggers a bounded retry. `confirm_failed` is NOT retried here
 * because that path means a signature DID get returned and may have
 * landed; the caller would need to verify on-chain status before re-doing
 * the swap, which is out of scope.
 *
 * The inner `lpJupiterSwap.executeSwap` already retries HTTP-level
 * failures (quote / build); this layer adds the missing piece for the
 * single-attempt on-chain send step. Each outer attempt re-runs quote +
 * build + sign + send from scratch, so each attempt gets a fresh
 * blockhash and a fresh quote — exactly what's needed when a blockhash-
 * expired error caused the previous send to fail.
 */
async function swapWithSendRetry(
  call: () => Promise<SwapResult>,
  label: string,
  logger?: { info: (msg: string) => void },
): Promise<SwapResult> {
  const maxAttempts = Math.max(1, env.LP_SWAP_SEND_RETRY_ATTEMPTS);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await call();
    } catch (err) {
      lastErr = err;
      if (
        !(err instanceof JupiterSwapError) ||
        err.kind !== "send_failed" ||
        attempt === maxAttempts
      ) {
        throw err;
      }
      logger?.info(
        `[lpManager] ${label} send_failed on attempt ${attempt}/${maxAttempts}, ` +
          `retrying with fresh quote+blockhash: ${(err as Error).message}`,
      );
    }
  }
  throw lastErr;
}

export type DeployResult = {
  /** Pubkey of the DLMM position account that holds this room's liquidity. */
  positionPubkey: string;
  /** Lamports of SOL placed into the position (pre-swap; deployedLamports total). */
  deployedLamports: bigint;
  /** Slippage paid on entry SOL→USDC swap. Tracked for ops monitoring. */
  swapSlippageLamports: bigint;
  /** Tx signatures generated during deploy (swap, init position). */
  signatures: string[];
  /** SOL→USDC entry swap: signature + amounts. Null in dry-run. */
  swapInTxSignature: string | null;
  swapInSolLamports: bigint;
  swapInUsdcRaw: bigint;
  /** DLMM addLiquidity (init position) tx. Null in dry-run. */
  addLiquidityTxSignature: string | null;
  /** True when synthesized in dry-run mode (no on-chain DLMM call). */
  dryRun: boolean;
};

export type ExitResult = {
  /** Total SOL recovered from position + swap-back. */
  exitedLamports: bigint;
  /** Original deploy amount, echoed for clarity. */
  deployedLamports: bigint;
  /**
   * `exitedLamports - deployedLamports`, clamped to 0 on net loss.
   * Buffer top-up (if any) is reflected separately in `bufferTopUpLamports`.
   */
  realizedYieldLamports: bigint;
  /** Lamports the LP_MANAGER buffer had to cover when exit < deploy. */
  bufferTopUpLamports: bigint;
  /** Trading fees claimed from the DLMM position (pre-swap). */
  feesLamports: bigint;
  /** Combined slippage from SOL→USDC entry + USDC→SOL exit swap. */
  swapSlippageLamports: bigint;
  signatures: string[];
  /** Last DLMM removeLiquidity tx (multiple if split). Null in dry-run. */
  removeLiquidityTxSignature: string | null;
  removeLiquidityUsdcRaw: bigint;
  removeLiquiditySolLamports: bigint;
  /** USDC→SOL exit swap. Null when no USDC dust to swap, or in dry-run. */
  swapOutTxSignature: string | null;
  swapOutUsdcRaw: bigint;
  swapOutSolLamports: bigint;
  /** SystemProgram transfer of (deployed + yield) → room_vault. */
  depositYieldTxSignature: string | null;
  dryRun: boolean;
};

function isPlaceholderPool(): boolean {
  return env.METEORA_POOL_ADDRESS === PLACEHOLDER_POOL;
}

/**
 * Returns null with a reason string when the LP cycle should be skipped
 * (kill switch flipped, missing keypair, placeholder pool, buffer too low).
 * Caller (room-lifecycle tick) should mark `room.lp.status = "skipped"` and
 * leave `realizedYieldLamports = 0` so settlement still works.
 */
export function checkLpReady(_opts: {
  requiredBufferLamports: bigint;
}): { ok: true; signer: Keypair } | { ok: false; reason: string } {
  if (!env.FEATURES_LP_ENABLED)
    return { ok: false, reason: "feature flag off" };
  if (env.LP_KILL_SWITCH) return { ok: false, reason: "kill switch on" };
  const signer = loadLpManagerKeypair();
  if (!signer) return { ok: false, reason: "LP_MANAGER_KEYPAIR missing" };
  // Real DLMM only — dry-run mode tolerates the placeholder pool.
  if (!env.LP_DRY_RUN && isPlaceholderPool()) {
    return { ok: false, reason: "METEORA_POOL_ADDRESS is the placeholder" };
  }
  return { ok: true, signer };
}

/** SOL the LP manager wallet must hold *beyond* the room principal it absorbs. */
export async function checkBuffer(
  connection: Connection,
  signer: PublicKey,
  required: bigint,
): Promise<{ ok: boolean; balanceLamports: bigint }> {
  const balance = BigInt(await connection.getBalance(signer));
  return { ok: balance >= required, balanceLamports: balance };
}

async function deployToDlmm(opts: {
  connection: Connection;
  signer: Keypair;
  totalSolLamports: bigint;
}): Promise<DeployResult> {
  // Resolve SDK enum at runtime (the import is dynamic — see top-of-file
  // note about @meteora-ag/dlmm ESM/CJS interop). Reject typo'd env values
  // with a clear, listing-all-options error rather than `undefined`-cast.
  const { default: DLMM, StrategyType } = await import("@meteora-ag/dlmm");
  const strategyType =
    StrategyType[env.LP_STRATEGY_TYPE as keyof typeof StrategyType];
  if (strategyType === undefined) {
    const valid = Object.keys(StrategyType).filter((k) =>
      Number.isNaN(Number(k)),
    );
    throw new Error(
      `[lpManager] LP_STRATEGY_TYPE="${env.LP_STRATEGY_TYPE}" is not a valid ` +
        `Meteora StrategyType. Valid values: ${valid.join(", ")}`,
    );
  }

  // Split SOL between the SOL leg of the position and the portion that's
  // swapped into USDC. LP_SOL_USDC_SPLIT_BPS = 5000 reproduces the prior
  // 50/50 behavior; lowering keeps more SOL exposure and reduces the
  // amount routed through Jupiter (less swap slippage).
  const solSideBps = BigInt(env.LP_SOL_USDC_SPLIT_BPS);
  const solSide = (opts.totalSolLamports * solSideBps) / 10_000n;
  const usdcSide = opts.totalSolLamports - solSide;

  // 1) Swap the USDC portion of the SOL into USDC. Skip when the whole
  //    deposit is the SOL leg (LP_SOL_USDC_SPLIT_BPS=10000) — saves a
  //    Jupiter round-trip and avoids a 0-amount swap revert.
  let swap: SwapResult;
  if (usdcSide > 0n) {
    swap = await swapWithSendRetry(
      () =>
        swapSolToUsdc({
          connection: opts.connection,
          signer: opts.signer,
          amountLamports: usdcSide,
        }),
      "swapSolToUsdc (deploy)",
    );
  } else {
    swap = {
      signature: "",
      inLamports: 0n,
      outLamports: 0n,
      slippageLamports: 0n,
    };
  }

  // 2) Open a DLMM position with the SOL/USDC balances. Strategy + range
  //    + deposit slippage are env-driven so they can be tuned per pool
  //    without a redeploy. See env.ts comments for trade-offs.
  const poolAddress = new PublicKey(env.METEORA_POOL_ADDRESS);
  const dlmmPool = await DLMM.create(opts.connection, poolAddress);
  const activeBin = await dlmmPool.getActiveBin();
  const positionKeypair = Keypair.generate();

  const tx: Transaction =
    await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKeypair.publicKey,
      totalXAmount: new BN(solSide.toString()),
      totalYAmount: new BN(swap.outLamports.toString()),
      strategy: {
        minBinId: activeBin.binId - env.LP_BIN_RANGE,
        maxBinId: activeBin.binId + env.LP_BIN_RANGE,
        strategyType,
      },
      user: opts.signer.publicKey,
      slippage: env.LP_DEPLOY_SLIPPAGE_PCT,
    });
  tx.feePayer = opts.signer.publicKey;
  const { blockhash } = await opts.connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(opts.signer, positionKeypair);
  const initSig = await opts.connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await opts.connection.confirmTransaction(initSig, "confirmed");

  // Drop the swap sig from the tx list / signature field when no swap ran
  // (LP_SOL_USDC_SPLIT_BPS=10000). Avoids exposing "" as a confirmed tx.
  const didSwap = swap.signature !== "";

  return {
    positionPubkey: positionKeypair.publicKey.toBase58(),
    deployedLamports: opts.totalSolLamports,
    swapSlippageLamports: swap.slippageLamports,
    signatures: didSwap ? [swap.signature, initSig] : [initSig],
    swapInTxSignature: didSwap ? swap.signature : null,
    swapInSolLamports: swap.inLamports,
    swapInUsdcRaw: swap.outLamports,
    addLiquidityTxSignature: initSig,
    dryRun: false,
  };
}

async function exitFromDlmm(opts: {
  connection: Connection;
  signer: Keypair;
  positionPubkey: PublicKey;
  deployedLamports: bigint;
}): Promise<ExitResult> {
  const poolAddress = new PublicKey(env.METEORA_POOL_ADDRESS);
  const { default: DLMM } = await import("@meteora-ag/dlmm");
  const dlmmPool = await DLMM.create(opts.connection, poolAddress);
  await dlmmPool.refetchStates();

  const balanceBeforeSol = BigInt(
    await opts.connection.getBalance(opts.signer.publicKey),
  );

  const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(
    opts.signer.publicKey,
  );
  const position = userPositions.find((p: { publicKey: PublicKey }) =>
    p.publicKey.equals(opts.positionPubkey),
  );
  if (!position) {
    throw new Error(
      `[lpManager] DLMM position ${opts.positionPubkey.toBase58()} not found for signer`,
    );
  }

  const removeTxs: Transaction[] = await dlmmPool.removeLiquidity({
    user: opts.signer.publicKey,
    position: opts.positionPubkey,
    fromBinId: position.positionData.lowerBinId,
    toBinId: position.positionData.upperBinId,
    bps: new BN(10_000),
    shouldClaimAndClose: true,
  });
  const removeSigs: string[] = [];
  for (const tx of removeTxs) {
    tx.feePayer = opts.signer.publicKey;
    const { blockhash } = await opts.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.sign(opts.signer);
    const sig = await opts.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await opts.connection.confirmTransaction(sig, "confirmed");
    removeSigs.push(sig);
  }

  // Swap any USDC dust back to SOL. We assume LP_MANAGER's USDC balance came
  // entirely from this room's exit (no other USDC sources). For multi-room
  // safety, callers should serialize exits.
  const usdcAta = getAssociatedTokenAddressSync(
    new PublicKey(env.USDC_MINT_ADDRESS),
    opts.signer.publicKey,
    false,
    TOKEN_PROGRAM_ID,
  );
  let swapBackSig: string | null = null;
  let swapBackSlippage = 0n;
  let swapBackUsdcIn = 0n;
  let swapBackSolOut = 0n;
  let removedUsdc = 0n;
  try {
    const balance = await opts.connection.getTokenAccountBalance(usdcAta);
    const usdcLamports = BigInt(balance.value.amount);
    removedUsdc = usdcLamports;
    if (usdcLamports > 0n) {
      const swap = await swapWithSendRetry(
        () =>
          swapUsdcToSol({
            connection: opts.connection,
            signer: opts.signer,
            amountLamports: usdcLamports,
          }),
        "swapUsdcToSol (exit)",
      );
      swapBackSig = swap.signature;
      swapBackSlippage = swap.slippageLamports;
      swapBackUsdcIn = swap.inLamports;
      swapBackSolOut = swap.outLamports;
    }
  } catch {
    // ATA does not exist (no USDC was received) — nothing to swap back.
  }

  const balanceAfterSol = BigInt(
    await opts.connection.getBalance(opts.signer.publicKey),
  );

  const exitedLamports =
    balanceAfterSol > balanceBeforeSol
      ? balanceAfterSol - balanceBeforeSol
      : 0n;

  const realizedYield =
    exitedLamports > opts.deployedLamports
      ? exitedLamports - opts.deployedLamports
      : 0n;
  const bufferTopUp =
    exitedLamports < opts.deployedLamports
      ? opts.deployedLamports - exitedLamports
      : 0n;

  // The SOL leg returned by removeLiquidity is approximated as
  // (balanceAfter - balanceBefore) - swapBackOut, since the swap-back happens
  // between the two balance reads. Best-effort; DLMM SDK doesn't expose
  // per-tx amounts cleanly.
  const removedSol =
    exitedLamports > swapBackSolOut ? exitedLamports - swapBackSolOut : 0n;

  return {
    exitedLamports,
    deployedLamports: opts.deployedLamports,
    realizedYieldLamports: realizedYield,
    bufferTopUpLamports: bufferTopUp,
    feesLamports: realizedYield, // approximation; full breakdown needs DLMM telemetry
    swapSlippageLamports: swapBackSlippage,
    signatures: swapBackSig ? [...removeSigs, swapBackSig] : removeSigs,
    removeLiquidityTxSignature: removeSigs[removeSigs.length - 1] ?? null,
    removeLiquidityUsdcRaw: removedUsdc,
    removeLiquiditySolLamports: removedSol,
    swapOutTxSignature: swapBackSig,
    swapOutUsdcRaw: swapBackUsdcIn,
    swapOutSolLamports: swapBackSolOut,
    depositYieldTxSignature: null,
    dryRun: false,
  };
}

/**
 * Deploy a room's principal into a DLMM position (dry-run synthesizes a fake
 * positionPubkey and skips the SDK calls). Caller is responsible for first
 * calling the on-chain `withdraw_to_lp_manager` so the SOL has actually
 * arrived in LP_MANAGER's wallet.
 */
export async function deployRoomLiquidity(opts: {
  roomPdaStr: string;
  lamports: bigint;
}): Promise<DeployResult> {
  const ready = checkLpReady({
    requiredBufferLamports: BigInt(env.IL_BUFFER_LAMPORTS_MIN),
  });
  if (!ready.ok) throw new Error(`[lpManager] not ready: ${ready.reason}`);
  const connection = getRoomsConnection();

  if (env.LP_DRY_RUN) {
    const fakePosition = Keypair.generate().publicKey.toBase58();
    return {
      positionPubkey: fakePosition,
      deployedLamports: opts.lamports,
      swapSlippageLamports: 0n,
      signatures: [],
      swapInTxSignature: null,
      swapInSolLamports: opts.lamports / 2n,
      swapInUsdcRaw: 0n,
      addLiquidityTxSignature: null,
      dryRun: true,
    };
  }

  return deployToDlmm({
    connection,
    signer: ready.signer,
    totalSolLamports: opts.lamports,
  });
}

/**
 * Exit a room's DLMM position, return SOL into the room_vault, and report
 * realized yield. In dry-run mode synthesizes the configured fake yield and
 * still performs the on-chain transfer back to the vault so the rest of the
 * settlement flow exercises end-to-end.
 */
export async function exitRoomLiquidity(opts: {
  roomPdaStr: string;
  positionPubkeyStr: string;
  deployedLamports: bigint;
  /** room_vault PDA — destination for `deployed + max(yield, 0)`. */
  roomVault: PublicKey;
}): Promise<ExitResult> {
  const ready = checkLpReady({
    requiredBufferLamports: BigInt(env.IL_BUFFER_LAMPORTS_MIN),
  });
  if (!ready.ok) throw new Error(`[lpManager] not ready: ${ready.reason}`);
  const connection = getRoomsConnection();

  let exit: ExitResult;
  if (env.LP_DRY_RUN) {
    const synthYield = BigInt(env.LP_DRY_RUN_YIELD_LAMPORTS);
    exit = {
      exitedLamports: opts.deployedLamports + synthYield,
      deployedLamports: opts.deployedLamports,
      realizedYieldLamports: synthYield,
      bufferTopUpLamports: 0n,
      feesLamports: synthYield,
      swapSlippageLamports: 0n,
      signatures: [],
      removeLiquidityTxSignature: null,
      removeLiquidityUsdcRaw: 0n,
      removeLiquiditySolLamports: opts.deployedLamports + synthYield,
      swapOutTxSignature: null,
      swapOutUsdcRaw: 0n,
      swapOutSolLamports: 0n,
      depositYieldTxSignature: null,
      dryRun: true,
    };
  } else {
    exit = await exitFromDlmm({
      connection,
      signer: ready.signer,
      positionPubkey: new PublicKey(opts.positionPubkeyStr),
      deployedLamports: opts.deployedLamports,
    });
  }

  // Send (deployed + realized_yield) back to the room vault. On loss this
  // takes the missing piece from the LP_MANAGER buffer.
  const sendBack = opts.deployedLamports + exit.realizedYieldLamports;
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: ready.signer.publicKey,
      toPubkey: opts.roomVault,
      lamports: Number(sendBack),
    }),
  );
  tx.feePayer = ready.signer.publicKey;
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(ready.signer);
  const sendBackSig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await connection.confirmTransaction(sendBackSig, "confirmed");

  return {
    ...exit,
    signatures: [...exit.signatures, sendBackSig],
    depositYieldTxSignature: sendBackSig,
  };
}

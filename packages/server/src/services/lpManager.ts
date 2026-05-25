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
// @meteora-ag/dlmm has malformed ESM/CJS interop — import lazily inside
// functions so dry-run and tests never touch the SDK.
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
 * Retry only `send_failed` (no signature issued) — re-running quote+build+send
 * is safe. `confirm_failed` is NOT retried: tx may have landed.
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
  /** Clamped to 0 on net loss; deficit is in bufferTopUpLamports. */
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
 * Returns reason string when LP cycle should be skipped (kill switch,
 * missing keypair, placeholder pool, low buffer). Caller marks
 * `room.lp.status = "skipped"` with `realizedYieldLamports = 0`.
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

/** @internal — exported for the surfpool e2e test only. App code should use `deployRoomLiquidity`. */
export async function deployToDlmm(opts: {
  connection: Connection;
  signer: Keypair;
  totalSolLamports: bigint;
}): Promise<DeployResult> {
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

  const solSideBps = BigInt(env.LP_SOL_USDC_SPLIT_BPS);
  const solSide = (opts.totalSolLamports * solSideBps) / 10_000n;
  const usdcSide = opts.totalSolLamports - solSide;

  // Skip when all SOL (SPLIT_BPS=10000) — avoids 0-amount swap revert.
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

  const poolAddress = new PublicKey(env.METEORA_POOL_ADDRESS);
  const dlmmPool = await DLMM.create(opts.connection, poolAddress);
  // Refresh on-chain state immediately before reading the active bin / building
  // the add-liquidity tx; a stale active bin causes strategy/slippage reverts.
  await dlmmPool.refetchStates();

  // Idempotency guard against double-deploy. With retries enabled, a prior
  // attempt whose tx LANDED but whose DB write failed would leave an orphan
  // position; opening another would split funds. The system deploys one room
  // at a time per LP_MANAGER, so any pre-existing position here is unexpected —
  // refuse and surface for manual reconciliation rather than risk a double.
  const existing = await dlmmPool.getPositionsByUserAndLbPair(
    opts.signer.publicKey,
  );
  if (existing.userPositions.length > 0) {
    throw new Error(
      `[lpManager] LP_MANAGER already holds ${existing.userPositions.length} ` +
        `position(s) in pool ${poolAddress.toBase58()} — refusing to open ` +
        `another (possible orphan from a prior partial deploy). Reconcile manually.`,
    );
  }

  const activeBin = await dlmmPool.getActiveBin();
  const positionKeypair = Keypair.generate();

  // Use the USDC actually sitting in the wallet, NOT the swap's quoted output.
  // swap.outLamports is build.outAmount (the quote); the realized balance after
  // slippage is lower, so passing the quote as totalYAmount makes
  // AddLiquidityByStrategy try to transfer more USDC than exists → SPL Token
  // "insufficient funds" (0x1). Confirmed via the surfpool fork e2e.
  let totalYAmount = swap.outLamports;
  if (usdcSide > 0n) {
    const usdcAta = getAssociatedTokenAddressSync(
      new PublicKey(env.USDC_MINT_ADDRESS),
      opts.signer.publicKey,
      false,
      TOKEN_PROGRAM_ID,
    );
    const bal = await opts.connection.getTokenAccountBalance(usdcAta);
    totalYAmount = BigInt(bal.value.amount);
  }

  const tx: Transaction =
    await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKeypair.publicKey,
      totalXAmount: new BN(solSide.toString()),
      totalYAmount: new BN(totalYAmount.toString()),
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

  // Avoids exposing "" as a confirmed tx when no swap ran.
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

/** @internal — exported for the surfpool e2e test only. App code should use `exitRoomLiquidity`. */
export async function exitFromDlmm(opts: {
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

  // Assumes LP_MANAGER's USDC is from this room only. Serialize multi-room exits.
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
    // ATA missing — no USDC received, nothing to swap.
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

  // Approximation — DLMM SDK doesn't expose per-tx amounts cleanly.
  const removedSol =
    exitedLamports > swapBackSolOut ? exitedLamports - swapBackSolOut : 0n;

  return {
    exitedLamports,
    deployedLamports: opts.deployedLamports,
    realizedYieldLamports: realizedYield,
    bufferTopUpLamports: bufferTopUp,
    feesLamports: realizedYield,
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
 * Caller must first invoke on-chain `withdraw_to_lp_manager` so SOL has
 * actually arrived in LP_MANAGER's wallet.
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
 * Exits the position, returns SOL to room_vault, reports yield. Dry-run
 * synthesizes yield but still transfers so settlement runs end-to-end.
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

  // On loss the deficit comes from the LP_MANAGER buffer.
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

import { describe, it, expect, beforeAll } from "vitest";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  swapSolToUsdc,
  swapUsdcToSol,
} from "../../src/services/lpJupiterSwap.js";
import {
  deployToDlmm,
  exitFromDlmm,
} from "../../src/services/lpManager.js";
import { parseKeypair } from "../../src/solana/keypairs.js";

const SHOULD_RUN = process.env.RUN_LP_E2E === "1";

(SHOULD_RUN ? describe : describe.skip)(
  "surfpool e2e — Jupiter swap + Meteora LP (real fork)",
  () => {
    let connection: Connection;
    let signer: Keypair;

    beforeAll(async () => {
      const rpc = process.env.SOLANA_RPC_URL;
      const kpJson = process.env.LP_MANAGER_KEYPAIR;
      if (!rpc || !kpJson) {
        throw new Error(
          "RUN_LP_E2E=1 but SOLANA_RPC_URL or LP_MANAGER_KEYPAIR missing — " +
            "use scripts/test-lp-e2e.sh which sets these.",
        );
      }
      if (!process.env.JUPITER_API_KEY) {
        throw new Error("RUN_LP_E2E=1 but JUPITER_API_KEY missing");
      }
      connection = new Connection(rpc, "confirmed");
      const parsed = parseKeypair(kpJson);
      if (!parsed) {
        throw new Error(
          "LP_MANAGER_KEYPAIR did not parse as JSON byte array or base58 64-byte secret key",
        );
      }
      signer = parsed;

      const balance = await connection.getBalance(signer.publicKey);
      if (balance < 0.2 * LAMPORTS_PER_SOL) {
        throw new Error(
          `LP_MANAGER wallet ${signer.publicKey.toBase58()} has only ` +
            `${balance / LAMPORTS_PER_SOL} SOL on the fork — the shell ` +
            `script should airdrop ≥ 0.2 SOL via surfnet_setAccount.`,
        );
      }
    }, 60_000);

    it("Jupiter swap: SOL → USDC lands on the fork", async () => {
      // 0.05 SOL — large enough that price impact is small, small enough
      // that the fork's cloned state covers it.
      const amount = BigInt(0.05 * LAMPORTS_PER_SOL);

      const beforeSol = BigInt(
        await connection.getBalance(signer.publicKey),
      );

      const result = await swapSolToUsdc({
        connection,
        signer,
        amountLamports: amount,
      });

      expect(result.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
      expect(result.inLamports).toBe(amount);
      expect(result.outLamports).toBeGreaterThan(0n);
      // otherAmountThreshold (minOut) gap should be bounded by slippageBps.
      // Default LP_SWAP_SLIPPAGE_BPS=50 → 0.5% max slippage.
      const slipBps =
        (Number(result.slippageLamports) * 10_000) / Number(result.outLamports);
      expect(slipBps).toBeLessThanOrEqual(100); // slack for jitter

      const afterSol = BigInt(await connection.getBalance(signer.publicKey));
      // Spent at least `amount` (plus fees + rent for WSOL ATA).
      expect(beforeSol - afterSol).toBeGreaterThanOrEqual(amount);

      // USDC ATA should now exist with the swapped amount.
      const usdcAta = getAssociatedTokenAddressSync(
        new PublicKey(process.env.USDC_MINT_ADDRESS!),
        signer.publicKey,
        false,
        TOKEN_PROGRAM_ID,
      );
      const usdcBal = await connection.getTokenAccountBalance(usdcAta);
      expect(BigInt(usdcBal.value.amount)).toBeGreaterThanOrEqual(
        result.outLamports - result.slippageLamports,
      );
    }, 120_000);

    it("Jupiter swap: USDC → SOL lands on the fork", async () => {
      // Use whatever USDC the previous test deposited.
      const usdcAta = getAssociatedTokenAddressSync(
        new PublicKey(process.env.USDC_MINT_ADDRESS!),
        signer.publicKey,
        false,
        TOKEN_PROGRAM_ID,
      );
      const bal = await connection.getTokenAccountBalance(usdcAta);
      const usdcLamports = BigInt(bal.value.amount);
      expect(usdcLamports).toBeGreaterThan(0n);

      const result = await swapUsdcToSol({
        connection,
        signer,
        amountLamports: usdcLamports,
      });

      expect(result.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
      expect(result.outLamports).toBeGreaterThan(0n);
    }, 120_000);

    it("Meteora DLMM: deploy → exit round-trip", async () => {
      // Use a conservative deploy size — 0.1 SOL total. The strategy splits
      // into SOL + USDC according to LP_SOL_USDC_SPLIT_BPS (default 5000).
      const deployLamports = BigInt(0.1 * LAMPORTS_PER_SOL);

      // Capture wallet balance before the whole cycle so we can compute
      // the actual net cost (fees + slippage) end-to-end.
      const walletBefore = BigInt(
        await connection.getBalance(signer.publicKey),
      );

      const deploy = await deployToDlmm({
        connection,
        signer,
        totalSolLamports: deployLamports,
      });

      expect(deploy.positionPubkey).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
      expect(deploy.addLiquidityTxSignature).toMatch(
        /^[1-9A-HJ-NP-Za-km-z]+$/,
      );
      expect(deploy.deployedLamports).toBe(deployLamports);
      expect(deploy.dryRun).toBe(false);

      // Position should exist on chain.
      const positionInfo = await connection.getAccountInfo(
        new PublicKey(deploy.positionPubkey),
      );
      expect(positionInfo).not.toBeNull();

      // Exit immediately — no yield expected on a fresh position over
      // the duration of one test, but the round-trip must succeed.
      const exit = await exitFromDlmm({
        connection,
        signer,
        positionPubkey: new PublicKey(deploy.positionPubkey),
        deployedLamports: deployLamports,
      });

      expect(exit.removeLiquidityTxSignature).toMatch(
        /^[1-9A-HJ-NP-Za-km-z]+$/,
      );
      expect(exit.dryRun).toBe(false);

      const walletAfter = BigInt(
        await connection.getBalance(signer.publicKey),
      );

      // Diagnostic log — fork-state Meteora math diverges from mainnet,
      // so what we want to see here is "did the cycle complete and did
      // we recover most of the SOL", not exact accounting.
      const netCostLamports = walletBefore - walletAfter;
      const reportedExited = exit.exitedLamports;
      console.log(
        `[DLMM e2e] deploy=${deployLamports} ` +
          `walletBefore=${walletBefore} walletAfter=${walletAfter} ` +
          `netCost=${netCostLamports} ` +
          `reportedExited=${reportedExited} ` +
          `position=${deploy.positionPubkey}`,
      );

      // Loose assertion: net cost across the whole cycle should be
      // bounded — we shouldn't lose more than 20% of the deploy size to
      // fees + slippage on a fork. Anything tighter is unreliable
      // because surfpool's cloned bin arrays don't match mainnet
      // depth. For accurate slippage assertions, use the mainnet-dust
      // e2e (pnpm e2e:lp:mainnet).
      if (netCostLamports > 0n) {
        // We lost SOL net (expected case): bound the loss.
        const lossPct =
          (Number(netCostLamports) * 100) / Number(deployLamports);
        expect(lossPct).toBeLessThan(20);
      } else {
        // We gained SOL net (rare — usually means residual USDC from a
        // previous test got swept). Just log and pass; the cycle ran.
        console.log(
          `[DLMM e2e] net positive (gained ${-netCostLamports} lamports) — ` +
            `likely residual USDC from a previous test was swept on exit.`,
        );
      }
    }, 300_000);
  },
);

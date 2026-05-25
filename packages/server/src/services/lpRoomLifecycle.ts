import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { env } from "../config/env.js";
import {
  getRoomsProgram,
  getRoomPda,
  getRoomVaultPda,
  getProgramConfigPda,
  loadLpManagerKeypair,
} from "../solana/roomsProgram.js";
import { isProgramPaused } from "../solana/configCache.js";
import { Room } from "../db/schema.js";
import {
  checkLpReady,
  deployRoomLiquidity,
  exitRoomLiquidity,
} from "./lpManager.js";
import { formatSolanaError } from "../solana/formatError.js";
import { computeRentSafeWithdrawAmount } from "./lpWithdrawMath.js";

type LpLogger = {
  info: (msg: string) => void;
  error: (msg: string) => void;
};

const noopLogger: LpLogger = { info: () => {}, error: () => {} };

/** Idempotent — re-running on already-deployed rooms is a no-op. */
export async function deployReadyRoomLp(logger: LpLogger = noopLogger) {
  if (!env.FEATURES_LP_ENABLED) return;

  const rooms = await Room.find({
    phase: "active",
    onChainPoolId: { $ne: null },
    "lp.status": "pending",
  }).lean();
  if (rooms.length === 0) return;

  const ready = checkLpReady({
    requiredBufferLamports: BigInt(env.IL_BUFFER_LAMPORTS_MIN),
  });
  if (!ready.ok) {
    logger.info(`lpDeploy skipped — ${ready.reason}`);
    return;
  }

  const loaded = getRoomsProgram();
  if (!loaded) {
    logger.info("lpDeploy skipped — TREASURY_KEYPAIR not configured");
    return;
  }
  const { program, signer: treasury } = loaded;
  const lpManager = loadLpManagerKeypair();
  if (!lpManager) return;

  if (await isProgramPaused()) {
    logger.info("lpDeploy skipped — program paused");
    return;
  }

  for (const room of rooms) {
    try {
      const onChainRoomId = BigInt(room.onChainPoolId!);
      const roomPda = getRoomPda(onChainRoomId);
      const roomVaultPda = getRoomVaultPda(roomPda);
      const onChainRoom = await program.account.room.fetchNullable(roomPda);
      if (!onChainRoom) continue;

      // Crash-recovery: withdraw already landed before the prior DB write.
      const alreadyOnChain =
        BigInt(onChainRoom.lpDeployedLamports.toString()) > 0n;

      const principal = BigInt(onChainRoom.depositedLamports.toString());
      if (principal === 0n) {
        await Room.updateOne(
          { roomId: room.roomId },
          { $set: { "lp.status": "skipped", "lp.lastError": "no deposits" } },
        );
        continue;
      }

      // Rent-safe withdraw amount: withdrawing the full principal can leave the
      // vault holding non-zero dust below the rent-exempt minimum, which makes
      // the System transfer CPI fail simulation with "insufficient funds for
      // rent" — the bug that stranded rooms. See computeRentSafeWithdrawAmount.
      const connection = program.provider.connection;
      const vaultBalance = BigInt(await connection.getBalance(roomVaultPda));
      const rentMin = BigInt(
        await connection.getMinimumBalanceForRentExemption(0),
      );
      const amount = computeRentSafeWithdrawAmount({
        principal,
        vaultBalance,
        rentMin,
      });
      if (amount <= 0n) {
        await Room.updateOne(
          { roomId: room.roomId },
          {
            $set: {
              "lp.status": "skipped",
              "lp.lastError": `vault ${vaultBalance} <= rentMin ${rentMin}; nothing to withdraw`,
            },
          },
        );
        continue;
      }

      // Crash-recovery: if the withdraw already landed, reuse the on-chain
      // amount so the Meteora deploy matches what actually arrived.
      const deployLamports = alreadyOnChain
        ? BigInt(onChainRoom.lpDeployedLamports.toString())
        : amount;

      let withdrawSig: string | null = null;
      if (!alreadyOnChain) {
        withdrawSig = await program.methods
          .withdrawToLpManager(new BN(amount.toString()))
          .accounts({
            room: roomPda,
            config: getProgramConfigPda(),
            roomVault: roomVaultPda,
            lpManager: lpManager.publicKey,
            admin: treasury.publicKey,
          } as never)
          .rpc();
        logger.info(
          `room=${room.roomId} withdraw_to_lp_manager ${amount} lamports ` +
            `(vault=${vaultBalance}, rentMin=${rentMin}) tx=${withdrawSig}`,
        );
      }

      const deploy = await deployRoomLiquidity({
        roomPdaStr: roomPda.toBase58(),
        lamports: deployLamports,
      });
      logger.info(
        `room=${room.roomId} lp deploy ok pos=${deploy.positionPubkey} dryRun=${deploy.dryRun}`,
      );

      await Room.updateOne(
        { roomId: room.roomId },
        {
          $set: {
            "lp.status": "deployed",
            "lp.positionPubkey": deploy.positionPubkey,
            "lp.deployedLamports": Number(deploy.deployedLamports),
            "lp.deployedAt": new Date(),
            "lp.deployTxSignature": withdrawSig,
            "lp.swapSlippageLamports": Number(deploy.swapSlippageLamports),
            "lp.withdrawTxSignature": withdrawSig,
            "lp.swapInTxSignature": deploy.swapInTxSignature,
            "lp.swapInSolLamports": Number(deploy.swapInSolLamports),
            "lp.swapInUsdcRaw": deploy.swapInUsdcRaw.toString(),
            "lp.addLiquidityTxSignature": deploy.addLiquidityTxSignature,
          },
        },
      );
    } catch (err) {
      const detailed = formatSolanaError(err);
      logger.error(`lpDeploy room=${room.roomId} failed: ${detailed}`);
      await Room.updateOne(
        { roomId: room.roomId },
        {
          $set: {
            "lp.status": "failed",
            // Multi-line so admin dashboards see program logs without re-running.
            "lp.lastError": detailed.slice(0, 4000),
          },
        },
      );
    }
  }
}

/** settleRoom reads realizedYieldLamports when it runs close_room. */
export async function exitReadyRoomLp(logger: LpLogger = noopLogger) {
  if (!env.FEATURES_LP_ENABLED) return;

  const exitWindow = new Date(
    Date.now() + env.LP_EXIT_HOURS_BEFORE_CLOSE * 60 * 60 * 1000,
  );
  const rooms = await Room.find({
    phase: "active",
    onChainPoolId: { $ne: null },
    "lp.status": "deployed",
    closesAt: { $lte: exitWindow },
  }).lean();
  if (rooms.length === 0) return;

  const ready = checkLpReady({
    requiredBufferLamports: BigInt(env.IL_BUFFER_LAMPORTS_MIN),
  });
  if (!ready.ok) {
    logger.info(`lpExit skipped — ${ready.reason}`);
    return;
  }

  for (const room of rooms) {
    try {
      const onChainRoomId = BigInt(room.onChainPoolId!);
      const roomPda = getRoomPda(onChainRoomId);
      const roomVaultPda = getRoomVaultPda(roomPda);
      const positionPubkeyStr = room.lp?.positionPubkey;
      const deployedLamports = BigInt(room.lp?.deployedLamports ?? 0);
      if (!positionPubkeyStr || deployedLamports === 0n) {
        await Room.updateOne(
          { roomId: room.roomId },
          { $set: { "lp.status": "skipped", "lp.lastError": "no deploy state" } },
        );
        continue;
      }

      const exit = await exitRoomLiquidity({
        roomPdaStr: roomPda.toBase58(),
        positionPubkeyStr,
        deployedLamports,
        roomVault: new PublicKey(roomVaultPda),
      });
      logger.info(
        `room=${room.roomId} lp exit ok yield=${exit.realizedYieldLamports} ` +
          `bufferTopUp=${exit.bufferTopUpLamports} dryRun=${exit.dryRun}`,
      );

      await Room.updateOne(
        { roomId: room.roomId },
        {
          $set: {
            "lp.status": "exited",
            "lp.exitedLamports": Number(exit.exitedLamports),
            "lp.exitedAt": new Date(),
            "lp.feesLamports": Number(exit.feesLamports),
            "lp.swapSlippageLamports":
              Number(exit.swapSlippageLamports) +
              (room.lp?.swapSlippageLamports ?? 0),
            "lp.realizedYieldLamports": Number(exit.realizedYieldLamports),
            "lp.bufferTopUpLamports": Number(exit.bufferTopUpLamports),
            "lp.removeLiquidityTxSignature": exit.removeLiquidityTxSignature,
            "lp.removeLiquidityUsdcRaw": exit.removeLiquidityUsdcRaw.toString(),
            "lp.removeLiquiditySolLamports": Number(
              exit.removeLiquiditySolLamports,
            ),
            "lp.swapOutTxSignature": exit.swapOutTxSignature,
            "lp.swapOutUsdcRaw": exit.swapOutUsdcRaw.toString(),
            "lp.swapOutSolLamports": Number(exit.swapOutSolLamports),
            "lp.depositYieldTxSignature": exit.depositYieldTxSignature,
          },
        },
      );
    } catch (err) {
      const detailed = formatSolanaError(err);
      logger.error(`lpExit room=${room.roomId} failed: ${detailed}`);
      await Room.updateOne(
        { roomId: room.roomId },
        {
          $set: {
            "lp.status": "failed",
            "lp.lastError": detailed.slice(0, 4000),
          },
        },
      );
    }
  }
}

import mongoose from "mongoose";
import { env } from "../config/env.js";
import { Player } from "../db/schema.js";

/**
 * Dev-only: seed a fake deposit on a Player so fishing works without an
 * actual on-chain `deposit_room` flow. The cast flow reads
 * `player.deposits[].amount` to compute initial bait
 * (services/fishing/wsExecutor.ts:ensureActiveSession). This script inserts
 * a row with that shape.
 *
 * Refuses to run in production.
 *
 * Usage:
 *   pnpm exec tsx src/cli/seedDevDeposit.ts <walletAddress> [amountSol]
 *
 * Example:
 *   pnpm exec tsx src/cli/seedDevDeposit.ts 7xK...abc 1
 */
async function main() {
  if (env.APP_ENV === "production") {
    throw new Error("seedDevDeposit refuses to run in production");
  }

  const wallet = process.argv[2];
  const amountSol = Number(process.argv[3] ?? "1");
  if (!wallet) {
    throw new Error("Usage: seedDevDeposit.ts <walletAddress> [amountSol]");
  }
  if (!Number.isFinite(amountSol) || amountSol <= 0) {
    throw new Error(`Invalid amountSol: ${process.argv[3]}`);
  }

  await mongoose.connect(env.MONGODB_URI);

  const now = new Date();
  const activeMonth = now.toISOString().slice(0, 7);
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const fakeTx = `dev-seed-${now.getTime()}`;

  const updated = await Player.findOneAndUpdate(
    { walletAddress: wallet },
    {
      $push: {
        deposits: {
          poolId: `dev-pool-${activeMonth}`,
          amount: amountSol,
          depositTxSignature: fakeTx,
          activeMonth,
          depositedAt: now,
          expiresAt,
          returned: false,
          returnedAt: null,
        },
      },
    },
    { new: true, upsert: false },
  ).lean();

  if (!updated) {
    throw new Error(
      `No Player found for wallet ${wallet}. Connect once via the client first to create the row.`,
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        wallet,
        amountSol,
        activeMonth,
        depositTxSignature: fakeTx,
        depositCount: updated.deposits?.length ?? 0,
      },
      null,
      2,
    ),
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

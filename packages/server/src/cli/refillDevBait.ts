import mongoose from "mongoose";
import { env } from "../config/env.js";
import { Player, FishingSession } from "../db/schema.js";
import { assignWindow } from "../services/fishing/window.js";

/**
 * Dev-only: refill bait on the player's currently-active FishingSession so
 * casting can continue without waiting for the next bait window. Targets the
 * session at the current (dateKey, window) slot.
 *
 * Refuses to run in production.
 *
 * Usage:
 *   pnpm exec tsx src/cli/refillDevBait.ts <walletAddress> [baitAmount]
 *
 * Default baitAmount is 20.
 */
async function main() {
  if (env.APP_ENV === "production") {
    throw new Error("refillDevBait refuses to run in production");
  }

  const wallet = process.argv[2];
  const bait = Number(process.argv[3] ?? "20");
  if (!wallet) {
    throw new Error("Usage: refillDevBait.ts <walletAddress> [baitAmount]");
  }
  if (!Number.isInteger(bait) || bait <= 0 || bait > 255) {
    throw new Error(`Invalid baitAmount: ${process.argv[3]} (must be 1..255)`);
  }

  await mongoose.connect(env.MONGODB_URI);

  const player = await Player.findOne({ walletAddress: wallet }, { _id: 1 }).lean();
  if (!player) throw new Error(`No Player for wallet ${wallet}`);

  const { dateKey, window } = assignWindow(new Date());

  const updated = await FishingSession.findOneAndUpdate(
    { playerId: player._id, dateKey, window, status: "active" },
    { $set: { baitRemaining: bait }, $max: { baitInitial: bait } },
    { new: true },
  ).lean();

  if (!updated) {
    // Diagnostic: list everything we have for this player so we can see
    // whether the session is in a different window or non-active status.
    const all = await FishingSession.find(
      { playerId: player._id },
      { dateKey: 1, window: 1, status: 1, baitRemaining: 1, baitInitial: 1, startedAt: 1 },
    )
      .sort({ startedAt: -1 })
      .limit(5)
      .lean();
    console.error(
      JSON.stringify(
        {
          error: "no active session in current window",
          target: { dateKey, window },
          recentSessions: all.map((s) => ({
            dateKey: s.dateKey,
            window: s.window,
            status: s.status,
            bait: `${s.baitRemaining}/${s.baitInitial}`,
            startedAt: s.startedAt,
          })),
        },
        null,
        2,
      ),
    );
    throw new Error(
      "No active session matched. See recentSessions above. If status is 'committed', start a new session by casting again (bait will use the latest deposit amount).",
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        wallet,
        sessionId: String(updated._id),
        dateKey,
        window,
        baitRemaining: updated.baitRemaining,
        baitInitial: updated.baitInitial,
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

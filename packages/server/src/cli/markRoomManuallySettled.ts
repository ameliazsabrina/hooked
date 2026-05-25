import mongoose from "mongoose";
import { env } from "../config/env.js";
import { Player, Room } from "../db/schema.js";

/**
 * Marks a room as settled OFF-CHAIN: when principal (+ yield) was paid to
 * players directly from the LP_MANAGER wallet rather than via the on-chain
 * close_room → return_principal keeper path.
 *
 * Effects (with CONFIRM=yes):
 *   - room.phase            → "closed"  (keeper's `phase:"settling"` query
 *                                        will no longer pick it up — no on-chain
 *                                        settlement will run)
 *   - room.lp.status        → "exited"  + lastError note
 *   - room.players[].returned → true    (returnedAt = now, returnTxSignature =
 *                                        your manual payout sig if supplied)
 *   - Player.deposits matching this poolId → returned = true (same fields)
 *
 * Usage:
 *   pnpm tsx src/cli/markRoomManuallySettled.ts <roomId|onChainPoolId> ['{"<wallet>":"<payoutSig>",...}']
 *   CONFIRM=yes pnpm tsx src/cli/markRoomManuallySettled.ts ...
 *
 * Does NOT touch on-chain state. The on-chain room keeps its rent remnant in
 * the vault; reclaim it separately via close_room → finalize_room if desired.
 */
async function main() {
  const idArg = process.argv[2];
  const sigMapArg = process.argv[3];
  if (!idArg) {
    console.error(
      "usage: pnpm tsx src/cli/markRoomManuallySettled.ts <roomId|onChainPoolId> ['{\"<wallet>\":\"<payoutSig>\"}']",
    );
    process.exit(1);
  }

  let payoutSigs: Record<string, string> = {};
  if (sigMapArg) {
    try {
      payoutSigs = JSON.parse(sigMapArg) as Record<string, string>;
    } catch {
      console.error("Second arg must be a JSON object {wallet: payoutSig}.");
      process.exit(1);
    }
  }

  const numericArg = /^[0-9]+$/.test(idArg);
  const query = numericArg ? { onChainPoolId: idArg } : { roomId: idArg };

  await mongoose.connect(env.MONGODB_URI);
  try {
    const room = await Room.findOne(query).lean();
    if (!room) {
      console.error(`Room not found for ${JSON.stringify(query)}.`);
      process.exit(1);
    }
    const roomId = room.roomId;
    const players = room.players ?? [];

    const sigFor = (wallet: string): string =>
      payoutSigs[wallet] ?? "manual-offchain";

    console.log("─── current state ────────────────────────────");
    console.log(`roomId          ${roomId}`);
    console.log(`onChainPoolId   ${room.onChainPoolId}`);
    console.log(`phase           ${room.phase}  →  closed`);
    console.log(`lp.status       ${room.lp?.status ?? "(none)"}  →  exited`);
    console.log(`players (${players.length}):`);
    for (const p of players) {
      console.log(
        `  ${p.walletAddress}  deposit=${p.deposit} returned=${p.returned} ` +
          `→ returned=true sig=${sigFor(p.walletAddress)}`,
      );
    }
    const unknownWallets = Object.keys(payoutSigs).filter(
      (w) => !players.some((p) => p.walletAddress === w),
    );
    if (unknownWallets.length > 0) {
      console.warn(
        `⚠  payout-sig wallets not in this room (ignored): ${unknownWallets.join(", ")}`,
      );
    }
    console.log("──────────────────────────────────────────────");

    if (process.env.CONFIRM !== "yes") {
      console.log("\nDry run. Re-run with CONFIRM=yes to write.");
      return;
    }

    const now = new Date();

    // 1) Room: phase + lp + each embedded player entry.
    const setOps: Record<string, unknown> = {
      phase: "closed",
      "lp.status": "exited",
      "lp.lastError": "manual off-chain payout to players (principal + yield)",
      "lp.exitedAt": now,
    };
    players.forEach((p, i) => {
      setOps[`players.${i}.returned`] = true;
      setOps[`players.${i}.returnedAt`] = now;
      setOps[`players.${i}.returnTxSignature`] = sigFor(p.walletAddress);
    });
    const roomRes = await Room.updateOne({ roomId }, { $set: setOps });
    console.log(
      `✓ Room updated (matched=${roomRes.matchedCount}, modified=${roomRes.modifiedCount})`,
    );

    // 2) Player.deposits matching this poolId.
    let playerUpdates = 0;
    for (const p of players) {
      const res = await Player.updateOne(
        { walletAddress: p.walletAddress },
        {
          $set: {
            "deposits.$[d].returned": true,
            "deposits.$[d].returnedAt": now,
            "deposits.$[d].returnTxSignature": sigFor(p.walletAddress),
          },
        },
        { arrayFilters: [{ "d.poolId": roomId, "d.returned": false }] },
      );
      if (res.modifiedCount > 0) playerUpdates += 1;
    }
    console.log(`✓ Player deposits marked returned for ${playerUpdates} wallet(s)`);

    console.log(
      "\nDone. Keeper will no longer pick up this room (phase=closed). " +
        "On-chain rent remnant in the vault is untouched — reclaim via " +
        "close_room → finalize_room if you want it back to treasury.",
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("markRoomManuallySettled failed:", err);
  process.exit(1);
});

import mongoose from "mongoose";
import { env } from "../config/env.js";
import { Room } from "../db/schema.js";

/**
 * READ-ONLY diagnostic. Prints a room's lifecycle + LP state, including the
 * captured lp.lastError that explains why an automated LP deploy failed.
 *
 * Usage:
 *   pnpm tsx src/cli/printRoomLpState.ts <roomId|onChainPoolId>
 *
 * Needs only MONGODB_URI. Makes no on-chain calls and writes nothing.
 */
async function main() {
  const idArg = process.argv[2];
  if (!idArg) {
    console.error("usage: pnpm tsx src/cli/printRoomLpState.ts <roomId|onChainPoolId>");
    process.exit(1);
  }

  const numeric = /^[0-9]+$/.test(idArg);
  const query = numeric ? { onChainPoolId: idArg } : { roomId: idArg };

  await mongoose.connect(env.MONGODB_URI);
  try {
    const room = await Room.findOne(query).lean();
    if (!room) {
      console.error(`Room not found for ${numeric ? "onChainPoolId" : "roomId"}="${idArg}".`);
      // Numeric stored as number in some schemas — retry loose match.
      if (numeric) {
        const alt = await Room.findOne({ onChainPoolId: Number(idArg) }).lean();
        if (alt) {
          printRoom(alt);
          return;
        }
      }
      process.exit(1);
    }
    printRoom(room);
  } finally {
    await mongoose.disconnect();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function printRoom(room: any) {
  console.log("─── room ─────────────────────────────────────");
  console.log(`roomId          ${room.roomId}`);
  console.log(`onChainPoolId   ${room.onChainPoolId}`);
  console.log(`phase           ${room.phase}`);
  console.log(`entryClosesAt   ${fmt(room.entryClosesAt)}`);
  console.log(`closesAt        ${fmt(room.closesAt)}`);
  console.log(`depositedSol    ${room.depositedSol}`);
  console.log(`realPlayerCount ${room.realPlayerCount}`);
  console.log(`closeTx         ${room.closeTxSignature ?? "—"}`);
  console.log(`finalizeTx      ${room.finalizeTxSignature ?? "—"}`);
  console.log("─── room.lp ──────────────────────────────────");
  if (!room.lp) {
    console.log("(no lp subdocument)");
  } else {
    console.log(`lp.status       ${room.lp.status}`);
    console.log(`lp.positionPubkey ${room.lp.positionPubkey ?? "—"}`);
    console.log(`lp.deployedLamports ${room.lp.deployedLamports ?? "—"}`);
    console.log(`lp.deployedAt   ${fmt(room.lp.deployedAt)}`);
    console.log(`lp.realizedYieldLamports ${room.lp.realizedYieldLamports ?? "—"}`);
    console.log("─── lp.lastError (full) ──────────────────────");
    console.log(room.lp.lastError ?? "(none)");
    console.log("─── lp (raw, all fields) ─────────────────────");
    console.dir(room.lp, { depth: null, maxStringLength: Infinity });
  }
  console.log("──────────────────────────────────────────────");
}

function fmt(v: unknown): string {
  if (!v) return "—";
  const d = v instanceof Date ? v : new Date(v as string);
  return `${d.toISOString()} (epoch ${Math.floor(d.getTime() / 1000)})`;
}

main().catch((err) => {
  console.error("printRoomLpState failed:", err);
  process.exit(1);
});

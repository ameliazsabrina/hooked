import { randomBytes } from "node:crypto";
import BN from "bn.js";
import { SystemProgram } from "@solana/web3.js";
import {
  ROOM_CAPACITY_SOL,
  ROOM_MAX_PLAYERS,
  computeRoomTimestamps,
  currentRoomWindowStart,
  nextRoomOpensAt,
} from "@hooked/shared";
import { Room } from "../db/schema.js";
import {
  getRoomsProgram,
  getRoomPda,
  getRoomVaultPda,
} from "../solana/roomsProgram.js";

const MAX_ROOMS_PER_UTC_DAY = 2;

function newRoomId(now: Date): string {
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = randomBytes(3).toString("hex");
  return `R-${ymd}-${suffix}`;
}

export type CreateRoomTrigger =
  | "admin"
  | "system:cron"
  | "system:capacity"
  | "system:rotation";

export type CreateRoomResult =
  | {
      ok: true;
      roomId: string;
      createdAt: Date;
      entryClosesAt: Date;
      closesAt: Date;
      phase: "entry";
      onChainRoomId: string;
      onChainRoomAddress: string;
      txSignature: string;
    }
  | {
      ok: false;
      skipped: true;
      reason: "daily-cap" | "treasury-missing" | "cron-already-created";
    };

export async function createRoomOnChainAndDb(opts: {
  createdBy: string;
  trigger: CreateRoomTrigger;
}): Promise<CreateRoomResult> {
  const loaded = getRoomsProgram();
  if (!loaded) {
    return { ok: false, skipped: true, reason: "treasury-missing" };
  }
  const { program, signer } = loaded;

  const now = new Date();

  // Hard ceiling regardless of trigger.
  const utcDayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const utcDayEnd = new Date(utcDayStart.getTime() + 24 * 60 * 60 * 1000);
  const existingToday = await Room.countDocuments({
    createdAt: { $gte: utcDayStart, $lt: utcDayEnd },
  });
  if (existingToday >= MAX_ROOMS_PER_UTC_DAY) {
    return { ok: false, skipped: true, reason: "daily-cap" };
  }

  // Cron fires once per bait window (02:00 / 14:00 UTC). Skip if a room was
  // already created in the active window — covers retries and the rare case
  // where a non-cron trigger ran first.
  if (opts.trigger === "system:cron") {
    const windowStart = currentRoomWindowStart(now);
    const windowEnd = nextRoomOpensAt(now);
    const existingThisWindow = await Room.countDocuments({
      createdAt: { $gte: windowStart, $lt: windowEnd },
    });
    if (existingThisWindow >= 1) {
      return { ok: false, skipped: true, reason: "cron-already-created" };
    }
  }

  const { entryClosesAt, closesAt } = computeRoomTimestamps(now);
  const roomId = newRoomId(now);
  const onChainRoomId = BigInt(Date.now());
  const roomPda = getRoomPda(onChainRoomId);
  const roomVaultPda = getRoomVaultPda(roomPda);

  const txSig = await program.methods
    .createRoom(new BN(onChainRoomId.toString()))
    .accounts({
      room: roomPda,
      roomVault: roomVaultPda,
      admin: signer.publicKey,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();

  const room = await Room.create({
    roomId,
    createdAt: now,
    entryClosesAt,
    closesAt,
    phase: "entry",
    capacitySol: ROOM_CAPACITY_SOL,
    maxPlayers: ROOM_MAX_PLAYERS,
    depositedSol: 0,
    realPlayerCount: 0,
    onChainPoolId: onChainRoomId.toString(),
    onChainPoolAddress: roomPda.toBase58(),
    createdByAdmin: opts.createdBy,
    createTxSignature: txSig,
  });

  return {
    ok: true,
    roomId: room.roomId,
    createdAt: room.createdAt,
    entryClosesAt: room.entryClosesAt,
    closesAt: room.closesAt,
    phase: "entry",
    onChainRoomId: onChainRoomId.toString(),
    onChainRoomAddress: roomPda.toBase58(),
    txSignature: txSig,
  };
}

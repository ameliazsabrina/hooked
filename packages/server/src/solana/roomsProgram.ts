import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import type { HookedRooms } from "../idl/hooked_rooms_types.js";
import roomsIdl from "../idl/hooked_rooms.json" with { type: "json" };
import { env } from "../config/env.js";

export const HOOKED_ROOMS_PROGRAM_ID = new PublicKey(
  env.HOOKED_ROOMS_PROGRAM_ID,
);

let cachedTreasury: Keypair | null | undefined;
let cachedLpManager: Keypair | null | undefined;

function parseKeypair(raw: string): Keypair | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const bytes = JSON.parse(trimmed) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(bytes));
    } catch {
      return null;
    }
  }
  try {
    const bytes = bs58.decode(trimmed);
    if (bytes.length !== 64) return null;
    return Keypair.fromSecretKey(bytes);
  } catch {
    return null;
  }
}

export function loadTreasuryKeypair(): Keypair | null {
  if (cachedTreasury !== undefined) return cachedTreasury;
  if (!env.TREASURY_KEYPAIR) {
    cachedTreasury = null;
    return null;
  }
  const kp = parseKeypair(env.TREASURY_KEYPAIR);
  if (!kp) {
    console.error(
      "[rooms] Invalid TREASURY_KEYPAIR — expected JSON byte array or base58 64-byte secret key",
    );
  }
  cachedTreasury = kp;
  return kp;
}

export function loadLpManagerKeypair(): Keypair | null {
  if (cachedLpManager !== undefined) return cachedLpManager;
  if (!env.LP_MANAGER_KEYPAIR) {
    cachedLpManager = null;
    return null;
  }
  const kp = parseKeypair(env.LP_MANAGER_KEYPAIR);
  if (!kp) {
    console.error(
      "[rooms] Invalid LP_MANAGER_KEYPAIR — expected JSON byte array or base58 64-byte secret key",
    );
  }
  cachedLpManager = kp;
  return kp;
}

let cachedAdmin: Keypair | null | undefined;

export function loadAdminKeypair(): Keypair | null {
  if (cachedAdmin !== undefined) return cachedAdmin;
  if (!env.ADMIN_KEYPAIR) {
    cachedAdmin = null;
    return null;
  }
  const kp = parseKeypair(env.ADMIN_KEYPAIR);
  if (!kp) {
    console.error(
      "[rooms] Invalid ADMIN_KEYPAIR — expected JSON byte array or base58 64-byte secret key",
    );
  }
  cachedAdmin = kp;
  return kp;
}

let cachedKeeper: Keypair | null | undefined;

export function loadKeeperKeypair(): Keypair | null {
  if (cachedKeeper !== undefined) return cachedKeeper;
  if (!env.KEEPER_KEYPAIR) {
    cachedKeeper = null;
    return null;
  }
  const kp = parseKeypair(env.KEEPER_KEYPAIR);
  if (!kp) {
    console.error(
      "[rooms] Invalid KEEPER_KEYPAIR — expected JSON byte array or base58 64-byte secret key",
    );
  }
  cachedKeeper = kp;
  return kp;
}

export function getRoomsConnection(): Connection {
  return new Connection(env.SOLANA_RPC_URL, "confirmed");
}

export function getRoomsProgram(
  signer?: Keypair,
): { program: Program<HookedRooms>; signer: Keypair } | null {
  const kp = signer ?? loadTreasuryKeypair();
  if (!kp) return null;
  const connection = getRoomsConnection();
  const provider = new AnchorProvider(connection, new Wallet(kp), {
    commitment: "confirmed",
  });
  const program = new Program<HookedRooms>(roomsIdl as HookedRooms, provider);
  return { program, signer: kp };
}

export function getRoomPda(roomId: bigint | number): PublicKey {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(roomId));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("room"), buf],
    HOOKED_ROOMS_PROGRAM_ID,
  )[0];
}

export function getRoomVaultPda(roomPda: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("room_vault"), roomPda.toBuffer()],
    HOOKED_ROOMS_PROGRAM_ID,
  )[0];
}

export function getRoomEntryPda(
  roomPda: PublicKey,
  authority: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("room_entry"), roomPda.toBuffer(), authority.toBuffer()],
    HOOKED_ROOMS_PROGRAM_ID,
  )[0];
}

export function getGatewayRegistryPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("gateway_registry")],
    HOOKED_ROOMS_PROGRAM_ID,
  )[0];
}

export function getProgramConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    HOOKED_ROOMS_PROGRAM_ID,
  )[0];
}

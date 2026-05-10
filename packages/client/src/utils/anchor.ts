import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { Transaction, VersionedTransaction } from "@solana/web3.js";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import type { HookedRooms } from "../idl/hooked_rooms_types";
import roomsIdlJson from "../idl/hooked_rooms.json";
import {
  FishRarity,
  FISH_SPECIES,
  TIMING_BAR_CONFIG,
  CIRCULAR_TAP_CONFIG,
  type CircularTapClientConfig,
} from "@hooked/shared";

// hooked_fishing program client and PDA helpers were retired in Phase 6:
// the program no longer exists on-chain and all fishing flows run through
// the off-chain tRPC API + WS gateway. The deposit screen and any future
// rooms interactions still need the rooms program below.

export const HOOKED_ROOMS_PROGRAM_ID = new PublicKey(
  import.meta.env.VITE_HOOKED_ROOMS_PROGRAM_ID ?? roomsIdlJson.address
);

export function getRoomsProgram(
  connection: Connection,
  wallet: AnchorWallet
): Program<HookedRooms> {
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  return new Program<HookedRooms>(roomsIdlJson as HookedRooms, provider);
}

/**
 * Read-only Program client. Used for fetching on-chain state without
 * needing the user to connect a wallet — e.g. polling `ProgramConfig.paused`
 * to gate the deposit UI before the user taps "Connect Wallet".
 *
 * The dummy wallet is intentional: AnchorProvider requires a wallet, but
 * read-only calls (`program.account.*.fetch()`) never invoke `signTransaction`.
 * If anything ever does try to sign through this provider it'll throw —
 * that's the safety net so we don't accidentally send a tx without the
 * user's actual wallet.
 */
export function getRoomsProgramReadonly(
  connection: Connection
): Program<HookedRooms> {
  const dummy = Keypair.generate();
  const wallet: AnchorWallet = {
    publicKey: dummy.publicKey,
    signTransaction: async <T extends Transaction | VersionedTransaction>(
      _tx: T
    ): Promise<T> => {
      throw new Error("getRoomsProgramReadonly: cannot sign");
    },
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(
      _txs: T[]
    ): Promise<T[]> => {
      throw new Error("getRoomsProgramReadonly: cannot sign");
    },
  };
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  return new Program<HookedRooms>(roomsIdlJson as HookedRooms, provider);
}

export function getProgramConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    HOOKED_ROOMS_PROGRAM_ID
  )[0];
}

export function getRoomPda(roomId: bigint | number): PublicKey {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(roomId));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("room"), buf],
    HOOKED_ROOMS_PROGRAM_ID
  )[0];
}

export function getRoomVaultPda(roomPda: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("room_vault"), roomPda.toBuffer()],
    HOOKED_ROOMS_PROGRAM_ID
  )[0];
}

export function getRoomEntryPda(
  roomPda: PublicKey,
  authority: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("room_entry"), roomPda.toBuffer(), authority.toBuffer()],
    HOOKED_ROOMS_PROGRAM_ID
  )[0];
}

const RARITY_MAP: FishRarity[] = [
  FishRarity.Basic,
  FishRarity.Rare,
  FishRarity.Monster,
  FishRarity.Legendary,
  FishRarity.Apex,
];

export function mapRarity(onChainRarity: number): FishRarity {
  return RARITY_MAP[onChainRarity] ?? FishRarity.Basic;
}

export function getSpeciesData(speciesId: number) {
  return FISH_SPECIES[speciesId] ?? FISH_SPECIES[0];
}

export function getTimingConfig(rarity: FishRarity) {
  return TIMING_BAR_CONFIG[rarity];
}

export function buildCircularTapConfig(
  rarity: FishRarity,
  castCount: number,
  tapsOverride?: number,
): CircularTapClientConfig | null {
  const cfg =
    CIRCULAR_TAP_CONFIG[rarity as keyof typeof CIRCULAR_TAP_CONFIG];
  if (!cfg) return null;

  const numTaps = tapsOverride ?? cfg.taps;
  const targets: number[] = [];
  for (let i = 0; i < numTaps; i++) {
    const angle = ((castCount * 137.5 + i * 72.0) % 360) * (Math.PI / 180);
    targets.push(angle);
  }

  return {
    targets,
    arcSize: cfg.arcSize,
    tapsRequired: numTaps,
    missesAllowed: cfg.missesAllowed,
    speedMultiplier: cfg.speedMultiplier,
  };
}

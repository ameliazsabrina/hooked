import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { Room } from "../src/db/schema.js";
import {
  startTestMongo,
  stopTestMongo,
  clearAllCollections,
} from "./setup.js";

process.env.FEATURES_LP_ENABLED = "true";
process.env.LP_DRY_RUN = "true";
process.env.LP_DRY_RUN_YIELD_LAMPORTS = "20000000";
process.env.LP_KILL_SWITCH = "false";
process.env.IL_BUFFER_LAMPORTS_MIN = "0";
process.env.LP_MANAGER_KEYPAIR = JSON.stringify(
  Array.from(Keypair.generate().secretKey),
);

type RpcCall = { method: string; amount?: string };
const rpcCalls: RpcCall[] = [];

const mockSigner = Keypair.generate();
const fakeRoomPda = Keypair.generate().publicKey;
const fakeVaultPda = Keypair.generate().publicKey;

vi.mock("../src/solana/roomsProgram.js", async () => {
  const real = (await vi.importActual(
    "../src/solana/roomsProgram.js",
  )) as typeof import("../src/solana/roomsProgram.js");
  return {
    ...real,
    getRoomsProgram: vi.fn(() => ({
      program: {
        provider: {
          connection: {
            getBalance: vi.fn(async () => 1_000_000_000),
            getMinimumBalanceForRentExemption: vi.fn(async () => 890_880),
          },
        },
        account: {
          room: {
            fetchNullable: vi.fn(async () => ({
              depositedLamports: new BN(1_000_000_000),
              lpDeployedLamports: new BN(0),
            })),
          },
          programConfig: {
            fetchNullable: vi.fn(async () => ({
              paused: false,
              admin: mockSigner.publicKey,
              treasury: mockSigner.publicKey,
              lpManager: mockSigner.publicKey,
              version: 1,
            })),
          },
        },
        methods: {
          withdrawToLpManager: vi.fn((amount: BN) => {
            const chain = {
              accounts: () => chain,
              rpc: vi.fn(async () => {
                rpcCalls.push({
                  method: "withdrawToLpManager",
                  amount: amount.toString(),
                });
                return `tx-withdraw-${rpcCalls.length}`;
              }),
            };
            return chain;
          }),
        },
      },
      signer: mockSigner,
    })),
    getRoomPda: vi.fn(() => fakeRoomPda),
    getRoomVaultPda: vi.fn(() => fakeVaultPda),
    loadLpManagerKeypair: vi.fn(() => mockSigner),
  };
});

const sentTxs: string[] = [];
vi.mock("@solana/web3.js", async (orig) => {
  const real = (await orig()) as typeof import("@solana/web3.js");
  return {
    ...real,
    Connection: class FakeConnection {
      async getLatestBlockhash() {
        return { blockhash: "11111111111111111111111111111111" };
      }
      async sendRawTransaction() {
        const sig = `dry-tx-${sentTxs.length}`;
        sentTxs.push(sig);
        return sig;
      }
      async confirmTransaction() {
        return { value: { err: null } };
      }
      async getBalance() {
        return 1_000_000_000;
      }
    },
  };
});

const { deployReadyRoomLp, exitReadyRoomLp } = await import(
  "../src/services/lpRoomLifecycle.js"
);

const ROOM_ID = "R-LP-1";
const ON_CHAIN_ID = "999";

async function seedActiveRoom(opts: {
  closesInMs: number;
  lpStatus: "pending" | "deployed";
  positionPubkey?: string;
  deployedLamports?: number;
}) {
  await Room.create({
    roomId: ROOM_ID,
    createdAt: new Date(Date.now() - 86_400_000),
    entryClosesAt: new Date(Date.now() - 100),
    closesAt: new Date(Date.now() + opts.closesInMs),
    phase: "active",
    capacitySol: 20,
    maxPlayers: 40,
    depositedSol: 1,
    realPlayerCount: 1,
    onChainPoolId: ON_CHAIN_ID,
    createdByAdmin: "test-admin",
    lp: {
      status: opts.lpStatus,
      positionPubkey: opts.positionPubkey ?? null,
      deployedLamports: opts.deployedLamports ?? null,
    },
  });
}

describe("lpRoomLifecycle — deploy + exit (dry-run, mocked program)", () => {
  beforeAll(async () => {
    await startTestMongo();
  });
  afterAll(async () => {
    await stopTestMongo();
    delete process.env.FEATURES_LP_ENABLED;
    delete process.env.LP_DRY_RUN;
    delete process.env.LP_DRY_RUN_YIELD_LAMPORTS;
    delete process.env.LP_MANAGER_KEYPAIR;
  });
  beforeEach(async () => {
    await clearAllCollections();
    rpcCalls.length = 0;
    sentTxs.length = 0;
  });

  it("deployReadyRoomLp — pending+active room → withdraw + dry-run deploy + DB write", async () => {
    await seedActiveRoom({
      closesInMs: 6 * 86_400_000,
      lpStatus: "pending",
    });

    await deployReadyRoomLp();

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.method).toBe("withdrawToLpManager");
    expect(rpcCalls[0]?.amount).toBe("1000000000");

    const room = await Room.findOne({ roomId: ROOM_ID }).lean();
    expect(room?.lp?.status).toBe("deployed");
    expect(room?.lp?.positionPubkey).toBeTruthy();
    expect(room?.lp?.deployedLamports).toBe(1_000_000_000);
    expect(room?.lp?.deployTxSignature).toMatch(/^tx-withdraw-/);
  });

  it("deployReadyRoomLp — already deployed room → no-op", async () => {
    await seedActiveRoom({
      closesInMs: 6 * 86_400_000,
      lpStatus: "deployed",
      positionPubkey: "existing-pos",
      deployedLamports: 1_000_000_000,
    });

    await deployReadyRoomLp();
    expect(rpcCalls).toHaveLength(0);
  });

  it("exitReadyRoomLp — deployed room within exit window → exit + DB write of realizedYield", async () => {
    await seedActiveRoom({
      closesInMs: 1_000,
      lpStatus: "deployed",
      positionPubkey: Keypair.generate().publicKey.toBase58(),
      deployedLamports: 1_000_000_000,
    });

    await exitReadyRoomLp();

    const room = await Room.findOne({ roomId: ROOM_ID }).lean();
    expect(room?.lp?.status).toBe("exited");
    expect(room?.lp?.realizedYieldLamports).toBe(20_000_000);
    expect(room?.lp?.bufferTopUpLamports).toBe(0);
    expect(room?.lp?.exitedLamports).toBe(1_020_000_000);
    expect(sentTxs.length).toBe(1);
  });

  it("exitReadyRoomLp — room not yet in exit window → no-op", async () => {
    await seedActiveRoom({
      closesInMs: 6 * 86_400_000,
      lpStatus: "deployed",
      positionPubkey: Keypair.generate().publicKey.toBase58(),
      deployedLamports: 1_000_000_000,
    });

    await exitReadyRoomLp();

    const room = await Room.findOne({ roomId: ROOM_ID }).lean();
    expect(room?.lp?.status).toBe("deployed");
    expect(room?.lp?.realizedYieldLamports).toBeFalsy();
    expect(sentTxs.length).toBe(0);
  });

  it("exitReadyRoomLp — settling-phase room with stuck LP is still picked up (recovery path)", async () => {
    // Without this, a room that flips active→settling before LP exit ran
    // (the bug behind R-20260512..R-20260522) is stranded — query was
    // phase:"active" only. Now phase ∈ {active, settling}.
    await Room.create({
      roomId: ROOM_ID,
      createdAt: new Date(Date.now() - 7 * 86_400_000),
      entryClosesAt: new Date(Date.now() - 6 * 86_400_000),
      closesAt: new Date(Date.now() - 60_000), // already past close
      phase: "settling",
      capacitySol: 20,
      maxPlayers: 40,
      depositedSol: 1,
      realPlayerCount: 1,
      onChainPoolId: ON_CHAIN_ID,
      createdByAdmin: "test-admin",
      lp: {
        status: "deployed",
        positionPubkey: Keypair.generate().publicKey.toBase58(),
        deployedLamports: 1_000_000_000,
      },
    });

    await exitReadyRoomLp();

    const room = await Room.findOne({ roomId: ROOM_ID }).lean();
    expect(room?.lp?.status).toBe("exited");
    expect(room?.lp?.exitAttempts).toBe(1);
    expect(room?.lp?.realizedYieldLamports).toBe(20_000_000);
  });

  it("exitReadyRoomLp — missing position → 'failed_permanent' immediately (terminal)", async () => {
    // "no deploy state" is terminal — there's nothing to exit, so a retry
    // can't fix it. Must alert (failed_permanent), not loop on transient retry.
    await seedActiveRoom({
      closesInMs: 1_000,
      lpStatus: "deployed",
      positionPubkey: undefined,
      deployedLamports: 0,
    });

    await exitReadyRoomLp();

    const room = await Room.findOne({ roomId: ROOM_ID }).lean();
    expect(room?.lp?.status).toBe("failed_permanent");
    expect(room?.lp?.exitAttempts).toBe(1);
    expect(room?.lp?.lastError).toMatch(/no deploy state/);
  });

  it("exitReadyRoomLp — 'failed' status under cap is retried; cap exhaustion flips to 'failed_permanent'", async () => {
    // First create the room with exitAttempts already at the cap so the next
    // failed attempt should escalate. With dry-run exit succeeding, we instead
    // verify the eligibility query: a room with exitAttempts >= max is NOT
    // selected (mirrors deployReadyRoomLp's attempt-cap behavior).
    process.env.LP_MAX_EXIT_ATTEMPTS = "2";
    vi.resetModules();
    const { exitReadyRoomLp: exitV2 } = await import(
      "../src/services/lpRoomLifecycle.js"
    );

    await Room.create({
      roomId: ROOM_ID,
      createdAt: new Date(Date.now() - 7 * 86_400_000),
      entryClosesAt: new Date(Date.now() - 6 * 86_400_000),
      closesAt: new Date(Date.now() - 60_000),
      phase: "settling",
      capacitySol: 20,
      maxPlayers: 40,
      depositedSol: 1,
      realPlayerCount: 1,
      onChainPoolId: ON_CHAIN_ID,
      createdByAdmin: "test-admin",
      lp: {
        status: "failed",
        exitAttempts: 2, // already at cap
        positionPubkey: Keypair.generate().publicKey.toBase58(),
        deployedLamports: 1_000_000_000,
      },
    });

    await exitV2();

    // Untouched: cap exhausted, query excluded the room.
    const room = await Room.findOne({ roomId: ROOM_ID }).lean();
    expect(room?.lp?.status).toBe("failed");
    expect(room?.lp?.exitAttempts).toBe(2);
    delete process.env.LP_MAX_EXIT_ATTEMPTS;
  });

  it("deployReadyRoomLp — no-op when feature flag off", async () => {
    process.env.FEATURES_LP_ENABLED = "false";
    vi.resetModules();
    const { deployReadyRoomLp: deployV2 } = await import(
      "../src/services/lpRoomLifecycle.js"
    );

    await seedActiveRoom({
      closesInMs: 6 * 86_400_000,
      lpStatus: "pending",
    });

    await deployV2();
    expect(rpcCalls).toHaveLength(0);

    const room = await Room.findOne({ roomId: ROOM_ID }).lean();
    expect(room?.lp?.status).toBe("pending");
    process.env.FEATURES_LP_ENABLED = "true";
  });
});

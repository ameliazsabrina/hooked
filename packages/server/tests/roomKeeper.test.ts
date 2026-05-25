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
import { Player, Room } from "../src/db/schema.js";
import {
  startTestMongo,
  stopTestMongo,
  clearAllCollections,
} from "./setup.js";


type MockEntry = {
  authority: PublicKey;
  returned: boolean;
  depositLamports?: bigint;
};

type MockState = {
  roomStatus: number;
  entries: MockEntry[];
  rpcFailFor: Set<string>;
  rpcCalls: Array<{ method: string; recipient?: string }>;
  vaultBalanceLamports: bigint;
  rentExemptLamports: bigint;
  firstPlace?: PublicKey;
  secondPlace?: PublicKey;
  thirdPlace?: PublicKey;
};

let state: MockState;

function makeMockProgram() {
  const SYSTEM = new PublicKey("11111111111111111111111111111111");
  const account = {
    room: {
      fetchNullable: vi.fn(async () => ({
        status: state.roomStatus,
        firstPlace: state.firstPlace ?? SYSTEM,
        secondPlace: state.secondPlace ?? SYSTEM,
        thirdPlace: state.thirdPlace ?? SYSTEM,
      })),
      fetch: vi.fn(async () => ({
        status: state.roomStatus,
        firstPlace: state.firstPlace ?? SYSTEM,
        secondPlace: state.secondPlace ?? SYSTEM,
        thirdPlace: state.thirdPlace ?? SYSTEM,
      })),
    },
    roomEntry: {
      all: vi.fn(async () =>
        state.entries.map((e) => ({
          account: {
            authority: e.authority,
            returned: e.returned,
            depositLamports: new BN(
              (e.depositLamports ?? 1_000_000_000n).toString(),
            ),
          },
        })),
      ),
      fetchNullable: vi.fn(),
    },
  };

  const provider = {
    connection: {
      getBalance: vi.fn(async () => Number(state.vaultBalanceLamports)),
      getMinimumBalanceForRentExemption: vi.fn(
        async () => Number(state.rentExemptLamports),
      ),
    },
  };

  const makeChain = (method: string) => ({
    accounts: () => ({
      rpc: vi.fn(async () => {
        if (method === "returnPrincipal") {
          const last = state.rpcCalls[state.rpcCalls.length - 1];
          if (last?.recipient && state.rpcFailFor.has(last.recipient)) {
            throw new Error("simulated RPC failure");
          }
          if (last?.recipient) {
            const e = state.entries.find(
              (en) => en.authority.toBase58() === last.recipient,
            );
            if (e) e.returned = true;
          }
          return `tx-${method}-${last?.recipient ?? "unknown"}`;
        }
        if (method === "closeRoom") {
          state.roomStatus = 2;
        }
        if (method === "finalizeRoom") {
          state.roomStatus = 3;
        }
        return `tx-${method}`;
      }),
    }),
  });

  const methods = {
    closeRoom: vi.fn((..._args: unknown[]) => {
      state.rpcCalls.push({ method: "closeRoom" });
      return makeChain("closeRoom");
    }),
    returnPrincipal: vi.fn((_amount: BN) => {
      const chain = {
        accounts: (accs: { recipient: PublicKey }) => {
          state.rpcCalls.push({
            method: "returnPrincipal",
            recipient: accs.recipient.toBase58(),
          });
          return chain;
        },
        rpc: vi.fn(async () => {
          const last = state.rpcCalls[state.rpcCalls.length - 1];
          const recipient = last?.recipient;
          if (recipient && state.rpcFailFor.has(recipient)) {
            throw new Error("simulated RPC failure");
          }
          if (recipient) {
            const e = state.entries.find(
              (en) => en.authority.toBase58() === recipient,
            );
            if (e) e.returned = true;
          }
          return `tx-returnPrincipal-${recipient ?? "unknown"}`;
        }),
      };
      return chain;
    }),
    finalizeRoom: vi.fn(() => {
      state.rpcCalls.push({ method: "finalizeRoom" });
      const chain = {
        accounts: () => chain,
        rpc: vi.fn(async () => {
          state.roomStatus = 3;
          return "tx-finalizeRoom";
        }),
      };
      return chain;
    }),
  };

  return {
    program: { account, methods, provider },
    signer: Keypair.generate(),
  };
}

vi.mock("../src/solana/roomsProgram.js", async () => {
  return {
    getRoomsProgram: vi.fn(() => makeMockProgram()),
    getRoomPda: vi.fn(() => Keypair.generate().publicKey),
    getRoomVaultPda: vi.fn(() => Keypair.generate().publicKey),
    getRoomEntryPda: vi.fn((_room: PublicKey, auth: PublicKey) => auth),
    getProgramConfigPda: vi.fn(() => Keypair.generate().publicKey),
    // Required by configCache.isProgramPaused (called inside settleRoom).
    // The fishing program ConfigCache prefers ADMIN over TREASURY when
    // both are loaded; returning null here forces the cache to short-
    // circuit to "not paused" via a defensive try/catch, which is what
    // we want for tests.
    loadAdminKeypair: vi.fn(() => null),
    loadTreasuryKeypair: vi.fn(() => null),
  };
});

// configCache reads the program config to determine pause state. With
// both keypair loaders mocked to null in the roomsProgram mock above,
// configCache.isProgramPaused short-circuits to false via getRoomsProgram
// returning null — but mocking it directly is sturdier and isolates this
// suite from configCache implementation drift.
vi.mock("../src/solana/configCache.js", () => ({
  isProgramPaused: vi.fn(async () => false),
  getProgramConfigCached: vi.fn(async () => null),
}));

const { settleRoom } = await import("../src/services/roomKeeper.js");

const ROOM_ID = "R-1";
const ON_CHAIN_ID = "1";

async function seedRoomAndPlayers(wallets: string[]) {
  await Room.create({
    roomId: ROOM_ID,
    createdAt: new Date(Date.now() - 8 * 86_400_000),
    entryClosesAt: new Date(Date.now() - 7 * 86_400_000),
    closesAt: new Date(Date.now() - 86_400_000),
    phase: "settling",
    capacitySol: 20,
    maxPlayers: 40,
    depositedSol: wallets.length,
    realPlayerCount: wallets.length,
    onChainPoolId: ON_CHAIN_ID,
    players: wallets.map((w) => ({
      walletAddress: w,
      deposit: 1,
      depositTxSignature: `dep-${w}`,
      depositedAt: new Date(),
      returned: false,
    })),
    createdByAdmin: "test-admin",
  });

  for (const w of wallets) {
    await Player.create({
      walletAddress: w,
      nickname: `nick-${w.slice(0, 8)}`,
      deposits: [
        {
          poolId: ROOM_ID,
          amount: 1,
          depositTxSignature: `dep-${w}`,
          activeMonth: "2026-04",
          depositedAt: new Date(),
          expiresAt: new Date(Date.now() + 86_400_000),
          returned: false,
        },
      ],
    });
  }
}

function makeWallets(n: number): string[] {
  return Array.from({ length: n }, () =>
    Keypair.generate().publicKey.toBase58(),
  );
}

describe("roomKeeper.settleRoom", () => {
  beforeAll(async () => {
    await startTestMongo();
  });
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearAllCollections();
    state = {
      roomStatus: 1, // active — settleRoom will close to 2
      entries: [],
      rpcFailFor: new Set(),
      rpcCalls: [],
      // Default: vault is well-funded so the B2 precondition passes for
      // happy-path tests. Tests for B2 override this to a smaller value.
      vaultBalanceLamports: 1_000_000_000_000n,
      rentExemptLamports: 0n,
    };
  });

  it("happy path: returns SOL to all human entries and updates both collections", async () => {
    const wallets = makeWallets(3);
    await seedRoomAndPlayers(wallets);
    state.entries = wallets.map((w) => ({
      authority: new PublicKey(w),
      returned: false,
    }));

    const res = await settleRoom(ROOM_ID);

    expect(res.status).toBe("ok");
    expect(res.returned).toBe(3);
    expect(res.failed).toBe(0);

    const room = await Room.findOne({ roomId: ROOM_ID }).lean();
    expect(room?.phase).toBe("closed");
    for (const w of wallets) {
      const rp = room?.players.find((p) => p.walletAddress === w);
      expect(rp?.returned).toBe(true);
      expect(rp?.returnTxSignature).toMatch(/^tx-returnPrincipal-/);
      expect(rp?.returnedAt).toBeInstanceOf(Date);
    }

    for (const w of wallets) {
      const player = await Player.findOne({ walletAddress: w }).lean();
      const dep = player?.deposits.find((d) => d.poolId === ROOM_ID);
      expect(dep?.returned).toBe(true);
      expect(dep?.returnTxSignature).toMatch(/^tx-returnPrincipal-/);
      expect(dep?.returnedAt).toBeInstanceOf(Date);
    }
  });

  it("RPC failure on one entry: that entry stays unreturned, others succeed", async () => {
    const wallets = makeWallets(3);
    await seedRoomAndPlayers(wallets);
    state.rpcFailFor = new Set([wallets[1]]);
    state.entries = wallets.map((w) => ({
      authority: new PublicKey(w),
      returned: false,
    }));

    const res = await settleRoom(ROOM_ID);
    expect(res.returned).toBe(2);
    expect(res.failed).toBe(1);

    // The failed wallet stays returned=false in both collections
    const room = await Room.findOne({ roomId: ROOM_ID }).lean();
    const failedRoomEntry = room?.players.find(
      (p) => p.walletAddress === wallets[1],
    );
    expect(failedRoomEntry?.returned).toBe(false);

    const failedPlayer = await Player.findOne({
      walletAddress: wallets[1],
    }).lean();
    expect(failedPlayer?.deposits[0]?.returned).toBe(false);

    // The successful ones did flip
    const okPlayer = await Player.findOne({
      walletAddress: wallets[0],
    }).lean();
    expect(okPlayer?.deposits[0]?.returned).toBe(true);
  });

  it("reconciles entries that are returned on-chain but stale in Mongo (the production lockout bug)", async () => {
    const wallets = makeWallets(2);
    await seedRoomAndPlayers(wallets);
    // Simulate the prod bug: on-chain is already returned, but Player.deposits
    // and Room.players are still false because the old keeper never updated
    // the Player collection.
    state.entries = wallets.map((w) => ({
      authority: new PublicKey(w),
      returned: true,
    }));

    const res = await settleRoom(ROOM_ID);
    expect(res.returned).toBe(0);
    expect(res.reconciled).toBe(2);
    expect(res.failed).toBe(0);

    // No returnPrincipal calls — already returned on-chain
    const rpCalls = state.rpcCalls.filter(
      (c) => c.method === "returnPrincipal",
    );
    expect(rpCalls).toHaveLength(0);

    // But both Mongo collections must now reflect returned=true
    for (const w of wallets) {
      const player = await Player.findOne({ walletAddress: w }).lean();
      expect(player?.deposits[0]?.returned).toBe(true);
      expect(player?.deposits[0]?.returnedAt).toBeInstanceOf(Date);
    }
    const room = await Room.findOne({ roomId: ROOM_ID }).lean();
    for (const w of wallets) {
      const rp = room?.players.find((p) => p.walletAddress === w);
      expect(rp?.returned).toBe(true);
    }
  });

  it("calls close_room when on-chain status < 2, skips when already settling", async () => {
    const wallets = makeWallets(1);
    await seedRoomAndPlayers(wallets);
    state.roomStatus = 1;
    state.entries = wallets.map((w) => ({
      authority: new PublicKey(w),
      returned: false,
    }));
    await settleRoom(ROOM_ID);
    expect(
      state.rpcCalls.filter((c) => c.method === "closeRoom"),
    ).toHaveLength(1);

    // Reset and run again with status already 2
    await clearAllCollections();
    await seedRoomAndPlayers(wallets);
    state.rpcCalls = [];
    state.roomStatus = 2;
    state.entries = wallets.map((w) => ({
      authority: new PublicKey(w),
      returned: false,
    }));
    await settleRoom(ROOM_ID);
    expect(
      state.rpcCalls.filter((c) => c.method === "closeRoom"),
    ).toHaveLength(0);
  });

  it("returns skipped when room not found", async () => {
    const res = await settleRoom("does-not-exist");
    expect(res.status).toBe("skipped");
  });

  // === B2: vault precondition before close_room ===
  // Post-2026-05-18 incident: if the vault is short, do NOT advance past
  // close_room. close_room → return_principal × N with an empty vault is
  // recoverable (vault can be topped up), but close_room → finalize_room
  // (the old B1 bug) makes the room terminal. Stay in settling instead.

  it("B2: skips close_room when vault is short of unreturned principal", async () => {
    const wallets = makeWallets(3);
    await seedRoomAndPlayers(wallets);
    state.roomStatus = 1;
    state.entries = wallets.map((w) => ({
      authority: new PublicKey(w),
      returned: false,
      depositLamports: 500_000_000n, // 0.5 SOL each = 1.5 SOL total
    }));
    state.vaultBalanceLamports = 1_000_000_000n; // only 1.0 SOL — short

    const res = await settleRoom(ROOM_ID);

    expect(res.status).toBe("skipped");
    expect(res.message).toMatch(/vault insufficient before close_room/);
    // close_room MUST NOT run when vault is short.
    expect(
      state.rpcCalls.filter((c) => c.method === "closeRoom"),
    ).toHaveLength(0);
    expect(
      state.rpcCalls.filter((c) => c.method === "returnPrincipal"),
    ).toHaveLength(0);
    expect(
      state.rpcCalls.filter((c) => c.method === "finalizeRoom"),
    ).toHaveLength(0);

    // Room stays in settling so the next tick can retry after a top-up.
    const room = await Room.findOne({ roomId: ROOM_ID }).lean();
    expect(room?.phase).toBe("settling");
  });

  it("B2: includes yield + rent-exempt in required-balance check", async () => {
    const wallets = makeWallets(1);
    await seedRoomAndPlayers(wallets);
    state.roomStatus = 1;
    state.entries = wallets.map((w) => ({
      authority: new PublicKey(w),
      returned: false,
      depositLamports: 1_000_000_000n,
    }));
    // Vault holds exactly the principal but no headroom for yield/rent.
    state.vaultBalanceLamports = 1_000_000_000n;
    state.rentExemptLamports = 890_880n;
    await Room.updateOne(
      { roomId: ROOM_ID },
      { $set: { "lp.realizedYieldLamports": 100_000_000n.toString() } },
    );
    // Required = 1.0 SOL principal + 0.1 SOL yield + 0.000890 rent ~= 1.100890 SOL
    // Vault has only 1.0 SOL → short.
    const res = await settleRoom(ROOM_ID);
    expect(res.status).toBe("skipped");
    expect(
      state.rpcCalls.filter((c) => c.method === "closeRoom"),
    ).toHaveLength(0);
  });

  it("B2: passes precondition when vault exactly equals required (boundary)", async () => {
    const wallets = makeWallets(2);
    await seedRoomAndPlayers(wallets);
    state.roomStatus = 1;
    state.entries = wallets.map((w) => ({
      authority: new PublicKey(w),
      returned: false,
      depositLamports: 500_000_000n,
    }));
    state.vaultBalanceLamports = 1_000_000_000n; // exactly principal sum
    state.rentExemptLamports = 0n;

    const res = await settleRoom(ROOM_ID);

    expect(res.status).toBe("ok");
    expect(
      state.rpcCalls.filter((c) => c.method === "closeRoom"),
    ).toHaveLength(1);
  });

  it("B2: skips precondition when status >= 2 (close_room already ran)", async () => {
    // If close_room already ran on a previous tick, we trust the chain's
    // own VaultInsufficientFunds revert for return_principal. The B2 check
    // gates the close_room transition only.
    const wallets = makeWallets(1);
    await seedRoomAndPlayers(wallets);
    state.roomStatus = 2; // close_room already done
    state.entries = wallets.map((w) => ({
      authority: new PublicKey(w),
      returned: false,
      depositLamports: 1_000_000_000n,
    }));
    state.vaultBalanceLamports = 100_000n; // short of principal

    // The mocked program's returnPrincipal succeeds (it doesn't simulate
    // VaultInsufficientFunds), so we expect "ok" with 1 returned. In real
    // chain a short vault would revert and `failed` would tick — also OK
    // for our gate. The point of this test is: the B2 precondition did
    // NOT block the run when status was already 2.
    const res = await settleRoom(ROOM_ID);
    expect(res.status).toBe("ok");
    expect(res.returned).toBe(1);
  });

  // === B1: finalize_room gate ===
  // Only finalize when every entry is settled. Finalize closes the vault
  // on-chain and the room becomes terminal — never finalize an in-progress
  // settlement or we lock unpaid entries out of recovery.

  it("B1: skips finalize_room when any return_principal failed", async () => {
    const wallets = makeWallets(3);
    await seedRoomAndPlayers(wallets);
    state.rpcFailFor = new Set([wallets[1]]);
    state.entries = wallets.map((w) => ({
      authority: new PublicKey(w),
      returned: false,
    }));

    const res = await settleRoom(ROOM_ID);
    expect(res.returned).toBe(2);
    expect(res.failed).toBe(1);

    // finalize_room MUST NOT run when even a single entry failed.
    expect(
      state.rpcCalls.filter((c) => c.method === "finalizeRoom"),
    ).toHaveLength(0);

    // Room stays in settling so the failed entry can retry next tick.
    const room = await Room.findOne({ roomId: ROOM_ID }).lean();
    expect(room?.phase).toBe("settling");

    // Successful entries are still flagged returned=true so they're not
    // double-paid on the next tick.
    const okPlayer = await Player.findOne({
      walletAddress: wallets[0],
    }).lean();
    expect(okPlayer?.deposits[0]?.returned).toBe(true);
  });

  it("B1: finalizes when all entries are reconciled (no fresh returns needed)", async () => {
    const wallets = makeWallets(2);
    await seedRoomAndPlayers(wallets);
    // All entries already returned on-chain — just need the DB reconcile
    // path to flip Mongo. No return_principal calls, but finalize SHOULD
    // still run because (returned + reconciled === humanCount) and failed===0.
    state.entries = wallets.map((w) => ({
      authority: new PublicKey(w),
      returned: true,
    }));

    const res = await settleRoom(ROOM_ID);
    expect(res.returned).toBe(0);
    expect(res.reconciled).toBe(2);
    expect(res.failed).toBe(0);

    expect(
      state.rpcCalls.filter((c) => c.method === "finalizeRoom"),
    ).toHaveLength(1);
    const room = await Room.findOne({ roomId: ROOM_ID }).lean();
    expect(room?.phase).toBe("closed");
  });

  it("B1: finalizes on empty room (humanCount=0) — degenerate but safe", async () => {
    const wallets = makeWallets(0);
    await seedRoomAndPlayers(wallets);
    state.entries = [];
    state.roomStatus = 1;

    const res = await settleRoom(ROOM_ID);
    expect(res.returned).toBe(0);
    expect(res.reconciled).toBe(0);
    expect(res.failed).toBe(0);

    // No entries to pay → safe to finalize. close_room runs first, then
    // finalize. (Vault precondition trivially passes because 0+0+0 ≤ any.)
    expect(
      state.rpcCalls.filter((c) => c.method === "finalizeRoom"),
    ).toHaveLength(1);
  });

  it("B1 + B2 interaction: vault short → skip close_room, no finalize call", async () => {
    const wallets = makeWallets(2);
    await seedRoomAndPlayers(wallets);
    state.roomStatus = 1;
    state.entries = wallets.map((w) => ({
      authority: new PublicKey(w),
      returned: false,
      depositLamports: 1_000_000_000n,
    }));
    state.vaultBalanceLamports = 100n; // basically empty

    const res = await settleRoom(ROOM_ID);
    expect(res.status).toBe("skipped");
    expect(
      state.rpcCalls.filter((c) => c.method === "closeRoom"),
    ).toHaveLength(0);
    expect(
      state.rpcCalls.filter((c) => c.method === "finalizeRoom"),
    ).toHaveLength(0);

    // Room stays in settling, ready for retry once vault is funded.
    const room = await Room.findOne({ roomId: ROOM_ID }).lean();
    expect(room?.phase).toBe("settling");
  });
});

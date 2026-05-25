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

import { Player } from "../src/db/schema.js";
import {
  startTestMongo,
  stopTestMongo,
  clearAllCollections,
} from "./setup.js";

const sendRawTxSpy = vi.fn(async () => "tx-sig-finalize");
const confirmTxSpy = vi.fn(async () => ({ value: { err: null } }));
const getLatestBlockhashSpy = vi.fn(async () => ({
  blockhash: "11111111111111111111111111111111",
  lastValidBlockHeight: 100,
}));

const entryStore = new Map<
  string,
  { finalScore?: BN | null; score?: BN | null }
>();

vi.mock("@solana/web3.js", async (orig) => {
  const real = (await orig()) as typeof import("@solana/web3.js");
  return {
    ...real,
    ComputeBudgetProgram: real.ComputeBudgetProgram,
  };
});

vi.mock("../src/solana/roomsProgram.js", () => ({
  getRoomEntryPda: vi.fn((_room: PublicKey, auth: PublicKey) => auth),
}));

const { finalizeRoomLeaderboardOnChain } = await import(
  "../src/services/roomLeaderboardFinalize.js"
);

function makeFakeProgram() {
  const updateRoomEntryScoreSpy = vi.fn((amount: BN) => ({
    accountsPartial: () => ({
      instruction: vi.fn(async () => ({
        keys: [],
        programId: Keypair.generate().publicKey,
        data: Buffer.from(amount.toArray("le")),
      })),
    }),
  }));
  return {
    program: {
      account: {
        roomEntry: {
          fetchNullable: vi.fn(async (pda: PublicKey) =>
            entryStore.get(pda.toBase58()) ?? null,
          ),
        },
      },
      methods: {
        updateRoomEntryScore: updateRoomEntryScoreSpy,
      },
      provider: {
        connection: {
          getLatestBlockhash: getLatestBlockhashSpy,
          sendRawTransaction: sendRawTxSpy,
          confirmTransaction: confirmTxSpy,
        },
      },
    },
    updateRoomEntryScoreSpy,
  };
}

function makeFakeRedis(top: { playerId: string; score: number }[]) {
  return {
    zrevrange: vi.fn(async () =>
      top.flatMap((t) => [t.playerId, String(t.score)]),
    ),
  };
}

const ROOM_ID = "R-test";
const ROOM_PDA = new PublicKey("11111111111111111111111111111112");
const KEEPER = Keypair.generate();

describe("finalizeRoomLeaderboardOnChain", () => {
  beforeAll(async () => {
    await startTestMongo();
  });
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearAllCollections();
    sendRawTxSpy.mockClear();
    confirmTxSpy.mockClear();
    getLatestBlockhashSpy.mockClear();
    entryStore.clear();
  });

  async function seedPlayers(
    players: { playerId?: string; wallet: string }[],
  ) {
    const docs: { _id: string; walletAddress: string }[] = [];
    for (const p of players) {
      const player = await Player.create({
        walletAddress: p.wallet,
        nickname: `t_${p.wallet.slice(0, 6)}`,
      });
      docs.push({ _id: String(player._id), walletAddress: p.wallet });
    }
    return docs;
  }

  it("noop when redis is null", async () => {
    const fake = makeFakeProgram();
    const logged: string[] = [];
    const result = await finalizeRoomLeaderboardOnChain({
      redis: null,
      program: fake.program as never,
      keeper: KEEPER,
      roomId: ROOM_ID,
      roomPda: ROOM_PDA,
      logger: {
        info: (s) => logged.push(s),
        error: (s) => logged.push("ERR " + s),
      },
    });
    expect(result.pushed).toBe(0);
    expect(result.detectedScoreBridgeGap).toBe(false);
    expect(logged.join("\n")).toContain("no redis client");
    expect(fake.updateRoomEntryScoreSpy).not.toHaveBeenCalled();
  });

  it("noop when keeper is null (logs degradation loudly)", async () => {
    const fake = makeFakeProgram();
    const errors: string[] = [];
    const result = await finalizeRoomLeaderboardOnChain({
      redis: makeFakeRedis([]) as never,
      program: fake.program as never,
      keeper: null,
      roomId: ROOM_ID,
      roomPda: ROOM_PDA,
      logger: { info: () => {}, error: (s) => errors.push(s) },
    });
    expect(result.pushed).toBe(0);
    // Must log loudly so the operator sees the degradation.
    expect(errors.join("\n")).toMatch(/KEEPER_KEYPAIR not set/);
    expect(fake.updateRoomEntryScoreSpy).not.toHaveBeenCalled();
  });

  it("noop + zero gap when Redis is empty", async () => {
    const fake = makeFakeProgram();
    const result = await finalizeRoomLeaderboardOnChain({
      redis: makeFakeRedis([]) as never,
      program: fake.program as never,
      keeper: KEEPER,
      roomId: ROOM_ID,
      roomPda: ROOM_PDA,
      logger: { info: () => {}, error: () => {} },
    });
    expect(result).toMatchObject({
      pushed: 0,
      alreadyCurrent: 0,
      skipped: 0,
      detectedScoreBridgeGap: false,
    });
    expect(fake.updateRoomEntryScoreSpy).not.toHaveBeenCalled();
  });

  it("pushes update_room_entry_score for each top-3 with Redis ahead of chain", async () => {
    const w1 = Keypair.generate().publicKey.toBase58();
    const w2 = Keypair.generate().publicKey.toBase58();
    const w3 = Keypair.generate().publicKey.toBase58();
    const players = await seedPlayers([
      { wallet: w1 },
      { wallet: w2 },
      { wallet: w3 },
    ]);
    // On-chain entries exist with finalScore=0 → Redis ahead by full score.
    for (const p of players) {
      entryStore.set(p.walletAddress, { finalScore: new BN(0) });
    }

    const fake = makeFakeProgram();
    const result = await finalizeRoomLeaderboardOnChain({
      redis: makeFakeRedis([
        { playerId: players[0]._id, score: 170 },
        { playerId: players[1]._id, score: 167 },
        { playerId: players[2]._id, score: 113 },
      ]) as never,
      program: fake.program as never,
      keeper: KEEPER,
      roomId: ROOM_ID,
      roomPda: ROOM_PDA,
      logger: { info: () => {}, error: () => {} },
    });
    expect(result.pushed).toBe(3);
    expect(result.alreadyCurrent).toBe(0);
    expect(result.detectedScoreBridgeGap).toBe(true);

    // updateRoomEntryScore called with deltas matching redis scores.
    const calls = fake.updateRoomEntryScoreSpy.mock.calls;
    expect(calls.map((c: [BN]) => c[0].toNumber()).sort((a, b) => a - b)).toEqual([113, 167, 170]);
    expect(sendRawTxSpy).toHaveBeenCalledTimes(3);
  });

  it("alreadyCurrent when on-chain score matches Redis (idempotent on a healthy room)", async () => {
    const w1 = Keypair.generate().publicKey.toBase58();
    const w2 = Keypair.generate().publicKey.toBase58();
    const players = await seedPlayers([{ wallet: w1 }, { wallet: w2 }]);
    entryStore.set(w1, { finalScore: new BN(170) });
    entryStore.set(w2, { finalScore: new BN(167) });

    const fake = makeFakeProgram();
    const result = await finalizeRoomLeaderboardOnChain({
      redis: makeFakeRedis([
        { playerId: players[0]._id, score: 170 },
        { playerId: players[1]._id, score: 167 },
      ]) as never,
      program: fake.program as never,
      keeper: KEEPER,
      roomId: ROOM_ID,
      roomPda: ROOM_PDA,
      logger: { info: () => {}, error: () => {} },
    });
    expect(result.pushed).toBe(0);
    expect(result.alreadyCurrent).toBe(2);
    expect(result.detectedScoreBridgeGap).toBe(false);
    expect(sendRawTxSpy).not.toHaveBeenCalled();
  });

  it("skips entries with no matching Player document or no on-chain entry", async () => {
    const w1 = Keypair.generate().publicKey.toBase58();
    const players = await seedPlayers([{ wallet: w1 }]);
    // No entryStore entry for w1 → fetchNullable returns null → skipped.
    const fake = makeFakeProgram();
    const result = await finalizeRoomLeaderboardOnChain({
      redis: makeFakeRedis([
        { playerId: players[0]._id, score: 100 },
        { playerId: "0000000000000000000000aa", score: 50 }, // unknown player
      ]) as never,
      program: fake.program as never,
      keeper: KEEPER,
      roomId: ROOM_ID,
      roomPda: ROOM_PDA,
      logger: { info: () => {}, error: () => {} },
    });
    expect(result.pushed).toBe(0);
    expect(result.skipped).toBe(2);
    expect(sendRawTxSpy).not.toHaveBeenCalled();
  });

  it("records errors but continues across entries", async () => {
    const w1 = Keypair.generate().publicKey.toBase58();
    const w2 = Keypair.generate().publicKey.toBase58();
    const players = await seedPlayers([{ wallet: w1 }, { wallet: w2 }]);
    entryStore.set(w1, { score: new BN(0) });
    entryStore.set(w2, { score: new BN(0) });

    // Fail the first send, succeed on the second.
    let calls = 0;
    sendRawTxSpy.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("RPC blip");
      return "tx-ok";
    });

    const fake = makeFakeProgram();
    const result = await finalizeRoomLeaderboardOnChain({
      redis: makeFakeRedis([
        { playerId: players[0]._id, score: 100 },
        { playerId: players[1]._id, score: 50 },
      ]) as never,
      program: fake.program as never,
      keeper: KEEPER,
      roomId: ROOM_ID,
      roomPda: ROOM_PDA,
      logger: { info: () => {}, error: () => {} },
    });
    expect(result.pushed).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.detectedScoreBridgeGap).toBe(true); // gap still detected
  });

  it("handles redis score that is fractional or negative (clamps + rounds)", async () => {
    const w1 = Keypair.generate().publicKey.toBase58();
    const players = await seedPlayers([{ wallet: w1 }]);
    entryStore.set(w1, { score: new BN(0) });
    const fake = makeFakeProgram();
    await finalizeRoomLeaderboardOnChain({
      redis: makeFakeRedis([{ playerId: players[0]._id, score: 99.7 }]) as never,
      program: fake.program as never,
      keeper: KEEPER,
      roomId: ROOM_ID,
      roomPda: ROOM_PDA,
      logger: { info: () => {}, error: () => {} },
    });
    // Math.round(99.7) === 100 → delta 100.
    const delta = fake.updateRoomEntryScoreSpy.mock.calls[0][0] as BN;
    expect(delta.toNumber()).toBe(100);
  });
});

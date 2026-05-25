import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { Keypair } from "@solana/web3.js";
import { startTestMongo, stopTestMongo, clearAllCollections } from "./setup.js";

const treasury = Keypair.generate();
vi.mock("../src/solana/roomsProgram.js", () => ({
  loadTreasuryKeypair: () => treasury,
}));

const sendRawTransaction = vi.fn();
const getBalance = vi.fn();
const getLatestBlockhash = vi.fn();
const confirmTransaction = vi.fn();
const getSignatureStatus = vi.fn();

vi.mock("@solana/web3.js", async () => {
  const actual =
    await vi.importActual<typeof import("@solana/web3.js")>(
      "@solana/web3.js",
    );
  return {
    ...actual,
    Connection: vi.fn().mockImplementation(() => ({
      sendRawTransaction,
      getBalance,
      getLatestBlockhash,
      confirmTransaction,
      getSignatureStatus,
    })),
  };
});

const { processPoolPayout } = await import("../src/jobs/payoutWorker.js");
const { PoolTier } = await import("../src/db/schema.js");

function makeJob(data: any): any {
  return { data, log: vi.fn() };
}

async function seedPoolWithWinner(overrides: {
  rank: number;
  walletAddress: string;
  prizeSol: number;
  paid?: boolean;
  signature?: string | null;
  attempts?: number;
}) {
  const doc = await PoolTier.create({
    tier: 1,
    activeMonth: "2026-04",
    status: "closed",
    onChainPoolId: "1",
    winners: [
      {
        rank: overrides.rank,
        walletAddress: overrides.walletAddress,
        displayName: "Test",
        prizeSol: overrides.prizeSol,
        paid: overrides.paid ?? false,
        signature: overrides.signature ?? null,
        paidAt: null,
        attempts: overrides.attempts ?? 0,
        lastError: null,
      },
    ],
  });
  return doc;
}

describe("payoutWorker — idempotency", () => {
  beforeAll(async () => {
    await startTestMongo();
  });
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearAllCollections();
    sendRawTransaction.mockReset();
    getBalance.mockReset();
    getLatestBlockhash.mockReset();
    confirmTransaction.mockReset();
    getSignatureStatus.mockReset();

    getBalance.mockResolvedValue(10_000_000_000);
    getLatestBlockhash.mockResolvedValue({
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 1,
    });
    sendRawTransaction.mockResolvedValue("fake-sig");
    confirmTransaction.mockResolvedValue({ value: { err: null } });
  });

  it("skips a winner that is already marked paid", async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const pool = await seedPoolWithWinner({
      rank: 1,
      walletAddress: wallet,
      prizeSol: 0.5,
      paid: true,
      signature: "prior-sig",
    });

    await processPoolPayout(
      makeJob({
        playerId: "dummy",
        walletAddress: wallet,
        prizeSOL: 0.5,
        poolId: "1",
        poolDocId: pool._id.toString(),
        rank: 1,
      }),
    );

    expect(sendRawTransaction).not.toHaveBeenCalled();
    expect(getLatestBlockhash).not.toHaveBeenCalled();
  });

  it("marks a winner paid when the prior signature was already confirmed on-chain", async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const pool = await seedPoolWithWinner({
      rank: 1,
      walletAddress: wallet,
      prizeSol: 0.5,
      signature: "prior-sig",
      attempts: 1,
    });

    getSignatureStatus.mockResolvedValue({
      value: { confirmationStatus: "confirmed", err: null },
    });

    await processPoolPayout(
      makeJob({
        playerId: "dummy",
        walletAddress: wallet,
        prizeSOL: 0.5,
        poolId: "1",
        poolDocId: pool._id.toString(),
        rank: 1,
      }),
    );

    expect(sendRawTransaction).not.toHaveBeenCalled();

    const updated = await PoolTier.findById(pool._id).lean();
    expect(updated?.winners[0].paid).toBe(true);
    expect(updated?.winners[0].signature).toBe("prior-sig");
  });

  it("clears a failed prior signature and proceeds with a fresh attempt", async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const pool = await seedPoolWithWinner({
      rank: 1,
      walletAddress: wallet,
      prizeSol: 0.5,
      signature: "failed-sig",
      attempts: 1,
    });

    getSignatureStatus.mockResolvedValue({
      value: { confirmationStatus: null, err: "TxFailed" },
    });

    await processPoolPayout(
      makeJob({
        playerId: "dummy",
        walletAddress: wallet,
        prizeSOL: 0.5,
        poolId: "1",
        poolDocId: pool._id.toString(),
        rank: 1,
      }),
    );

    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(confirmTransaction).toHaveBeenCalledTimes(1);

    const updated = await PoolTier.findById(pool._id).lean();
    expect(updated?.winners[0].paid).toBe(true);
    expect(updated?.winners[0].signature).toBeTruthy();
    expect(updated?.winners[0].signature).not.toBe("failed-sig");
    expect(updated?.winners[0].attempts).toBe(2);
  });

  it("persists the signature before confirming, so a crash post-send doesn't cause a re-sign", async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const pool = await seedPoolWithWinner({
      rank: 1,
      walletAddress: wallet,
      prizeSol: 0.5,
    });

    let sigAtSendTime: string | null | undefined;
    sendRawTransaction.mockImplementation(async () => {
      const doc = await PoolTier.findById(pool._id).lean();
      sigAtSendTime = doc?.winners[0].signature;
      return "fake-sig";
    });

    await processPoolPayout(
      makeJob({
        playerId: "dummy",
        walletAddress: wallet,
        prizeSOL: 0.5,
        poolId: "1",
        poolDocId: pool._id.toString(),
        rank: 1,
      }),
    );

    expect(sigAtSendTime).toBeTruthy();
    expect(typeof sigAtSendTime).toBe("string");

    const final = await PoolTier.findById(pool._id).lean();
    expect(final?.winners[0].paid).toBe(true);
    expect(final?.winners[0].signature).toBe(sigAtSendTime);
  });

  it("throws (and does not mark paid) when treasury balance is insufficient", async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const pool = await seedPoolWithWinner({
      rank: 1,
      walletAddress: wallet,
      prizeSol: 0.5,
    });
    getBalance.mockResolvedValue(0);

    await expect(
      processPoolPayout(
        makeJob({
          playerId: "dummy",
          walletAddress: wallet,
          prizeSOL: 0.5,
          poolId: "1",
          poolDocId: pool._id.toString(),
          rank: 1,
        }),
      ),
    ).rejects.toThrow(/Treasury balance too low/);

    expect(sendRawTransaction).not.toHaveBeenCalled();
    const doc = await PoolTier.findById(pool._id).lean();
    expect(doc?.winners[0].paid).toBe(false);
    expect(doc?.winners[0].signature).toBeNull();
  });

  it("records lastError when confirmation fails", async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const pool = await seedPoolWithWinner({
      rank: 1,
      walletAddress: wallet,
      prizeSol: 0.5,
    });
    confirmTransaction.mockRejectedValue(new Error("confirmation timeout"));

    await expect(
      processPoolPayout(
        makeJob({
          playerId: "dummy",
          walletAddress: wallet,
          prizeSOL: 0.5,
          poolId: "1",
          poolDocId: pool._id.toString(),
          rank: 1,
        }),
      ),
    ).rejects.toThrow(/confirmation timeout/);

    const doc = await PoolTier.findById(pool._id).lean();
    expect(doc?.winners[0].paid).toBe(false);
    expect(doc?.winners[0].signature).toBeTruthy();
    expect(doc?.winners[0].lastError).toMatch(/confirmation timeout/);
  });
});

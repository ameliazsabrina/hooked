import { randomBytes } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "vitest";

import { Catch, FishingSession, Player, Room } from "../src/db/schema.js";
import {
  processScoreBridge,
  type ScoreBridgeSubmitter,
} from "../src/jobs/scoreBridge.js";
import {
  decodeScoreBridgeMemo,
  encodeScoreBridgeMemo,
} from "../src/services/fishing/memo.js";
import {
  clearAllCollections,
  startTestMongo,
  stopTestMongo,
} from "./setup.js";

beforeAll(async () => {
  await startTestMongo();
  await FishingSession.syncIndexes();
  await Catch.syncIndexes();
});
afterAll(async () => {
  await stopTestMongo();
});
afterEach(async () => {
  await clearAllCollections();
});

const TEST_KEEPER = Keypair.generate();
const presentKeeper = () => TEST_KEEPER;
const absentKeeper = () => null;

function makeMockSubmitter(signature?: string): ScoreBridgeSubmitter & {
  calls: Array<Parameters<ScoreBridgeSubmitter["submit"]>[0]>;
} {
  const calls: Array<Parameters<ScoreBridgeSubmitter["submit"]>[0]> = [];
  return {
    calls,
    async submit(input) {
      calls.push(input);
      return signature ?? "sig-" + randomBytes(8).toString("hex");
    },
  };
}

async function createCommittedSession(opts: {
  wallet?: string;
  sessionScore?: number;
  catchCount?: number;
  withDeposit?: boolean;
  withRoom?: boolean;
  onChainPoolId?: string | null;
  merkleRoot?: Buffer | null;
} = {}) {
  const wallet =
    opts.wallet ??
    Keypair.generate().publicKey.toBase58();
  const player = await Player.create({
    walletAddress: wallet,
    nickname: `t_${randomBytes(4).toString("hex")}`,
    deposits:
      opts.withDeposit === false
        ? []
        : [
            {
              poolId: "room-test-1",
              amount: 1.0,
              depositTxSignature: "sig-" + randomBytes(8).toString("hex"),
              activeMonth: "2026-05",
              depositedAt: new Date(),
              expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
              returned: false,
            },
          ],
  });

  if (opts.withRoom !== false) {
    await Room.create({
      roomId: "room-test-1",
      createdAt: new Date(),
      entryClosesAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      closesAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      onChainPoolId: opts.onChainPoolId === undefined ? "1" : opts.onChainPoolId,
      createdByAdmin: "admin-test",
    });
  }

  const session = await FishingSession.create({
    playerId: player._id,
    walletAddress: wallet,
    dateKey: 20_000,
    window: 0,
    baitInitial: 10,
    baitRemaining: 0,
    tier: 1,
    sessionScore: opts.sessionScore ?? 100,
    castCount: 5,
    catchCount: opts.catchCount ?? 3,
    status: "committed",
    committedAt: new Date(),
    merkleRoot:
      opts.merkleRoot === undefined
        ? Buffer.alloc(32, 0xab)
        : opts.merkleRoot,
    dailySeedDate: "2026-05-09",
  });
  return { player, session, wallet };
}

describe("encodeScoreBridgeMemo / decodeScoreBridgeMemo", () => {
  test("round-trips a sessionId + merkleRoot", () => {
    const sessionId = "0123456789abcdef01234567";
    const merkleRoot = Buffer.alloc(32, 0xfe);
    const memo = encodeScoreBridgeMemo({ sessionId, merkleRoot });
    const decoded = decodeScoreBridgeMemo(memo);
    expect(decoded?.sessionId).toBe(sessionId);
    expect(decoded?.merkleRoot.equals(merkleRoot)).toBe(true);
  });

  test("rejects 16-byte merkle root", () => {
    expect(() =>
      encodeScoreBridgeMemo({
        sessionId: "0123456789abcdef01234567",
        merkleRoot: Buffer.alloc(16),
      }),
    ).toThrow();
  });

  test("rejects malformed sessionId", () => {
    expect(() =>
      encodeScoreBridgeMemo({
        sessionId: "not-an-objectid",
        merkleRoot: Buffer.alloc(32),
      }),
    ).toThrow();
  });

  test("returns null on decode of unrelated memo", () => {
    expect(decodeScoreBridgeMemo("just a regular memo")).toBeNull();
    expect(decodeScoreBridgeMemo("hooked-v1|toofewparts")).toBeNull();
    expect(
      decodeScoreBridgeMemo("v999|0123456789abcdef01234567|" + "f".repeat(64)),
    ).toBeNull();
  });

  test("memo total length is bounded", () => {
    const memo = encodeScoreBridgeMemo({
      sessionId: "0123456789abcdef01234567",
      merkleRoot: Buffer.alloc(32, 0xff),
    });
    // version|sessionId|hex = 9+1+24+1+64 = 99
    expect(memo.length).toBeLessThan(150);
  });
});

describe("processScoreBridge", () => {
  test("submitted: builds memo + delegates to submitter + persists signature", async () => {
    const { session } = await createCommittedSession({ sessionScore: 250 });
    const submitter = makeMockSubmitter("real-sig-abc");
    const outcome = await processScoreBridge(String(session._id), {
      submitter,
      keeperLoader: presentKeeper,
    });

    expect(outcome.status).toBe("submitted");
    expect(outcome.signature).toBe("real-sig-abc");
    expect(submitter.calls).toHaveLength(1);
    const call = submitter.calls[0];
    expect(call.scoreDelta).toBe(250n);

    const decoded = decodeScoreBridgeMemo(call.memo);
    expect(decoded).not.toBeNull();
    expect(decoded!.sessionId).toBe(String(session._id));
    expect(decoded!.merkleRoot.length).toBe(32);

    const reloaded = await FishingSession.findById(session._id);
    expect(reloaded?.chainScoreTxSignature).toBe("real-sig-abc");
    expect(reloaded?.chainScoreBridgedAt).toBeTruthy();
  });

  test("idempotent: second call returns already-bridged without re-submitting", async () => {
    const { session } = await createCommittedSession();
    const submitter = makeMockSubmitter("first-sig");

    const first = await processScoreBridge(String(session._id), {
      submitter,
      keeperLoader: presentKeeper,
    });
    expect(first.status).toBe("submitted");

    const second = await processScoreBridge(String(session._id), {
      submitter,
      keeperLoader: presentKeeper,
    });
    expect(second.status).toBe("already-bridged");
    expect(second.signature).toBe("first-sig");
    expect(submitter.calls).toHaveLength(1);
  });

  test("zero score: short-circuits with sentinel, no submission", async () => {
    const { session } = await createCommittedSession({ sessionScore: 0 });
    const submitter = makeMockSubmitter();
    const outcome = await processScoreBridge(String(session._id), {
      submitter,
      keeperLoader: presentKeeper,
    });

    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("zero-score");
    expect(submitter.calls).toHaveLength(0);

    const reloaded = await FishingSession.findById(session._id);
    expect(reloaded?.chainScoreTxSignature).toBe("skipped:zero-score");
  });

  test("no keeper configured: marks sentinel, doesn't submit", async () => {
    const { session } = await createCommittedSession({ sessionScore: 100 });
    const submitter = makeMockSubmitter();
    const outcome = await processScoreBridge(String(session._id), {
      submitter,
      keeperLoader: absentKeeper,
    });

    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("no-keeper-keypair");
    expect(submitter.calls).toHaveLength(0);

    const reloaded = await FishingSession.findById(session._id);
    expect(reloaded?.chainScoreTxSignature).toBe("skipped:no-keeper");
  });

  test("session not found: skipped without DB write", async () => {
    const submitter = makeMockSubmitter();
    const outcome = await processScoreBridge("000000000000000000000000", {
      submitter,
      keeperLoader: presentKeeper,
    });
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("session-not-found");
    expect(submitter.calls).toHaveLength(0);
  });

  test("non-committed session: skipped (status sentinel)", async () => {
    const { session } = await createCommittedSession();
    await FishingSession.updateOne({ _id: session._id }, { $set: { status: "active" } });
    const submitter = makeMockSubmitter();
    const outcome = await processScoreBridge(String(session._id), {
      submitter,
      keeperLoader: presentKeeper,
    });
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("session-status-active");
  });

  test("no active deposit: skipped", async () => {
    const { session } = await createCommittedSession({ withDeposit: false });
    const submitter = makeMockSubmitter();
    const outcome = await processScoreBridge(String(session._id), {
      submitter,
      keeperLoader: presentKeeper,
    });
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("no-active-deposit");
  });

  test("room not on-chain yet: skipped", async () => {
    const { session } = await createCommittedSession({ onChainPoolId: null });
    const submitter = makeMockSubmitter();
    const outcome = await processScoreBridge(String(session._id), {
      submitter,
      keeperLoader: presentKeeper,
    });
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("room-not-on-chain");
  });

  test("missing merkleRoot: skipped (would otherwise crash submitter)", async () => {
    const { session } = await createCommittedSession({ merkleRoot: null });
    const submitter = makeMockSubmitter();
    const outcome = await processScoreBridge(String(session._id), {
      submitter,
      keeperLoader: presentKeeper,
    });
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("missing-merkle-root");
    expect(submitter.calls).toHaveLength(0);
  });

  test("derives correct entryPda from session walletAddress and room", async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const { session } = await createCommittedSession({ wallet });
    const submitter = makeMockSubmitter();
    await processScoreBridge(String(session._id), {
      submitter,
      keeperLoader: presentKeeper,
    });

    expect(submitter.calls).toHaveLength(1);
    const call = submitter.calls[0];
    expect(call.authority.toBase58()).toBe(wallet);
    expect(call.entryPda).toBeInstanceOf(PublicKey);
    expect(call.roomPda).toBeInstanceOf(PublicKey);
    expect(call.keeper.publicKey.toBase58()).toBe(TEST_KEEPER.publicKey.toBase58());
  });
});

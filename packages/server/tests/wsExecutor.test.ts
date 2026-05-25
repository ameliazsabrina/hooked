import { randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";
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
  executeCancelOnDisconnectOffchain,
  executeInitiateCastOffchain,
  executeSubmitResolveOffchain,
} from "../src/services/fishing/wsExecutor.js";
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

async function createTestPlayer(opts: {
  depositSol?: number;
  roomPhase?: "entry" | "active" | "settling" | "closed";
  roomClosesAt?: Date;
  skipRoom?: boolean;
} = {}) {
  const wallet = Keypair.generate();
  const roomId = `room-test-${randomBytes(4).toString("hex")}`;
  const closesAt =
    opts.roomClosesAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const phase = opts.roomPhase ?? "active";

  if (opts.depositSol && !opts.skipRoom) {
    // Cast-gate (ensureActiveSession) now looks the room up by deposit.poolId.
    // Tests that exercise the happy path need a matching active room; tests
    // that exercise WINDOW_CLOSED override phase / closesAt.
    await Room.create({
      roomId,
      onChainPoolId: null,
      phase,
      entryClosesAt: new Date(Date.now() - 1000),
      closesAt,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      capacitySol: 100,
      depositedSol: 0,
      maxPlayers: 50,
      realPlayerCount: 0,
      players: [],
      createdByAdmin: "test-suite",
    });
  }

  const player = await Player.create({
    walletAddress: wallet.publicKey.toBase58(),
    nickname: `t_${randomBytes(4).toString("hex")}`,
    deposits: opts.depositSol
      ? [
          {
            poolId: roomId,
            amount: opts.depositSol,
            depositTxSignature: "sig-" + randomBytes(8).toString("hex"),
            activeMonth: "2026-05",
            depositedAt: new Date(),
            expiresAt: closesAt,
            returned: false,
          },
        ]
      : [],
  });
  return { wallet, player, roomId };
}

describe("executeInitiateCastOffchain", () => {
  test("auto-creates a session and rolls a cast", async () => {
    const { wallet } = await createTestPlayer({ depositSol: 1.0 });
    const result = await executeInitiateCastOffchain(wallet.publicKey, "client-cast-1");

    expect(result.sessionId).toMatch(/^[0-9a-f]{24}$/);
    expect(result.rolled.speciesId).toBeGreaterThanOrEqual(0);
    expect([0, 1, 2, 3, 4]).toContain(result.rolled.rarity);
    expect([0, 1]).toContain(result.rolled.mechanic);
    expect(result.rolled.weightHg).toBeGreaterThan(0);
    expect(result.rolled.rngSeed).toBeGreaterThan(0);

    // Session row created with bait debited.
    const session = await FishingSession.findById(result.sessionId);
    expect(session?.baitInitial).toBe(10);
    expect(session?.baitRemaining).toBe(9);
    expect(session?.castCount).toBe(1);
    expect(session?.pendingCast).not.toBeNull();
  });

  test("idempotent session-creation: chain two casts on the same session", async () => {
    const { wallet } = await createTestPlayer({ depositSol: 1.0 });
    const first = await executeInitiateCastOffchain(wallet.publicKey, "c1");
    // Resolve so the second initiate doesn't trip CAST_PENDING.
    await executeSubmitResolveOffchain(first.sessionId, false);
    const second = await executeInitiateCastOffchain(wallet.publicKey, "c2");
    expect(second.sessionId).toBe(first.sessionId);

    const session = await FishingSession.findById(first.sessionId);
    expect(session?.castCount).toBe(2);
    expect(session?.baitRemaining).toBe(8);
  });

  test("rejects when player has no active deposit", async () => {
    const { wallet } = await createTestPlayer();
    await expect(
      executeInitiateCastOffchain(wallet.publicKey, "c1"),
    ).rejects.toMatchObject({ code: "NO_BAIT" });
  });

  test("rejects when wallet has no Player document", async () => {
    const wallet = Keypair.generate();
    await expect(
      executeInitiateCastOffchain(wallet.publicKey, "c1"),
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });

  // === Cast-gate (WINDOW_CLOSED) — defense-in-depth from 2026-05-18 incident.
  // Without these tests, a wedged settlement keeper that fails to flip
  // `deposits[].returned` would let players keep casting on a closed room.

  test("WINDOW_CLOSED: rejects when room phase is 'settling'", async () => {
    const { wallet } = await createTestPlayer({
      depositSol: 1.0,
      roomPhase: "settling",
    });
    await expect(
      executeInitiateCastOffchain(wallet.publicKey, "c1"),
    ).rejects.toMatchObject({ code: "WINDOW_CLOSED" });
  });

  test("WINDOW_CLOSED: rejects when room phase is 'closed'", async () => {
    const { wallet } = await createTestPlayer({
      depositSol: 1.0,
      roomPhase: "closed",
    });
    await expect(
      executeInitiateCastOffchain(wallet.publicKey, "c1"),
    ).rejects.toMatchObject({ code: "WINDOW_CLOSED" });
  });

  test("WINDOW_CLOSED: rejects when closesAt has passed even if phase is 'active'", async () => {
    // This is the exact race condition that bit the 2026-05-18 incident:
    // the lifecycle tick hadn't run yet to flip phase active→settling, but
    // the wall clock had passed closesAt. Without this check, the cast
    // path would silently allow casting until the next tick.
    const { wallet } = await createTestPlayer({
      depositSol: 1.0,
      roomPhase: "active",
      roomClosesAt: new Date(Date.now() - 1000),
    });
    await expect(
      executeInitiateCastOffchain(wallet.publicKey, "c1"),
    ).rejects.toMatchObject({ code: "WINDOW_CLOSED" });
  });

  test("WINDOW_CLOSED: rejects when deposit points to a room that no longer exists", async () => {
    // A deposit row outlives its Room only via direct DB tampering or a
    // legacy migration; treat it as a closed window.
    const { wallet } = await createTestPlayer({
      depositSol: 1.0,
      skipRoom: true,
    });
    await expect(
      executeInitiateCastOffchain(wallet.publicKey, "c1"),
    ).rejects.toMatchObject({ code: "WINDOW_CLOSED" });
  });

  test("happy path: phase 'entry' is still allowed (deposits open, gameplay live)", async () => {
    const { wallet } = await createTestPlayer({
      depositSol: 1.0,
      roomPhase: "entry",
    });
    const result = await executeInitiateCastOffchain(wallet.publicKey, "c1");
    expect(result.sessionId).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe("executeSubmitResolveOffchain", () => {
  test("hit: writes catch and returns score > 0", async () => {
    const { wallet } = await createTestPlayer({ depositSol: 1.0 });
    const cast = await executeInitiateCastOffchain(wallet.publicKey, "c1");
    const result = await executeSubmitResolveOffchain(cast.sessionId, true);
    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThan(0);

    const catches = await Catch.find({ sessionId: cast.sessionId });
    expect(catches.length).toBe(1);
  });

  test("miss: returns 0 score, no catch written", async () => {
    const { wallet } = await createTestPlayer({ depositSol: 1.0 });
    const cast = await executeInitiateCastOffchain(wallet.publicKey, "c1");
    const result = await executeSubmitResolveOffchain(cast.sessionId, false);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(0);

    const catches = await Catch.find({ sessionId: cast.sessionId });
    expect(catches.length).toBe(0);
  });

  test("returns null when no pending cast (race)", async () => {
    const { wallet } = await createTestPlayer({ depositSol: 1.0 });
    const cast = await executeInitiateCastOffchain(wallet.publicKey, "c1");
    await executeSubmitResolveOffchain(cast.sessionId, true);
    // Second call has nothing to resolve — gateway interprets null as "race"
    // and falls back to its own scoring.
    const second = await executeSubmitResolveOffchain(cast.sessionId, true);
    expect(second).toBeNull();
  });
});

describe("executeCancelOnDisconnectOffchain", () => {
  test("refunds bait when called within grace window", async () => {
    const { wallet } = await createTestPlayer({ depositSol: 1.0 });
    const cast = await executeInitiateCastOffchain(wallet.publicKey, "c1");
    const before = await FishingSession.findById(cast.sessionId);
    expect(before?.baitRemaining).toBe(9);

    await executeCancelOnDisconnectOffchain(cast.sessionId);
    const after = await FishingSession.findById(cast.sessionId);
    expect(after?.baitRemaining).toBe(10);
    expect(after?.pendingCast).toBeNull();
    // castCount stays incremented (RNG monotonicity).
    expect(after?.castCount).toBe(1);
  });

  test("silently no-ops with no pending cast (post-resolve disconnect)", async () => {
    const { wallet } = await createTestPlayer({ depositSol: 1.0 });
    const cast = await executeInitiateCastOffchain(wallet.publicKey, "c1");
    await executeSubmitResolveOffchain(cast.sessionId, true);
    // A trailing disconnect after resolve shouldn't throw.
    await expect(
      executeCancelOnDisconnectOffchain(cast.sessionId),
    ).resolves.toBeUndefined();
  });

  test("silently no-ops on unknown session id", async () => {
    await expect(
      executeCancelOnDisconnectOffchain("000000000000000000000000"),
    ).resolves.toBeUndefined();
  });
});

describe("end-to-end gateway-style flow", () => {
  test("cast → resolve hit → cast again chains correctly", async () => {
    const { wallet } = await createTestPlayer({ depositSol: 1.0 });

    const cast1 = await executeInitiateCastOffchain(wallet.publicKey, "c1");
    expect(cast1.rolled.speciesId).toBeGreaterThanOrEqual(0);

    const result1 = await executeSubmitResolveOffchain(cast1.sessionId, true);
    expect(result1!.score).toBeGreaterThan(0);

    const cast2 = await executeInitiateCastOffchain(wallet.publicKey, "c2");
    expect(cast2.sessionId).toBe(cast1.sessionId);

    // Different cast index → likely different roll. Persistence sanity:
    const session = await FishingSession.findById(cast1.sessionId);
    expect(session?.castCount).toBe(2);
    expect(session?.catchCount).toBe(1);
    expect(session?.sessionScore).toBeGreaterThan(0);
  });

  test("cast → cancel → cast again keeps castCount monotonic", async () => {
    const { wallet } = await createTestPlayer({ depositSol: 1.0 });

    const cast1 = await executeInitiateCastOffchain(wallet.publicKey, "c1");
    expect(cast1.rolled).toBeDefined();
    await executeCancelOnDisconnectOffchain(cast1.sessionId);

    const cast2 = await executeInitiateCastOffchain(wallet.publicKey, "c2");
    const session = await FishingSession.findById(cast1.sessionId);
    // castCount: 1 (cast1, kept after cancel) + 1 (cast2) = 2. RNG slot 1
    // cannot be re-rolled.
    expect(session?.castCount).toBe(2);
    // Bait: started 10, cast1 → 9, cancel → 10, cast2 → 9.
    expect(session?.baitRemaining).toBe(9);
    expect(cast2).toBeDefined();
  });
});

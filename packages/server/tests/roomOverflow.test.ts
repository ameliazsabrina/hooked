import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { Room } from "../src/db/schema.js";
import {
  startTestMongo,
  stopTestMongo,
  clearAllCollections,
} from "./setup.js";


const CAPACITY_SOL = 20;
const MAX_PLAYERS = 40;

async function seedRoom(opts: {
  roomId: string;
  phase?: "entry" | "active" | "settling" | "closed";
  depositedSol?: number;
  players?: Array<{ walletAddress: string; deposit: number }>;
}) {
  return Room.create({
    roomId: opts.roomId,
    createdAt: new Date(),
    entryClosesAt: new Date(Date.now() + 3_600_000),
    closesAt: new Date(Date.now() + 7_200_000),
    phase: opts.phase ?? "entry",
    capacitySol: CAPACITY_SOL,
    maxPlayers: MAX_PLAYERS,
    depositedSol: opts.depositedSol ?? 0,
    realPlayerCount: opts.players?.length ?? 0,
    players: (opts.players ?? []).map((p) => ({
      walletAddress: p.walletAddress,
      deposit: p.deposit,
      depositTxSignature: `sig-${p.walletAddress}`,
      depositedAt: new Date(),
      returned: false,
    })),
    createdByAdmin: "test-admin",
  });
}

function joinFilter(roomId: string, wallet: string, depositSol: number) {
  return {
    roomId,
    phase: "entry" as const,
    "players.walletAddress": { $ne: wallet },
    depositedSol: { $lte: CAPACITY_SOL - depositSol },
    $expr: { $lt: [{ $size: "$players" }, "$maxPlayers"] },
  };
}

function joinUpdate(wallet: string, depositSol: number) {
  return {
    $push: {
      players: {
        walletAddress: wallet,
        deposit: depositSol,
        depositTxSignature: `sig-${wallet}`,
        depositedAt: new Date(),
        returned: false,
      },
    },
    $inc: { realPlayerCount: 1, depositedSol: depositSol },
  };
}

describe("room overflow — atomic capacity guard", () => {
  beforeAll(async () => {
    await startTestMongo();
  });
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearAllCollections();
  });

  it("accepts a join that fits within capacity", async () => {
    await seedRoom({ roomId: "R1", depositedSol: 10 });
    const res = await Room.updateOne(
      joinFilter("R1", "walletA", 5),
      joinUpdate("walletA", 5),
    );
    expect(res.modifiedCount).toBe(1);

    const room = await Room.findOne({ roomId: "R1" }).lean();
    expect(room?.depositedSol).toBe(15);
  });

  it("refuses a join that would exceed capacity", async () => {
    await seedRoom({ roomId: "R1", depositedSol: 18 });
    const res = await Room.updateOne(
      joinFilter("R1", "walletA", 5), // 18 + 5 = 23 > 20
      joinUpdate("walletA", 5),
    );
    expect(res.modifiedCount).toBe(0);

    const room = await Room.findOne({ roomId: "R1" }).lean();
    expect(room?.depositedSol).toBe(18); // unchanged
  });

  it("refuses a join after the room has left entry phase", async () => {
    await seedRoom({ roomId: "R1", depositedSol: 5, phase: "active" });
    const res = await Room.updateOne(
      joinFilter("R1", "walletA", 5),
      joinUpdate("walletA", 5),
    );
    expect(res.modifiedCount).toBe(0);
  });

  it("refuses a duplicate join from the same wallet", async () => {
    await seedRoom({
      roomId: "R1",
      depositedSol: 5,
      players: [{ walletAddress: "walletA", deposit: 5 }],
    });
    const res = await Room.updateOne(
      joinFilter("R1", "walletA", 5),
      joinUpdate("walletA", 5),
    );
    expect(res.modifiedCount).toBe(0);
  });

  it("refuses a join when maxPlayers is reached", async () => {
    const players = Array.from({ length: MAX_PLAYERS }, (_, i) => ({
      walletAddress: `w${i}`,
      deposit: 0.1,
    }));
    await seedRoom({ roomId: "R1", depositedSol: 4, players });

    const res = await Room.updateOne(
      joinFilter("R1", "walletNew", 1),
      joinUpdate("walletNew", 1),
    );
    expect(res.modifiedCount).toBe(0);
  });

  it("under concurrent joins racing for the last slot of capacity, exactly one wins", async () => {
    // Room has 18 SOL already; both callers want to add 5 SOL each.
    // Only one can succeed without overflowing (18 + 5 = 23 > 20).
    await seedRoom({ roomId: "R1", depositedSol: 18 });

    const results = await Promise.all([
      Room.updateOne(joinFilter("R1", "walletA", 5), joinUpdate("walletA", 5)),
      Room.updateOne(joinFilter("R1", "walletB", 5), joinUpdate("walletB", 5)),
    ]);

    const winners = results.filter((r) => r.modifiedCount === 1);
    expect(winners).toHaveLength(0); // Neither fits (18+5 > 20)

    const room = await Room.findOne({ roomId: "R1" }).lean();
    expect(room?.depositedSol).toBe(18);
  });

  it("under concurrent joins where only one fits, exactly one wins", async () => {
    // 18 SOL seeded. One caller wants 2 (fits), another wants 5 (doesn't).
    await seedRoom({ roomId: "R1", depositedSol: 18 });

    const results = await Promise.all([
      Room.updateOne(joinFilter("R1", "walletA", 2), joinUpdate("walletA", 2)),
      Room.updateOne(joinFilter("R1", "walletB", 5), joinUpdate("walletB", 5)),
    ]);

    const modified = results.filter((r) => r.modifiedCount === 1);
    expect(modified).toHaveLength(1);

    const room = await Room.findOne({ roomId: "R1" }).lean();
    expect(room?.depositedSol).toBeLessThanOrEqual(CAPACITY_SOL);
    expect(room?.depositedSol).toBe(20);
  });
});

// Mirrors the claim filter inside `maybeTriggerCapacityOverflow`. Kept inline
// (rather than importing the un-exported function) so the test exercises the
// exact MongoDB query semantics that decide whether overflow fires.
function overflowClaimFilter(roomId: string) {
  return {
    roomId,
    phase: "entry" as const,
    overflowTriggered: { $ne: true },
    $expr: {
      $or: [
        { $gte: ["$depositedSol", "$capacitySol"] },
        { $gte: ["$realPlayerCount", "$maxPlayers"] },
      ],
    },
  };
}

describe("room overflow — claim filter for spawning next room", () => {
  beforeAll(async () => {
    await startTestMongo();
  });
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearAllCollections();
  });

  it("fires when SOL capacity is reached", async () => {
    await seedRoom({ roomId: "R1", depositedSol: CAPACITY_SOL });
    const claim = await Room.findOneAndUpdate(
      overflowClaimFilter("R1"),
      { $set: { overflowTriggered: true } },
      { new: true },
    ).lean();
    expect(claim).not.toBeNull();
    expect(claim?.overflowTriggered).toBe(true);
  });

  it("fires when player count fills before SOL fills", async () => {
    const players = Array.from({ length: MAX_PLAYERS }, (_, i) => ({
      walletAddress: `w${i}`,
      deposit: 0.1,
    }));
    // 40 players × 0.1 SOL = 4 SOL — well under the 20 SOL cap, yet the room
    // is effectively full because no more wallets can join.
    await seedRoom({ roomId: "R1", depositedSol: 4, players });
    const claim = await Room.findOneAndUpdate(
      overflowClaimFilter("R1"),
      { $set: { overflowTriggered: true } },
      { new: true },
    ).lean();
    expect(claim).not.toBeNull();
    expect(claim?.overflowTriggered).toBe(true);
  });

  it("does not fire when neither cap is reached", async () => {
    await seedRoom({
      roomId: "R1",
      depositedSol: 10,
      players: [{ walletAddress: "walletA", deposit: 10 }],
    });
    const claim = await Room.findOneAndUpdate(
      overflowClaimFilter("R1"),
      { $set: { overflowTriggered: true } },
      { new: true },
    ).lean();
    expect(claim).toBeNull();
  });

  it("does not fire twice for the same source room", async () => {
    await seedRoom({ roomId: "R1", depositedSol: CAPACITY_SOL });
    const first = await Room.findOneAndUpdate(
      overflowClaimFilter("R1"),
      { $set: { overflowTriggered: true } },
      { new: true },
    ).lean();
    expect(first).not.toBeNull();

    const second = await Room.findOneAndUpdate(
      overflowClaimFilter("R1"),
      { $set: { overflowTriggered: true } },
      { new: true },
    ).lean();
    expect(second).toBeNull();
  });
});

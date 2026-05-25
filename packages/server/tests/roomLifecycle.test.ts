import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { Room } from "../src/db/schema.js";
import {
  startTestMongo,
  stopTestMongo,
  clearAllCollections,
} from "./setup.js";

const settleAllReadyRoomsMock = vi.fn(async () => [] as unknown[]);
const createRoomOnChainAndDbMock = vi.fn();

vi.mock("../src/services/roomKeeper.js", () => ({
  settleAllReadyRooms: settleAllReadyRoomsMock,
}));

vi.mock("../src/services/roomFactory.js", () => ({
  createRoomOnChainAndDb: createRoomOnChainAndDbMock,
}));

const { runRoomLifecycleTick, createRoomLifecycleWorker } = await import(
  "../src/jobs/roomLifecycle.js"
);

async function seedRoom(opts: {
  roomId: string;
  phase: "entry" | "active" | "settling" | "closed";
  entryClosesAt: Date;
  closesAt: Date;
  createdAt?: Date;
  onChainPoolId?: string | null;
}) {
  return Room.create({
    roomId: opts.roomId,
    createdAt:
      opts.createdAt ?? new Date(opts.entryClosesAt.getTime() - 86_400_000),
    entryClosesAt: opts.entryClosesAt,
    closesAt: opts.closesAt,
    phase: opts.phase,
    capacitySol: 20,
    maxPlayers: 40,
    depositedSol: 0,
    realPlayerCount: 0,
    players: [],
    createdByAdmin: "test-admin",
    onChainPoolId: opts.onChainPoolId ?? null,
  });
}

describe("roomLifecycle phase transitions", () => {
  beforeAll(async () => {
    await startTestMongo();
  });
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearAllCollections();
    settleAllReadyRoomsMock.mockClear();
    createRoomOnChainAndDbMock.mockReset();
    createRoomOnChainAndDbMock.mockImplementation(async () => {
      const now = new Date();
      const newRoomId = `R-rot-${Date.now()}`;
      await Room.create({
        roomId: newRoomId,
        createdAt: now,
        entryClosesAt: new Date(now.getTime() + 86_400_000),
        closesAt: new Date(now.getTime() + 7 * 86_400_000),
        phase: "entry",
        capacitySol: 20,
        maxPlayers: 40,
        depositedSol: 0,
        realPlayerCount: 0,
        onChainPoolId: "999",
        onChainPoolAddress: "Pda999",
        createdByAdmin: "system:rotation",
      });
      return {
        ok: true,
        roomId: newRoomId,
        createdAt: now,
        entryClosesAt: new Date(now.getTime() + 86_400_000),
        closesAt: new Date(now.getTime() + 7 * 86_400_000),
        phase: "entry" as const,
        onChainRoomId: "999",
        onChainRoomAddress: "Pda999",
        txSignature: "tx-rotation",
      };
    });
  });

  it("transitions entry → active when entryClosesAt has passed", async () => {
    await seedRoom({
      roomId: "R1",
      phase: "entry",
      entryClosesAt: new Date(Date.now() - 1000),
      closesAt: new Date(Date.now() + 86_400_000),
    });
    await runRoomLifecycleTick();
    const room = await Room.findOne({ roomId: "R1" }).lean();
    expect(room?.phase).toBe("active");
  });

  it("does not transition entry → active when entryClosesAt is in the future", async () => {
    await seedRoom({
      roomId: "R1",
      phase: "entry",
      entryClosesAt: new Date(Date.now() + 60_000),
      closesAt: new Date(Date.now() + 86_400_000),
    });
    await runRoomLifecycleTick();
    const room = await Room.findOne({ roomId: "R1" }).lean();
    expect(room?.phase).toBe("entry");
  });

  it("transitions active → settling when closesAt has passed", async () => {
    await seedRoom({
      roomId: "R1",
      phase: "active",
      entryClosesAt: new Date(Date.now() - 86_400_000),
      closesAt: new Date(Date.now() - 1000),
    });
    await runRoomLifecycleTick();
    const room = await Room.findOne({ roomId: "R1" }).lean();
    expect(room?.phase).toBe("settling");
  });

  it("calls settleAllReadyRooms exactly once per tick", async () => {
    await seedRoom({
      roomId: "R1",
      phase: "settling",
      entryClosesAt: new Date(Date.now() - 86_400_000),
      closesAt: new Date(Date.now() - 1000),
    });
    await runRoomLifecycleTick();
    expect(settleAllReadyRoomsMock).toHaveBeenCalledTimes(1);
  });

  it("does not move a closed room", async () => {
    await seedRoom({
      roomId: "R1",
      phase: "closed",
      entryClosesAt: new Date(Date.now() - 86_400_000),
      closesAt: new Date(Date.now() - 1000),
    });
    await runRoomLifecycleTick();
    const room = await Room.findOne({ roomId: "R1" }).lean();
    expect(room?.phase).toBe("closed");
  });

  it("auto-creates a successor room when the only entry-phase room transitions out", async () => {
    await seedRoom({
      roomId: "R1",
      phase: "entry",
      entryClosesAt: new Date(Date.now() - 1000),
      closesAt: new Date(Date.now() + 86_400_000),
    });
    await runRoomLifecycleTick();
    expect(createRoomOnChainAndDbMock).toHaveBeenCalledTimes(1);
    expect(createRoomOnChainAndDbMock).toHaveBeenCalledWith({
      createdBy: "system:rotation",
      trigger: "system:rotation",
    });
    const entryRooms = await Room.find({ phase: "entry" }).lean();
    expect(entryRooms).toHaveLength(1);
  });

  it("does not rotate when another entry-phase room is still available", async () => {
    // R1 transitions out, but R2 is still in entry phase → no rotation needed.
    await seedRoom({
      roomId: "R1",
      phase: "entry",
      entryClosesAt: new Date(Date.now() - 1000),
      closesAt: new Date(Date.now() + 86_400_000),
    });
    await seedRoom({
      roomId: "R2",
      phase: "entry",
      entryClosesAt: new Date(Date.now() + 86_400_000),
      closesAt: new Date(Date.now() + 7 * 86_400_000),
      onChainPoolId: "1",
    });
    await runRoomLifecycleTick();
    expect(createRoomOnChainAndDbMock).not.toHaveBeenCalled();
  });

  it("logs the factory skip reason when watchdog cannot create a room", async () => {
    createRoomOnChainAndDbMock.mockReset();
    createRoomOnChainAndDbMock.mockResolvedValue({
      ok: false,
      skipped: true,
      reason: "paused",
    });

    await seedRoom({
      roomId: "R1",
      phase: "entry",
      entryClosesAt: new Date(Date.now() - 1000),
      closesAt: new Date(Date.now() + 86_400_000),
    });

    const logs: string[] = [];
    await runRoomLifecycleTick((msg) => logs.push(msg));

    expect(createRoomOnChainAndDbMock).toHaveBeenCalledTimes(1);
    expect(logs.some((m) => m.includes("watchdog: skipped (paused)"))).toBe(
      true,
    );
    const entryRooms = await Room.find({ phase: "entry" }).lean();
    expect(entryRooms).toHaveLength(0);
  });

  it("does not crash if rotation throws — logs the error and continues to settle", async () => {
    createRoomOnChainAndDbMock.mockReset();
    createRoomOnChainAndDbMock.mockRejectedValue(new Error("rpc down"));

    await seedRoom({
      roomId: "R1",
      phase: "entry",
      entryClosesAt: new Date(Date.now() - 1000),
      closesAt: new Date(Date.now() + 86_400_000),
    });

    const logs: string[] = [];
    await runRoomLifecycleTick((msg) => logs.push(msg));

    expect(logs.some((m) => m.includes("watchdog: error rpc down"))).toBe(true);
    // settle still ran
    expect(settleAllReadyRoomsMock).toHaveBeenCalledTimes(1);
  });

  it("worker factory is exported", () => {
    expect(typeof createRoomLifecycleWorker).toBe("function");
  });
});

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

process.env.FEATURES_LP_ENABLED = "true";
process.env.LP_DRY_RUN = "true";
process.env.LP_DRY_RUN_YIELD_LAMPORTS = "0";
process.env.LP_KILL_SWITCH = "false";
process.env.IL_BUFFER_LAMPORTS_MIN = "0";
process.env.LP_MANAGER_KEYPAIR = JSON.stringify(
  Array.from(Keypair.generate().secretKey),
);

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

// Hoisted spies for the deploy-path tests. Defined here (outside any test
// block) so vi.mock factories can close over them — vi.mock is hoisted to
// the top of the file, so referencing them inside the factory works as
// long as the variables themselves are declared above the mock call.
const dlmmInitSpy = vi.fn(async () => ({
  // Minimal Transaction-shaped object: lpManager assigns feePayer/recentBlockhash
  // and calls .sign() + .serialize() on it. The mocked Connection.sendRawTransaction
  // ignores the bytes, so any sign/serialize-capable stub works.
  feePayer: null as PublicKey | null,
  recentBlockhash: "",
  sign() {},
  serialize() {
    return Buffer.from([]);
  },
}));
const dlmmCreateSpy = vi.fn(async () => ({
  getActiveBin: async () => ({ binId: 100 }),
  initializePositionAndAddLiquidityByStrategy: dlmmInitSpy,
}));
const swapSolToUsdcSpy = vi.fn(async (opts: { amountLamports: bigint }) => ({
  signature: `jup-swap-${opts.amountLamports}`,
  inLamports: opts.amountLamports,
  outLamports: opts.amountLamports / 2n, // pretend 1 SOL = 0.5 USDC for math sanity
  slippageLamports: 0n,
}));

vi.mock("@meteora-ag/dlmm", () => ({
  default: { create: dlmmCreateSpy },
  StrategyType: { Spot: 0, Curve: 1, BidAsk: 2 },
}));

// Re-export the real JupiterSwapError class so tests can construct it with
// the canonical shape. Only the swap call sites get the spy.
class FakeJupiterSwapError extends Error {
  public readonly kind: string;
  public readonly retryable: boolean;
  public readonly httpStatus: number | undefined;
  public readonly attempt: number;
  public readonly body: string | undefined;
  constructor(opts: {
    kind: string;
    message: string;
    attempt: number;
    httpStatus?: number;
    body?: string;
  }) {
    super(opts.message);
    this.name = "JupiterSwapError";
    this.kind = opts.kind;
    // Mirror lpJupiterSwap.isRetryableKind without duplicating the switch —
    // we only use "send_failed" / "confirm_failed" / "http_bad_request" in
    // these tests, all of which return false from the inner retry helper.
    // The outer swapWithSendRetry only retries send_failed regardless.
    this.retryable = false;
    this.httpStatus = opts.httpStatus;
    this.attempt = opts.attempt;
    this.body = opts.body;
  }
}

vi.mock("../src/services/lpJupiterSwap.js", () => ({
  swapSolToUsdc: swapSolToUsdcSpy,
  swapUsdcToSol: vi.fn(),
  JupiterSwapError: FakeJupiterSwapError,
}));

const { deployRoomLiquidity, exitRoomLiquidity, checkLpReady } = await import(
  "../src/services/lpManager.js"
);

describe("lpManager — dry-run mode (no DLMM SDK calls)", () => {
  beforeAll(() => {
    sentTxs.length = 0;
  });
  beforeEach(() => {
    sentTxs.length = 0;
  });
  afterAll(() => {
    delete process.env.FEATURES_LP_ENABLED;
    delete process.env.LP_DRY_RUN;
    delete process.env.LP_DRY_RUN_YIELD_LAMPORTS;
    delete process.env.LP_MANAGER_KEYPAIR;
  });

  it("checkLpReady — returns ok when feature flag on, kill switch off, signer present", () => {
    const r = checkLpReady({ requiredBufferLamports: 0n });
    expect(r.ok).toBe(true);
  });

  it("deployRoomLiquidity dry-run — synthesizes a fake position pubkey, no SDK call", async () => {
    const result = await deployRoomLiquidity({
      roomPdaStr: "test-room-pda",
      lamports: 1_000_000_000n,
    });
    expect(result.dryRun).toBe(true);
    expect(result.deployedLamports).toBe(1_000_000_000n);
    expect(result.positionPubkey).toMatch(/^[A-Za-z0-9]{32,44}$/);
    expect(result.signatures).toEqual([]);
  });

  it("exitRoomLiquidity dry-run — synthesizes 0 yield by default and sends back to vault", async () => {
    const fakeVault = Keypair.generate().publicKey;
    const result = await exitRoomLiquidity({
      roomPdaStr: "test-room-pda",
      positionPubkeyStr: Keypair.generate().publicKey.toBase58(),
      deployedLamports: 1_000_000_000n,
      roomVault: fakeVault,
    });
    expect(result.dryRun).toBe(true);
    expect(result.realizedYieldLamports).toBe(0n);
    expect(result.bufferTopUpLamports).toBe(0n);
    expect(result.exitedLamports).toBe(1_000_000_000n);
    // Sent one transfer-back tx to the room vault
    expect(result.signatures.length).toBe(1);
    expect(sentTxs.length).toBe(1);
  });

  it("exitRoomLiquidity dry-run — picks up LP_DRY_RUN_YIELD_LAMPORTS for happy-path simulation", async () => {
    process.env.LP_DRY_RUN_YIELD_LAMPORTS = "50000000";
    // Re-import after env mutation (Node caches module config)
    vi.resetModules();
    const { exitRoomLiquidity: exitV2 } = await import(
      "../src/services/lpManager.js"
    );

    const fakeVault = Keypair.generate().publicKey;
    const result = await exitV2({
      roomPdaStr: "test-room-pda",
      positionPubkeyStr: Keypair.generate().publicKey.toBase58(),
      deployedLamports: 1_000_000_000n,
      roomVault: fakeVault,
    });
    expect(result.realizedYieldLamports).toBe(50_000_000n);
    expect(result.exitedLamports).toBe(1_050_000_000n);
    process.env.LP_DRY_RUN_YIELD_LAMPORTS = "0";
  });

  it("checkLpReady — kill switch on → not ready", async () => {
    process.env.LP_KILL_SWITCH = "true";
    vi.resetModules();
    const { checkLpReady: checkV2 } = await import(
      "../src/services/lpManager.js"
    );
    const r = checkV2({ requiredBufferLamports: 0n });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/kill switch/);
    process.env.LP_KILL_SWITCH = "false";
  });

  it("checkLpReady — feature flag off → not ready", async () => {
    process.env.FEATURES_LP_ENABLED = "false";
    vi.resetModules();
    const { checkLpReady: checkV2 } = await import(
      "../src/services/lpManager.js"
    );
    const r = checkV2({ requiredBufferLamports: 0n });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/feature flag/);
    process.env.FEATURES_LP_ENABLED = "true";
  });
});

describe("lpManager — deployToDlmm env-driven strategy (LP_DRY_RUN=false)", () => {
  // The placeholder pool check in checkLpReady refuses to deploy when
  // METEORA_POOL_ADDRESS is the schema default. Set a non-placeholder pubkey
  // so the deploy path runs all the way through to the (mocked) SDK call.
  const NON_PLACEHOLDER_POOL = Keypair.generate().publicKey.toBase58();

  beforeEach(() => {
    dlmmCreateSpy.mockClear();
    dlmmInitSpy.mockClear();
    swapSolToUsdcSpy.mockClear();
    sentTxs.length = 0;
    process.env.FEATURES_LP_ENABLED = "true";
    process.env.LP_KILL_SWITCH = "false";
    process.env.LP_DRY_RUN = "false";
    process.env.METEORA_POOL_ADDRESS = NON_PLACEHOLDER_POOL;
    process.env.LP_STRATEGY_TYPE = "Spot";
    process.env.LP_BIN_RANGE = "10";
    process.env.LP_DEPLOY_SLIPPAGE_PCT = "1";
    process.env.LP_SOL_USDC_SPLIT_BPS = "5000";
  });

  afterAll(() => {
    delete process.env.LP_DRY_RUN;
    delete process.env.METEORA_POOL_ADDRESS;
    delete process.env.LP_STRATEGY_TYPE;
    delete process.env.LP_BIN_RANGE;
    delete process.env.LP_DEPLOY_SLIPPAGE_PCT;
    delete process.env.LP_SOL_USDC_SPLIT_BPS;
  });

  it("happy path — valid strategy + 5000bps split calls SDK with env-driven args", async () => {
    process.env.LP_STRATEGY_TYPE = "BidAsk";
    process.env.LP_BIN_RANGE = "15";
    process.env.LP_DEPLOY_SLIPPAGE_PCT = "3";
    process.env.LP_SOL_USDC_SPLIT_BPS = "5000";
    vi.resetModules();
    const { deployRoomLiquidity } = await import(
      "../src/services/lpManager.js"
    );

    const result = await deployRoomLiquidity({
      roomPdaStr: "test-room-pda",
      lamports: 1_000_000_000n,
    });

    // Jupiter swap got half the SOL (5000bps USDC side = 500_000_000 lamports).
    expect(swapSolToUsdcSpy).toHaveBeenCalledTimes(1);
    expect(swapSolToUsdcSpy.mock.calls[0][0].amountLamports).toBe(500_000_000n);

    // DLMM was initialized once with the env-driven strategy/range/slippage.
    expect(dlmmCreateSpy).toHaveBeenCalledTimes(1);
    expect(dlmmInitSpy).toHaveBeenCalledTimes(1);
    const args = dlmmInitSpy.mock.calls[0][0] as {
      strategy: { minBinId: number; maxBinId: number; strategyType: number };
      slippage: number;
      totalXAmount: { toString(): string };
      totalYAmount: { toString(): string };
    };
    // Active bin in the mock is 100; LP_BIN_RANGE=15 → [85, 115].
    expect(args.strategy.minBinId).toBe(85);
    expect(args.strategy.maxBinId).toBe(115);
    // BidAsk maps to enum value 2 in the mocked StrategyType.
    expect(args.strategy.strategyType).toBe(2);
    expect(args.slippage).toBe(3);
    // SOL side = 500_000_000; USDC side = 250_000_000 (per swap mock 2:1).
    expect(args.totalXAmount.toString()).toBe("500000000");
    expect(args.totalYAmount.toString()).toBe("250000000");

    // The init tx sig is captured and added to the signatures array.
    expect(result.dryRun).toBe(false);
    expect(result.signatures.length).toBe(2); // swap + init
    expect(result.swapInTxSignature).toBe("jup-swap-500000000");
  });

  it("invalid strategy throws with all valid options listed", async () => {
    process.env.LP_STRATEGY_TYPE = "NotARealStrategy";
    vi.resetModules();
    const { deployRoomLiquidity } = await import(
      "../src/services/lpManager.js"
    );

    await expect(
      deployRoomLiquidity({
        roomPdaStr: "test-room-pda",
        lamports: 1_000_000_000n,
      }),
    ).rejects.toThrow(/NotARealStrategy/);
    await expect(
      deployRoomLiquidity({
        roomPdaStr: "test-room-pda",
        lamports: 1_000_000_000n,
      }),
    ).rejects.toThrow(/Valid values:.*Spot.*Curve.*BidAsk/);

    // SDK + swap were never invoked because the throw happens before either.
    // (deployRoomLiquidity was called twice above — assert nothing leaked
    //  through on the strategy check.)
    expect(dlmmInitSpy).not.toHaveBeenCalled();
    expect(swapSolToUsdcSpy).not.toHaveBeenCalled();
  });

  it("SOL-only split (10000bps) skips Jupiter swap entirely", async () => {
    process.env.LP_SOL_USDC_SPLIT_BPS = "10000";
    vi.resetModules();
    const { deployRoomLiquidity } = await import(
      "../src/services/lpManager.js"
    );

    const result = await deployRoomLiquidity({
      roomPdaStr: "test-room-pda",
      lamports: 1_000_000_000n,
    });

    // No Jupiter quote, no swap tx, swapInTxSignature is null.
    expect(swapSolToUsdcSpy).not.toHaveBeenCalled();
    expect(result.swapInTxSignature).toBeNull();
    expect(result.swapInSolLamports).toBe(0n);
    expect(result.swapInUsdcRaw).toBe(0n);

    // DLMM still gets initialized with the full SOL side, zero USDC side.
    expect(dlmmInitSpy).toHaveBeenCalledTimes(1);
    const args = dlmmInitSpy.mock.calls[0][0] as {
      totalXAmount: { toString(): string };
      totalYAmount: { toString(): string };
    };
    expect(args.totalXAmount.toString()).toBe("1000000000");
    expect(args.totalYAmount.toString()).toBe("0");

    // Only the init sig in the signatures array — no swap sig prefix.
    expect(result.signatures.length).toBe(1);
  });
});

describe("lpManager — swapWithSendRetry (outer retry on JupiterSwapError.send_failed)", () => {
  const NON_PLACEHOLDER_POOL = Keypair.generate().publicKey.toBase58();

  beforeEach(() => {
    dlmmCreateSpy.mockClear();
    dlmmInitSpy.mockClear();
    swapSolToUsdcSpy.mockClear();
    sentTxs.length = 0;
    process.env.FEATURES_LP_ENABLED = "true";
    process.env.LP_KILL_SWITCH = "false";
    process.env.LP_DRY_RUN = "false";
    process.env.METEORA_POOL_ADDRESS = NON_PLACEHOLDER_POOL;
    process.env.LP_STRATEGY_TYPE = "Spot";
    process.env.LP_BIN_RANGE = "10";
    process.env.LP_DEPLOY_SLIPPAGE_PCT = "1";
    process.env.LP_SOL_USDC_SPLIT_BPS = "5000";
    process.env.LP_SWAP_SEND_RETRY_ATTEMPTS = "3";
  });

  afterAll(() => {
    delete process.env.LP_SWAP_SEND_RETRY_ATTEMPTS;
  });

  it("retries on JupiterSwapError(kind=send_failed) and recovers", async () => {
    // Make the swap throw a send_failed on the first call, succeed on the
    // second. The outer retry should swallow the first throw and return
    // the success.
    const { JupiterSwapError } = await import(
      "../src/services/lpJupiterSwap.js"
    );
    let calls = 0;
    swapSolToUsdcSpy.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        throw new JupiterSwapError({
          kind: "send_failed",
          message: "Blockhash not found",
          attempt: 1,
        });
      }
      return {
        signature: "jup-recovered",
        inLamports: 500_000_000n,
        outLamports: 250_000_000n,
        slippageLamports: 0n,
      };
    });

    vi.resetModules();
    const { deployRoomLiquidity } = await import(
      "../src/services/lpManager.js"
    );
    const result = await deployRoomLiquidity({
      roomPdaStr: "test-room-pda",
      lamports: 1_000_000_000n,
    });

    expect(swapSolToUsdcSpy).toHaveBeenCalledTimes(2);
    expect(result.swapInTxSignature).toBe("jup-recovered");
  });

  it("does NOT retry on JupiterSwapError(kind=confirm_failed) — could double-spend", async () => {
    const { JupiterSwapError } = await import(
      "../src/services/lpJupiterSwap.js"
    );
    swapSolToUsdcSpy.mockImplementation(async () => {
      throw new JupiterSwapError({
        kind: "confirm_failed",
        message: "tx confirmed with err",
        attempt: 1,
      });
    });

    vi.resetModules();
    const { deployRoomLiquidity } = await import(
      "../src/services/lpManager.js"
    );
    await expect(
      deployRoomLiquidity({
        roomPdaStr: "test-room-pda",
        lamports: 1_000_000_000n,
      }),
    ).rejects.toMatchObject({ kind: "confirm_failed" });
    expect(swapSolToUsdcSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on JupiterSwapError(kind=http_bad_request) — non-retryable input error", async () => {
    const { JupiterSwapError } = await import(
      "../src/services/lpJupiterSwap.js"
    );
    swapSolToUsdcSpy.mockImplementation(async () => {
      throw new JupiterSwapError({
        kind: "http_bad_request",
        message: "no route",
        attempt: 3, // already exhausted the inner retry
        httpStatus: 400,
      });
    });

    vi.resetModules();
    const { deployRoomLiquidity } = await import(
      "../src/services/lpManager.js"
    );
    await expect(
      deployRoomLiquidity({
        roomPdaStr: "test-room-pda",
        lamports: 1_000_000_000n,
      }),
    ).rejects.toMatchObject({ kind: "http_bad_request" });
    expect(swapSolToUsdcSpy).toHaveBeenCalledTimes(1);
  });

  it("exhausts LP_SWAP_SEND_RETRY_ATTEMPTS on persistent send_failed", async () => {
    process.env.LP_SWAP_SEND_RETRY_ATTEMPTS = "2";
    const { JupiterSwapError } = await import(
      "../src/services/lpJupiterSwap.js"
    );
    swapSolToUsdcSpy.mockImplementation(async () => {
      throw new JupiterSwapError({
        kind: "send_failed",
        message: "Blockhash expired",
        attempt: 1,
      });
    });

    vi.resetModules();
    const { deployRoomLiquidity } = await import(
      "../src/services/lpManager.js"
    );
    await expect(
      deployRoomLiquidity({
        roomPdaStr: "test-room-pda",
        lamports: 1_000_000_000n,
      }),
    ).rejects.toMatchObject({ kind: "send_failed" });
    // 2 attempts (LP_SWAP_SEND_RETRY_ATTEMPTS=2)
    expect(swapSolToUsdcSpy).toHaveBeenCalledTimes(2);
  });

  it("non-JupiterSwapError errors propagate immediately without retry", async () => {
    swapSolToUsdcSpy.mockImplementation(async () => {
      throw new Error("something unrelated exploded");
    });

    vi.resetModules();
    const { deployRoomLiquidity } = await import(
      "../src/services/lpManager.js"
    );
    await expect(
      deployRoomLiquidity({
        roomPdaStr: "test-room-pda",
        lamports: 1_000_000_000n,
      }),
    ).rejects.toThrow(/something unrelated exploded/);
    expect(swapSolToUsdcSpy).toHaveBeenCalledTimes(1);
  });
});

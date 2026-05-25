import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import { Keypair } from "@solana/web3.js";

process.env.JUPITER_API_URL = "https://fake-jupiter.test/swap/v2";
process.env.USDC_MINT_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
process.env.LP_SWAP_SLIPPAGE_BPS = "50";
process.env.LP_JUPITER_RETRY_ATTEMPTS = "3";
process.env.LP_JUPITER_RETRY_BASE_DELAY_MS = "1";
process.env.LP_JUPITER_RETRY_MAX_DELAY_MS = "2";
process.env.LP_JUPITER_RETRY_JITTER_PCT = "0";
process.env.LP_JUPITER_TIMEOUT_MS = "100";

type Responder = (url: string, init?: RequestInit) => Promise<Response> | Response;
const fetchQueue: Responder[] = [];
const fetchLog: { url: string; init?: RequestInit }[] = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  fetchLog.push({ url, init });
  const r = fetchQueue.shift();
  if (!r) throw new Error(`unexpected fetch — no responder queued (${url})`);
  return r(url, init);
});
vi.stubGlobal("fetch", fetchMock);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

const SYS_PROGRAM = "11111111111111111111111111111111";

// Minimum-viable v2 /build response. Empty setup/cleanup so
// compileToV0Message gets a single zero-data instruction. The signing path
// is stubbed via the VersionedTransaction mock below.
const validBuildBody = {
  inputMint: "So11111111111111111111111111111111111111112",
  outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  inAmount: "500000000",
  outAmount: "250000000",
  otherAmountThreshold: "249000000",
  slippageBps: 50,
  priceImpactPct: "0.01",
  swapInstruction: {
    programId: SYS_PROGRAM,
    accounts: [],
    data: "",
  },
  addressesByLookupTableAddress: {},
};

// Stub VersionedTransaction's constructor + sign — we never want real
// signing in unit tests. compileToV0Message still runs on real web3.js.
vi.mock("@solana/web3.js", async (orig) => {
  const real = (await orig()) as typeof import("@solana/web3.js");
  class FakeVersionedTx {
    public message: unknown;
    constructor(msg?: unknown) {
      this.message = msg;
    }
    sign() {}
    serialize() {
      return new Uint8Array(0);
    }
  }
  return {
    ...real,
    VersionedTransaction: FakeVersionedTx,
  };
});

const { swapSolToUsdc, JupiterSwapError } = await import(
  "../src/services/lpJupiterSwap.js"
);

// Minimal Connection stub — send + confirm succeed by default. The new
// flow also calls getLatestBlockhash and getAddressLookupTable; both are
// stubbed to return safe defaults.
function makeFakeConnection(opts?: {
  sendImpl?: () => Promise<string>;
  confirmImpl?: () => Promise<{ value: { err: unknown } }>;
}): import("@solana/web3.js").Connection {
  const conn = {
    async sendRawTransaction() {
      return opts?.sendImpl ? opts.sendImpl() : "sig-ok";
    },
    async confirmTransaction() {
      return opts?.confirmImpl
        ? opts.confirmImpl()
        : ({ value: { err: null } } as { value: { err: unknown } });
    },
    async getLatestBlockhash() {
      return {
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 0,
      };
    },
    async getAddressLookupTable() {
      return { value: null };
    },
  };
  return conn as unknown as import("@solana/web3.js").Connection;
}

describe("lpJupiterSwap — retry & classification (v2 /build)", () => {
  beforeAll(() => {
    fetchQueue.length = 0;
    fetchLog.length = 0;
  });
  beforeEach(() => {
    fetchQueue.length = 0;
    fetchLog.length = 0;
    fetchMock.mockClear();
    delete process.env.JUPITER_API_KEY;
  });
  afterAll(() => {
    delete process.env.JUPITER_API_URL;
    delete process.env.JUPITER_API_KEY;
    delete process.env.LP_JUPITER_RETRY_ATTEMPTS;
    delete process.env.LP_JUPITER_RETRY_BASE_DELAY_MS;
    delete process.env.LP_JUPITER_RETRY_MAX_DELAY_MS;
    delete process.env.LP_JUPITER_RETRY_JITTER_PCT;
    delete process.env.LP_JUPITER_TIMEOUT_MS;
  });

  it("happy path — /build succeeds on first attempt", async () => {
    fetchQueue.push(() => jsonResponse(validBuildBody));

    const signer = Keypair.generate();
    const result = await swapSolToUsdc({
      connection: makeFakeConnection(),
      signer,
      amountLamports: 500_000_000n,
    });

    expect(result.signature).toBe("sig-ok");
    expect(result.inLamports).toBe(500_000_000n);
    expect(result.outLamports).toBe(250_000_000n);
    expect(result.slippageLamports).toBe(1_000_000n); // outAmount − otherAmountThreshold
    expect(fetchLog.length).toBe(1);
    expect(fetchLog[0].url).toContain("/build");
    // v2 rename: userPublicKey → taker
    expect(fetchLog[0].url).toContain("taker=");
    expect(fetchLog[0].url).not.toContain("userPublicKey");
  });

  it("retries on 429 (rate limit) then succeeds", async () => {
    fetchQueue.push(() => textResponse("rate limit", 429));
    fetchQueue.push(() => textResponse("rate limit", 429));
    fetchQueue.push(() => jsonResponse(validBuildBody));

    const result = await swapSolToUsdc({
      connection: makeFakeConnection(),
      signer: Keypair.generate(),
      amountLamports: 500_000_000n,
    });
    expect(result.signature).toBe("sig-ok");
    expect(fetchLog.length).toBe(3);
  });

  it("retries on 500 (server error) then succeeds", async () => {
    fetchQueue.push(() => textResponse("upstream broke", 500));
    fetchQueue.push(() => jsonResponse(validBuildBody));

    const result = await swapSolToUsdc({
      connection: makeFakeConnection(),
      signer: Keypair.generate(),
      amountLamports: 500_000_000n,
    });
    expect(result.signature).toBe("sig-ok");
    expect(fetchLog.length).toBe(2);
  });

  it("does NOT retry on 400 (bad request) — fail fast", async () => {
    fetchQueue.push(() => textResponse("invalid mint", 400));

    await expect(
      swapSolToUsdc({
        connection: makeFakeConnection(),
        signer: Keypair.generate(),
        amountLamports: 500_000_000n,
      }),
    ).rejects.toMatchObject({
      name: "JupiterSwapError",
      kind: "http_bad_request",
      retryable: false,
      httpStatus: 400,
      attempt: 1,
    });
    expect(fetchLog.length).toBe(1);
  });

  it("does NOT retry on 404 (no route) — fail fast", async () => {
    fetchQueue.push(() => textResponse("no route", 404));

    await expect(
      swapSolToUsdc({
        connection: makeFakeConnection(),
        signer: Keypair.generate(),
        amountLamports: 500_000_000n,
      }),
    ).rejects.toMatchObject({
      kind: "http_not_found",
      retryable: false,
      attempt: 1,
    });
    expect(fetchLog.length).toBe(1);
  });

  it("exhausts maxAttempts on persistent 429 and throws with attempt=3", async () => {
    fetchQueue.push(() => textResponse("rate", 429));
    fetchQueue.push(() => textResponse("rate", 429));
    fetchQueue.push(() => textResponse("rate", 429));

    await expect(
      swapSolToUsdc({
        connection: makeFakeConnection(),
        signer: Keypair.generate(),
        amountLamports: 500_000_000n,
      }),
    ).rejects.toMatchObject({
      kind: "http_rate_limit",
      retryable: true,
      attempt: 3,
    });
    expect(fetchLog.length).toBe(3);
  });

  it("classifies AbortController timeout as kind=timeout and retries", async () => {
    const hang: Responder = (_url, init) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    fetchQueue.push(hang);
    fetchQueue.push(hang);
    fetchQueue.push(() => jsonResponse(validBuildBody));

    const result = await swapSolToUsdc({
      connection: makeFakeConnection(),
      signer: Keypair.generate(),
      amountLamports: 500_000_000n,
    });
    expect(result.signature).toBe("sig-ok");
    expect(fetchLog.length).toBe(3);
  });

  it("classifies network errors (ECONNRESET) as kind=network and retries", async () => {
    fetchQueue.push(() => {
      throw new Error("fetch failed: ECONNRESET");
    });
    fetchQueue.push(() => jsonResponse(validBuildBody));

    const result = await swapSolToUsdc({
      connection: makeFakeConnection(),
      signer: Keypair.generate(),
      amountLamports: 500_000_000n,
    });
    expect(result.signature).toBe("sig-ok");
    expect(fetchLog.length).toBe(2);
  });

  it("invalid_input (zero amount) fails fast without any fetch", async () => {
    await expect(
      swapSolToUsdc({
        connection: makeFakeConnection(),
        signer: Keypair.generate(),
        amountLamports: 0n,
      }),
    ).rejects.toMatchObject({
      kind: "invalid_input",
      retryable: false,
    });
    expect(fetchLog.length).toBe(0);
  });

  it("send_failed is classified and NOT retried (single attempt)", async () => {
    fetchQueue.push(() => jsonResponse(validBuildBody));

    const conn = makeFakeConnection({
      sendImpl: async () => {
        throw new Error("Blockhash not found");
      },
    });

    await expect(
      swapSolToUsdc({
        connection: conn,
        signer: Keypair.generate(),
        amountLamports: 500_000_000n,
      }),
    ).rejects.toMatchObject({
      kind: "send_failed",
      retryable: false,
      attempt: 1,
    });
    // /build ran once — no retry of the build chain since the failure
    // happened downstream in send.
    expect(fetchLog.length).toBe(1);
  });

  it("confirm_failed is classified (on confirmed-with-err response)", async () => {
    fetchQueue.push(() => jsonResponse(validBuildBody));

    const conn = makeFakeConnection({
      confirmImpl: async () =>
        ({ value: { err: { InstructionError: [0, "ProgramFailedToComplete"] } } }) as {
          value: { err: unknown };
        },
    });

    await expect(
      swapSolToUsdc({
        connection: conn,
        signer: Keypair.generate(),
        amountLamports: 500_000_000n,
      }),
    ).rejects.toMatchObject({
      kind: "confirm_failed",
      retryable: false,
    });
  });

  it("classifies invalid_response when body parses but lacks required fields", async () => {
    // 200 OK but missing swapInstruction/outAmount/otherAmountThreshold
    fetchQueue.push(() => jsonResponse({ inAmount: "1" }));

    await expect(
      swapSolToUsdc({
        connection: makeFakeConnection(),
        signer: Keypair.generate(),
        amountLamports: 500_000_000n,
      }),
    ).rejects.toMatchObject({
      kind: "invalid_response",
      retryable: false,
    });
    // Single attempt — invalid_response is not retried
    expect(fetchLog.length).toBe(1);
  });

  it("JupiterSwapError is an instanceof Error and exposes kind/attempt/httpStatus", async () => {
    fetchQueue.push(() => textResponse("oops", 502));
    fetchQueue.push(() => textResponse("oops", 502));
    fetchQueue.push(() => textResponse("oops", 502));

    try {
      await swapSolToUsdc({
        connection: makeFakeConnection(),
        signer: Keypair.generate(),
        amountLamports: 500_000_000n,
      });
      expect.unreachable("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(JupiterSwapError);
      const e = err as InstanceType<typeof JupiterSwapError>;
      expect(e.kind).toBe("http_server_error");
      expect(e.retryable).toBe(true);
      expect(e.httpStatus).toBe(502);
      expect(e.attempt).toBe(3);
    }
  });

  it("does NOT send x-api-key header when JUPITER_API_KEY is unset", async () => {
    fetchQueue.push(() => jsonResponse(validBuildBody));

    await swapSolToUsdc({
      connection: makeFakeConnection(),
      signer: Keypair.generate(),
      amountLamports: 500_000_000n,
    });
    const headers = fetchLog[0].init?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.["x-api-key"]).toBeUndefined();
  });
});

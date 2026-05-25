import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { randomUUID } from "node:crypto";
import { adminTestRouter } from "./adminTestRouter.js";
import { AdminAuditLog } from "../src/db/schema.js";
import type { Context } from "../src/trpc/context.js";
import { TEST_ADMIN_KEYPAIR, TEST_ADMIN_PUBKEY } from "./testAdmin.js";
import {
  startTestMongo,
  stopTestMongo,
  clearAllCollections,
  makeFreshRedis,
} from "./setup.js";

function buildContext(redis: any, overrides: Partial<Context> = {}): Context {
  return {
    walletAddress: null,
    sessionToken: null,
    ipCountry: null,
    ipAddress: "127.0.0.1",
    adminHeaders: {
      wallet: null,
      timestamp: null,
      nonce: null,
      signature: null,
    },
    redis,
    ...overrides,
  };
}

function freshNonce(): string {
  return randomUUID().replace(/-/g, "");
}

function signAdminHeaders(
  kp: Keypair,
  path: string,
  opts?: { timestamp?: number; nonce?: string },
) {
  const timestamp = String(opts?.timestamp ?? Date.now());
  const nonce = opts?.nonce ?? freshNonce();
  const message = new TextEncoder().encode(
    `hooked-admin:${path}:${timestamp}:${nonce}`,
  );
  const signature = bs58.encode(nacl.sign.detached(message, kp.secretKey));
  return {
    wallet: kp.publicKey.toBase58(),
    timestamp,
    nonce,
    signature,
  };
}

function callerWithHeaders(
  redis: any,
  headers: {
    wallet: string | null;
    timestamp: string | null;
    nonce: string | null;
    signature: string | null;
  },
) {
  return adminTestRouter.createCaller(
    buildContext(redis, { adminHeaders: headers }),
  );
}

describe("isSignedAdmin middleware", () => {
  let redis: any;

  beforeAll(async () => {
    await startTestMongo();
  });
  afterAll(async () => {
    await stopTestMongo();
  });
  beforeEach(async () => {
    await clearAllCollections();
    redis = await makeFreshRedis();
  });

  it("rejects when admin headers are missing", async () => {
    const caller = callerWithHeaders(redis, {
      wallet: null,
      timestamp: null,
      nonce: null,
      signature: null,
    });
    await expect(caller.ping()).rejects.toThrow(/Missing admin signature/);
  });

  it("rejects a wallet not in the admin allow-list", async () => {
    const impostor = Keypair.generate();
    const headers = signAdminHeaders(impostor, "ping");
    const caller = callerWithHeaders(redis, headers);
    await expect(caller.ping()).rejects.toThrow(/Not an admin wallet/);
  });

  it("rejects a non-numeric timestamp", async () => {
    const headers = signAdminHeaders(TEST_ADMIN_KEYPAIR, "ping");
    const caller = callerWithHeaders(redis, {
      ...headers,
      timestamp: "not-a-number",
    });
    await expect(caller.ping()).rejects.toThrow(/Invalid timestamp/);
  });

  it("rejects a timestamp outside the ±60s skew window", async () => {
    const staleTs = Date.now() - 5 * 60 * 1000; // 5 min ago
    const headers = signAdminHeaders(TEST_ADMIN_KEYPAIR, "ping", {
      timestamp: staleTs,
    });
    const caller = callerWithHeaders(redis, headers);
    await expect(caller.ping()).rejects.toThrow(/Timestamp out of range/);
  });

  it("rejects a nonce with invalid format", async () => {
    const headers = signAdminHeaders(TEST_ADMIN_KEYPAIR, "ping", {
      nonce: "not-hex!!",
    });
    const caller = callerWithHeaders(redis, headers);
    await expect(caller.ping()).rejects.toThrow(/Invalid nonce/);
  });

  it("rejects a malformed (non-base58) signature", async () => {
    const headers = signAdminHeaders(TEST_ADMIN_KEYPAIR, "ping");
    const caller = callerWithHeaders(redis, {
      ...headers,
      signature: "not-base58-0OIl",
    });
    await expect(caller.ping()).rejects.toThrow(
      /Malformed signature|Signature verification failed/,
    );
  });

  it("rejects a valid signature signed over the wrong procedure path", async () => {
    // Signing for "echo" but calling "ping" — the middleware builds the
    // message from the runtime `path`, so the signature won't verify.
    const headers = signAdminHeaders(TEST_ADMIN_KEYPAIR, "echo");
    const caller = callerWithHeaders(redis, headers);
    await expect(caller.ping()).rejects.toThrow(/Signature verification failed/);
  });

  it("accepts a valid signature and the procedure returns successfully", async () => {
    const headers = signAdminHeaders(TEST_ADMIN_KEYPAIR, "ping");
    const caller = callerWithHeaders(redis, headers);
    const res = await caller.ping();
    expect(res).toEqual({ ok: true });
  });

  it("refuses to accept the same nonce twice (replay protection)", async () => {
    const nonce = freshNonce();
    const headers = signAdminHeaders(TEST_ADMIN_KEYPAIR, "ping", { nonce });
    const caller = callerWithHeaders(redis, headers);

    await caller.ping();
    await expect(caller.ping()).rejects.toThrow(/Nonce already used/);
  });

  it("writes an audit-log entry on success", async () => {
    const headers = signAdminHeaders(TEST_ADMIN_KEYPAIR, "echo");
    const caller = callerWithHeaders(redis, headers);
    await caller.echo({ msg: "hello" });

    // Audit log write is fire-and-forget, so allow the microtask queue to flush.
    await new Promise((r) => setTimeout(r, 50));

    const logs = await AdminAuditLog.find({ adminWallet: TEST_ADMIN_PUBKEY })
      .lean();
    expect(logs).toHaveLength(1);
    expect(logs[0].procedure).toBe("echo");
    expect(logs[0].outcome).toBe("ok");
    expect(logs[0].inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(logs[0].ipAddress).toBe("127.0.0.1");
  });

  it("rate-limits admin calls at 30 per 5-minute window", async () => {
    // Fire 30 valid calls, each with a fresh nonce. 31st should be rejected.
    for (let i = 0; i < 30; i++) {
      const headers = signAdminHeaders(TEST_ADMIN_KEYPAIR, "ping");
      await callerWithHeaders(redis, headers).ping();
    }
    const headers = signAdminHeaders(TEST_ADMIN_KEYPAIR, "ping");
    await expect(callerWithHeaders(redis, headers).ping()).rejects.toThrow(
      /Admin rate limit exceeded/,
    );
  });

  it("writes an error audit entry when the handler throws", async () => {
    const headers = signAdminHeaders(TEST_ADMIN_KEYPAIR, "boom");
    const caller = callerWithHeaders(redis, headers);
    await expect(caller.boom()).rejects.toThrow(/handler boom/);

    // Fire-and-forget audit write; let microtasks flush.
    await new Promise((r) => setTimeout(r, 50));
    const logs = await AdminAuditLog.find({}).lean();
    expect(logs).toHaveLength(1);
    expect(logs[0].outcome).toBe("error");
    expect(logs[0].errorMessage).toMatch(/handler boom/);
    expect(logs[0].procedure).toBe("boom");
  });
});

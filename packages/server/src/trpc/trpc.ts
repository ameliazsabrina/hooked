import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { initTRPC, TRPCError } from "@trpc/server";
import type { Context } from "./context.js";
import { isAdminWallet } from "../config/env.js";
import { AdminAuditLog } from "../db/schema.js";

const t = initTRPC.context<Context>().create();

const isAuthed = t.middleware(({ ctx, next }) => {
  if (!ctx.walletAddress) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Wallet not connected" });
  }
  return next({ ctx: { walletAddress: ctx.walletAddress } });
});

const ADMIN_TIMESTAMP_SKEW_MS = 60_000;
const ADMIN_NONCE_TTL_SEC = 300;
const ADMIN_RATE_LIMIT_MAX = 30;
const ADMIN_RATE_LIMIT_WINDOW_SEC = 300;

function buildAdminMessage(
  procedurePath: string,
  timestamp: string,
  nonce: string
): Uint8Array {
  return new TextEncoder().encode(
    `hooked-admin:${procedurePath}:${timestamp}:${nonce}`
  );
}

function hashInput(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(input ?? null))
    .digest("hex");
}

const isSignedAdmin = t.middleware(async ({ ctx, path, getRawInput, next }) => {
  const { wallet, timestamp, nonce, signature } = ctx.adminHeaders;
  if (!wallet || !timestamp || !nonce || !signature) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing admin signature headers",
    });
  }
  if (!isAdminWallet(wallet)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Not an admin wallet" });
  }

  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid timestamp" });
  }
  if (Math.abs(Date.now() - tsNum) > ADMIN_TIMESTAMP_SKEW_MS) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Timestamp out of range" });
  }
  if (!/^[0-9a-f]{16,64}$/i.test(nonce)) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid nonce" });
  }

  let walletKey: PublicKey;
  let sigBytes: Uint8Array;
  try {
    walletKey = new PublicKey(wallet);
    sigBytes = bs58.decode(signature);
  } catch {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Malformed signature" });
  }
  const msgBytes = buildAdminMessage(path, timestamp, nonce);
  const verified = nacl.sign.detached.verify(
    msgBytes,
    sigBytes,
    walletKey.toBytes()
  );
  if (!verified) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Signature verification failed" });
  }

  const nonceKey = `admin-nonce:${nonce}`;
  const nonceSet = await ctx.redis.set(
    nonceKey,
    "1",
    "EX",
    ADMIN_NONCE_TTL_SEC,
    "NX"
  );
  if (nonceSet !== "OK") {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Nonce already used" });
  }

  const rlBucket = Math.floor(Date.now() / 1000 / ADMIN_RATE_LIMIT_WINDOW_SEC);
  const rlKey = `admin-rl:${wallet}:${rlBucket}`;
  const rlCount = await ctx.redis.incr(rlKey);
  if (rlCount === 1) {
    await ctx.redis.expire(rlKey, ADMIN_RATE_LIMIT_WINDOW_SEC);
  }
  if (rlCount > ADMIN_RATE_LIMIT_MAX) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Admin rate limit exceeded",
    });
  }

  let rawInput: unknown = undefined;
  try {
    rawInput = await getRawInput();
  } catch {
    // If raw input can't be materialized, still hash a placeholder.
  }
  const inputHash = hashInput(rawInput);
  const writeAudit = (outcome: "ok" | "error", errorMessage?: string) => {
    AdminAuditLog.create({
      adminWallet: wallet,
      procedure: path,
      inputHash,
      timestamp: new Date(),
      outcome,
      errorMessage: errorMessage ?? null,
      ipAddress: ctx.ipAddress,
    }).catch((err) => {
      console.error("[admin-audit] write failed", err);
    });
  };

  // try/catch is a safety net for synchronous throws; v11 next() resolves with errors.
  try {
    const result = await next({ ctx: { ...ctx, adminWallet: wallet } });
    if (result.ok) {
      writeAudit("ok");
    } else {
      const errMessage =
        (result.error as { message?: string } | undefined)?.message ??
        "unknown error";
      writeAudit("error", errMessage);
    }
    return result;
  } catch (err) {
    writeAudit("error", (err as Error).message);
    throw err;
  }
});

// Admin session: bearer token in Redis with 1h TTL — avoids per-call wallet signing.
const ADMIN_SESSION_REDIS_PREFIX = "admin-session:";
const ADMIN_SESSION_RATE_LIMIT_MAX = 120;
const ADMIN_SESSION_RATE_LIMIT_WINDOW_SEC = 60;

const isSessionAdmin = t.middleware(async ({ ctx, path, getRawInput, next }) => {
  if (!ctx.sessionToken) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing admin session token",
    });
  }
  const wallet = await ctx.redis.get(
    `${ADMIN_SESSION_REDIS_PREFIX}${ctx.sessionToken}`,
  );
  if (!wallet) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Admin session expired or invalid",
    });
  }
  if (!isAdminWallet(wallet)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Not an admin wallet" });
  }

  const rlBucket = Math.floor(
    Date.now() / 1000 / ADMIN_SESSION_RATE_LIMIT_WINDOW_SEC,
  );
  const rlKey = `admin-rl-session:${wallet}:${rlBucket}`;
  const rlCount = await ctx.redis.incr(rlKey);
  if (rlCount === 1) {
    await ctx.redis.expire(rlKey, ADMIN_SESSION_RATE_LIMIT_WINDOW_SEC);
  }
  if (rlCount > ADMIN_SESSION_RATE_LIMIT_MAX) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Admin rate limit exceeded",
    });
  }

  let rawInput: unknown = undefined;
  try {
    rawInput = await getRawInput();
  } catch {
    // ignore — still hash a placeholder
  }
  const inputHash = hashInput(rawInput);
  const writeAudit = (outcome: "ok" | "error", errorMessage?: string) => {
    AdminAuditLog.create({
      adminWallet: wallet,
      procedure: path,
      inputHash,
      timestamp: new Date(),
      outcome,
      errorMessage: errorMessage ?? null,
      ipAddress: ctx.ipAddress,
    }).catch((err) => {
      console.error("[admin-audit] write failed", err);
    });
  };

  try {
    const result = await next({ ctx: { ...ctx, adminWallet: wallet } });
    if (result.ok) {
      writeAudit("ok");
    } else {
      const errMessage =
        (result.error as { message?: string } | undefined)?.message ??
        "unknown error";
      writeAudit("error", errMessage);
    }
    return result;
  } catch (err) {
    writeAudit("error", (err as Error).message);
    throw err;
  }
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(isAuthed);
export const adminSignedProcedure = t.procedure.use(isSignedAdmin);
export const adminSessionProcedure = t.procedure.use(isSessionAdmin);
export const middleware = t.middleware;

export const ADMIN_SESSION = {
  redisPrefix: ADMIN_SESSION_REDIS_PREFIX,
  ttlSeconds: 60 * 60,
  buildMessage: buildAdminMessage,
} as const;

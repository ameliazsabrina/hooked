import { randomBytes } from "node:crypto";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { router, publicProcedure, protectedProcedure } from "./trpc.js";
import {
  RateLimitError,
  UnauthorizedError,
  mapAppErrorToTRPC,
} from "../errors/AppError.js";

const SESSION_TTL_SEC = 24 * 60 * 60;
const AUTH_RATE_LIMIT_MAX = 20;
const AUTH_RATE_LIMIT_WINDOW_SEC = 60;
const DELEGATION_REPLAY_TTL_SEC = 7 * 24 * 60 * 60;

async function checkAuthRateLimit(
  redis: import("ioredis").default,
  wallet: string,
): Promise<void> {
  const bucket = Math.floor(
    Date.now() / 1000 / AUTH_RATE_LIMIT_WINDOW_SEC,
  );
  const key = `http-auth-rl:exchange:${wallet}:${bucket}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, AUTH_RATE_LIMIT_WINDOW_SEC);
  }
  if (count > AUTH_RATE_LIMIT_MAX) {
    throw new RateLimitError("Auth rate limit exceeded");
  }
}

const WalletSchema = z
  .string()
  .min(32)
  .max(44)
  .refine((s) => {
    try {
      new PublicKey(s);
      return true;
    } catch {
      return false;
    }
  }, "Invalid wallet address");

const DelegationSchema = z.object({
  wallet: WalletSchema,
  sessionPubkey: z.string().min(32).max(44),
  expiresAt: z.number().int().positive(),
  message: z.string().min(1).max(512),
  signature: z.string().min(1).max(128),
});

function sessionKey(token: string): string {
  return `http-session:${token}`;
}

/** Lets logout find the sessionPubkey that minted this token. */
function sessionMetaKey(token: string): string {
  return `http-session-meta:${token}`;
}

/** Prevents a leaked delegation from being exchanged repeatedly. */
function delegationBindingKey(wallet: string, sessionPubkey: string): string {
  return `http-auth-delegation:${wallet}:${sessionPubkey}`;
}

/** Set on logout to block delegation replay until the original expires. */
function delegationRevokedKey(wallet: string, sessionPubkey: string): string {
  return `http-auth-revoked:${wallet}:${sessionPubkey}`;
}

function buildExpectedDelegationMessage(
  wallet: string,
  sessionPubkey: string,
  expiresAt: number,
): string {
  return [
    "Hooked WS Session Delegation",
    `wallet: ${wallet}`,
    `session: ${sessionPubkey}`,
    `expires: ${expiresAt}`,
  ].join("\n");
}

export const authRouter = router({
  // Same delegation authorizes both HTTP (this token) and WS (gateway verifies).
  exchangeDelegation: publicProcedure
    .input(z.object({ delegation: DelegationSchema }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const { delegation } = input;
        await checkAuthRateLimit(ctx.redis, delegation.wallet);

        if (delegation.expiresAt < Date.now()) {
          throw new UnauthorizedError("Delegation expired");
        }

        const expectedMessage = buildExpectedDelegationMessage(
          delegation.wallet,
          delegation.sessionPubkey,
          delegation.expiresAt,
        );
        if (delegation.message !== expectedMessage) {
          throw new UnauthorizedError("Delegation message mismatch");
        }

        let walletKey: PublicKey;
        let sessionPubkeyBytes: Uint8Array;
        let sigBytes: Uint8Array;
        try {
          walletKey = new PublicKey(delegation.wallet);
          sessionPubkeyBytes = bs58.decode(delegation.sessionPubkey);
          if (sessionPubkeyBytes.length !== 32) {
            throw new Error("invalid session pubkey length");
          }
          sigBytes = bs58.decode(delegation.signature);
        } catch {
          throw new UnauthorizedError("Malformed delegation");
        }

        const msgBytes = new TextEncoder().encode(delegation.message);
        const verified = nacl.sign.detached.verify(
          msgBytes,
          sigBytes,
          walletKey.toBytes(),
        );
        if (!verified) {
          throw new UnauthorizedError("Signature verification failed");
        }

        const bindingKey = delegationBindingKey(
          delegation.wallet,
          delegation.sessionPubkey,
        );
        const revokedKey = delegationRevokedKey(
          delegation.wallet,
          delegation.sessionPubkey,
        );
        if (await ctx.redis.get(revokedKey)) {
          throw new UnauthorizedError("Delegation revoked");
        }
        const sessionTtlSec = Math.min(
          SESSION_TTL_SEC,
          Math.max(1, Math.floor((delegation.expiresAt - Date.now()) / 1000)),
        );

        // Idempotent re-exchange — abuse surface is bounded by rate limit,
        // session TTL, and logout-revokes-binding.
        const priorToken = await ctx.redis.get(bindingKey);
        if (priorToken) {
          const priorTtlSec = await ctx.redis.ttl(sessionKey(priorToken));
          if (priorTtlSec > 0) {
            return {
              token: priorToken,
              expiresAt: Date.now() + priorTtlSec * 1000,
              walletAddress: delegation.wallet,
            };
          }
          // Binding outlived its token — mint a fresh one.
        }

        const token = randomBytes(32).toString("hex");
        const expiresAt = Date.now() + sessionTtlSec * 1000;
        await ctx.redis.set(bindingKey, token, "EX", DELEGATION_REPLAY_TTL_SEC);
        await ctx.redis.set(
          sessionKey(token),
          delegation.wallet,
          "EX",
          sessionTtlSec,
        );
        await ctx.redis.set(
          sessionMetaKey(token),
          delegation.sessionPubkey,
          "EX",
          sessionTtlSec,
        );

        return {
          token,
          expiresAt,
          walletAddress: delegation.wallet,
        };
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),

  logout: protectedProcedure.mutation(async ({ ctx }) => {
    if (ctx.sessionToken) {
      // Revoke delegation so a captured one can't be replayed after logout.
      const metaKey = sessionMetaKey(ctx.sessionToken);
      const sessionPubkey = await ctx.redis.get(metaKey);
      if (sessionPubkey && ctx.walletAddress) {
        await ctx.redis.set(
          delegationRevokedKey(ctx.walletAddress, sessionPubkey),
          "1",
          "EX",
          DELEGATION_REPLAY_TTL_SEC,
        );
        await ctx.redis.del(
          delegationBindingKey(ctx.walletAddress, sessionPubkey),
        );
      }
      await ctx.redis.del(sessionKey(ctx.sessionToken), metaKey);
    }
    return { ok: true };
  }),
});

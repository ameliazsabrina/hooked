import { randomBytes } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { router, publicProcedure, protectedProcedure } from "./trpc.js";

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
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Auth rate limit exceeded",
    });
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

// Companion key holding the sessionPubkey that minted a given session token,
// so logout can locate and delete the matching delegation binding.
function sessionMetaKey(token: string): string {
  return `http-session-meta:${token}`;
}

// Tracks (wallet, sessionPubkey) bindings already minted into a session token,
// so a leaked delegation can't be exchanged repeatedly for fresh tokens.
function delegationBindingKey(wallet: string, sessionPubkey: string): string {
  return `http-auth-delegation:${wallet}:${sessionPubkey}`;
}

// Marker set on logout for the (wallet, sessionPubkey) of the revoked
// delegation. exchangeDelegation refuses to mint a token for a marker hit
// until the original delegation expires, so a captured delegation can't be
// replayed after the user explicitly logged out.
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
  // Single-signature handshake: client signs a delegation message that
  // authorizes an ephemeral keypair to act on its behalf for both HTTP
  // (this token) and WS (gateway verifies the same delegation on connect).
  exchangeDelegation: publicProcedure
    .input(z.object({ delegation: DelegationSchema }))
    .mutation(async ({ ctx, input }) => {
      const { delegation } = input;
      await checkAuthRateLimit(ctx.redis, delegation.wallet);

      if (delegation.expiresAt < Date.now()) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Delegation expired",
        });
      }

      const expectedMessage = buildExpectedDelegationMessage(
        delegation.wallet,
        delegation.sessionPubkey,
        delegation.expiresAt,
      );
      if (delegation.message !== expectedMessage) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Delegation message mismatch",
        });
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
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Malformed delegation",
        });
      }

      const msgBytes = new TextEncoder().encode(delegation.message);
      const verified = nacl.sign.detached.verify(
        msgBytes,
        sigBytes,
        walletKey.toBytes(),
      );
      if (!verified) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Signature verification failed",
        });
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
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Delegation revoked",
        });
      }
      const sessionTtlSec = Math.min(
        SESSION_TTL_SEC,
        Math.max(1, Math.floor((delegation.expiresAt - Date.now()) / 1000)),
      );

      // Idempotent re-exchange: if this delegation already minted a token
      // and the token is still in Redis, return it. Refusing replay would
      // punish legitimate clients (cleared storage, second tab, recovered
      // session) without raising the bar for an attacker who already has
      // the delegation. Rate limit + session TTL + logout-revokes-binding
      // (see logout below) cover the abuse surface.
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
        // Binding outlived its token — fall through and mint a fresh one,
        // overwriting the binding.
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
    }),

  logout: protectedProcedure.mutation(async ({ ctx }) => {
    if (ctx.sessionToken) {
      // Revoke the delegation too, so a captured delegation can't be replayed
      // via exchangeDelegation to mint a fresh token after logout. We mark
      // (wallet, sessionPubkey) as revoked for the full delegation lifetime
      // and tear down the binding + session state.
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

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  ADMIN_SESSION,
  adminSessionProcedure,
  publicProcedure,
  router,
} from "../trpc.js";
import { isAdminWallet } from "../../config/env.js";

const TIMESTAMP_SKEW_MS = 60_000;

const loginInput = z.object({
  wallet: z.string().min(32).max(64),
  timestamp: z.string().regex(/^\d+$/),
  nonce: z.string().regex(/^[0-9a-f]{16,64}$/i),
  signature: z.string().min(1),
});

export const adminSessionRouter = router({
  login: publicProcedure
    .input(loginInput)
    .mutation(async ({ ctx, input }) => {
      if (!isAdminWallet(input.wallet)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Not an admin wallet",
        });
      }

      const tsNum = Number(input.timestamp);
      if (
        !Number.isFinite(tsNum) ||
        Math.abs(Date.now() - tsNum) > TIMESTAMP_SKEW_MS
      ) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Timestamp out of range",
        });
      }

      let walletKey: PublicKey;
      let sigBytes: Uint8Array;
      try {
        walletKey = new PublicKey(input.wallet);
        sigBytes = bs58.decode(input.signature);
      } catch {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Malformed signature",
        });
      }

      const msgBytes = ADMIN_SESSION.buildMessage(
        "admin.session.login",
        input.timestamp,
        input.nonce,
      );
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

      const nonceKey = `admin-login-nonce:${input.nonce}`;
      const nonceSet = await ctx.redis.set(
        nonceKey,
        "1",
        "EX",
        300,
        "NX",
      );
      if (nonceSet !== "OK") {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Nonce already used",
        });
      }

      const token = randomBytes(32).toString("hex");
      await ctx.redis.set(
        `${ADMIN_SESSION.redisPrefix}${token}`,
        input.wallet,
        "EX",
        ADMIN_SESSION.ttlSeconds,
      );

      return {
        token,
        wallet: input.wallet,
        expiresAt: new Date(
          Date.now() + ADMIN_SESSION.ttlSeconds * 1000,
        ).toISOString(),
      };
    }),

  logout: adminSessionProcedure.mutation(async ({ ctx }) => {
    if (ctx.sessionToken) {
      await ctx.redis.del(`${ADMIN_SESSION.redisPrefix}${ctx.sessionToken}`);
    }
    return { ok: true };
  }),

  me: adminSessionProcedure.query(async ({ ctx }) => {
    const ttl = ctx.sessionToken
      ? await ctx.redis.ttl(`${ADMIN_SESSION.redisPrefix}${ctx.sessionToken}`)
      : -1;
    return {
      wallet: (ctx as { adminWallet?: string }).adminWallet ?? null,
      expiresInSeconds: ttl,
    };
  }),
});

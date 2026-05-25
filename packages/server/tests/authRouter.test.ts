import { describe, it, expect, beforeEach } from "vitest";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { authRouter } from "../src/trpc/authRouter.js";
import type { Context } from "../src/trpc/context.js";
import { makeRedis } from "./setup.js";

function buildContext(redis: any, overrides: Partial<Context> = {}): Context {
  return {
    walletAddress: null,
    sessionToken: null,
    ipCountry: null,
    ipAddress: null,
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

interface BuiltDelegation {
  wallet: string;
  sessionPubkey: string;
  expiresAt: number;
  message: string;
  signature: string;
}

function buildDelegationMessage(
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

function makeDelegation(
  signer: Keypair,
  opts: { expiresAt?: number; sessionKeypair?: nacl.SignKeyPair } = {},
): BuiltDelegation {
  const wallet = signer.publicKey.toBase58();
  const sessionKp = opts.sessionKeypair ?? nacl.sign.keyPair();
  const sessionPubkey = bs58.encode(sessionKp.publicKey);
  const expiresAt = opts.expiresAt ?? Date.now() + 60 * 60 * 1000;
  const message = buildDelegationMessage(wallet, sessionPubkey, expiresAt);
  const signature = bs58.encode(
    nacl.sign.detached(new TextEncoder().encode(message), signer.secretKey),
  );
  return { wallet, sessionPubkey, expiresAt, message, signature };
}

describe("authRouter", () => {
  let redis: any;
  let keypair: Keypair;
  let wallet: string;

  beforeEach(() => {
    redis = makeRedis();
    keypair = Keypair.generate();
    wallet = keypair.publicKey.toBase58();
  });

  it("exchangeDelegation issues a session token mapped to the wallet", async () => {
    const caller = authRouter.createCaller(buildContext(redis));
    const delegation = makeDelegation(keypair);

    const res = await caller.exchangeDelegation({ delegation });
    expect(res.token).toMatch(/^[0-9a-f]{64}$/);
    expect(res.walletAddress).toBe(wallet);
    expect(res.expiresAt).toBeGreaterThan(Date.now());

    expect(await redis.get(`http-session:${res.token}`)).toBe(wallet);
    expect(
      await redis.get(`http-auth-delegation:${wallet}:${delegation.sessionPubkey}`),
    ).toBe(res.token);
  });

  it("rejects a delegation signed by the wrong keypair", async () => {
    const caller = authRouter.createCaller(buildContext(redis));
    const impostor = Keypair.generate();
    const sessionKp = nacl.sign.keyPair();
    const sessionPubkey = bs58.encode(sessionKp.publicKey);
    const expiresAt = Date.now() + 60 * 60 * 1000;
    const message = buildDelegationMessage(wallet, sessionPubkey, expiresAt);
    const signature = bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(message), impostor.secretKey),
    );

    await expect(
      caller.exchangeDelegation({
        delegation: { wallet, sessionPubkey, expiresAt, message, signature },
      }),
    ).rejects.toThrow(/Signature verification failed/);
  });

  it("rejects an expired delegation", async () => {
    const caller = authRouter.createCaller(buildContext(redis));
    const delegation = makeDelegation(keypair, {
      expiresAt: Date.now() - 1,
    });
    await expect(
      caller.exchangeDelegation({ delegation }),
    ).rejects.toThrow(/Delegation expired/);
  });

  it("rejects a delegation whose message doesn't match its fields", async () => {
    const caller = authRouter.createCaller(buildContext(redis));
    const delegation = makeDelegation(keypair);
    const tampered = { ...delegation, message: delegation.message + "\nextra" };
    await expect(
      caller.exchangeDelegation({ delegation: tampered }),
    ).rejects.toThrow(/Delegation message mismatch/);
  });

  it("re-exchange of the same delegation returns the existing token (idempotent)", async () => {
    const caller = authRouter.createCaller(buildContext(redis));
    const delegation = makeDelegation(keypair);
    const first = await caller.exchangeDelegation({ delegation });
    const second = await caller.exchangeDelegation({ delegation });
    expect(second.token).toBe(first.token);
    expect(second.walletAddress).toBe(first.walletAddress);
  });

  it("re-exchange after the bound token has expired mints a fresh token", async () => {
    const caller = authRouter.createCaller(buildContext(redis));
    const delegation = makeDelegation(keypair);
    const first = await caller.exchangeDelegation({ delegation });
    // Simulate natural TTL expiry of the session token while the binding
    // (7d) outlives it. (Distinct from logout, which sets a revocation
    // marker — see the logout tests below.)
    await redis.del(`http-session:${first.token}`);
    const second = await caller.exchangeDelegation({ delegation });
    expect(second.token).not.toBe(first.token);
    expect(await redis.get(`http-session:${second.token}`)).toBe(wallet);
  });

  it("rate-limits exchangeDelegation per wallet", async () => {
    const caller = authRouter.createCaller(buildContext(redis));
    // Limit is 20 per 60s per wallet. Use distinct session keypairs to
    // exercise the rate limiter rather than the idempotent-return path.
    for (let i = 0; i < 20; i++) {
      await caller.exchangeDelegation({ delegation: makeDelegation(keypair) });
    }
    await expect(
      caller.exchangeDelegation({ delegation: makeDelegation(keypair) }),
    ).rejects.toThrow(/Auth rate limit exceeded/);
  });

  it("logout clears the session token", async () => {
    const caller = authRouter.createCaller(buildContext(redis));
    const delegation = makeDelegation(keypair);
    const { token } = await caller.exchangeDelegation({ delegation });

    const authedCaller = authRouter.createCaller(
      buildContext(redis, { walletAddress: wallet, sessionToken: token }),
    );
    await authedCaller.logout();

    expect(await redis.get(`http-session:${token}`)).toBeNull();
  });

  it("logout revokes the delegation so it can't be replayed for a fresh token", async () => {
    const caller = authRouter.createCaller(buildContext(redis));
    const delegation = makeDelegation(keypair);
    const { token } = await caller.exchangeDelegation({ delegation });

    const authedCaller = authRouter.createCaller(
      buildContext(redis, { walletAddress: wallet, sessionToken: token }),
    );
    await authedCaller.logout();

    // Same delegation must not be replayable into a fresh session token.
    await expect(
      caller.exchangeDelegation({ delegation }),
    ).rejects.toThrow(/Delegation revoked/);

    // Binding and session+meta state must be cleared.
    expect(await redis.get(`http-session:${token}`)).toBeNull();
    expect(await redis.get(`http-session-meta:${token}`)).toBeNull();
    expect(
      await redis.get(
        `http-auth-delegation:${wallet}:${delegation.sessionPubkey}`,
      ),
    ).toBeNull();
    expect(
      await redis.get(
        `http-auth-revoked:${wallet}:${delegation.sessionPubkey}`,
      ),
    ).toBe("1");
  });

  it("logout does not block fresh delegations with a new session keypair", async () => {
    const caller = authRouter.createCaller(buildContext(redis));
    const firstDelegation = makeDelegation(keypair);
    const first = await caller.exchangeDelegation({ delegation: firstDelegation });

    await authRouter
      .createCaller(
        buildContext(redis, {
          walletAddress: wallet,
          sessionToken: first.token,
        }),
      )
      .logout();

    // New delegation = new sessionPubkey → different revocation key, must work.
    const freshDelegation = makeDelegation(keypair);
    const second = await caller.exchangeDelegation({
      delegation: freshDelegation,
    });
    expect(second.token).not.toBe(first.token);
    expect(await redis.get(`http-session:${second.token}`)).toBe(wallet);
  });
});

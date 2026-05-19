import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import type Redis from "ioredis";

export interface AdminHeaders {
  wallet: string | null;
  timestamp: string | null;
  nonce: string | null;
  signature: string | null;
}

export interface Context {
  walletAddress: string | null;
  sessionToken: string | null;
  ipCountry: string | null;
  ipAddress: string | null;
  adminHeaders: AdminHeaders;
  redis: Redis;
  /** scheme://host from x-forwarded-proto + host; absolute-URL anchor. */
  requestOrigin: string;
}

function extractBearer(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const [scheme, value] = authorization.split(" ", 2);
  if (!scheme || !value) return null;
  if (scheme.toLowerCase() !== "bearer") return null;
  return value.trim() || null;
}

export async function createContext({
  req,
}: CreateFastifyContextOptions): Promise<Context> {
  const redis = (req.server as any).redis as Redis;

  const sessionToken =
    extractBearer(req.headers.authorization as string | undefined) ??
    ((req.headers["x-session-token"] as string | undefined) ?? null);

  let walletAddress: string | null = null;
  if (sessionToken) {
    try {
      walletAddress = await redis.get(`http-session:${sessionToken}`);
    } catch {
      walletAddress = null;
    }
  }

  const ipCountry = req.headers["cf-ipcountry"] as string | undefined;
  const ipAddress =
    (req.headers["cf-connecting-ip"] as string | undefined) ??
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
    req.ip ??
    null;

  const adminHeaders: AdminHeaders = {
    wallet: (req.headers["x-admin-wallet"] as string | undefined) ?? null,
    timestamp: (req.headers["x-admin-timestamp"] as string | undefined) ?? null,
    nonce: (req.headers["x-admin-nonce"] as string | undefined) ?? null,
    signature: (req.headers["x-admin-signature"] as string | undefined) ?? null,
  };

  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ??
    req.protocol ??
    "http";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) ??
    (req.headers.host as string | undefined) ??
    "localhost:3001";
  const requestOrigin = `${proto}://${host}`;

  return {
    walletAddress,
    sessionToken,
    ipCountry: ipCountry ?? null,
    ipAddress,
    adminHeaders,
    redis,
    requestOrigin,
  };
}

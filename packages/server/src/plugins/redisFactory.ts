import Redis, { type RedisOptions } from "ioredis";

// Centralized so Heroku's self-signed rediss:// cert handling can't be
// forgotten at a new call site.

export function buildRedis(url: string, extra: RedisOptions = {}): Redis {
  const useTls = url.startsWith("rediss://");
  const opts: RedisOptions = {
    ...(useTls ? { tls: { rejectUnauthorized: false } } : {}),
    ...extra,
  };
  return new Redis(url, opts);
}

/** Options-shape (not instance) so BullMQ owns the connection lifecycle. */
export function buildBullMqConnection(url: string): {
  url: string;
  tls?: { rejectUnauthorized: false };
} {
  const useTls = url.startsWith("rediss://");
  return useTls
    ? { url, tls: { rejectUnauthorized: false } }
    : { url };
}

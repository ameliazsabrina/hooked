import Redis, { type RedisOptions } from "ioredis";

/**
 * Single, audited place to build an ioredis client.
 *
 * Heroku Redis exposes a `rediss://` URL whose TLS chain is signed by a
 * self-signed cert that ioredis (and node's tls.connect) reject by
 * default. The original incident's logs were full of:
 *
 *   [ioredis] Unhandled error event: Error: self-signed certificate in certificate chain
 *
 * because three separate `new Redis(...)` call sites (poolLifecycle,
 * dailyReset, dropBotData) were missing the `tls: { rejectUnauthorized: false }`
 * option that plugins/redis.ts had been carrying since day one. Each one
 * was its own forgotten copy-paste. Funnel everything through this
 * factory so the next "yet another `new Redis(url)`" call site can't
 * regress.
 *
 * The connection-options form that BullMQ accepts is the same shape;
 * `buildBullMqConnection` returns the object form for `new Queue / new
 * Worker` callers so they don't duplicate the cert handling either.
 */

/** Build a configured ioredis client. Pass `extra` for caller-specific
 *  options (e.g. `maxRetriesPerRequest: null` for BullMQ-compatible
 *  clients used in pub/sub contexts). */
export function buildRedis(url: string, extra: RedisOptions = {}): Redis {
  const useTls = url.startsWith("rediss://");
  const opts: RedisOptions = {
    ...(useTls ? { tls: { rejectUnauthorized: false } } : {}),
    ...extra,
  };
  return new Redis(url, opts);
}

/** Build a connection-options object for BullMQ's `Queue` / `Worker`
 *  constructors. BullMQ accepts either an ioredis instance or this
 *  options shape; we pass the shape so BullMQ owns the connection
 *  lifecycle and we don't risk a single client being shared in ways
 *  that break BullMQ's pub/sub assumptions. */
export function buildBullMqConnection(url: string): {
  url: string;
  tls?: { rejectUnauthorized: false };
} {
  const useTls = url.startsWith("rediss://");
  return useTls
    ? { url, tls: { rejectUnauthorized: false } }
    : { url };
}

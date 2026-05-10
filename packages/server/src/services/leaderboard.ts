import type Redis from "ioredis";

const LB_TTL = 48 * 60 * 60;
const POOL_LB_TTL = 35 * 24 * 60 * 60;

function lbKey(tier: number, date: string) {
  return `lb:${tier}:${date}`;
}

function topCatchKey(tier: number, date: string) {
  return `lb:top:${tier}:${date}`;
}

function poolLbKey(poolId: string) {
  return `lb:pool:${poolId}`;
}

function poolTopCatchKey(poolId: string) {
  return `lb:pool:top:${poolId}`;
}

export function redisMemberId(playerId: string): string {
  return playerId;
}

export function parseMemberId(member: string): { playerId: string } {
  return { playerId: member };
}

export async function addScore(
  redis: Redis,
  tier: number,
  date: string,
  playerId: string,
  score: number
): Promise<number> {
  const key = lbKey(tier, date);
  const newScore = await redis.zincrby(key, score, playerId);
  await redis.expire(key, LB_TTL);
  return parseFloat(newScore);
}

export async function getLeaderboard(
  redis: Redis,
  tier: number,
  date: string,
  offset: number = 0,
  limit: number = 50
): Promise<{ member: string; score: number }[]> {
  const key = lbKey(tier, date);
  const raw = await redis.zrevrange(key, offset, offset + limit - 1, "WITHSCORES");

  const results: { member: string; score: number }[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    results.push({ member: raw[i], score: parseFloat(raw[i + 1]) });
  }
  return results;
}

export async function getEntryCount(
  redis: Redis,
  tier: number,
  date: string
): Promise<number> {
  return redis.zcard(lbKey(tier, date));
}

export async function getPlayerRank(
  redis: Redis,
  tier: number,
  date: string,
  playerId: string
): Promise<number | null> {
  const rank = await redis.zrevrank(lbKey(tier, date), playerId);
  return rank;
}

export async function getPlayerScore(
  redis: Redis,
  tier: number,
  date: string,
  playerId: string
): Promise<number | null> {
  const score = await redis.zscore(lbKey(tier, date), playerId);
  return score !== null ? parseFloat(score) : null;
}

export async function getAllScores(
  redis: Redis,
  tier: number,
  date: string
): Promise<{ member: string; score: number }[]> {
  const key = lbKey(tier, date);
  const raw = await redis.zrevrange(key, 0, -1, "WITHSCORES");

  const results: { member: string; score: number }[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    results.push({ member: raw[i], score: parseFloat(raw[i + 1]) });
  }
  return results;
}

export async function updateTopCatch(
  redis: Redis,
  tier: number,
  date: string,
  playerId: string,
  catchData: { species: string; rarity: string; weightKg: number; score: number }
): Promise<void> {
  const key = topCatchKey(tier, date);
  const existing = await redis.hget(key, playerId);
  if (existing) {
    const parsed = JSON.parse(existing);
    if (parsed.score >= catchData.score) return;
  }
  await redis.hset(key, playerId, JSON.stringify(catchData));
  await redis.expire(key, LB_TTL);
}

export async function getTopCatches(
  redis: Redis,
  tier: number,
  date: string,
  memberIds: string[]
): Promise<Map<string, { species: string; rarity: string; weightKg: number; score: number }>> {
  if (memberIds.length === 0) return new Map();
  const key = topCatchKey(tier, date);
  const pipeline = redis.pipeline();
  for (const id of memberIds) {
    pipeline.hget(key, id);
  }
  const results = await pipeline.exec();
  const map = new Map<string, { species: string; rarity: string; weightKg: number; score: number }>();

  if (results) {
    for (let i = 0; i < memberIds.length; i++) {
      const [err, val] = results[i];
      if (!err && val && typeof val === "string") {
        map.set(memberIds[i], JSON.parse(val));
      }
    }
  }
  return map;
}

export async function addPoolScore(
  redis: Redis,
  poolId: string,
  playerId: string,
  score: number
): Promise<number> {
  const key = poolLbKey(poolId);
  const newScore = await redis.zincrby(key, score, playerId);
  await redis.expire(key, POOL_LB_TTL);
  return parseFloat(newScore);
}

export async function getPoolLeaderboard(
  redis: Redis,
  poolId: string,
  offset: number = 0,
  limit: number = 50
): Promise<{ member: string; score: number }[]> {
  const key = poolLbKey(poolId);
  const raw = await redis.zrevrange(key, offset, offset + limit - 1, "WITHSCORES");
  const results: { member: string; score: number }[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    results.push({ member: raw[i], score: parseFloat(raw[i + 1]) });
  }
  return results;
}

export async function getPoolPlayerRank(
  redis: Redis,
  poolId: string,
  playerId: string
): Promise<number | null> {
  return redis.zrevrank(poolLbKey(poolId), playerId);
}

export async function getPoolPlayerScore(
  redis: Redis,
  poolId: string,
  playerId: string
): Promise<number | null> {
  const score = await redis.zscore(poolLbKey(poolId), playerId);
  return score !== null ? parseFloat(score) : null;
}

export async function updatePoolTopCatch(
  redis: Redis,
  poolId: string,
  playerId: string,
  catchData: { species: string; rarity: string; weightKg: number; score: number }
): Promise<void> {
  const key = poolTopCatchKey(poolId);
  const existing = await redis.hget(key, playerId);
  if (existing) {
    const parsed = JSON.parse(existing);
    if (parsed.score >= catchData.score) return;
  }
  await redis.hset(key, playerId, JSON.stringify(catchData));
  await redis.expire(key, POOL_LB_TTL);
}

export async function getPoolEntryCount(
  redis: Redis,
  poolId: string
): Promise<number> {
  return redis.zcard(poolLbKey(poolId));
}

const ROOM_LB_TTL = 10 * 24 * 60 * 60;

function roomLbKey(roomId: string) {
  return `lb:room:${roomId}`;
}

function roomTopCatchKey(roomId: string) {
  return `lb:room:top:${roomId}`;
}

export async function addRoomScore(
  redis: Redis,
  roomId: string,
  playerId: string,
  score: number
): Promise<number> {
  const key = roomLbKey(roomId);
  const newScore = await redis.zincrby(key, score, playerId);
  await redis.expire(key, ROOM_LB_TTL);
  return parseFloat(newScore);
}

/**
 * Insert a player into the room leaderboard with score 0 if they don't
 * already have an entry. Idempotent: existing scores are preserved (the
 * NX flag is what guarantees that). Called when a player joins a room
 * so they appear on the leaderboard immediately, before their first
 * catch credits any score via `addRoomScore`.
 */
export async function seedRoomMember(
  redis: Redis,
  roomId: string,
  playerId: string
): Promise<void> {
  const key = roomLbKey(roomId);
  await redis.zadd(key, "NX", 0, playerId);
  await redis.expire(key, ROOM_LB_TTL);
}

/**
 * Bulk variant of `seedRoomMember`: NX-add many players in one pipeline.
 * Used by the leaderboard query to self-heal — if any depositor in
 * `room.players[]` is missing from the sorted set (e.g. they joined
 * before per-join seeding shipped, or a Redis hiccup dropped their
 * insert), this brings them back without resetting any existing score.
 */
export async function seedRoomMembers(
  redis: Redis,
  roomId: string,
  playerIds: string[]
): Promise<void> {
  if (playerIds.length === 0) return;
  const key = roomLbKey(roomId);
  const pipeline = redis.pipeline();
  for (const id of playerIds) {
    pipeline.zadd(key, "NX", 0, id);
  }
  pipeline.expire(key, ROOM_LB_TTL);
  await pipeline.exec();
}

export async function getRoomLeaderboard(
  redis: Redis,
  roomId: string,
  offset: number = 0,
  limit: number = 50
): Promise<{ member: string; score: number }[]> {
  const key = roomLbKey(roomId);
  const raw = await redis.zrevrange(key, offset, offset + limit - 1, "WITHSCORES");
  const results: { member: string; score: number }[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    results.push({ member: raw[i], score: parseFloat(raw[i + 1]) });
  }
  return results;
}

export async function getRoomPlayerRank(
  redis: Redis,
  roomId: string,
  playerId: string
): Promise<number | null> {
  return redis.zrevrank(roomLbKey(roomId), playerId);
}

export async function getRoomPlayerScore(
  redis: Redis,
  roomId: string,
  playerId: string
): Promise<number | null> {
  const score = await redis.zscore(roomLbKey(roomId), playerId);
  return score !== null ? parseFloat(score) : null;
}

export async function getRoomEntryCount(
  redis: Redis,
  roomId: string
): Promise<number> {
  return redis.zcard(roomLbKey(roomId));
}

export async function updateRoomTopCatch(
  redis: Redis,
  roomId: string,
  memberId: string,
  catchData: { species: string; rarity: string; weightKg: number; score: number }
): Promise<void> {
  const key = roomTopCatchKey(roomId);
  const existing = await redis.hget(key, memberId);
  if (existing) {
    const parsed = JSON.parse(existing);
    if (parsed.score >= catchData.score) return;
  }
  await redis.hset(key, memberId, JSON.stringify(catchData));
  await redis.expire(key, ROOM_LB_TTL);
}

export async function getRoomTopCatches(
  redis: Redis,
  roomId: string,
  memberIds: string[]
): Promise<Map<string, { species: string; rarity: string; weightKg: number; score: number }>> {
  if (memberIds.length === 0) return new Map();
  const key = roomTopCatchKey(roomId);
  const pipeline = redis.pipeline();
  for (const id of memberIds) pipeline.hget(key, id);
  const results = await pipeline.exec();
  const map = new Map<string, { species: string; rarity: string; weightKg: number; score: number }>();
  if (results) {
    for (let i = 0; i < memberIds.length; i++) {
      const [err, val] = results[i];
      if (!err && val && typeof val === "string") {
        map.set(memberIds[i], JSON.parse(val));
      }
    }
  }
  return map;
}

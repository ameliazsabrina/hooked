import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import RedisMock from "ioredis-mock";

let mongod: MongoMemoryServer | null = null;

export async function startTestMongo(): Promise<string> {
  if (mongod) return mongod.getUri();
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri, { dbName: "hooked_test" });
  return uri;
}

export async function stopTestMongo(): Promise<void> {
  await mongoose.disconnect();
  if (mongod) {
    await mongod.stop();
    mongod = null;
  }
}

export async function clearAllCollections(): Promise<void> {
  const { collections } = mongoose.connection;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
}

export function makeRedis(): any {
  return new RedisMock();
}

export async function makeFreshRedis(): Promise<any> {
  const redis = new RedisMock();
  await redis.flushall();
  return redis;
}

import { describe, it, expect, beforeEach } from "vitest";
import {
  claimBaitIssuance,
  releaseBaitIssuance,
} from "../src/services/baitClaim.js";
import { makeRedis } from "./setup.js";

describe("baitClaim", () => {
  let redis: any;
  beforeEach(() => {
    redis = makeRedis();
  });

  it("first caller wins the claim", async () => {
    const ok = await claimBaitIssuance(redis, "wallet-a", 1, 0);
    expect(ok).toBe(true);
  });

  it("second caller for the same (wallet, date, window) loses", async () => {
    await claimBaitIssuance(redis, "wallet-a", 1, 0);
    const ok = await claimBaitIssuance(redis, "wallet-a", 1, 0);
    expect(ok).toBe(false);
  });

  it("different window or date are independent claims", async () => {
    await claimBaitIssuance(redis, "wallet-a", 1, 0);
    expect(await claimBaitIssuance(redis, "wallet-a", 1, 1)).toBe(true);
    expect(await claimBaitIssuance(redis, "wallet-a", 2, 0)).toBe(true);
    expect(await claimBaitIssuance(redis, "wallet-b", 1, 0)).toBe(true);
  });

  it("release frees the slot for re-claim", async () => {
    await claimBaitIssuance(redis, "wallet-a", 1, 0);
    await releaseBaitIssuance(redis, "wallet-a", 1, 0);
    expect(await claimBaitIssuance(redis, "wallet-a", 1, 0)).toBe(true);
  });

  it("under concurrent racers, exactly one wins", async () => {
    const results = await Promise.all([
      claimBaitIssuance(redis, "racer", 1, 0),
      claimBaitIssuance(redis, "racer", 1, 0),
      claimBaitIssuance(redis, "racer", 1, 0),
      claimBaitIssuance(redis, "racer", 1, 0),
      claimBaitIssuance(redis, "racer", 1, 0),
    ]);
    expect(results.filter((r) => r === true)).toHaveLength(1);
    expect(results.filter((r) => r === false)).toHaveLength(4);
  });
});

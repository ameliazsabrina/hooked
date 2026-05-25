import { describe, it, expect } from "vitest";
import { withDeadline } from "../src/utils/timeout.js";

describe("withDeadline", () => {
  it("resolves when the inner promise beats the deadline", async () => {
    const value = await withDeadline(
      new Promise((r) => setTimeout(() => r(42), 10)),
      100,
      "fast",
    );
    expect(value).toBe(42);
  });

  it("rejects with a labeled error when the deadline expires first", async () => {
    await expect(
      withDeadline(new Promise((r) => setTimeout(r, 200)), 20, "slow op"),
    ).rejects.toThrow(/slow op timed out after 20ms/);
  });

  it("propagates the inner rejection instead of timing out", async () => {
    await expect(
      withDeadline(Promise.reject(new Error("bang")), 100, "op"),
    ).rejects.toThrow("bang");
  });

  it("clears the timer so fast resolves don't keep the loop alive", async () => {
    const start = Date.now();
    await withDeadline(Promise.resolve("ok"), 5_000, "op");
    expect(Date.now() - start).toBeLessThan(100);
  });
});

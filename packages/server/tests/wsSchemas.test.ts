import { describe, it, expect } from "vitest";
import { ClientMessageSchema } from "../src/ws/schemas.js";

describe("ClientMessageSchema", () => {
  it("accepts a valid cast_initiate", () => {
    expect(
      ClientMessageSchema.safeParse({
        type: "cast_initiate",
        power: 100,
        clientCastId: "abc",
      }).success,
    ).toBe(true);
  });

  it("accepts authenticate with optional recoverCastId", () => {
    expect(
      ClientMessageSchema.safeParse({
        type: "authenticate",
        wallet: "w",
        nonce: "n",
        signature: "s",
        recoverCastId: "c",
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown message type", () => {
    expect(ClientMessageSchema.safeParse({ type: "nope" }).success).toBe(false);
  });

  it("rejects a missing required field", () => {
    expect(
      ClientMessageSchema.safeParse({ type: "cast_initiate", power: 100 })
        .success,
    ).toBe(false);
  });

  it("rejects a wrong field type", () => {
    expect(
      ClientMessageSchema.safeParse({
        type: "cast_initiate",
        power: "fast",
        clientCastId: "a",
      }).success,
    ).toBe(false);
  });

  it("allows unknown extra keys (not strict)", () => {
    expect(
      ClientMessageSchema.safeParse({ type: "ping", t: 1, extra: true }).success,
    ).toBe(true);
  });

  it("bounds the input_samples array length", () => {
    const samples = Array.from({ length: 600 }, (_, i) => ({
      held: true,
      index: i,
      t_ms: i,
    }));
    expect(
      ClientMessageSchema.safeParse({
        type: "input_samples",
        sessionId: "s",
        clientCastId: "c",
        samples,
      }).success,
    ).toBe(false);
  });
});

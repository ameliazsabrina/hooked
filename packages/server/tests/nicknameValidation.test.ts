import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  NICKNAME_MIN,
  NICKNAME_MAX,
  NICKNAME_REGEX,
  NICKNAME_ERRORS,
  isValidNickname,
  sanitizeNickname,
} from "@hooked/shared";

// Mirror of the server's setNickname input (playerRouter composes it from the
// same shared constants). This test guards that the client predicate and the
// server schema can never drift.
const serverNicknameSchema = z
  .string()
  .min(NICKNAME_MIN, NICKNAME_ERRORS.min)
  .max(NICKNAME_MAX, NICKNAME_ERRORS.max)
  .regex(NICKNAME_REGEX, NICKNAME_ERRORS.charset);

const CASES = [
  "",
  "ab",
  "abc",
  "Player1",
  "a".repeat(NICKNAME_MAX),
  "a".repeat(NICKNAME_MAX + 1),
  "ab cd",
  "ab_cd",
  "über",
  "  spaces  ",
  "1234567890",
  "ABCdef123",
];

describe("nickname validation parity (client predicate vs server schema)", () => {
  it.each(CASES)("agrees on %j", (value) => {
    const serverOk = serverNicknameSchema.safeParse(value).success;
    expect(isValidNickname(value)).toBe(serverOk);
  });
});

describe("isValidNickname", () => {
  it("rejects too-short", () => expect(isValidNickname("ab")).toBe(false));
  it("accepts min length", () => expect(isValidNickname("abc")).toBe(true));
  it("accepts max length", () =>
    expect(isValidNickname("a".repeat(NICKNAME_MAX))).toBe(true));
  it("rejects over max", () =>
    expect(isValidNickname("a".repeat(NICKNAME_MAX + 1))).toBe(false));
  it("rejects non-alphanumeric", () => {
    expect(isValidNickname("ab cd")).toBe(false);
    expect(isValidNickname("ab_cd")).toBe(false);
    expect(isValidNickname("über")).toBe(false);
  });
});

describe("sanitizeNickname", () => {
  it("strips disallowed characters", () =>
    expect(sanitizeNickname("a b_c!d")).toBe("abcd"));
  it("clamps to max length", () =>
    expect(sanitizeNickname("a".repeat(50))).toHaveLength(NICKNAME_MAX));
  it("produces a value that passes validation when long enough", () => {
    const out = sanitizeNickname("My Cool Name!!!");
    expect(isValidNickname(out)).toBe(true);
  });
  it("leaves a valid nickname unchanged", () =>
    expect(sanitizeNickname("Player1")).toBe("Player1"));
});

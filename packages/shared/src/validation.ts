// Single source of truth for nickname rules — server composes its Zod schema
// from these; the client validates with the predicate. No duplicated regex.
export const NICKNAME_MIN = 3;
export const NICKNAME_MAX = 16;
export const NICKNAME_REGEX = /^[a-zA-Z0-9]+$/;

export const NICKNAME_ERRORS = {
  min: `Nickname must be at least ${NICKNAME_MIN} characters`,
  max: `Nickname must be at most ${NICKNAME_MAX} characters`,
  charset: "Nickname must be alphanumeric",
} as const;

export function isValidNickname(value: string): boolean {
  return (
    value.length >= NICKNAME_MIN &&
    value.length <= NICKNAME_MAX &&
    NICKNAME_REGEX.test(value)
  );
}

// Strips disallowed characters and clamps length — for live input filtering.
export function sanitizeNickname(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").slice(0, NICKNAME_MAX);
}

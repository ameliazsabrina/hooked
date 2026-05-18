import { TRPCError } from "@trpc/server";
import { CastEngineError, type CastEngineErrorCode } from "./errors.js";

/**
 * Map domain errors from the off-chain fishing engine to TRPCError codes.
 * Keeps TRPCError out of the engine layer (commands/services speak the
 * domain language) and centralizes the mapping so error semantics stay
 * consistent across all fishing routes.
 *
 * Use as: `try { ... } catch (e) { mapFishingError(e); }` — the helper
 * always throws.
 */
const CODE_MAP: Record<CastEngineErrorCode, TRPCError["code"]> = {
  SESSION_NOT_FOUND: "NOT_FOUND",
  SESSION_NOT_ACTIVE: "BAD_REQUEST",
  NO_BAIT: "BAD_REQUEST",
  CAST_PENDING: "CONFLICT",
  NO_CAST_TO_RESOLVE: "BAD_REQUEST",
  CANCEL_GRACE_EXPIRED: "BAD_REQUEST",
  CATCHES_FULL: "BAD_REQUEST",
  CAST_RACE: "CONFLICT",
  // Cast attempted on a room past closesAt or past its `entry`/`active`
  // phase. PRECONDITION_FAILED rather than BAD_REQUEST because the client's
  // request is well-formed — the world state just no longer permits it.
  WINDOW_CLOSED: "PRECONDITION_FAILED",
};

export function mapFishingError(err: unknown): never {
  if (err instanceof CastEngineError) {
    throw new TRPCError({
      code: CODE_MAP[err.code],
      message: err.message,
      cause: err,
    });
  }
  // Re-throw unknown errors unchanged so the global error handler can log
  // them at error-level and the client sees INTERNAL_SERVER_ERROR.
  throw err;
}

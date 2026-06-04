import { TRPCError } from "@trpc/server";
import { AppError, mapAppErrorToTRPC } from "../../errors/AppError.js";
import { CastEngineError, type CastEngineErrorCode } from "./errors.js";

// Map fishing-engine domain errors to TRPCError codes; keeps TRPCError out of the engine. Always throws.
const CODE_MAP: Record<CastEngineErrorCode, TRPCError["code"]> = {
  SESSION_NOT_FOUND: "NOT_FOUND",
  SESSION_NOT_ACTIVE: "BAD_REQUEST",
  NO_BAIT: "BAD_REQUEST",
  CAST_PENDING: "CONFLICT",
  NO_CAST_TO_RESOLVE: "BAD_REQUEST",
  CANCEL_GRACE_EXPIRED: "BAD_REQUEST",
  CATCHES_FULL: "BAD_REQUEST",
  CAST_RACE: "CONFLICT",
  // PRECONDITION_FAILED not BAD_REQUEST: the request is well-formed, the world state just no longer permits the cast.
  WINDOW_CLOSED: "PRECONDITION_FAILED",
};

export function mapFishingError(err: unknown): never {
  if (err instanceof AppError) mapAppErrorToTRPC(err);
  if (err instanceof CastEngineError) {
    throw new TRPCError({
      code: CODE_MAP[err.code],
      message: err.message,
      cause: err,
    });
  }
  // Re-throw unknown errors so the global handler logs them and the client sees INTERNAL_SERVER_ERROR.
  throw err;
}

/**
 * Domain errors thrown by the off-chain fishing engine. Routers translate
 * these into TRPCError codes; commands/services should never throw TRPCError
 * directly.
 */

export type CastEngineErrorCode =
  | "SESSION_NOT_ACTIVE"
  | "SESSION_NOT_FOUND"
  | "NO_BAIT"
  | "CAST_PENDING"
  | "NO_CAST_TO_RESOLVE"
  | "CANCEL_GRACE_EXPIRED"
  | "CATCHES_FULL"
  | "CAST_RACE"
  | "WINDOW_CLOSED";

export class CastEngineError extends Error {
  constructor(
    public readonly code: CastEngineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CastEngineError";
  }
}

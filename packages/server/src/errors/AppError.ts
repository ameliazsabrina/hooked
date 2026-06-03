import { TRPCError } from "@trpc/server";

export type AppErrorCode =
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "CONFLICT"
  | "FORBIDDEN"
  | "UNAUTHORIZED"
  | "TOO_MANY_REQUESTS"
  | "PRECONDITION_FAILED";

export abstract class AppError extends Error {
  abstract readonly code: AppErrorCode;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND" as const;
  constructor(message = "Not found") {
    super(message);
  }
}

export class ValidationError extends AppError {
  readonly code = "BAD_REQUEST" as const;
}

export class ConflictError extends AppError {
  readonly code = "CONFLICT" as const;
}

export class ForbiddenError extends AppError {
  readonly code = "FORBIDDEN" as const;
}

export class UnauthorizedError extends AppError {
  readonly code = "UNAUTHORIZED" as const;
}

export class RateLimitError extends AppError {
  readonly code = "TOO_MANY_REQUESTS" as const;
  constructor(message = "Rate limit exceeded") {
    super(message);
  }
}

export class PreconditionError extends AppError {
  readonly code = "PRECONDITION_FAILED" as const;
}

export function mapAppErrorToTRPC(err: unknown): never {
  if (err instanceof AppError) {
    throw new TRPCError({ code: err.code, message: err.message, cause: err });
  }
  // Already-mapped errors (middleware, nested helpers) pass through untouched.
  if (err instanceof TRPCError) throw err;
  // Unknown errors reach the global handler as INTERNAL_SERVER_ERROR.
  throw err;
}

import { z } from "zod";

// Structural validation of inbound messages. Deliberately NOT strict — unknown
// keys pass so an independently-versioned client doesn't break. Physics-value
// validation (clamps, out-of-order rejection) stays in the handlers.

const delegationSchema = z.object({
  wallet: z.string(),
  sessionPubkey: z.string(),
  expiresAt: z.number(),
  message: z.string(),
  signature: z.string(),
});

const authenticate = z.object({
  type: z.literal("authenticate"),
  wallet: z.string(),
  nonce: z.string(),
  signature: z.string(),
  delegation: delegationSchema.optional(),
  recoverCastId: z.string().optional(),
});

const castInitiate = z.object({
  type: z.literal("cast_initiate"),
  power: z.number().finite(),
  clientCastId: z.string().min(1),
});

const nibbleResponse = z.object({
  type: z.literal("nibble_response"),
  sessionId: z.string(),
  clientCastId: z.string().min(1),
  clientTs: z.number().finite(),
});

const inputSample = z.object({
  held: z.boolean(),
  index: z.number().int(),
  t_ms: z.number().finite(),
});

const inputSamples = z.object({
  type: z.literal("input_samples"),
  sessionId: z.string(),
  clientCastId: z.string().min(1),
  samples: z.array(inputSample).max(512),
});

const castFinalize = z.object({
  type: z.literal("cast_finalize"),
  sessionId: z.string(),
  clientCastId: z.string().min(1),
});

const circularTapInput = z.object({
  tapIndex: z.number().int(),
  msSinceTapStart: z.number().finite(),
});

const circularTapComplete = z.object({
  type: z.literal("circular_tap_complete"),
  sessionId: z.string(),
  clientCastId: z.string().min(1),
  taps: z.array(circularTapInput).max(256),
});

const ping = z.object({
  type: z.literal("ping"),
  t: z.number().finite(),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  authenticate,
  castInitiate,
  nibbleResponse,
  inputSamples,
  castFinalize,
  circularTapComplete,
  ping,
]);

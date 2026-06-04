import { router, publicProcedure } from "./trpc.js";
import { authRouter } from "./authRouter.js";
import { playerRouter } from "./playerRouter.js";
import { poolRouter } from "./poolRouter.js";
import { roomRouter } from "./roomRouter.js";
import { fishingRouter } from "./fishingRouter.js";
import { auditRouter } from "./auditRouter.js";
import { shopRouter } from "./shopRouter.js";
import { bountyRouter } from "./bountyRouter.js";
import { adminRouter } from "./adminRouter.js";

export const healthRouter = router({
  ping: publicProcedure.query(() => {
    return "pong";
  }),

  status: publicProcedure.query(() => {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      version: "0.0.0",
    };
  }),
});

export const appRouter = router({
  health: healthRouter,
  auth: authRouter,
  player: playerRouter,
  pool: poolRouter,
  room: roomRouter,
  fishing: fishingRouter,
  audit: auditRouter,
  shop: shopRouter,
  bounty: bountyRouter,
  admin: adminRouter,
});

export type AppRouter = typeof appRouter;

import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;

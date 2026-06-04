import { z } from "zod";
import { RODS, BAITS } from "@hooked/shared";
import { router, protectedProcedure } from "./trpc.js";
import { mapAppErrorToTRPC } from "../errors/AppError.js";
import * as shop from "../services/shop.js";

const slugInput = z.object({ slug: z.string().min(1) }).strict();
const catchIdInput = z.object({ catchId: z.string().min(1) }).strict();
const catchIdsInput = z
  .object({ catchIds: z.array(z.string().min(1)).min(1).max(100) })
  .strict();

export const shopRouter = router({
  catalog: protectedProcedure.query(() => ({ rods: RODS, baits: BAITS })),

  buyRod: protectedProcedure.input(slugInput).mutation(async ({ ctx, input }) => {
    try {
      return await shop.buyRod(ctx.walletAddress, input.slug);
    } catch (err) {
      mapAppErrorToTRPC(err);
    }
  }),

  buyBait: protectedProcedure.input(slugInput).mutation(async ({ ctx, input }) => {
    try {
      return await shop.buyBait(ctx.walletAddress, input.slug);
    } catch (err) {
      mapAppErrorToTRPC(err);
    }
  }),

  equipRod: protectedProcedure.input(slugInput).mutation(async ({ ctx, input }) => {
    try {
      return await shop.equipRod(ctx.walletAddress, input.slug);
    } catch (err) {
      mapAppErrorToTRPC(err);
    }
  }),

  equipBait: protectedProcedure.input(slugInput).mutation(async ({ ctx, input }) => {
    try {
      return await shop.equipBait(ctx.walletAddress, input.slug);
    } catch (err) {
      mapAppErrorToTRPC(err);
    }
  }),

  sellFish: protectedProcedure
    .input(catchIdInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await shop.sellFish(ctx.walletAddress, input.catchId);
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),

  sellFishBulk: protectedProcedure
    .input(catchIdsInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await shop.sellFishBulk(ctx.walletAddress, input.catchIds);
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),
});

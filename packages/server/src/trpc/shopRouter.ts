import { TRPCError } from "@trpc/server";
import { z } from "zod";
import mongoose from "mongoose";
import {
  RODS,
  BAITS,
  isRodSlug,
  isBaitSlug,
  getRod,
  getBait,
} from "@hooked/shared";
import { router, protectedProcedure } from "./trpc.js";
import { Player, Catch } from "../db/schema.js";

const slugInput = z.object({ slug: z.string().min(1) });

export const shopRouter = router({
  catalog: protectedProcedure.query(() => ({
    rods: RODS,
    baits: BAITS,
  })),

  buyRod: protectedProcedure
    .input(slugInput)
    .mutation(async ({ ctx, input }) => {
      if (!isRodSlug(input.slug)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown rod" });
      }
      const rod = getRod(input.slug);

      // Atomic purchase: deduct shell and add rod to inventory iff
      //   - player exists, has enough shell, and doesn't already own it.
      const purchased = await Player.findOneAndUpdate(
        {
          walletAddress: ctx.walletAddress,
          shellBalance: { $gte: rod.shellCost },
          "equipment.ownedRods": { $ne: rod.slug },
        },
        {
          $inc: { shellBalance: -rod.shellCost },
          $push: { "equipment.ownedRods": rod.slug },
        },
        { new: true },
      );

      if (!purchased) {
        const existing = await Player.findOne(
          { walletAddress: ctx.walletAddress },
          { shellBalance: 1, "equipment.ownedRods": 1 },
        ).lean();
        if (!existing) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Player not found" });
        }
        if ((existing.equipment?.ownedRods ?? []).includes(rod.slug)) {
          throw new TRPCError({ code: "CONFLICT", message: "Already owned" });
        }
        throw new TRPCError({ code: "BAD_REQUEST", message: "Not enough Shell" });
      }

      // Optional tier upgrade — only applies if this rod outranks the currently
      // equipped one. Guard on rodTier in the filter so a concurrent purchase
      // of a higher tier can't be stomped.
      let result = purchased;
      if (rod.tier > (purchased.equipment?.rodTier ?? 0)) {
        const upgraded = await Player.findOneAndUpdate(
          { _id: purchased._id, "equipment.rodTier": { $lt: rod.tier } },
          {
            $set: {
              "equipment.rodTier": rod.tier,
              "equipment.rodEquipped": rod.slug,
            },
          },
          { new: true },
        );
        if (upgraded) result = upgraded;
      }

      return { shellBalance: result.shellBalance, equipment: result.equipment };
    }),

  buyBait: protectedProcedure
    .input(slugInput)
    .mutation(async ({ ctx, input }) => {
      if (!isBaitSlug(input.slug)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown bait" });
      }
      const bait = getBait(input.slug);

      const purchased = await Player.findOneAndUpdate(
        {
          walletAddress: ctx.walletAddress,
          shellBalance: { $gte: bait.shellCost },
          "equipment.ownedBaits": { $ne: bait.slug },
        },
        {
          $inc: { shellBalance: -bait.shellCost },
          $push: { "equipment.ownedBaits": bait.slug },
        },
        { new: true },
      );

      if (!purchased) {
        const existing = await Player.findOne(
          { walletAddress: ctx.walletAddress },
          { shellBalance: 1, "equipment.ownedBaits": 1 },
        ).lean();
        if (!existing) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Player not found" });
        }
        if ((existing.equipment?.ownedBaits ?? []).includes(bait.slug)) {
          throw new TRPCError({ code: "CONFLICT", message: "Already owned" });
        }
        throw new TRPCError({ code: "BAD_REQUEST", message: "Not enough Shell" });
      }

      let result = purchased;
      if (bait.tier > (purchased.equipment?.luckyLureTier ?? 0)) {
        const upgraded = await Player.findOneAndUpdate(
          { _id: purchased._id, "equipment.luckyLureTier": { $lt: bait.tier } },
          {
            $set: {
              "equipment.luckyLureTier": bait.tier,
              "equipment.baitEquipped": bait.slug,
            },
          },
          { new: true },
        );
        if (upgraded) result = upgraded;
      }

      return {
        shellBalance: result.shellBalance,
        equipment: result.equipment,
      };
    }),

  equipRod: protectedProcedure
    .input(slugInput)
    .mutation(async ({ ctx, input }) => {
      if (!isRodSlug(input.slug)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown rod" });
      }
      const rod = getRod(input.slug);

      const result = await Player.findOneAndUpdate(
        {
          walletAddress: ctx.walletAddress,
          "equipment.ownedRods": rod.slug,
        },
        {
          $set: {
            "equipment.rodEquipped": rod.slug,
            "equipment.rodTier": rod.tier,
          },
        },
        { new: true },
      );

      if (!result) {
        const existing = await Player.findOne({ walletAddress: ctx.walletAddress })
          .select({ _id: 1 })
          .lean();
        throw new TRPCError({
          code: existing ? "BAD_REQUEST" : "NOT_FOUND",
          message: existing ? "Rod not owned" : "Player not found",
        });
      }

      return { equipment: result.equipment };
    }),

  equipBait: protectedProcedure
    .input(slugInput)
    .mutation(async ({ ctx, input }) => {
      if (!isBaitSlug(input.slug)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown bait" });
      }
      const bait = getBait(input.slug);

      const result = await Player.findOneAndUpdate(
        {
          walletAddress: ctx.walletAddress,
          "equipment.ownedBaits": bait.slug,
        },
        {
          $set: {
            "equipment.baitEquipped": bait.slug,
            "equipment.luckyLureTier": bait.tier,
          },
        },
        { new: true },
      );

      if (!result) {
        const existing = await Player.findOne({ walletAddress: ctx.walletAddress })
          .select({ _id: 1 })
          .lean();
        throw new TRPCError({
          code: existing ? "BAD_REQUEST" : "NOT_FOUND",
          message: existing ? "Bait not owned" : "Player not found",
        });
      }

      return { equipment: result.equipment };
    }),

  sellFish: protectedProcedure
    .input(z.object({ catchId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      if (!mongoose.isValidObjectId(input.catchId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid catch id" });
      }
      const player = await Player.findOne(
        { walletAddress: ctx.walletAddress },
        { _id: 1 },
      ).lean();
      if (!player) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Player not found" });
      }

      const now = new Date();
      const claimed = await Catch.findOneAndUpdate(
        {
          _id: input.catchId,
          playerId: player._id,
          released: false,
        },
        { $set: { released: true, soldAt: now } },
        { new: true, projection: { sellValue: 1, rarity: 1 } },
      ).lean();

      if (!claimed) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Catch not available" });
      }

      const price = claimed.sellValue ?? 0;
      const [, updatedPlayer] = await Promise.all([
        Catch.updateOne({ _id: claimed._id }, { $set: { soldPrice: price } }),
        Player.findOneAndUpdate(
          { _id: player._id },
          { $inc: { shellBalance: price } },
          { new: true, projection: { shellBalance: 1 } },
        ).lean(),
      ]);

      return {
        price,
        shellBalance: updatedPlayer?.shellBalance ?? 0,
      };
    }),

  sellFishBulk: protectedProcedure
    .input(
      z.object({
        catchIds: z.array(z.string().min(1)).min(1).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const validIds = input.catchIds.filter((id) => mongoose.isValidObjectId(id));
      if (validIds.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "No valid catch ids" });
      }
      const player = await Player.findOne(
        { walletAddress: ctx.walletAddress },
        { _id: 1 },
      ).lean();
      if (!player) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Player not found" });
      }

      const candidates = await Catch.find(
        {
          _id: { $in: validIds },
          playerId: player._id,
          released: false,
        },
        { _id: 1, sellValue: 1 },
      ).lean();

      if (candidates.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Nothing to sell" });
      }

      // Claim each catch atomically and in parallel. Only catches we successfully
      // flipped to released contribute to the total — this protects against
      // concurrent double-sells.
      const now = new Date();
      const outcomes = await Promise.all(
        candidates.map(async (c) => {
          const price = c.sellValue ?? 0;
          const res = await Catch.updateOne(
            { _id: c._id, released: false },
            { $set: { released: true, soldAt: now, soldPrice: price } },
          );
          return res.modifiedCount === 1
            ? { id: String(c._id), price }
            : null;
        }),
      );

      const sold = outcomes.filter(
        (o): o is { id: string; price: number } => o !== null,
      );
      if (sold.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Nothing to sell" });
      }
      const totalPrice = sold.reduce((acc, s) => acc + s.price, 0);

      const updatedPlayer = await Player.findOneAndUpdate(
        { _id: player._id },
        { $inc: { shellBalance: totalPrice } },
        { new: true, projection: { shellBalance: 1 } },
      ).lean();

      return {
        totalPrice,
        soldIds: sold.map((s) => s.id),
        shellBalance: updatedPlayer?.shellBalance ?? 0,
      };
    }),
});

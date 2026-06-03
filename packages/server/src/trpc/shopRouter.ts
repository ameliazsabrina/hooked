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
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  mapAppErrorToTRPC,
} from "../errors/AppError.js";

const slugInput = z.object({ slug: z.string().min(1) }).strict();

export const shopRouter = router({
  catalog: protectedProcedure.query(() => ({
    rods: RODS,
    baits: BAITS,
  })),

  buyRod: protectedProcedure
    .input(slugInput)
    .mutation(async ({ ctx, input }) => {
      try {
        if (!isRodSlug(input.slug)) {
          throw new ValidationError("Unknown rod");
        }
        const rod = getRod(input.slug);

        // Atomic purchase: deduct shell and add rod iff player exists, can
        // afford it, and doesn't already own it.
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
          if (!existing) throw new NotFoundError("Player not found");
          if ((existing.equipment?.ownedRods ?? []).includes(rod.slug)) {
            throw new ConflictError("Already owned");
          }
          throw new ValidationError("Not enough Shell");
        }

        // Tier upgrade only if this rod outranks the equipped one; guard on
        // rodTier so a concurrent higher-tier purchase can't be stomped.
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
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),

  buyBait: protectedProcedure
    .input(slugInput)
    .mutation(async ({ ctx, input }) => {
      try {
        if (!isBaitSlug(input.slug)) {
          throw new ValidationError("Unknown bait");
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
          if (!existing) throw new NotFoundError("Player not found");
          if ((existing.equipment?.ownedBaits ?? []).includes(bait.slug)) {
            throw new ConflictError("Already owned");
          }
          throw new ValidationError("Not enough Shell");
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
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),

  equipRod: protectedProcedure
    .input(slugInput)
    .mutation(async ({ ctx, input }) => {
      try {
        if (!isRodSlug(input.slug)) {
          throw new ValidationError("Unknown rod");
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
          if (!existing) throw new NotFoundError("Player not found");
          throw new ValidationError("Rod not owned");
        }

        return { equipment: result.equipment };
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),

  equipBait: protectedProcedure
    .input(slugInput)
    .mutation(async ({ ctx, input }) => {
      try {
        if (!isBaitSlug(input.slug)) {
          throw new ValidationError("Unknown bait");
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
          if (!existing) throw new NotFoundError("Player not found");
          throw new ValidationError("Bait not owned");
        }

        return { equipment: result.equipment };
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),

  sellFish: protectedProcedure
    .input(z.object({ catchId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        if (!mongoose.isValidObjectId(input.catchId)) {
          throw new ValidationError("Invalid catch id");
        }
        const player = await Player.findOne(
          { walletAddress: ctx.walletAddress },
          { _id: 1 },
        ).lean();
        if (!player) throw new NotFoundError("Player not found");

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
          throw new ValidationError("Catch not available");
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
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),

  sellFishBulk: protectedProcedure
    .input(
      z
        .object({
          catchIds: z.array(z.string().min(1)).min(1).max(100),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const validIds = input.catchIds.filter((id) => mongoose.isValidObjectId(id));
        if (validIds.length === 0) {
          throw new ValidationError("No valid catch ids");
        }
        const player = await Player.findOne(
          { walletAddress: ctx.walletAddress },
          { _id: 1 },
        ).lean();
        if (!player) throw new NotFoundError("Player not found");

        const candidates = await Catch.find(
          {
            _id: { $in: validIds },
            playerId: player._id,
            released: false,
          },
          { _id: 1, sellValue: 1 },
        ).lean();

        if (candidates.length === 0) {
          throw new ValidationError("Nothing to sell");
        }

        // Claim each catch atomically and in parallel; only catches we flipped
        // to released count, guarding against concurrent double-sells.
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
          throw new ValidationError("Nothing to sell");
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
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),
});

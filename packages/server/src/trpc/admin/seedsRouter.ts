import { z } from "zod";
import { adminSessionProcedure, router } from "../trpc.js";
import { FishingDailySeed, FishingSession } from "../../db/schema.js";
import { NotFoundError, mapAppErrorToTRPC } from "../../errors/AppError.js";

// Mongoose Buffer fields come back as BSON Binary on lean(); normalize to hex.
function bytesToHex(value: unknown): string | null {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  const maybe = value as { buffer?: ArrayBufferLike; toString?: () => string };
  if (maybe.buffer instanceof ArrayBuffer) {
    return Buffer.from(maybe.buffer as ArrayBuffer).toString("hex");
  }
  if (typeof maybe.toString === "function") return maybe.toString();
  return null;
}

export const adminSeedsRouter = router({
  list: adminSessionProcedure
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(100).default(30),
      }).strict(),
    )
    .query(async ({ input }) => {
      const [items, totalCount] = await Promise.all([
        FishingDailySeed.find()
          .sort({ date: -1 })
          .skip((input.page - 1) * input.limit)
          .limit(input.limit)
          .lean(),
        FishingDailySeed.countDocuments(),
      ]);

      const now = Date.now();
      return {
        items: items.map((s) => {
          const revealed = new Date(s.revealAfter).getTime() <= now;
          return {
            date: s.date,
            seedHashHex: bytesToHex(s.seedHash),
            // Only expose the raw seed after revealAfter (same policy as the public audit endpoint).
            seedHex: revealed ? bytesToHex(s.seed) : null,
            revealed,
            publishedAt: s.publishedAt,
            revealAfter: s.revealAfter,
          };
        }),
        totalCount,
        page: input.page,
        limit: input.limit,
      };
    }),

  get: adminSessionProcedure
    .input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict())
    .query(async ({ input }) => {
      try {
        const seed = await FishingDailySeed.findOne({ date: input.date }).lean();
        if (!seed) {
          throw new NotFoundError(`No daily seed for ${input.date}`);
        }
        const revealed = new Date(seed.revealAfter).getTime() <= Date.now();

        // How many sessions rolled against this seed (audit reach metric).
        const sessionCount = await FishingSession.countDocuments({
          dailySeedDate: input.date,
        });

        return {
          date: seed.date,
          seedHashHex: bytesToHex(seed.seedHash),
          seedHex: revealed ? bytesToHex(seed.seed) : null,
          revealed,
          publishedAt: seed.publishedAt,
          revealAfter: seed.revealAfter,
          sessionCount,
        };
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),
});

import { z } from "zod";
import { adminSessionProcedure, router } from "../trpc.js";
import { AdminAuditLog } from "../../db/schema.js";

export const adminAuditRouter = router({
  list: adminSessionProcedure
    .input(
      z.object({
        adminWallet: z.string().min(32).max(64).optional(),
        outcome: z.enum(["ok", "error"]).optional(),
        procedure: z.string().optional(),
        page: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(async ({ input }) => {
      const filter: Record<string, unknown> = {};
      if (input.adminWallet) filter.adminWallet = input.adminWallet;
      if (input.outcome) filter.outcome = input.outcome;
      if (input.procedure) {
        filter.procedure = new RegExp(
          input.procedure.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "i",
        );
      }

      const [items, totalCount] = await Promise.all([
        AdminAuditLog.find(filter)
          .sort({ timestamp: -1 })
          .skip((input.page - 1) * input.limit)
          .limit(input.limit)
          .lean(),
        AdminAuditLog.countDocuments(filter),
      ]);

      return {
        items,
        totalCount,
        page: input.page,
        limit: input.limit,
      };
    }),
});

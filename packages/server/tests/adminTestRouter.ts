import { z } from "zod";
import { router, adminSignedProcedure } from "../src/trpc/trpc.js";

export const adminTestRouter = router({
  ping: adminSignedProcedure.mutation(() => ({ ok: true as const })),
  echo: adminSignedProcedure
    .input(z.object({ msg: z.string() }))
    .mutation(({ input }) => ({ msg: input.msg })),
  boom: adminSignedProcedure.mutation(() => {
    throw new Error("handler boom");
  }),
});

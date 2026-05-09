import { router, protectedProcedure } from "./trpc.js";
import { Player } from "../db/schema.js";
import { listActiveBountiesForPlayer } from "../bounties/progress.js";

export const bountyRouter = router({
  active: protectedProcedure.query(async ({ ctx }) => {
    const player = await Player.findOne({
      walletAddress: ctx.walletAddress,
    }).lean();
    if (!player) return { bounties: [] };
    const bounties = await listActiveBountiesForPlayer(player._id);
    return { bounties };
  }),
});

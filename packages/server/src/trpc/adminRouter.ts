import { router, adminSessionProcedure } from "./trpc.js";
import {
  getEventStatus,
  type EventStatus,
} from "../services/eventConfig.js";
import { adminSessionRouter } from "./admin/sessionRouter.js";
import { adminRoomsRouter } from "./admin/roomsRouter.js";
import { adminLpRouter } from "./admin/lpRouter.js";
import { adminAuditRouter } from "./admin/auditRouter.js";
import { adminStatsRouter } from "./admin/statsRouter.js";
import { adminSessionsRouter } from "./admin/sessionsRouter.js";
import { adminCatchesRouter } from "./admin/catchesRouter.js";
import { adminSeedsRouter } from "./admin/seedsRouter.js";
import { adminReactionsRouter } from "./admin/reactionsRouter.js";
import { adminEventRouter } from "./admin/eventRouter.js";
import { adminApexFishRouter } from "./admin/apexFishRouter.js";

export const adminRouter = router({
  session: adminSessionRouter,
  rooms: adminRoomsRouter,
  lp: adminLpRouter,
  audit: adminAuditRouter,
  stats: adminStatsRouter,
  sessions: adminSessionsRouter,
  catches: adminCatchesRouter,
  seeds: adminSeedsRouter,
  reactions: adminReactionsRouter,
  event: adminEventRouter,
  apexFish: adminApexFishRouter,

  /** Backward-compat wrapper for the legacy admin.getEvent path. */
  getEvent: adminSessionProcedure.query(async (): Promise<EventStatus | null> => {
    return getEventStatus(true);
  }),
});

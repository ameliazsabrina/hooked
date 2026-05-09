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

export const adminRouter = router({
  session: adminSessionRouter,
  rooms: adminRoomsRouter,
  lp: adminLpRouter,
  audit: adminAuditRouter,
  stats: adminStatsRouter,
  // Fishing data — replaces the on-chain hooked_fishing program (retired in
  // Phase 6). All four collections live in MongoDB now and are read-only from
  // the dashboard's perspective.
  sessions: adminSessionsRouter,
  catches: adminCatchesRouter,
  seeds: adminSeedsRouter,
  reactions: adminReactionsRouter,
  // DB-backed admin events: full CRUD + lifecycle + winner payout. See
  // services/eventConfig.ts and services/eventWinners.ts for the wiring.
  event: adminEventRouter,

  /**
   * Backward-compat thin wrapper for any caller that still hits the legacy
   * `admin.getEvent` path. The new dashboard prefers `admin.event.list({
   * status: "active" })` for richer status, but the wire shape returned here
   * is unchanged so old clients keep rendering. Returns the cached active
   * event read from `services/eventConfig.ts`.
   */
  getEvent: adminSessionProcedure.query(async (): Promise<EventStatus | null> => {
    return getEventStatus(true);
  }),
});

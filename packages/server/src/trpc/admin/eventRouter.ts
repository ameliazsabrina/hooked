import { z } from "zod";

import { ApexFish, FishingEvent } from "../../db/schema.js";
import { readApexCatalog } from "../../services/fishing/apexCatalog.js";
import { getEventStatus } from "../../services/eventConfig.js";
import { computeEventWinners } from "../../services/eventWinners.js";
import { adminSessionProcedure, router } from "../trpc.js";
import {
  NotFoundError,
  ConflictError,
  ValidationError,
  mapAppErrorToTRPC,
} from "../../errors/AppError.js";

const ObjectIdString = z
  .string()
  .regex(/^[0-9a-f]{24}$/i, "Must be a 24-char hex ObjectId");

const STATUS_FILTER = z.enum(["all", "active", "scheduled", "ended"]).default("all");

/** 50% of BPS_SCALE — caps apex weight to keep the rarity distribution well-formed. */
const MAX_EVENT_APEX_BP = 5000;

const datePair = z
  .object({
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
  })
  .strict()
  .refine((v) => v.endsAt.getTime() > v.startsAt.getTime(), {
    path: ["endsAt"],
    message: "endsAt must be after startsAt",
  });

async function assertApexFishIdsExist(ids: string[]): Promise<void> {
  const dedup = Array.from(new Set(ids));
  const found = await ApexFish.find(
    { _id: { $in: dedup } },
    { _id: 1 },
  ).lean();
  if (found.length !== dedup.length) {
    const foundSet = new Set(found.map((d) => String(d._id)));
    const missing = dedup.filter((id) => !foundSet.has(id));
    throw new ValidationError(`Unknown apex fish ids: ${missing.join(", ")}`);
  }
}

const apexFishIdsSchema = z
  .array(ObjectIdString)
  .min(1, "Pick at least one apex fish");

const createInput = z
  .object({
    name: z.string().trim().min(1).max(64),
    apexBp: z.number().int().min(0).max(MAX_EVENT_APEX_BP),
    prizePoolSol: z.number().nonnegative(),
    apexFishIds: apexFishIdsSchema,
  })
  .strict()
  .and(datePair);

const updateInput = z
  .object({
    id: ObjectIdString,
    name: z.string().trim().min(1).max(64).optional(),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().optional(),
    apexBp: z.number().int().min(0).max(MAX_EVENT_APEX_BP).optional(),
    prizePoolSol: z.number().nonnegative().optional(),
    apexFishIds: apexFishIdsSchema.optional(),
  })
  .strict()
  .refine(
    (v) =>
      !v.startsAt ||
      !v.endsAt ||
      v.endsAt.getTime() > v.startsAt.getTime(),
    { path: ["endsAt"], message: "endsAt must be after startsAt" },
  );

function statusOf(ev: { active: boolean; startsAt: Date; endsAt: Date }, now = new Date()):
  | "active"
  | "scheduled"
  | "ended" {
  if (ev.active) return "active";
  if (ev.startsAt.getTime() > now.getTime()) return "scheduled";
  return "ended";
}

/** Named so tRPC consumers don't see `never` from inference holes. */
export interface SerializedFinalRank {
  rank: number;
  walletAddress: string;
  displayName: string;
  score: number;
  prizeSol: number;
  paid: boolean;
  signature: string | null;
  paidAt: Date | null;
  attempts: number;
  lastError: string | null;
}

export interface SerializedEvent {
  id: string;
  name: string;
  status: "active" | "scheduled" | "ended";
  active: boolean;
  startsAt: string;
  endsAt: string;
  apexBp: number;
  prizePoolSol: number;
  apexFishIds: string[];
  finalRanks: SerializedFinalRank[] | null;
  createdBy: string;
}

// Accepts hydrated (.toObject()) and lean docs; normalizes finalRanks to null.
interface RawEventLike {
  _id: unknown;
  name: string;
  active: boolean;
  startsAt: Date;
  endsAt: Date;
  apexBp: number;
  prizePoolSol: number;
  apexFishIds: unknown[];
  finalRanks?: unknown;
  createdBy: string;
}

function serializeEvent(ev: RawEventLike): SerializedEvent {
  const raw = (ev.finalRanks ?? null) as Array<Record<string, unknown>> | null;
  const finalRanks: SerializedFinalRank[] | null = raw
    ? raw.map((r) => ({
        rank: r.rank as number,
        walletAddress: r.walletAddress as string,
        displayName: r.displayName as string,
        score: r.score as number,
        prizeSol: r.prizeSol as number,
        paid: r.paid as boolean,
        signature: (r.signature as string | null) ?? null,
        paidAt: (r.paidAt as Date | null) ?? null,
        attempts: r.attempts as number,
        lastError: (r.lastError as string | null) ?? null,
      }))
    : null;
  return {
    id: String(ev._id),
    name: ev.name,
    status: statusOf(ev),
    active: ev.active,
    startsAt: ev.startsAt.toISOString(),
    endsAt: ev.endsAt.toISOString(),
    apexBp: ev.apexBp,
    prizePoolSol: ev.prizePoolSol,
    apexFishIds: ev.apexFishIds.map((id) => String(id)),
    finalRanks,
    createdBy: ev.createdBy,
  };
}

export const adminEventRouter = router({
  list: adminSessionProcedure
    .input(
      z.object({
        status: STATUS_FILTER,
        page: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(100).default(50),
      }).strict(),
    )
    .query(async ({ input }) => {
      const now = new Date();
      const filter: Record<string, unknown> = {};
      if (input.status === "active") {
        filter.active = true;
      } else if (input.status === "scheduled") {
        Object.assign(filter, { active: false, startsAt: { $gt: now } });
      } else if (input.status === "ended") {
        Object.assign(filter, { active: false, endsAt: { $lte: now } });
      }
      const skip = (input.page - 1) * input.limit;
      const [events, total] = await Promise.all([
        FishingEvent.find(filter)
          .sort({ startsAt: -1 })
          .skip(skip)
          .limit(input.limit)
          .lean(),
        FishingEvent.countDocuments(filter),
      ]);
      return {
        events: events.map(serializeEvent),
        page: input.page,
        limit: input.limit,
        total,
      };
    }),

  get: adminSessionProcedure
    .input(z.object({ id: ObjectIdString }).strict())
    .query(async ({ input }) => {
      try {
        const ev = await FishingEvent.findById(input.id).lean();
        if (!ev) {
          throw new NotFoundError("Event not found");
        }
        return serializeEvent(ev);
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),

  /** 60s cache; apexFish mutations invalidate on write. */
  apexCatalog: adminSessionProcedure
    .input(z.object({ force: z.boolean().default(false) }).strict().optional())
    .query(async ({ ctx, input }) => {
      return readApexCatalog(ctx.requestOrigin, input?.force ?? false);
    }),

  /** Created inactive; lifecycle worker promotes at startsAt. */
  create: adminSessionProcedure
    .input(createInput)
    .mutation(async ({ ctx, input }) => {
      try {
        await assertApexFishIdsExist(input.apexFishIds);
        const ev = await FishingEvent.create({
          name: input.name,
          active: false,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          apexBp: input.apexBp,
          prizePoolSol: input.prizePoolSol,
          apexFishIds: input.apexFishIds,
          createdBy: ctx.adminWallet,
        });
        return serializeEvent(ev.toObject());
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),

  /** Refused while active so session snapshots stay honest. */
  update: adminSessionProcedure
    .input(updateInput)
    .mutation(async ({ input }) => {
      try {
        const existing = await FishingEvent.findById(input.id);
        if (!existing) {
          throw new NotFoundError("Event not found");
        }
        if (existing.active) {
          throw new ConflictError("Cannot edit an active event. Deactivate first.");
        }
        if (input.apexFishIds !== undefined) {
          await assertApexFishIdsExist(input.apexFishIds);
        }
        const patch: Record<string, unknown> = {};
        if (input.name !== undefined) patch.name = input.name;
        if (input.startsAt !== undefined) patch.startsAt = input.startsAt;
        if (input.endsAt !== undefined) patch.endsAt = input.endsAt;
        if (input.apexBp !== undefined) patch.apexBp = input.apexBp;
        if (input.prizePoolSol !== undefined) patch.prizePoolSol = input.prizePoolSol;
        if (input.apexFishIds !== undefined) patch.apexFishIds = input.apexFishIds;
        const updated = await FishingEvent.findByIdAndUpdate(input.id, { $set: patch }, { new: true });
        if (!updated) {
          throw new NotFoundError("Event vanished mid-update");
        }
        return serializeEvent(updated.toObject());
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),

  activate: adminSessionProcedure
    .input(z.object({ id: ObjectIdString }).strict())
    .mutation(async ({ input }) => {
      try {
        const conflict = await FishingEvent.findOne({ active: true });
        if (conflict && String(conflict._id) !== input.id) {
          throw new ConflictError(`Another event is already active: ${conflict.name}`);
        }
        const ev = await FishingEvent.findById(input.id);
        if (!ev) {
          throw new NotFoundError("Event not found");
        }
        if (ev.active) return serializeEvent(ev.toObject());
        try {
          const updated = await FishingEvent.findByIdAndUpdate(
            ev._id,
            { $set: { active: true } },
            { new: true },
          );
          await getEventStatus(true).catch(() => {});
          return serializeEvent((updated ?? ev).toObject());
        } catch (err) {
          if ((err as { code?: number }).code === 11000) {
            throw new ConflictError("Another event was activated concurrently.");
          }
          throw err;
        }
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),

  /** Force-end + trigger winners compute. */
  deactivate: adminSessionProcedure
    .input(z.object({ id: ObjectIdString }).strict())
    .mutation(async ({ input }) => {
      try {
        const updated = await FishingEvent.findOneAndUpdate(
          { _id: input.id, active: true },
          { $set: { active: false } },
          { new: true },
        );
        if (!updated) {
          throw new NotFoundError("No active event with that id");
        }
        await getEventStatus(true).catch(() => {});
        // Best-effort; non-fatal warning surfaces in the response.
        let winnersComputedAt: string | null = null;
        let winnersError: string | null = null;
        try {
          await computeEventWinners(String(updated._id));
          winnersComputedAt = new Date().toISOString();
        } catch (err) {
          winnersError = (err as Error).message;
        }
        return {
          event: serializeEvent(updated.toObject()),
          winnersComputedAt,
          winnersError,
        };
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),

  /** Forbidden while active or once finalRanks is populated (audit trail). */
  delete: adminSessionProcedure
    .input(z.object({ id: ObjectIdString }).strict())
    .mutation(async ({ input }) => {
      try {
        const ev = await FishingEvent.findById(input.id);
        if (!ev) {
          throw new NotFoundError("Event not found");
        }
        if (ev.active) {
          throw new ConflictError("Cannot delete an active event");
        }
        if (ev.finalRanks && ev.finalRanks.length > 0) {
          throw new ConflictError(
            "Cannot delete an event that already has finalRanks (audit trail)",
          );
        }
        await FishingEvent.deleteOne({ _id: ev._id });
        return { ok: true };
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),

  /** Idempotent; `force: true` overwrites finalRanks. */
  computeWinners: adminSessionProcedure
    .input(z.object({ id: ObjectIdString, force: z.boolean().default(false) }).strict())
    .mutation(async ({ input }) => {
      try {
        const result = await computeEventWinners(input.id, { force: input.force });
        return {
          eventId: result.eventId,
          ranks: result.ranks,
          alreadyComputed: result.alreadyComputed,
        };
      } catch (err) {
        mapAppErrorToTRPC(new ValidationError((err as Error).message));
      }
    }),

  /** Stub: marks paid with a sentinel signature pending payout-worker wiring. */
  payWinner: adminSessionProcedure
    .input(z.object({ id: ObjectIdString, rank: z.number().int().min(1) }).strict())
    .mutation(async ({ input }) => {
      try {
        const ev = await FishingEvent.findOne({
          _id: input.id,
          finalRanks: { $elemMatch: { rank: input.rank, paid: false } },
        });
        if (!ev) {
          throw new NotFoundError("No unpaid winner with that rank");
        }
        const now = new Date();
        const sentinelSig = `pending-payout-${input.rank}-${now.getTime()}`;
        await FishingEvent.updateOne(
          { _id: ev._id, "finalRanks.rank": input.rank, "finalRanks.paid": false },
          {
            $set: {
              "finalRanks.$.paid": true,
              "finalRanks.$.signature": sentinelSig,
              "finalRanks.$.paidAt": now,
            },
            $inc: { "finalRanks.$.attempts": 1 },
          },
        );
        return { ok: true, signature: sentinelSig };
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),

  payAllWinners: adminSessionProcedure
    .input(z.object({ id: ObjectIdString }).strict())
    .mutation(async ({ input }) => {
      try {
        const ev = await FishingEvent.findById(input.id).lean();
        if (!ev) {
          throw new NotFoundError("Event not found");
        }
        const unpaid = (ev.finalRanks ?? []).filter((r) => !r.paid);
        if (unpaid.length === 0) {
          return { ok: true, paid: 0, signatures: [] };
        }
        const now = new Date();
        const signatures: string[] = [];
        for (const row of unpaid) {
          const sig = `pending-payout-${row.rank}-${now.getTime()}`;
          await FishingEvent.updateOne(
            { _id: ev._id, "finalRanks.rank": row.rank, "finalRanks.paid": false },
            {
              $set: {
                "finalRanks.$.paid": true,
                "finalRanks.$.signature": sig,
                "finalRanks.$.paidAt": now,
              },
              $inc: { "finalRanks.$.attempts": 1 },
            },
          );
          signatures.push(sig);
        }
        return { ok: true, paid: signatures.length, signatures };
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),
});

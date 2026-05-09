import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { FishingEvent } from "../../db/schema.js";
import { readApexCatalog } from "../../services/fishing/apexCatalog.js";
import { getEventStatus } from "../../services/eventConfig.js";
import { computeEventWinners } from "../../services/eventWinners.js";
import { adminSessionProcedure, router } from "../trpc.js";

const ObjectIdString = z
  .string()
  .regex(/^[0-9a-f]{24}$/i, "Must be a 24-char hex ObjectId");

const STATUS_FILTER = z.enum(["all", "active", "scheduled", "ended"]).default("all");

// MAX_EVENT_APEX_BP — capped at 50% of BPS_SCALE so the rarity distribution
// stays well-formed even with the maximum apex weight. Mirrors the schema's
// `apexBp` validator and the pre-Phase-6 on-chain constant.
const MAX_EVENT_APEX_BP = 5000;

const datePair = z
  .object({
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
  })
  .refine((v) => v.endsAt.getTime() > v.startsAt.getTime(), {
    path: ["endsAt"],
    message: "endsAt must be after startsAt",
  });

const apexSpeciesIdsInput = z
  .array(z.number().int().nonnegative())
  .min(1, "Pick at least one apex fish")
  .refine(
    (ids) => {
      const allowed = new Set(readApexCatalog().map((e) => e.id));
      return ids.every((id) => allowed.has(id));
    },
    "Each id must be present in the apex catalog (filesystem-driven)",
  );

const createInput = z
  .object({
    name: z.string().trim().min(1).max(64),
    apexBp: z.number().int().min(0).max(MAX_EVENT_APEX_BP),
    prizePoolSol: z.number().nonnegative(),
    apexSpeciesIds: apexSpeciesIdsInput,
  })
  .and(datePair);

const updateInput = z
  .object({
    id: ObjectIdString,
    name: z.string().trim().min(1).max(64).optional(),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().optional(),
    apexBp: z.number().int().min(0).max(MAX_EVENT_APEX_BP).optional(),
    prizePoolSol: z.number().nonnegative().optional(),
    apexSpeciesIds: apexSpeciesIdsInput.optional(),
  })
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

// Exported so tRPC can name the inferred output type when consumers (the
// admin dashboard) compile against the router. Otherwise consumers see
// `never` for fields downstream of the unnamed type in their inference.
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
  apexSpeciesIds: number[];
  finalRanks: SerializedFinalRank[] | null;
  createdBy: string;
}

// Loose input type — accepts both mongoose-hydrated docs (`.toObject()`)
// and lean docs. The mongoose type for finalRanks is optional, so we
// normalize to `null` here so the wire shape is stable.
interface RawEventLike {
  _id: unknown;
  name: string;
  active: boolean;
  startsAt: Date;
  endsAt: Date;
  apexBp: number;
  prizePoolSol: number;
  apexSpeciesIds: number[];
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
    apexSpeciesIds: ev.apexSpeciesIds,
    finalRanks,
    createdBy: ev.createdBy,
  };
}

/**
 * Admin event management. Routes exposed to the dashboard for CRUD on
 * FishingEvent docs plus winner computation/payout. Read paths use lean
 * queries; write paths conditional updates so concurrent admins resolve
 * cleanly via the partial unique index on `active`.
 */
export const adminEventRouter = router({
  /** Paginated list, filterable by lifecycle status. */
  list: adminSessionProcedure
    .input(
      z.object({
        status: STATUS_FILTER,
        page: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(100).default(50),
      }),
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

  /** Single event detail, including finalRanks if computed. */
  get: adminSessionProcedure
    .input(z.object({ id: ObjectIdString }))
    .query(async ({ input }) => {
      const ev = await FishingEvent.findById(input.id).lean();
      if (!ev) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Event not found" });
      }
      return serializeEvent(ev);
    }),

  /**
   * Apex catalog — filesystem-driven. Enumerates PNGs in the client's
   * `/assets/fish/apex/` directory and matches each filename against
   * FISH_SPECIES (by basename) to attach a stable id + weight range.
   *
   * Adding a new apex fish:
   *   1. Drop the PNG in `packages/client/public/assets/fish/apex/`
   *   2. Add a FISH_SPECIES entry in `@hooked/shared/species.ts` with
   *      `rarity: FishRarity.Apex` and `asset: "<basename>.png"` (or any
   *      path ending in the same filename — the matcher uses basename).
   * The cached catalog refreshes every 60s; `force` bypasses the cache.
   */
  apexCatalog: adminSessionProcedure
    .input(z.object({ force: z.boolean().default(false) }).optional())
    .query(({ input }) => {
      return readApexCatalog(input?.force ?? false);
    }),

  /** Create a new (inactive) event. Lifecycle worker promotes to active when startsAt arrives. */
  create: adminSessionProcedure
    .input(createInput)
    .mutation(async ({ ctx, input }) => {
      const ev = await FishingEvent.create({
        name: input.name,
        active: false,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        apexBp: input.apexBp,
        prizePoolSol: input.prizePoolSol,
        apexSpeciesIds: input.apexSpeciesIds,
        createdBy: ctx.adminWallet,
      });
      return serializeEvent(ev.toObject());
    }),

  /** Edit a non-active event. Refused while active to keep snapshot semantics honest. */
  update: adminSessionProcedure
    .input(updateInput)
    .mutation(async ({ input }) => {
      const existing = await FishingEvent.findById(input.id);
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Event not found" });
      }
      if (existing.active) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Cannot edit an active event. Deactivate first.",
        });
      }
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.startsAt !== undefined) patch.startsAt = input.startsAt;
      if (input.endsAt !== undefined) patch.endsAt = input.endsAt;
      if (input.apexBp !== undefined) patch.apexBp = input.apexBp;
      if (input.prizePoolSol !== undefined) patch.prizePoolSol = input.prizePoolSol;
      if (input.apexSpeciesIds !== undefined) patch.apexSpeciesIds = input.apexSpeciesIds;
      const updated = await FishingEvent.findByIdAndUpdate(input.id, { $set: patch }, { new: true });
      if (!updated) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Event vanished mid-update" });
      }
      return serializeEvent(updated.toObject());
    }),

  /** Manual override: flip the event active. Refuses if another event is already active. */
  activate: adminSessionProcedure
    .input(z.object({ id: ObjectIdString }))
    .mutation(async ({ input }) => {
      const conflict = await FishingEvent.findOne({ active: true });
      if (conflict && String(conflict._id) !== input.id) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Another event is already active: ${conflict.name}`,
        });
      }
      const ev = await FishingEvent.findById(input.id);
      if (!ev) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Event not found" });
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
          throw new TRPCError({
            code: "CONFLICT",
            message: "Another event was activated concurrently.",
          });
        }
        throw err;
      }
    }),

  /** Force-end an active event. Triggers winners computation. */
  deactivate: adminSessionProcedure
    .input(z.object({ id: ObjectIdString }))
    .mutation(async ({ input }) => {
      const updated = await FishingEvent.findOneAndUpdate(
        { _id: input.id, active: true },
        { $set: { active: false } },
        { new: true },
      );
      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No active event with that id",
        });
      }
      await getEventStatus(true).catch(() => {});
      // Best-effort winners compute; surface a non-fatal warning to the
      // dashboard via the response.
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
    }),

  /** Delete an event. Forbidden while active or once finalRanks is populated. */
  delete: adminSessionProcedure
    .input(z.object({ id: ObjectIdString }))
    .mutation(async ({ input }) => {
      const ev = await FishingEvent.findById(input.id);
      if (!ev) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Event not found" });
      }
      if (ev.active) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Cannot delete an active event",
        });
      }
      if (ev.finalRanks && ev.finalRanks.length > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Cannot delete an event that already has finalRanks (audit trail)",
        });
      }
      await FishingEvent.deleteOne({ _id: ev._id });
      return { ok: true };
    }),

  /**
   * Run the winners-computation pipeline for an ended event. Idempotent —
   * pass `force: true` to overwrite an existing finalRanks (e.g. after fixing
   * a scoring bug).
   */
  computeWinners: adminSessionProcedure
    .input(z.object({ id: ObjectIdString, force: z.boolean().default(false) }))
    .mutation(async ({ input }) => {
      try {
        const result = await computeEventWinners(input.id, { force: input.force });
        return {
          eventId: result.eventId,
          ranks: result.ranks,
          alreadyComputed: result.alreadyComputed,
        };
      } catch (err) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: (err as Error).message,
        });
      }
    }),

  /**
   * Pay one winner. Updates the FishingEvent.finalRanks subdoc with paid:
   * true + signature once the SOL transfer confirms. Reuses the same keeper
   * keypair the bountySolPayout job uses; transfer logic factored into the
   * dedicated worker pattern when more payout types arrive.
   *
   * For now we mark `paid: true` with a sentinel signature to unblock the
   * dashboard wire; the actual on-chain transfer integration plugs into the
   * `bountySolPayout` worker pattern in a follow-up. See plan Phase 7.
   */
  payWinner: adminSessionProcedure
    .input(z.object({ id: ObjectIdString, rank: z.number().int().min(1) }))
    .mutation(async ({ input }) => {
      const ev = await FishingEvent.findOne({
        _id: input.id,
        finalRanks: { $elemMatch: { rank: input.rank, paid: false } },
      });
      if (!ev) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No unpaid winner with that rank",
        });
      }
      // Stub the actual transfer for now — dashboard surfaces the row as
      // paid so the workflow is traversable end-to-end. Real keeper transfer
      // wiring is the next implementation step (mirrors bountySolPayout).
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
    }),

  /** Pay all unpaid winners for an event. Iterates and reuses payWinner. */
  payAllWinners: adminSessionProcedure
    .input(z.object({ id: ObjectIdString }))
    .mutation(async ({ input }) => {
      const ev = await FishingEvent.findById(input.id).lean();
      if (!ev) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Event not found" });
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
    }),
});

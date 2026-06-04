import { z } from "zod";
import { TRPCError } from "@trpc/server";

import {
  ApexFish,
  FishingEvent,
  APEX_IMAGE_MIME_TYPES_LIST,
} from "../../db/schema.js";
import { invalidateApexCatalog } from "../../services/fishing/apexCatalog.js";
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

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const imageMimeSchema = z.enum(APEX_IMAGE_MIME_TYPES_LIST);

const imagePayloadSchema = z.object({
  imageBase64: z
    .string()
    .min(1)
    .refine((s) => /^[A-Za-z0-9+/=]+$/.test(s), "imageBase64 must be base64"),
  imageMimeType: imageMimeSchema,
}).strict();

function decodeImage(input: {
  imageBase64: string;
  imageMimeType: (typeof APEX_IMAGE_MIME_TYPES_LIST)[number];
}): {
  buffer: Buffer;
  mimeType: (typeof APEX_IMAGE_MIME_TYPES_LIST)[number];
} {
  const buffer = Buffer.from(input.imageBase64, "base64");
  if (buffer.length === 0) {
    throw new ValidationError("imageBase64 decoded to zero bytes");
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    // PAYLOAD_TOO_LARGE has no AppError subclass; keep TRPCError directly.
    throw new TRPCError({
      code: "PAYLOAD_TOO_LARGE",
      message: `Image exceeds ${MAX_IMAGE_BYTES} bytes (${buffer.length})`,
    });
  }
  return { buffer, mimeType: input.imageMimeType };
}

export interface SerializedApexFish {
  id: string;
  name: string;
  weightMinKg: number;
  weightMaxKg: number;
  imageMimeType: string;
  /** Absolute URL the dashboard `<img>` can point at (different origin). */
  assetUrl: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

function serialize(
  doc: {
    _id: unknown;
    name: string;
    weightMinKg: number;
    weightMaxKg: number;
    imageMimeType: string;
    createdBy: string;
    createdAt: Date;
    updatedAt: Date;
  },
  baseUrl: string,
): SerializedApexFish {
  const id = String(doc._id);
  return {
    id,
    name: doc.name,
    weightMinKg: doc.weightMinKg,
    weightMaxKg: doc.weightMaxKg,
    imageMimeType: doc.imageMimeType,
    assetUrl: `${baseUrl}/admin/apex-fish/${id}/image`,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

const createInput = z.object({
  name: z.string().trim().min(1).max(64),
  weightMinKg: z.number().min(0),
  weightMaxKg: z.number().min(0),
  ...imagePayloadSchema.shape,
}).strict();

const updateInput = z.object({
  id: ObjectIdString,
  name: z.string().trim().min(1).max(64).optional(),
  weightMinKg: z.number().min(0).optional(),
  weightMaxKg: z.number().min(0).optional(),
  imageBase64: imagePayloadSchema.shape.imageBase64.optional(),
  imageMimeType: imagePayloadSchema.shape.imageMimeType.optional(),
}).strict();

// Admin CRUD for the ApexFish catalog; images arrive as base64 (cap ~2MB), served via GET /admin/apex-fish/:id/image.
export const adminApexFishRouter = router({
  list: adminSessionProcedure.query(async ({ ctx }) => {
    const docs = await ApexFish.find(
      {},
      { imageData: 0 },
    )
      .sort({ createdAt: -1 })
      .lean();
    return docs.map((d) => serialize(d, ctx.requestOrigin));
  }),

  get: adminSessionProcedure
    .input(z.object({ id: ObjectIdString }).strict())
    .query(async ({ ctx, input }) => {
      try {
        const doc = await ApexFish.findById(input.id, { imageData: 0 }).lean();
        if (!doc) {
          throw new NotFoundError("Apex fish not found");
        }
        return serialize(doc, ctx.requestOrigin);
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),

  create: adminSessionProcedure
    .input(createInput)
    .mutation(async ({ ctx, input }) => {
      try {
        if (input.weightMaxKg < input.weightMinKg) {
          throw new ValidationError("weightMaxKg must be ≥ weightMinKg");
        }
        const { buffer, mimeType } = decodeImage(input);
        try {
          const doc = await ApexFish.create({
            name: input.name,
            weightMinKg: input.weightMinKg,
            weightMaxKg: input.weightMaxKg,
            imageData: buffer,
            imageMimeType: mimeType,
            createdBy: ctx.adminWallet,
          });
          invalidateApexCatalog();
          return serialize(doc.toObject(), ctx.requestOrigin);
        } catch (err) {
          if ((err as { code?: number }).code === 11000) {
            throw new ConflictError(`An apex fish named "${input.name}" already exists`);
          }
          throw err;
        }
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),

  update: adminSessionProcedure
    .input(updateInput)
    .mutation(async ({ ctx, input }) => {
      try {
        const existing = await ApexFish.findById(input.id);
        if (!existing) {
          throw new NotFoundError("Apex fish not found");
        }
        if (input.name !== undefined) existing.name = input.name;
        if (input.weightMinKg !== undefined) existing.weightMinKg = input.weightMinKg;
        if (input.weightMaxKg !== undefined) existing.weightMaxKg = input.weightMaxKg;
        if (existing.weightMaxKg < existing.weightMinKg) {
          throw new ValidationError("weightMaxKg must be ≥ weightMinKg");
        }
        if (input.imageBase64 !== undefined) {
          if (input.imageMimeType === undefined) {
            throw new ValidationError("imageMimeType required when uploading new image bytes");
          }
          const { buffer, mimeType } = decodeImage({
            imageBase64: input.imageBase64,
            imageMimeType: input.imageMimeType,
          });
          existing.imageData = buffer;
          existing.imageMimeType = mimeType;
        }
        try {
          await existing.save();
        } catch (err) {
          if ((err as { code?: number }).code === 11000) {
            throw new ConflictError(`Apex fish name conflicts with an existing record`);
          }
          throw err;
        }
        invalidateApexCatalog();
        return serialize(existing.toObject(), ctx.requestOrigin);
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),

  delete: adminSessionProcedure
    .input(z.object({ id: ObjectIdString }).strict())
    .mutation(async ({ input }) => {
      try {
        const blocking = await FishingEvent.findOne({
          apexFishIds: input.id,
          $or: [{ active: true }, { endsAt: { $gt: new Date() } }],
        })
          .select({ _id: 1, name: 1 })
          .lean();
        if (blocking) {
          throw new ConflictError(
            `Cannot delete: apex fish is referenced by an active or ` +
            `scheduled event ("${blocking.name}"). Remove it from the ` +
            `event first.`,
          );
        }
        const result = await ApexFish.deleteOne({ _id: input.id });
        if (result.deletedCount === 0) {
          throw new NotFoundError("Apex fish not found");
        }
        invalidateApexCatalog();
        return { ok: true };
      } catch (err) {
        mapAppErrorToTRPC(err);
      }
    }),
});

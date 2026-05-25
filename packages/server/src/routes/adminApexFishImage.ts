import type { FastifyInstance } from "fastify";

import { ApexFish } from "../db/schema.js";

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

export default async function adminApexFishImageRoutes(
  fastify: FastifyInstance,
) {
  fastify.get<{ Params: { id: string } }>(
    "/admin/apex-fish/:id/image",
    async (req, reply) => {
      const { id } = req.params;
      if (!OBJECT_ID_PATTERN.test(id)) {
        return reply.code(400).send({ error: "Invalid id" });
      }
      const doc = await ApexFish.findById(id, {
        imageData: 1,
        imageMimeType: 1,
      }).lean();
      if (!doc) {
        return reply.code(404).send({ error: "Not found" });
      }
      // `.lean()` returns the raw BSON Binary for Buffer-typed fields, which
      // Fastify's `.send()` rejects ("invalid type 'object'"). Coerce to a
      // Node Buffer so the bytes go out with the right Content-Type.
      const raw = doc.imageData as unknown as
        | Buffer
        | { buffer: ArrayBufferLike };
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer);
      reply
        .header("Content-Type", doc.imageMimeType)
        .header("Cache-Control", "public, max-age=300")
        .send(bytes);
    },
  );
}

import type { FastifyInstance } from "fastify";

import { ApexFish } from "../db/schema.js";

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/**
 * Public read endpoint for apex fish image bytes. Public because the admin
 * dashboard `<img>` and the player client both load the URL directly and
 * can't attach the admin-session header — and the bytes themselves are not
 * sensitive (they're shown to every player during a live event). Cached on
 * the client for 5 minutes; invalidate by uploading a new image (which
 * keeps the same id).
 *
 * Mounted at `GET /admin/apex-fish/:id/image`.
 */
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
      reply
        .header("Content-Type", doc.imageMimeType)
        .header("Cache-Control", "public, max-age=300")
        .send(doc.imageData);
    },
  );
}

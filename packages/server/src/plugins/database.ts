import fp from "fastify-plugin";
import mongoose from "mongoose";
import { env } from "../config/env.js";

export default fp(async (fastify) => {
  await mongoose.connect(env.MONGODB_URI);
  fastify.log.info(`MongoDB connected: ${env.MONGODB_URI}`);

  fastify.addHook("onClose", async () => {
    await mongoose.disconnect();
  });
});

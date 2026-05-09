import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@hooked/server/trpc";

export const trpc = createTRPCReact<AppRouter>();

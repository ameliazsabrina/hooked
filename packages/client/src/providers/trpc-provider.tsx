import { useMemo, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { trpc } from "~/utils/trpc";
import { sessionTokenStore } from "~/utils/session-auth";

export function TRPCProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const trpcClient = useMemo(
    () =>
      trpc.createClient({
        links: [
          httpBatchLink({
            url: `${import.meta.env.VITE_GATEWAY_HTTP ?? "http://localhost:3001"}/trpc`,
            headers() {
              const token = sessionTokenStore.get();
              return token ? { Authorization: `Bearer ${token}` } : {};
            },
          }),
        ],
      }),
    [],
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </trpc.Provider>
  );
}

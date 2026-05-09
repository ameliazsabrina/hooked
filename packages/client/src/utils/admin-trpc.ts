import { createTRPCClient, httpLink } from "@trpc/client";
import type { AppRouter } from "@hooked/server/trpc";
import bs58 from "bs58";

export type SignMessage = (msg: Uint8Array) => Promise<Uint8Array>;

function randomNonceHex(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function buildAdminHeaders(opts: {
  walletAddress: string;
  signMessage: SignMessage;
  procedurePath: string;
}): Promise<Record<string, string>> {
  const timestamp = Date.now().toString();
  const nonce = randomNonceHex();
  const msg = new TextEncoder().encode(
    `hooked-admin:${opts.procedurePath}:${timestamp}:${nonce}`
  );
  const sigBytes = await opts.signMessage(msg);
  return {
    "x-admin-wallet": opts.walletAddress,
    "x-admin-timestamp": timestamp,
    "x-admin-nonce": nonce,
    "x-admin-signature": bs58.encode(sigBytes),
  };
}

export function createAdminTrpcClient(opts: {
  baseUrl: string;
  walletAddress: string;
  signMessage: SignMessage;
}) {
  return createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: `${opts.baseUrl}/trpc`,
        async headers({ op }) {
          return buildAdminHeaders({
            walletAddress: opts.walletAddress,
            signMessage: opts.signMessage,
            procedurePath: op.path,
          });
        },
      }),
    ],
  });
}

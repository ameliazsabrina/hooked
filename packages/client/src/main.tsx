import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import { clusterApiUrl, type Cluster } from "@solana/web3.js";
import "@solana/wallet-adapter-react-ui/styles.css";
import "@fontsource/jersey-10";
import "@fontsource/vt323";
import { TRPCProvider } from "./providers/trpc-provider";
import { SessionAuthProvider } from "./providers/session-auth-provider";
import { ErrorBoundary } from "./components/error-boundary";
import "./index.css";
import App from "./app.tsx";

function Root() {
  const endpoint = useMemo(() => {
    const rawCluster = import.meta.env.VITE_SOLANA_CLUSTER;
    if (!rawCluster) {
      throw new Error(
        "VITE_SOLANA_CLUSTER is not set. Configure it in the build environment (e.g. 'mainnet-beta')."
      );
    }
    const cluster = (rawCluster === "mainnet" ? "mainnet-beta" : rawCluster) as Cluster;
    const heliusKey = import.meta.env.VITE_HELIUS_API_KEY;
    if (heliusKey) {
      const host = cluster === "mainnet-beta" ? "mainnet" : "devnet";
      return `https://${host}.helius-rpc.com/?api-key=${heliusKey}`;
    }
    return clusterApiUrl(cluster);
  }, []);
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );

  return (
    <ErrorBoundary>
      <ConnectionProvider endpoint={endpoint}>
        <WalletProvider wallets={wallets} autoConnect>
          <WalletModalProvider>
            <TRPCProvider>
              <SessionAuthProvider>
                <App />
              </SessionAuthProvider>
            </TRPCProvider>
          </WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </ErrorBoundary>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>
);

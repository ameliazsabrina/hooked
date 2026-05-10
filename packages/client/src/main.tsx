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
    const cluster = (import.meta.env.VITE_SOLANA_CLUSTER ?? "devnet") as Cluster;
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

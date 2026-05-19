import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { trpc } from "~/utils/trpc";
import {
  clearSession,
  loadSession,
  saveSession,
  sessionTokenStore,
} from "~/utils/session-auth";
import {
  clearDelegation,
  createDelegation,
  loadDelegation,
  saveDelegation,
} from "~/utils/ws-delegation";

type AuthState = "idle" | "signing" | "verifying" | "ready" | "error";

interface SessionAuthContextValue {
  state: AuthState;
  walletAddress: string | null;
  ready: boolean;
  error: string | null;
  retry: () => void;
  logout: () => Promise<void>;
}

const SessionAuthContext = createContext<SessionAuthContextValue | null>(null);

export function useSessionAuth(): SessionAuthContextValue {
  const ctx = useContext(SessionAuthContext);
  if (!ctx) {
    throw new Error("useSessionAuth must be used inside SessionAuthProvider");
  }
  return ctx;
}

export function SessionAuthProvider({ children }: { children: ReactNode }) {
  const { publicKey, signMessage, connected } = useWallet();
  const walletAddress = publicKey?.toBase58() ?? null;

  const [state, setState] = useState<AuthState>("idle");
  const [error, setError] = useState<string | null>(null);
  const attemptRef = useRef(0);
  const attemptedWalletRef = useRef<string | null>(null);
  const wasConnectedRef = useRef(false);

  const utils = trpc.useUtils();

  const runHandshake = useCallback(
    async (wallet: string) => {
      if (!signMessage) {
        setError("Wallet does not support message signing");
        setState("error");
        return;
      }
      const attempt = ++attemptRef.current;
      setError(null);

      try {
        // Reuse a still-valid delegation so a tRPC token loss doesn't force a
        // fresh wallet popup.
        let bundle = loadDelegation(wallet);
        setState("signing");
        if (!bundle) {
          bundle = await createDelegation(wallet, signMessage);
          if (attempt !== attemptRef.current) return;
          saveDelegation(wallet, bundle);
        }

        setState("verifying");
        const result = await utils.client.auth.exchangeDelegation.mutate({
          delegation: bundle.delegation,
        });
        if (attempt !== attemptRef.current) return;

        saveSession({
          token: result.token,
          expiresAt: result.expiresAt,
          wallet,
        });
        sessionTokenStore.set(result.token);
        setState("ready");
      } catch (err) {
        if (attempt !== attemptRef.current) return;
        sessionTokenStore.set(null);
        // Cached delegation is unusable; drop it so retry() prompts fresh.
        clearDelegation(wallet);
        setError(err instanceof Error ? err.message : "Authentication failed");
        setState("error");
      }
    },
    [signMessage, utils],
  );

  useEffect(() => {
    if (!connected || !walletAddress) {
      sessionTokenStore.set(null);
      attemptedWalletRef.current = null;
      setState("idle");
      setError(null);
      if (wasConnectedRef.current && typeof window !== "undefined") {
        wasConnectedRef.current = false;
        window.location.reload();
      }
      return;
    }

    wasConnectedRef.current = true;

    if (attemptedWalletRef.current === walletAddress) return;
    attemptedWalletRef.current = walletAddress;

    const cached = loadSession(walletAddress);
    const delegation = loadDelegation(walletAddress);
    if (cached && delegation) {
      sessionTokenStore.set(cached.token);
      setState("ready");
      setError(null);
      return;
    }
    if (cached) clearSession(walletAddress);

    void runHandshake(walletAddress);
  }, [connected, walletAddress, runHandshake]);

  const retry = useCallback(() => {
    if (!walletAddress) return;
    clearSession(walletAddress);
    clearDelegation(walletAddress);
    sessionTokenStore.set(null);
    attemptedWalletRef.current = walletAddress;
    void runHandshake(walletAddress);
  }, [walletAddress, runHandshake]);

  const logout = useCallback(async () => {
    if (!walletAddress) return;
    try {
      await utils.client.auth.logout.mutate();
    } catch {
    }
    clearSession(walletAddress);
    clearDelegation(walletAddress);
    sessionTokenStore.set(null);
    attemptedWalletRef.current = null;
    wasConnectedRef.current = false;
    setState("idle");
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  }, [walletAddress, utils]);

  const value: SessionAuthContextValue = {
    state,
    walletAddress,
    ready: state === "ready",
    error,
    retry,
    logout,
  };

  return (
    <SessionAuthContext.Provider value={value}>
      {children}
    </SessionAuthContext.Provider>
  );
}

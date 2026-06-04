import { useEffect, useRef, useState } from "react";
import type { TerminalGuard } from "@hooked/shared";
import {
  wsUrl,
  httpBase,
  RECONNECT_DELAY_MS,
  type ServerMessage,
} from "./protocol";
import {
  loadDelegation,
  clearDelegation,
  signNonceWithSessionKey,
} from "../../utils/ws-delegation";
import {
  FishingSocketController,
  type WebSocketLike,
} from "./fishing-socket-controller";

const MAX_RECONNECT_ATTEMPTS = 5;

interface UseFishingSocketArgs {
  walletStr: string | null;
  authReady: boolean;
  guard: TerminalGuard;
  onMessage: (msg: ServerMessage) => void;
  onSession: (sessionPda: string | null) => void;
  onReset: () => void;
  getActiveCastId: () => string | null;
  sessionRetry: () => void;
}

// Thin React wrapper over FishingSocketController: wires live deps via a ref so
// the controller (and its tests) stay framework-agnostic.
export function useFishingSocket(args: UseFishingSocketArgs) {
  const [authed, setAuthed] = useState(false);
  const argsRef = useRef(args);
  argsRef.current = args;

  const controllerRef = useRef<FishingSocketController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new FishingSocketController({
      wsFactory: (url) => new WebSocket(url) as unknown as WebSocketLike,
      wsUrl,
      httpBase,
      fetchFn: (input, init) => fetch(input as RequestInfo, init),
      loadDelegation,
      signNonce: signNonceWithSessionKey,
      clearDelegation,
      guard: args.guard,
      reconnectDelayMs: RECONNECT_DELAY_MS,
      maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
      onMessage: (m) => argsRef.current.onMessage(m),
      onAuthChange: setAuthed,
      onSession: (s) => argsRef.current.onSession(s),
      onReset: () => argsRef.current.onReset(),
      getActiveCastId: () => argsRef.current.getActiveCastId(),
      sessionRetry: () => argsRef.current.sessionRetry(),
    });
  }

  useEffect(() => {
    const controller = controllerRef.current!;
    controller.configure(args.walletStr, args.authReady);
    controller.start();
    return () => controller.stop();
  }, [args.walletStr, args.authReady]);

  const sendRef = useRef((data: object) => controllerRef.current!.send(data));
  return { authed, send: sendRef.current };
}

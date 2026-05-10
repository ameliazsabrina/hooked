import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { getProgramConfigPda, getRoomsProgramReadonly } from "../utils/anchor";

/**
 * Polls ProgramConfig.paused so the UI can gate write actions (deposit)
 * before the user signs a tx that would fail on-chain. Returns:
 *
 *   null  — first fetch hasn't completed yet (treat as "unknown", allow UI)
 *   true  — paused; disable write paths
 *   false — not paused; normal flow
 *
 * Polls every 30s. That's slow enough to not hammer RPC, fast enough that
 * a real "pause for maintenance" propagates to all open tabs within half
 * a minute. The 30s window also matches typical room-lifecycle cadence —
 * if you flip pause right before a deposit window opens, every open client
 * will see it before the window starts.
 */
export function useProgramPaused() {
  const { connection } = useConnection();
  const [paused, setPaused] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      try {
        const program = getRoomsProgramReadonly(connection);
        const cfg = await program.account.programConfig.fetchNullable(
          getProgramConfigPda()
        );
        if (cancelled) return;
        // Config not initialized yet (pre-bootstrap cluster) → treat as
        // "not paused". The on-chain ix will surface the real error if the
        // user hits a path that needs config.
        setPaused(cfg?.paused ?? false);
      } catch {
        // RPC blip — keep the previous value; do NOT flip to "paused" on
        // a transient error or we'd spuriously disable the UI.
        if (cancelled) return;
        setPaused((prev) => prev);
      }
    };

    void tick();
    const id = setInterval(() => void tick(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [connection]);

  return paused;
}

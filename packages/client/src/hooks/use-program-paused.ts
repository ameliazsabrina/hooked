import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { getProgramConfigPda, getRoomsProgramReadonly } from "../utils/anchor";

/** Polls ProgramConfig.paused at 30s to gate write actions.
 *  Returns null until first fetch completes, then true|false. */
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
        // Pre-bootstrap cluster → treat as "not paused".
        setPaused(cfg?.paused ?? false);
      } catch {
        // RPC blip — keep previous value; flipping to paused would spuriously
        // disable the UI.
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

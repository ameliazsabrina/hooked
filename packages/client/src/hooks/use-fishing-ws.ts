import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  FishRarity,
  type CircularTapClientConfig,
  type CastDifficultyPayload,
  type FishSpecies,
  type TapResult,
  buildDifficultyProfile,
  buildLegendaryVerticalProfile,
  computeModifiers,
  getInteractionMechanic,
  TerminalGuard,
} from "@hooked/shared";
import {
  mapRarity,
  getSpeciesData,
  buildCircularTapConfig,
} from "../utils/anchor";
import { playSfx } from "../utils/audio";
import { vibrate } from "../utils/haptics";
import { trpc } from "../utils/trpc";
import { useSessionAuth } from "../providers/session-auth-provider";
import {
  CAST_ANIMATION_MS,
  HOOK_ANIMATION_MS,
  NIBBLE_WINDOW_MS,
  type ServerMessage,
} from "./fishing-ws/protocol";
import { useFishingSocket } from "./fishing-ws/use-fishing-socket";

export type FishingState =
  | "idle"
  | "casting"
  | "cast_animating"
  | "idle_waiting"
  | "nibble_window"
  | "hooking"
  | "biting"
  | "warning"
  | "reeling"
  | "circular_tap"
  | "caught"
  | "missed";

export interface CaughtFish {
  id: string;
  species: string;
  rarity: FishRarity;
  weightKg: number;
  score: number;
  asset: string;
  shellValue: number;
  caughtAt: string;
}

export interface RoomLeaderboardEntry {
  wallet: string;
  displayName?: string;
  score: number;
  catchCount: number;
}

export interface RoomLeaderboardSnapshot {
  roomId: string | null;
  entries: RoomLeaderboardEntry[];
  updatedAt: number;
}

export function useFishingWs(gameRef: React.RefObject<Phaser.Game | null>) {
  const { publicKey } = useWallet();
  const { ready: authReady, retry: sessionRetry } = useSessionAuth();

  const [state, setState] = useState<FishingState>("idle");
  const [bait, setBait] = useState(0);
  const [score, setScore] = useState(0);
  const [lastCatch, setLastCatch] = useState<CaughtFish | null>(null);
  const [catches, setCatches] = useState<CaughtFish[]>([]);
  const [discoveredSpecies, setDiscoveredSpecies] = useState<Set<string>>(
    () => new Set(),
  );
  const [discoveredApexFish, setDiscoveredApexFish] = useState<
    Array<{
      id: string;
      name: string;
      weightMinKg: number;
      weightMaxKg: number;
      assetUrl: string;
    }>
  >([]);
  const hydratedRef = useRef(false);
  const baitHydratedForWalletRef = useRef<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [mechanic, setMechanic] = useState<"timing_bar" | "circular_tap">(
    "timing_bar",
  );
  const [circularTapConfig, setCircularTapConfig] =
    useState<CircularTapClientConfig | null>(null);
  const [fishRarity, setFishRarity] = useState<FishRarity | null>(null);
  const [difficulty, setDifficulty] = useState<CastDifficultyPayload | null>(
    null,
  );
  const [species, setSpecies] = useState<FishSpecies | null>(null);
  const [castStartedAtMs, setCastStartedAtMs] = useState<number | null>(null);
  // Adaptive lag-comp buffer the server chose for the active cast; passed to
  // TimingBar so its local physics steps to the same simTime as the server.
  const [inputDelayMs, setInputDelayMs] = useState<number | null>(null);
  const [eventStatus, setEventStatus] = useState<{
    active: boolean;
    name: string;
    startsAt: number;
    endsAt: number;
    apexBp: number;
    prizePoolSol: number;
    apexFishes: Array<{
      id: string;
      name: string;
      weightMinKg: number;
      weightMaxKg: number;
      assetUrl: string;
    }>;
  } | null>(null);
  const [serverSnapshot, setServerSnapshot] = useState<{
    barY: number;
    fishY: number;
    progress: number;
    tickIndex: number;
  } | null>(null);
  // Bumped on `desync_correction` only (not routine `fishing_state` snapshots);
  // TimingBar uses this as a load-bearing reconcile signal to snap local state.
  const [reconcileVersion, setReconcileVersion] = useState(0);
  const [roomLeaderboard, setRoomLeaderboard] =
    useState<RoomLeaderboardSnapshot | null>(null);

  const activeCastIdRef = useRef<string | null>(null);
  const biteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const castAnimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hookAnimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nibbleWindowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const nibbleServerTsRef = useRef<number | null>(null);
  // Mirrors the socket's authed flag for non-reactive reads (e.g. cast()).
  const authedRef = useRef(false);
  // Dedups money-critical catch_resolved and tracks the cast to recover on
  // reconnect; see TerminalGuard.
  const guardRef = useRef(new TerminalGuard());

  const walletStr = publicKey?.toBase58() ?? null;
  const walletStrRef = useRef(walletStr);
  useEffect(() => {
    walletStrRef.current = walletStr;
  }, [walletStr]);

  const sessionStateQuery = trpc.player.sessionState.useQuery(undefined, {
    enabled: !!walletStr && authReady,
    refetchOnWindowFocus: false,
    refetchInterval: 20_000,
  });
  // Only "active" allows casting; everything past the window blocks it.
  const sessionWindowState = sessionStateQuery.data?.windowState ?? null;
  const roomSettling =
    sessionWindowState === "closing" ||
    sessionWindowState === "settling" ||
    sessionWindowState === "closed" ||
    sessionWindowState === "missing";
  const utils = trpc.useUtils();
  const sellFishMutation = trpc.shop.sellFish.useMutation();
  const sellFishBulkMutation = trpc.shop.sellFishBulk.useMutation();

  useEffect(() => {
    const data = sessionStateQuery.data;
    if (!data) return;
    // Hydrate bait once per (wallet, date, window); same-window reconnects keep local decrements, rotation re-hydrates.
    const baitKey = walletStr
      ? `${walletStr}:${data.date}:${data.window}`
      : null;
    if (baitKey && baitHydratedForWalletRef.current !== baitKey) {
      baitHydratedForWalletRef.current = baitKey;
      setBait(data.bait);
    }
    if (hydratedRef.current) return;
    hydratedRef.current = true;

    const hydrated: CaughtFish[] = (data.catches ?? []).map((c) => {
      const species = getSpeciesData(c.speciesId);
      return {
        id: c.id,
        species: species.name,
        rarity: mapRarity(c.rarity),
        weightKg: c.weightHg / 10,
        score: c.score,
        asset: species.asset,
        shellValue: c.sellValue ?? 0,
        caughtAt: c.caughtAt,
      };
    });
    setCatches(hydrated);
    setScore(data.score);
    // Tolerate older server / stale tRPC cache missing `discoveredSpeciesIds`;
    // an unguarded `.map` would throw and unmount GameLayout.
    setDiscoveredSpecies(
      new Set(
        (data.discoveredSpeciesIds ?? []).map((id) => getSpeciesData(id).name),
      ),
    );
    setDiscoveredApexFish(data.discoveredApexFish ?? []);
  }, [sessionStateQuery.data]);

  // Reset hydration gate on wallet change; bait uses its own per-wallet ref.
  useEffect(() => {
    hydratedRef.current = false;
    setDiscoveredSpecies(new Set());
    setDiscoveredApexFish([]);
  }, [walletStr]);

  // Gameplay-state cleanup when the socket drops; the controller stashes the
  // in-flight cast for recovery before calling this.
  const onReset = useCallback(() => {
    heldRef.current = false;
    activeCastIdRef.current = null;
    for (const t of [
      biteTimerRef,
      nibbleWindowTimerRef,
      castAnimTimerRef,
      hookAnimTimerRef,
    ]) {
      if (t.current) {
        clearTimeout(t.current);
        t.current = null;
      }
    }
    setState((prev) =>
      prev === "casting" ||
      prev === "cast_animating" ||
      prev === "idle_waiting" ||
      prev === "nibble_window" ||
      prev === "hooking" ||
      prev === "biting" ||
      prev === "reeling"
        ? "idle"
        : prev,
    );
  }, []);

  const onSession = useCallback((sessionPda: string | null) => {
    if (sessionPda) setSessionId(sessionPda);
  }, []);

  const handleMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case "bait_refilled": {
        // Align hydration key so a subsequent sessionStateQuery can't clobber.
        setBait(msg.bait);
        if (walletStr) {
          baitHydratedForWalletRef.current = `${walletStr}:${msg.date}:${msg.window}`;
        }
        return;
      }
      case "cast_accepted": {
        activeCastIdRef.current = msg.clientCastId;
        if (msg.sessionId) setSessionId(msg.sessionId);
        setCastStartedAtMs(msg.castTimestamp);
        setState("cast_animating");
        if (castAnimTimerRef.current) clearTimeout(castAnimTimerRef.current);
        castAnimTimerRef.current = setTimeout(() => {
          castAnimTimerRef.current = null;
          // Only advance if a server race hasn't already moved us forward.
          setState((prev) =>
            prev === "cast_animating" ? "idle_waiting" : prev,
          );
        }, CAST_ANIMATION_MS);
        return;
      }
      case "nibble_event": {
        if (activeCastIdRef.current !== msg.clientCastId) return;
        nibbleServerTsRef.current = msg.serverTs;
        playSfx("nibbleBite");
        // Triple-pulse so the nibble registers through a pocket/case.
        vibrate([140, 60, 140, 60, 260]);
        setState("nibble_window");
        if (nibbleWindowTimerRef.current) {
          clearTimeout(nibbleWindowTimerRef.current);
        }
        // Fallback in case the server's escape message is delayed.
        nibbleWindowTimerRef.current = setTimeout(() => {
          nibbleWindowTimerRef.current = null;
          setState((prev) =>
            prev === "nibble_window" ? "idle_waiting" : prev,
          );
        }, NIBBLE_WINDOW_MS + 250);
        return;
      }
      case "fish_escaped": {
        if (!guardRef.current.acceptEscape(msg.clientCastId, activeCastIdRef.current))
          return;
        if (nibbleWindowTimerRef.current) {
          clearTimeout(nibbleWindowTimerRef.current);
          nibbleWindowTimerRef.current = null;
        }
        setLastCatch(null);
        setState("missed");
        playSfx("fishGotAway");
        heldRef.current = false;
        // Bait decrement is owned by catch_resolved only; debiting here too
        // would double-debit locally vs server.
        return;
      }
      case "fish_hooked": {
        activeCastIdRef.current = msg.clientCastId;
        if (msg.sessionId) setSessionId(msg.sessionId);
        setCastStartedAtMs(msg.castTimestamp);
        setInputDelayMs(msg.inputDelayMs ?? null);
        const rarity = mapRarity(msg.rarity);
        const onChainMechanic = getInteractionMechanic(rarity);
        setFishRarity(rarity);
        setMechanic(onChainMechanic);
        // Apex catalog lives in MongoDB, not FISH_SPECIES.
        if (msg.apexFishId && msg.apexAssetUrl) {
          setSpecies({
            name: msg.speciesName,
            rarity: FishRarity.Apex,
            zone: getSpeciesData(0).zone,
            weightMin: 0,
            weightMax: 0,
            asset: msg.apexAssetUrl,
          });
        } else {
          setSpecies(getSpeciesData(msg.speciesId));
        }
        setServerSnapshot(null);

        const diffSeed = msg.rngSeed >>> 0;
        const diffMods = computeModifiers({
          streak: 0,
          poolTier: 0,
          sessionElapsedMs: 0,
        });
        const diffProfile = buildDifficultyProfile(rarity, diffSeed, diffMods);

        if (onChainMechanic === "circular_tap") {
          const taps =
            diffProfile.kind === "circular"
              ? diffProfile.tapsRequired
              : undefined;
          setCircularTapConfig(buildCircularTapConfig(rarity, 0, taps));
        }
        setDifficulty({
          seed: diffSeed,
          mods: diffMods,
          profile: diffProfile,
        });
        legendaryVerticalProfileRef.current =
          rarity === FishRarity.Legendary || rarity === FishRarity.Apex
            ? buildLegendaryVerticalProfile(rarity, diffSeed, diffMods)
            : null;

        // 450ms gate is a buffer for the hook-yank anim before the mechanic mounts.
        setState("biting");
        gameRef.current?.events.emit("fishBite");
        biteTimerRef.current = setTimeout(() => {
          if (onChainMechanic === "circular_tap") {
            setState("warning");
          } else {
            setState("reeling");
          }
        }, 450);
        return;
      }
      case "fishing_state": {
        if (activeCastIdRef.current !== msg.clientCastId) return;
        setServerSnapshot({
          barY: msg.barY,
          fishY: msg.fishY,
          progress: msg.progress,
          tickIndex: msg.tickIndex,
        });
        return;
      }
      case "desync_correction": {
        if (activeCastIdRef.current !== msg.clientCastId) return;
        setServerSnapshot({
          barY: msg.barY,
          fishY: msg.fishY,
          progress: msg.progress,
          tickIndex: msg.tickIndex,
        });
        setReconcileVersion((v) => v + 1);
        return;
      }
      case "catch_resolved": {
        if (!guardRef.current.acceptResolved(msg.clientCastId)) return;
        activeCastIdRef.current = null;
        heldRef.current = false;
        if (biteTimerRef.current) {
          clearTimeout(biteTimerRef.current);
          biteTimerRef.current = null;
        }
        if (msg.hit) {
          const rarity = mapRarity(msg.rarity);
          const isApex = !!msg.apexFishId && !!msg.apexAssetUrl;
          const speciesName = isApex
            ? msg.speciesName
            : getSpeciesData(msg.speciesId).name;
          const speciesAsset = isApex
            ? msg.apexAssetUrl!
            : getSpeciesData(msg.speciesId).asset;
          const caught: CaughtFish = {
            id: `pending:${crypto.randomUUID()}`,
            species: speciesName,
            rarity,
            weightKg: msg.weightHg / 10,
            score: msg.score,
            asset: speciesAsset,
            shellValue: 0,
            caughtAt: new Date().toISOString(),
          };
          setLastCatch(caught);
          setScore((s) => s + msg.score);
          setCatches((c) => [...c, caught]);
          setDiscoveredSpecies((prev) => {
            if (prev.has(speciesName)) return prev;
            const next = new Set(prev);
            next.add(speciesName);
            return next;
          });
          setState("caught");
          const isLegendary =
            rarity === FishRarity.Legendary || rarity === FishRarity.Apex;
          playSfx(isLegendary ? "caughtLegendary" : "caughtFish");
          hydratedRef.current = false;
          void sessionStateQuery.refetch();
        } else {
          setLastCatch(null);
          setState("missed");
          playSfx("fishGotAway");
        }
        setBait((b) => Math.max(0, b - 1));
        return;
      }
      case "leaderboard_update": {
        setRoomLeaderboard({
          roomId: msg.roomId ?? null,
          entries: msg.entries,
          updatedAt: Date.now(),
        });
        // Leaderboard broadcast carries post-credit Redis value; sessionState
        // refetch can return stale Mongo aggregate, so prefer this for sync.
        const myWallet = walletStrRef.current;
        if (myWallet) {
          const mine = msg.entries.find((e) => e.wallet === myWallet);
          if (mine) setScore(mine.score);
        }
        return;
      }
      case "event_status": {
        setEventStatus({
          active: msg.active,
          name: msg.name,
          startsAt: msg.startsAt,
          endsAt: msg.endsAt,
          apexBp: msg.apexBp,
          prizePoolSol: msg.prizePoolSol,
          apexFishes: msg.apexFishes,
        });
        return;
      }
      case "error": {
        console.warn("[ws] server error:", msg.code, msg.message);
        // no_active_cast is a race (server resolved while a keep-alive was in-flight); ignore, catch_resolved is coming.
        if (msg.code === "no_active_cast") {
          return;
        }
        // Room stopped accepting casts; refresh room state so the Cast button disables immediately.
        if (msg.code === "window_closed") {
          // Refresh sessionState + me; me's streak recompute is idempotent within a UTC day.
          void utils.player.sessionState.invalidate();
          void utils.player.me.invalidate();
        }
        activeCastIdRef.current = null;
        // Reset gate; stale heldRef would drop the next cast's first press.
        heldRef.current = false;
        if (biteTimerRef.current) {
          clearTimeout(biteTimerRef.current);
          biteTimerRef.current = null;
        }
        if (nibbleWindowTimerRef.current) {
          clearTimeout(nibbleWindowTimerRef.current);
          nibbleWindowTimerRef.current = null;
        }
        setState((prev) =>
          prev === "casting" ||
          prev === "cast_animating" ||
          prev === "idle_waiting" ||
          prev === "nibble_window" ||
          prev === "hooking" ||
          prev === "biting" ||
          prev === "reeling"
            ? "idle"
            : prev,
        );
        return;
      }
      case "pong": {
        return;
      }
    }
  }, []);

  const { authed, send } = useFishingSocket({
    walletStr,
    authReady,
    guard: guardRef.current,
    onMessage: handleMessage,
    onSession,
    onReset,
    getActiveCastId: () => activeCastIdRef.current,
    sessionRetry,
  });
  useEffect(() => {
    authedRef.current = authed;
  }, [authed]);

  // Socket lifecycle lives in useFishingSocket; just clear gameplay timers on unmount.
  useEffect(() => {
    return () => {
      for (const t of [
        biteTimerRef,
        castAnimTimerRef,
        hookAnimTimerRef,
        nibbleWindowTimerRef,
      ]) {
        if (t.current) {
          clearTimeout(t.current);
          t.current = null;
        }
      }
    };
  }, []);

  // Global tap-to-hook listener, mounted only during nibble_window so resting
  // taps (e.g. opening the shop) don't consume the hook.
  useEffect(() => {
    if (state !== "nibble_window") return;

    const handleTap = (ev: Event) => {
      // preventDefault stops mobile double-tap zoom + text selection.
      try {
        ev.preventDefault();
      } catch {}
      const castId = activeCastIdRef.current;
      if (!castId) return;
      const clientTs = Date.now();
      send({
        type: "nibble_response",
        sessionId: sessionId ?? "",
        clientCastId: castId,
        clientTs,
      });
      setState("hooking");
      if (hookAnimTimerRef.current) clearTimeout(hookAnimTimerRef.current);
      // Timer exists only for cleanup; fish_hooked is what advances state.
      hookAnimTimerRef.current = setTimeout(() => {
        hookAnimTimerRef.current = null;
      }, HOOK_ANIMATION_MS);
    };

    const handleKey = (ev: KeyboardEvent) => {
      if (ev.code !== "Space" || ev.repeat) return;
      handleTap(ev);
    };

    document.addEventListener("touchstart", handleTap, { passive: false });
    document.addEventListener("mousedown", handleTap);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("touchstart", handleTap);
      document.removeEventListener("mousedown", handleTap);
      document.removeEventListener("keydown", handleKey);
    };
  }, [state, sessionId, gameRef]);

  const startSession = useCallback(
    async (_window: "day" | "night" = "day") => {
      void _window;
      if (publicKey) setSessionId((prev) => prev ?? publicKey.toBase58());
    },
    [publicKey],
  );

  const cast = useCallback(async () => {
    if (state !== "idle" || bait <= 0 || !authedRef.current) return;

    const clientCastId = crypto.randomUUID();
    activeCastIdRef.current = clientCastId;
    setState("casting");
    gameRef.current?.events.emit("castLine");
    playSfx("castRod");

    send({ type: "cast_initiate", power: 100, clientCastId });
  }, [state, bait, gameRef]);

  const sendInputSamples = useCallback(
    (samples: Array<{ held: boolean; index: number; t_ms: number }>) => {
      const castId = activeCastIdRef.current;
      if (!castId) return;
      send({
        type: "input_samples",
        sessionId: sessionId ?? "",
        clientCastId: castId,
        samples,
      });
    },
    [sessionId],
  );

  /** Idempotent finalize; server decides catch vs miss using its own progress. */
  const sendCastFinalize = useCallback(() => {
    const castId = activeCastIdRef.current;
    if (!castId) return;
    send({
      type: "cast_finalize",
      sessionId: sessionId ?? "",
      clientCastId: castId,
    });
  }, [sessionId]);

  const holdIndexRef = useRef(0);
  const heldRef = useRef(false);
  // Built alongside the circular profile so the chained TimingBar phase for
  // Legendary/Apex can mount instantly without another server round-trip.
  const legendaryVerticalProfileRef = useRef<ReturnType<
    typeof buildLegendaryVerticalProfile
  > | null>(null);

  const setHeld = useCallback(
    (held: boolean, tNow?: number) => {
      if (heldRef.current === held) return;
      heldRef.current = held;
      // Caller passes `tNow` so its local inputHistoryRef and this send share
      // an identical timestamp; separate Date.now() calls can drift by 1ms.
      const t_ms = tNow ?? Date.now();
      sendInputSamples([{ held, index: holdIndexRef.current++, t_ms }]);
    },
    [sendInputSamples],
  );

  // Keep-alive so the server doesn't starve when no transitions occur.
  useEffect(() => {
    if (state !== "reeling") return;
    const id = window.setInterval(() => {
      sendInputSamples([
        {
          held: heldRef.current,
          index: holdIndexRef.current++,
          t_ms: Date.now(),
        },
      ]);
    }, 150);
    return () => window.clearInterval(id);
  }, [state, sendInputSamples]);

  const onCircularTapResult = useCallback(
    (tapResults: TapResult[]) => {
      const hits = tapResults.filter((r) => r.hit).length;
      const total = tapResults.length;
      const allHit = total > 0 && hits === total;

      const secondary = legendaryVerticalProfileRef.current;
      const seed = difficulty?.seed ?? 1;
      const mods = difficulty?.mods;

      // Both pass and fail go through `circular_tap_complete`; server replays
      // per-tap timestamps for authoritative validation.
      const taps = tapResults.map((r, i) => ({
        tapIndex: i,
        msSinceTapStart: r.msSinceTapStart,
      }));
      const castId = activeCastIdRef.current;
      if (castId) {
        send({
          type: "circular_tap_complete",
          sessionId: sessionId ?? "",
          clientCastId: castId,
          taps,
        });
      }

      // Optimistically mount phase two; server's catch_resolved is canonical.
      if (allHit && secondary && mods) {
        setMechanic("timing_bar");
        setDifficulty({ seed, mods, profile: secondary });
        setState("reeling");
      }
    },
    [difficulty, sessionId],
  );

  const onTimingBarResolve = useCallback(
    (outcome: "caught" | "escaped") => {
      // Server decides catch vs miss via its own progress floor; client outcome
      // is never honoured for force-escape.
      void outcome;
      sendCastFinalize();
    },
    [sendCastFinalize],
  );

  const advanceFromWarning = useCallback(() => {
    setState("circular_tap");
  }, []);

  const dismiss = useCallback(() => {
    setState("idle");
    setLastCatch(null);
    gameRef.current?.events.emit("stopFishing");
  }, [gameRef]);

  const endSession = useCallback(async () => {
    setSessionId(null);
    return { totalScore: score, catches };
  }, [score, catches]);

  const sellFish = useCallback(
    async (catchId: string) => {
      if (catchId.startsWith("pending:")) {
        throw new Error("Catch still syncing — try again in a moment");
      }
      const result = await sellFishMutation.mutateAsync({ catchId });
      setCatches((prev) => prev.filter((c) => c.id !== catchId));
      hydratedRef.current = false;
      await Promise.all([
        utils.player.sessionState.invalidate(),
        utils.player.me.invalidate(),
      ]);
      return result;
    },
    [sellFishMutation, utils],
  );

  const sellFishBulk = useCallback(
    async (catchIds: string[]) => {
      const ready = catchIds.filter((id) => !id.startsWith("pending:"));
      if (ready.length === 0) {
        throw new Error("Catches still syncing — try again in a moment");
      }
      const result = await sellFishBulkMutation.mutateAsync({
        catchIds: ready,
      });
      const soldSet = new Set(result.soldIds);
      setCatches((prev) => prev.filter((c) => !soldSet.has(c.id)));
      hydratedRef.current = false;
      await Promise.all([
        utils.player.sessionState.invalidate(),
        utils.player.me.invalidate(),
      ]);
      return result;
    },
    [sellFishBulkMutation, utils],
  );

  return {
    state,
    bait,
    score,
    lastCatch,
    catches,
    discoveredSpecies,
    discoveredApexFish,
    mechanic,
    circularTapConfig,
    fishRarity,
    difficulty,
    species,
    castStartedAtMs,
    inputDelayMs,
    serverSnapshot,
    reconcileVersion,
    sessionId,
    authed,
    roomSettling,
    eventStatus,
    roomLeaderboard,
    cast,
    setHeld,
    onCircularTapResult,
    onTimingBarResolve,
    sendInputSamples,
    advanceFromWarning,
    dismiss,
    sellFish,
    sellFishBulk,
    startSession,
    endSession,
  };
}

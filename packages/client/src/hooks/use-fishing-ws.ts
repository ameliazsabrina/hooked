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
  clearDelegation,
  loadDelegation,
  signNonceWithSessionKey,
} from "../utils/ws-delegation";

export type FishingState =
  | "idle"
  // Cast tap fired; waiting for the server to ack with cast_accepted.
  | "casting"
  // Cast acked; cast animation window before nibble timer starts.
  | "cast_animating"
  // Cast settled — server is silently holding the nibble timer.
  | "idle_waiting"
  // Nibble fired; player must tap anywhere within 2s.
  | "nibble_window"
  // Player tapped successfully; brief hook-yank anim before biting kicks in.
  | "hooking"
  | "biting"
  | "warning"
  | "reeling"
  | "circular_tap"
  | "caught"
  | "missed";

const CAST_ANIMATION_MS = 700;
const HOOK_ANIMATION_MS = 350;
const NIBBLE_WINDOW_MS = 2000;

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

const DEFAULT_GATEWAY_HTTP = "http://localhost:3001";
const RECONNECT_DELAY_MS = 1500;

type ServerMessage =
  | { type: "authenticated"; wallet: string; sessionPda?: string }
  | { type: "auth_failed"; reason: string }
  | {
      type: "cast_accepted";
      sessionId: string;
      clientCastId: string;
      castTimestamp: number;
    }
  | {
      type: "nibble_event";
      sessionId: string;
      clientCastId: string;
      serverTs: number;
    }
  | {
      type: "fish_escaped";
      sessionId: string;
      clientCastId: string;
      reason: "no_tap" | "early_tap";
    }
  | {
      type: "fish_hooked";
      sessionId: string;
      clientCastId: string;
      speciesId: number;
      apexFishId: string | null;
      apexAssetUrl: string | null;
      speciesName: string;
      rarity: number;
      mechanic: number;
      greenZoneStart: number;
      greenZoneWidth: number;
      weightHg: number;
      castTimestamp: number;
      rngSeed: number;
    }
  | {
      type: "fishing_state";
      sessionId: string;
      clientCastId: string;
      barY: number;
      fishY: number;
      progress: number;
      tickIndex: number;
    }
  | {
      type: "desync_correction";
      sessionId: string;
      clientCastId: string;
      barY: number;
      fishY: number;
      progress: number;
      tickIndex: number;
    }
  | {
      type: "catch_resolved";
      sessionId: string;
      clientCastId: string;
      hit: boolean;
      speciesId: number;
      apexFishId: string | null;
      apexAssetUrl: string | null;
      speciesName: string;
      rarity: number;
      weightHg: number;
      score: number;
      roomId?: string;
    }
  | {
      type: "leaderboard_update";
      roomId?: string;
      date: string;
      entries: Array<{
        wallet: string;
        displayName?: string;
        score: number;
        catchCount: number;
      }>;
    }
  | { type: "bait_refilled"; bait: number; window: number; date: number }
  | {
      type: "event_status";
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
    }
  | { type: "error"; code: string; message: string }
  | { type: "pong"; t: number };

function httpBase(): string {
  const override = import.meta.env.VITE_GATEWAY_HTTP as string | undefined;
  return override ?? DEFAULT_GATEWAY_HTTP;
}

function wsUrl(): string {
  const override = import.meta.env.VITE_WS_URL as string | undefined;
  if (override) return override;
  const http = httpBase();
  return http.replace(/^http/, "ws") + "/ws/gateway";
}

export function useFishingWs(gameRef: React.RefObject<Phaser.Game | null>) {
  const { publicKey } = useWallet();
  const { ready: authReady, retry: sessionRetry } = useSessionAuth();
  const sessionRetryRef = useRef(sessionRetry);
  useEffect(() => { sessionRetryRef.current = sessionRetry; }, [sessionRetry]);

  const [state, setState] = useState<FishingState>("idle");
  const [bait, setBait] = useState(0);
  const [score, setScore] = useState(0);
  const [lastCatch, setLastCatch] = useState<CaughtFish | null>(null);
  const [catches, setCatches] = useState<CaughtFish[]>([]);
  const [discoveredSpecies, setDiscoveredSpecies] = useState<Set<string>>(
    () => new Set(),
  );
  // Apex fish the player has caught at any point. Driven by the server's
  // `discoveredApexFish` (joined against the admin-managed ApexFish catalog),
  // so the Fish Index's apex tier can render slots for fish that aren't in
  // the currently-active event pool.
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
  // Live leaderboard pushed by the server after every credited catch in the
  // player's room. Replaces the 15s tRPC poll as the freshness source; the
  // tRPC query stays as a fallback for first paint and missed frames.
  const [roomLeaderboard, setRoomLeaderboard] =
    useState<RoomLeaderboardSnapshot | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const activeCastIdRef = useRef<string | null>(null);
  const biteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const castAnimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hookAnimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nibbleWindowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Server-supplied timestamp from the most recent nibble_event. Captured so
  // a player tap can be sent with the matching server reference (the server
  // re-derives reaction time from its own clock; this is for parity logging).
  const nibbleServerTsRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const authedRef = useRef(false);
  const connectingRef = useRef(false);
  const [authed, setAuthed] = useState(false);
  const reconnectAttemptsRef = useRef(0);
  const MAX_RECONNECT_ATTEMPTS = 5;

  const walletStr = publicKey?.toBase58() ?? null;
  const walletStrRef = useRef(walletStr);
  useEffect(() => { walletStrRef.current = walletStr; }, [walletStr]);

  const sessionStateQuery = trpc.player.sessionState.useQuery(undefined, {
    enabled: !!walletStr && authReady,
    refetchOnWindowFocus: false,
  });
  const utils = trpc.useUtils();
  const sellFishMutation = trpc.shop.sellFish.useMutation();
  const sellFishBulkMutation = trpc.shop.sellFishBulk.useMutation();

  useEffect(() => {
    const data = sessionStateQuery.data;
    if (!data) return;
    // Hydrate bait once per (wallet, date, window). Reconnecting with the same
    // wallet *inside the same window* keeps local state (optimistic decrements
    // in catch_resolved are authoritative). A wallet switch or a server
    // window rotation (date/window change) re-hydrates from on-chain state so
    // the player sees the fresh bait amount after sessionLifecycle's issue_bait.
    const baitKey = walletStr ? `${walletStr}:${data.date}:${data.window}` : null;
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
    // `discoveredSpeciesIds` was added to the sessionState response in the
    // same release as this hook. Tolerate an older server (or a stale tRPC
    // cache from before the deploy) returning the response without it —
    // unguarded `.map` would throw inside this effect, unmount GameLayout,
    // and leave the user staring at the body's #000 background.
    setDiscoveredSpecies(
      new Set(
        (data.discoveredSpeciesIds ?? []).map(
          (id) => getSpeciesData(id).name,
        ),
      ),
    );
    setDiscoveredApexFish(data.discoveredApexFish ?? []);
  }, [sessionStateQuery.data]);

  // Reset catch/score hydration gate on wallet change. Bait uses its own
  // per-wallet ref above so same-wallet reconnects preserve local state.
  useEffect(() => {
    hydratedRef.current = false;
    setDiscoveredSpecies(new Set());
    setDiscoveredApexFish([]);
  }, [walletStr]);

  const connect = useCallback(async () => {
    if (!walletStr) return;
    if (wsRef.current || connectingRef.current) return;
    // SessionAuthProvider owns the single signMessage prompt and persists
    // the delegation. The WS layer just reads it — never signs — so the
    // user only sees one wallet popup per delegation lifetime.
    if (!authReady) return;
    connectingRef.current = true;

    try {
      const bundle = loadDelegation(walletStr);
      if (!bundle) {
        console.warn(
          "[ws] no cached delegation; SessionAuthProvider must complete first.",
        );
        return;
      }

      const nonceRes = await fetch(`${httpBase()}/ws/nonce`);
      const { nonce } = (await nonceRes.json()) as {
        nonce: string;
        message: string;
      };

      const signature = signNonceWithSessionKey(bundle.sessionSecret, nonce);

      const claimRes = await fetch(`${httpBase()}/ws/claim-nonce`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: walletStr, nonce }),
      });
      if (!claimRes.ok) throw new Error("nonce claim failed");

      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({
            type: "authenticate",
            wallet: walletStr,
            nonce,
            signature,
            delegation: bundle.delegation,
          }),
        );
      });

      ws.addEventListener("message", (ev) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data as string) as ServerMessage;
        } catch {
          return;
        }
        handleMessage(msg);
      });

      ws.addEventListener("close", () => {
        const wasAuthed = authedRef.current;
        wsRef.current = null;
        authedRef.current = false;
        setAuthed(false);
        if (wasAuthed) {
          reconnectAttemptsRef.current = 0;
        }
        if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
          console.warn("[ws] max reconnect attempts reached — forcing re-auth");
          reconnectAttemptsRef.current = 0;
          sessionRetryRef.current();
          return;
        }
        reconnectAttemptsRef.current++;
        if (!reconnectTimerRef.current) {
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            connect();
          }, RECONNECT_DELAY_MS);
        }
      });

      ws.addEventListener("error", () => {
        try {
          ws.close();
        } catch {
        }
      });
    } catch (err) {
      console.warn("[ws] connect failed:", err);
    } finally {
      connectingRef.current = false;
    }
  }, [walletStr, authReady]);

  const handleMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case "authenticated": {
        authedRef.current = true;
        setAuthed(true);
        reconnectAttemptsRef.current = 0;
        if (msg.sessionPda) setSessionId(msg.sessionPda);
        return;
      }
      case "auth_failed": {
        console.warn("[ws] auth failed:", msg.reason);
        authedRef.current = false;
        setAuthed(false);
        const wallet = walletStrRef.current;
        if (wallet) clearDelegation(wallet);
        try { wsRef.current?.close(); } catch {}
        wsRef.current = null;
        sessionRetryRef.current();
        return;
      }
      case "bait_refilled": {
        // Server-authoritative push fired by sessionLifecycle.issueBait after
        // a window rotation. Adopt the fresh count and align the composite
        // hydration key so a subsequent sessionStateQuery doesn't clobber it.
        setBait(msg.bait);
        if (walletStr) {
          baitHydratedForWalletRef.current =
            `${walletStr}:${msg.date}:${msg.window}`;
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
          // Only advance if we're still on the same cast (not a server
          // race that already moved us to nibble_window).
          setState((prev) => (prev === "cast_animating" ? "idle_waiting" : prev));
        }, CAST_ANIMATION_MS);
        return;
      }
      case "nibble_event": {
        if (activeCastIdRef.current !== msg.clientCastId) return;
        nibbleServerTsRef.current = msg.serverTs;
        playSfx("nibbleBite");
        // Escalating triple-pulse: two short jolts + one strong sustain so
        // the nibble registers physically even through a pocket / case.
        vibrate([140, 60, 140, 60, 260]);
        setState("nibble_window");
        if (nibbleWindowTimerRef.current) {
          clearTimeout(nibbleWindowTimerRef.current);
        }
        // UI-side fallback: if the server's escape message is delayed by
        // network jitter, snap the visible state out of nibble_window so
        // the prompt doesn't linger past the window.
        nibbleWindowTimerRef.current = setTimeout(() => {
          nibbleWindowTimerRef.current = null;
          setState((prev) => (prev === "nibble_window" ? "idle_waiting" : prev));
        }, NIBBLE_WINDOW_MS + 250);
        return;
      }
      case "fish_escaped": {
        if (activeCastIdRef.current !== msg.clientCastId) return;
        if (nibbleWindowTimerRef.current) {
          clearTimeout(nibbleWindowTimerRef.current);
          nibbleWindowTimerRef.current = null;
        }
        setLastCatch(null);
        setState("missed");
        playSfx("fishGotAway");
        heldRef.current = false;
        // Bait was consumed at cast_initiate (on-chain) so reflect that
        // optimistically here. catch_resolved no longer fires for escape.
        setBait((b) => Math.max(0, b - 1));
        return;
      }
      case "fish_hooked": {
        activeCastIdRef.current = msg.clientCastId;
        if (msg.sessionId) setSessionId(msg.sessionId);
        setCastStartedAtMs(msg.castTimestamp);
        const rarity = mapRarity(msg.rarity);
        const onChainMechanic = getInteractionMechanic(rarity);
        setFishRarity(rarity);
        setMechanic(onChainMechanic);
        // For apex casts the catalog lives in MongoDB, not FISH_SPECIES — use
        // the server-supplied name + URL directly. Non-apex casts keep the
        // FISH_SPECIES lookup so existing assets (rod-icon mapping, etc.)
        // continue to resolve.
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
          const taps = diffProfile.kind === "circular" ? diffProfile.tapsRequired : undefined;
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

        // Server holds physics until it gets our first hold sample, so this
        // delay no longer drains the progress meter. The new nibble flow
        // already provided the anticipation that the bite slam used to
        // carry, so the 450ms gate is now mostly a buffer for the hook-yank
        // anim to land before the input mechanic mounts.
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
      case "fishing_state":
      case "desync_correction": {
        if (activeCastIdRef.current !== msg.clientCastId) return;
        setServerSnapshot({
          barY: msg.barY,
          fishY: msg.fishY,
          progress: msg.progress,
          tickIndex: msg.tickIndex,
        });
        return;
      }
      case "catch_resolved": {
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
        // The HUD score is authoritative iff it matches what Redis has for
        // this player. The optimistic +N on catch_resolved gives instant
        // feedback, but a subsequent sessionState refetch can clobber it
        // with a stale Mongo aggregate (catch row not yet visible). The
        // leaderboard broadcast carries the post-credit Redis value, so
        // sync from there whenever our wallet is present — eventually
        // consistent with the authoritative source within ~250ms.
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
        // "no_active_cast" during an active catch phase is typically a race:
        // the server already resolved the cast and cleared its slot, but a
        // keep-alive sample was already in-flight. The real verdict is coming
        // via catch_resolved. If we prematurely clear castId here, the timing
        // bar's onTimingBarResolve callback can't send its final sample, and
        // the catch hangs permanently. Likewise, resetting state to "idle"
        // would unmount the timing bar so it can never fire.
        if (msg.code === "no_active_cast") {
          // Log and ignore — catch_resolved will arrive shortly and set the
          // correct terminal state. If it never arrives (WS drop) the cast
          // will hang, but that's a reconnect problem, not this error path.
          return;
        }
        activeCastIdRef.current = null;
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

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (biteTimerRef.current) {
        clearTimeout(biteTimerRef.current);
        biteTimerRef.current = null;
      }
      if (castAnimTimerRef.current) {
        clearTimeout(castAnimTimerRef.current);
        castAnimTimerRef.current = null;
      }
      if (hookAnimTimerRef.current) {
        clearTimeout(hookAnimTimerRef.current);
        hookAnimTimerRef.current = null;
      }
      if (nibbleWindowTimerRef.current) {
        clearTimeout(nibbleWindowTimerRef.current);
        nibbleWindowTimerRef.current = null;
      }
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
      wsRef.current = null;
    };
  }, [connect]);

  // Global tap-to-hook listener: any pointerdown / touchstart anywhere on
  // the page during the nibble window registers as a hook attempt. Mounted
  // only while in nibble_window so resting state taps (e.g. opening the
  // shop) don't accidentally consume the hook.
  useEffect(() => {
    if (state !== "nibble_window") return;
    const ws = wsRef.current;
    if (!ws) return;

    const handleTap = (ev: Event) => {
      // The overlay is non-interactive; this fires on the underlying
      // viewport. preventDefault stops mobile double-tap zoom + text
      // selection without breaking actual UI buttons (which we exit
      // nibble_window before they can be tapped, since this listener
      // unmounts on state change).
      try {
        ev.preventDefault();
      } catch {
        // Some events ship with passive listeners — ignore.
      }
      const castId = activeCastIdRef.current;
      if (!castId) return;
      const clientTs = Date.now();
      ws.send(
        JSON.stringify({
          type: "nibble_response",
          sessionId: sessionId ?? "",
          clientCastId: castId,
          clientTs,
        }),
      );
      setState("hooking");
      if (hookAnimTimerRef.current) clearTimeout(hookAnimTimerRef.current);
      // No timer-driven transition out of `hooking` — the server's
      // fish_hooked broadcast is what advances us into `biting`. The timer
      // ref only exists for cleanup if a connection drop strands us here.
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

  const startSession = useCallback(async (_window: "day" | "night" = "day") => {
    void _window;
    if (publicKey) setSessionId((prev) => prev ?? publicKey.toBase58());
  }, [publicKey]);

  const cast = useCallback(async () => {
    if (state !== "idle" || bait <= 0 || !authedRef.current) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const clientCastId = crypto.randomUUID();
    activeCastIdRef.current = clientCastId;
    setState("casting");
    gameRef.current?.events.emit("castLine");
    playSfx("castRod");

    ws.send(
      JSON.stringify({ type: "cast_initiate", power: 100, clientCastId }),
    );
  }, [state, bait, gameRef]);

  const sendInputSamples = useCallback(
    (samples: Array<{ held: boolean; index: number; t_ms: number }>, final: boolean) => {
      const ws = wsRef.current;
      const castId = activeCastIdRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !castId) return;
      ws.send(
        JSON.stringify({
          type: "input_samples",
          sessionId: sessionId ?? "",
          clientCastId: castId,
          samples,
          final,
        }),
      );
    },
    [sessionId],
  );

  const holdIndexRef = useRef(0);
  const heldRef = useRef(false);
  // Legendary/Apex chain a TimingBar phase after the circular tap. Built at
  // fish_hooked alongside the circular profile so the second phase can mount
  // instantly when the taps clear, without another server round-trip.
  const legendaryVerticalProfileRef = useRef<ReturnType<
    typeof buildLegendaryVerticalProfile
  > | null>(null);

  const setHeld = useCallback(
    (held: boolean) => {
      if (heldRef.current === held) return;
      heldRef.current = held;
      sendInputSamples(
        [{ held, index: holdIndexRef.current++, t_ms: Date.now() }],
        false,
      );
    },
    [sendInputSamples],
  );

  // Keep-alive: re-send the current hold state periodically so the server
  // doesn't starve if no transitions occur mid-catch.
  useEffect(() => {
    if (state !== "reeling") return;
    const id = window.setInterval(() => {
      sendInputSamples(
        [
          {
            held: heldRef.current,
            index: holdIndexRef.current++,
            t_ms: Date.now(),
          },
        ],
        false,
      );
    }, 150);
    return () => window.clearInterval(id);
  }, [state, sendInputSamples]);

  const onCircularTapResult = useCallback(
    (tapResults: TapResult[]) => {
      const hits = tapResults.filter((r) => r.hit).length;
      const total = tapResults.length;
      const allHit = total > 0 && hits === total;
      console.warn(`[circular-tap] result: ${hits}/${total} hit, allHit=${allHit}`);

      const secondary = legendaryVerticalProfileRef.current;
      const seed = difficulty?.seed ?? 1;
      const mods = difficulty?.mods;

      // Send the per-tap timing payload up to the server. The server replays
      // the spinner physics on these timestamps and decides pass/fail itself
      // (C-1: server-authoritative resolution). Path is the same whether we
      // hit or missed locally — the server's verdict is what matters, and
      // for a verified pass it then drives the chained timing-bar phase.
      const taps = tapResults.map((r, i) => ({
        tapIndex: i,
        msSinceTapStart: r.tapTimeMs ?? -1,
      }));
      const ws = wsRef.current;
      const castId = activeCastIdRef.current;
      if (ws && ws.readyState === WebSocket.OPEN && castId) {
        ws.send(
          JSON.stringify({
            type: "circular_tap_complete",
            sessionId: sessionId ?? "",
            clientCastId: castId,
            taps,
          }),
        );
      }

      // If our local prediction is allHit + we have a secondary profile,
      // optimistically transition to the timing-bar UI so the player sees
      // the second phase mount immediately. The server is doing its own
      // validation in parallel; if it disagrees the verdict we receive on
      // catch_resolved will be hit=false and the UI will surface the miss.
      if (allHit && secondary && mods) {
        console.warn("[circular-tap] chaining to timing bar phase");
        setMechanic("timing_bar");
        setDifficulty({ seed, mods, profile: secondary });
        setState("reeling");
      }
      // If we predicted a miss locally, we keep waiting for catch_resolved
      // (which the server will send after its own validation). No further
      // input_samples are needed — the server rejects that path now.
    },
    [difficulty, sessionId],
  );

  const onTimingBarResolve = useCallback(
    (outcome: "caught" | "escaped") => {
      console.warn(
        `[timing-bar] resolve: outcome=${outcome} castId=${activeCastIdRef.current} ws=${wsRef.current?.readyState === WebSocket.OPEN ? "open" : "closed"}`,
      );
      sendInputSamples(
        [
          {
            // `held` bit (true = caught) carries the client-predicted outcome
            // so the server can resolve authoritatively even if its own
            // physics lag left progress just short of 1.0.
            held: outcome === "caught",
            index: holdIndexRef.current++,
            t_ms: Date.now(),
          },
        ],
        true,
      );
    },
    [sendInputSamples],
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
    serverSnapshot,
    sessionId,
    authed,
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

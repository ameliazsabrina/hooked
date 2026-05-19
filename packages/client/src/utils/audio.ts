export type SfxName =
  | "castRod"
  | "caughtFish"
  | "caughtLegendary"
  | "fishGotAway"
  | "buySell"
  | "nibbleBite"
  | "splash";

// nibbleBite + splash temporarily reuse castRod until dedicated SFX land.
const SFX_PATHS: Record<SfxName, string> = {
  castRod: "/assets/audio/cast-rod.mp3",
  caughtFish: "/assets/audio/caught-fish.mp3",
  caughtLegendary: "/assets/audio/caught-legendary-fish.mp3",
  fishGotAway: "/assets/audio/fish-got-away.mp3",
  buySell: "/assets/audio/buying-selling-item.mp3",
  nibbleBite: "/assets/audio/cast-rod.mp3",
  splash: "/assets/audio/cast-rod.mp3",
};

const MUSIC_PATH = "/assets/audio/ambient-music.mp3";

const sfxCache = new Map<SfxName, HTMLAudioElement>();

function getSfx(name: SfxName): HTMLAudioElement {
  let el = sfxCache.get(name);
  if (!el) {
    el = new Audio(SFX_PATHS[name]);
    el.preload = "auto";
    sfxCache.set(name, el);
  }
  return el;
}

let sfxVolumeScale = 1;

export function setSfxVolumeScale(v: number) {
  sfxVolumeScale = Math.max(0, Math.min(1, v));
}

export function playSfx(name: SfxName, volume = 0.7) {
  const src = getSfx(name);
  const node = src.cloneNode(true) as HTMLAudioElement;
  node.volume = Math.max(0, Math.min(1, volume * sfxVolumeScale));
  void node.play().catch(() => {});
}

// HTMLAudioElement's loop stutters at the seam; Web Audio loops sample-accurately.
let audioCtx: AudioContext | null = null;
let musicBuffer: AudioBuffer | null = null;
let musicSource: AudioBufferSourceNode | null = null;
let musicGain: GainNode | null = null;
let musicBufferLoading: Promise<AudioBuffer | null> | null = null;
let musicStarted = false;
let musicDesired = false;
let musicVolume = 0.15;

function ensureCtx(): AudioContext | null {
  if (audioCtx) return audioCtx;
  const Ctor =
    typeof window === "undefined"
      ? undefined
      : window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
  if (!Ctor) return null;
  audioCtx = new Ctor();
  return audioCtx;
}

function loadMusicBuffer(): Promise<AudioBuffer | null> {
  if (musicBuffer) return Promise.resolve(musicBuffer);
  if (musicBufferLoading) return musicBufferLoading;
  const ctx = ensureCtx();
  if (!ctx) return Promise.resolve(null);
  musicBufferLoading = fetch(MUSIC_PATH)
    .then((r) => r.arrayBuffer())
    .then((buf) => ctx.decodeAudioData(buf))
    .then((decoded) => {
      musicBuffer = decoded;
      return decoded;
    })
    .catch(() => null)
    .finally(() => {
      musicBufferLoading = null;
    });
  return musicBufferLoading;
}

async function tryPlay() {
  if (!musicDesired || musicStarted) return;
  const ctx = ensureCtx();
  if (!ctx) return;

  const buffer = await loadMusicBuffer();
  if (!buffer || !musicDesired || musicStarted) return;

  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      return;
    }
  }
  if (ctx.state !== "running") return;
  if (!musicDesired || musicStarted) return;

  musicGain = ctx.createGain();
  musicGain.gain.value = musicVolume;
  musicGain.connect(ctx.destination);

  musicSource = ctx.createBufferSource();
  musicSource.buffer = buffer;
  musicSource.loop = true;
  musicSource.connect(musicGain);
  musicSource.start(0);
  musicStarted = true;
  removeGestureListeners();
}

// Capture-phase listeners so first interaction unlocks AudioContext regardless
// of React mount order or downstream stopPropagation.
const GESTURE_EVENTS = [
  "pointerdown",
  "mousedown",
  "touchstart",
  "keydown",
] as const;

const onGesture = () => {
  void tryPlay();
};

function removeGestureListeners() {
  if (typeof document === "undefined") return;
  for (const ev of GESTURE_EVENTS) {
    document.removeEventListener(ev, onGesture, true);
  }
}

if (typeof document !== "undefined") {
  for (const ev of GESTURE_EVENTS) {
    document.addEventListener(ev, onGesture, { capture: true, passive: true });
  }
}

export function startAmbientMusic(volume = 0.15) {
  musicVolume = volume;
  musicDesired = true;
  if (musicGain) musicGain.gain.value = volume;
  void tryPlay();
}

export function setMusicVolume(v: number) {
  musicVolume = Math.max(0, Math.min(1, v));
  if (musicGain) musicGain.gain.value = musicVolume;
}

export function stopAmbientMusic() {
  musicDesired = false;
  if (musicSource) {
    try {
      musicSource.stop();
    } catch {
    }
    musicSource.disconnect();
    musicSource = null;
  }
  if (musicGain) {
    musicGain.disconnect();
    musicGain = null;
  }
  musicStarted = false;
}

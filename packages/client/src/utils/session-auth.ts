const STORAGE_PREFIX = "hooked:http-session:";
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export interface SessionRecord {
  token: string;
  expiresAt: number;
  wallet: string;
}

export function loadSession(wallet: string): SessionRecord | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + wallet);
    if (!raw) return null;
    const rec = JSON.parse(raw) as SessionRecord;
    if (!rec?.token || typeof rec.expiresAt !== "number") return null;
    if (rec.expiresAt - Date.now() < EXPIRY_BUFFER_MS) return null;
    return rec;
  } catch {
    return null;
  }
}

export function saveSession(rec: SessionRecord): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + rec.wallet, JSON.stringify(rec));
  } catch {
  }
}

export function clearSession(wallet: string): void {
  try {
    localStorage.removeItem(STORAGE_PREFIX + wallet);
  } catch {
  }
}

// Module-level store so the tRPC link reads the current token at request time
// without coupling to React render order with SessionAuthProvider.
let currentToken: string | null = null;
export const sessionTokenStore = {
  get: (): string | null => currentToken,
  set: (t: string | null): void => {
    currentToken = t;
  },
};

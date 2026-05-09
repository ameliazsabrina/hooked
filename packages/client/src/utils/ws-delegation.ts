import nacl from "tweetnacl";
import bs58 from "bs58";

export interface WsDelegation {
  wallet: string;
  sessionPubkey: string;
  expiresAt: number;
  message: string;
  signature: string;
}

export interface WsDelegationBundle {
  delegation: WsDelegation;
  sessionSecret: Uint8Array;
}

export const DELEGATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STORAGE_KEY = "hooked:ws-delegation";

interface StoredDelegation {
  delegation: WsDelegation;
  sessionSecretB58: string;
}

function storageKey(wallet: string): string {
  return `${STORAGE_KEY}:${wallet}`;
}

export function buildDelegationMessage(
  wallet: string,
  sessionPubkey: string,
  expiresAt: number,
): string {
  return [
    "Hooked WS Session Delegation",
    `wallet: ${wallet}`,
    `session: ${sessionPubkey}`,
    `expires: ${expiresAt}`,
  ].join("\n");
}

export function loadDelegation(wallet: string): WsDelegationBundle | null {
  try {
    const raw = localStorage.getItem(storageKey(wallet));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDelegation;
    if (!parsed.delegation || !parsed.sessionSecretB58) return null;
    if (parsed.delegation.wallet !== wallet) return null;
    if (parsed.delegation.expiresAt < Date.now() + 60_000) return null;
    return {
      delegation: parsed.delegation,
      sessionSecret: bs58.decode(parsed.sessionSecretB58),
    };
  } catch {
    return null;
  }
}

export function saveDelegation(
  wallet: string,
  bundle: WsDelegationBundle,
): void {
  const stored: StoredDelegation = {
    delegation: bundle.delegation,
    sessionSecretB58: bs58.encode(bundle.sessionSecret),
  };
  localStorage.setItem(storageKey(wallet), JSON.stringify(stored));
}

export function clearDelegation(wallet: string): void {
  try {
    localStorage.removeItem(storageKey(wallet));
  } catch {
  }
}

export async function createDelegation(
  wallet: string,
  signMessage: (msg: Uint8Array) => Promise<Uint8Array>,
): Promise<WsDelegationBundle> {
  const sessionKeypair = nacl.sign.keyPair();
  const sessionPubkey = bs58.encode(sessionKeypair.publicKey);
  const expiresAt = Date.now() + DELEGATION_TTL_MS;
  const message = buildDelegationMessage(wallet, sessionPubkey, expiresAt);

  const signed = await signMessage(new TextEncoder().encode(message));
  const signature = bs58.encode(signed);

  return {
    delegation: {
      wallet,
      sessionPubkey,
      expiresAt,
      message,
      signature,
    },
    sessionSecret: sessionKeypair.secretKey,
  };
}

export function signNonceWithSessionKey(
  sessionSecret: Uint8Array,
  nonce: string,
): string {
  const msg = new TextEncoder().encode(`Hooked Auth Nonce: ${nonce}`);
  const sig = nacl.sign.detached(msg, sessionSecret);
  return bs58.encode(sig);
}

import { PublicKey, TransactionInstruction } from "@solana/web3.js";

/**
 * SPL Memo program. We embed the per-session audit summary in a memo so the
 * keeper bridge tx is self-describing — anyone scanning the chain can pull
 * `(sessionId, merkleRoot)` straight off `update_room_entry_score` calls
 * without consulting our server.
 */
export const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

const MEMO_VERSION_TAG = "hooked-v1";

/**
 * Build the memo string for a score-bridge tx. Format:
 *   `hooked-v1|<sessionId>|<merkleRootHex>`
 * Total ~95 bytes — well under the per-tx soft limit. Stable so off-chain
 * audit tooling can parse historical txs without version-sniffing.
 */
export function encodeScoreBridgeMemo(input: {
  sessionId: string;
  merkleRoot: Buffer;
}): string {
  if (input.merkleRoot.length !== 32) {
    throw new Error(`merkleRoot must be 32 bytes, got ${input.merkleRoot.length}`);
  }
  if (!/^[0-9a-f]{24}$/i.test(input.sessionId)) {
    throw new Error(`sessionId must be a 24-char hex ObjectId, got ${input.sessionId}`);
  }
  return `${MEMO_VERSION_TAG}|${input.sessionId}|${input.merkleRoot.toString("hex")}`;
}

/** Inverse of `encodeScoreBridgeMemo`. Returns null on malformed input. */
export function decodeScoreBridgeMemo(memo: string): {
  sessionId: string;
  merkleRoot: Buffer;
} | null {
  const parts = memo.split("|");
  if (parts.length !== 3) return null;
  if (parts[0] !== MEMO_VERSION_TAG) return null;
  if (!/^[0-9a-f]{24}$/i.test(parts[1])) return null;
  if (!/^[0-9a-f]{64}$/i.test(parts[2])) return null;
  return {
    sessionId: parts[1],
    merkleRoot: Buffer.from(parts[2], "hex"),
  };
}

/** Build a memo instruction signed by `signer` (required so the memo is
 * attributable to the keeper, not anonymous). */
export function buildMemoInstruction(memo: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(memo, "utf-8"),
  });
}

import { PublicKey, TransactionInstruction } from "@solana/web3.js";

export const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

const MEMO_VERSION_TAG = "hooked-v1";

/** Format: `hooked-v1|<sessionId>|<merkleRootHex>`. Stable for audit tooling. */
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

/** Signer makes the memo attributable to the keeper. */
export function buildMemoInstruction(memo: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(memo, "utf-8"),
  });
}

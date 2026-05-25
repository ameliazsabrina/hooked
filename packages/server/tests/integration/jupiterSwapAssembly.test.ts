import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  __testing,
  type JupiterBuildResponse,
} from "../../src/services/lpJupiterSwap.js";

const FIXTURE_PATH = resolve(
  __dirname,
  "../fixtures/jupiter-build-sol-to-usdc.json",
);

const hasFixture = existsSync(FIXTURE_PATH);

(hasFixture ? describe : describe.skip)(
  "Jupiter v2 /build cassette — real response replay",
  () => {
    if (!hasFixture) {
      it.skip("fixture not present — run pnpm cassette:capture", () => {});
      return;
    }

    const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
    const meta = raw._meta as { params: { taker: string } };
    const build = raw.response as JupiterBuildResponse;
    const taker = new PublicKey(meta.params.taker);

    function makeStubConnection(): Connection {
      return {
        async getLatestBlockhash() {
          return {
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 0,
          };
        },
        async getAddressLookupTable(addr: PublicKey) {
          const empty = new AddressLookupTableAccount({
            key: addr,
            state: {
              deactivationSlot: BigInt("18446744073709551615"),
              lastExtendedSlot: 0,
              lastExtendedSlotStartIndex: 0,
              authority: undefined,
              addresses: [],
            },
          });
          return { value: empty };
        },
      } as unknown as Connection;
    }

    it("fixture has the v2 response fields the assembly path needs", () => {
      expect(build.swapInstruction).toBeDefined();
      expect(build.swapInstruction.programId).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
      expect(build.inAmount).toMatch(/^\d+$/);
      expect(build.outAmount).toMatch(/^\d+$/);
      expect(build.otherAmountThreshold).toMatch(/^\d+$/);
      expect(BigInt(build.otherAmountThreshold)).toBeLessThanOrEqual(
        BigInt(build.outAmount),
      );
    });

    it("toTransactionInstruction handles every returned instruction without throwing", () => {
      const all = [
        ...(build.computeBudgetInstructions ?? []),
        ...(build.setupInstructions ?? []),
        build.swapInstruction,
        ...(build.cleanupInstruction ? [build.cleanupInstruction] : []),
        ...(build.otherInstructions ?? []),
      ];
      expect(all.length).toBeGreaterThan(0);

      for (const ix of all) {
        const decoded = __testing.toTransactionInstruction(ix);
        expect(decoded.programId.toBase58()).toBe(ix.programId);
        expect(decoded.keys.length).toBe(ix.accounts.length);
        expect(decoded.data.length).toBe(
          Buffer.from(ix.data, "base64").length,
        );
      }
    });

    it("assembleSwapTransaction produces a signable VersionedTransaction", async () => {
      const tx = await __testing.assembleSwapTransaction({
        connection: makeStubConnection(),
        payer: taker,
        build,
      });

      expect(tx).toBeInstanceOf(VersionedTransaction);

      const firstKey = tx.message.staticAccountKeys[0];
      expect(firstKey.toBase58()).toBe(taker.toBase58());

      expect(tx.message.header.numRequiredSignatures).toBeGreaterThanOrEqual(1);

      expect(tx.message.compiledInstructions.length).toBeGreaterThan(0);
    });

    it("VersionedTransaction serialize/deserialize round-trips byte-for-byte", async () => {
      const tx = await __testing.assembleSwapTransaction({
        connection: makeStubConnection(),
        payer: taker,
        build,
      });
      const signer = Keypair.fromSeed(new Uint8Array(32).fill(9));
      try {
        tx.sign([signer]);
      } catch {
      }

      const serialized = tx.serialize();
      const reHydrated = VersionedTransaction.deserialize(serialized);
      const reSerialized = reHydrated.serialize();

      expect(Buffer.from(reSerialized).equals(Buffer.from(serialized))).toBe(
        true,
      );
    });

    it("v2-specific: response uses `taker` semantics (signer is first static key)", () => {
      const swapIx = build.swapInstruction;
      const hasSigner = swapIx.accounts.some((a) => a.isSigner);
      expect(hasSigner).toBe(true);
      const signerKey = swapIx.accounts.find((a) => a.isSigner)?.pubkey;
      expect(signerKey).toBe(meta.params.taker);
    });
  },
);

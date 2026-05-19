/**
 * Capture a real Jupiter v2 /build response for the cassette test.
 *
 * Run once whenever you need a fresh fixture:
 *
 *   JUPITER_API_KEY=... pnpm tsx src/cli/captureJupiterBuildFixture.ts
 *
 * Writes to packages/server/tests/fixtures/jupiter-build-sol-to-usdc.json.
 * The fixture is checked into git — regenerate it whenever Jupiter changes
 * the v2 response shape and the cassette test starts failing.
 *
 * No on-chain state is changed; this only hits the API.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import { env } from "../config/env.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const HERE = dirname(fileURLToPath(import.meta.url));
// packages/server/src/cli → packages/server/tests/fixtures
const FIXTURE_PATH = resolve(
  HERE,
  "../../tests/fixtures/jupiter-build-sol-to-usdc.json",
);

// Smallest amount Jupiter will route (0.01 SOL). We never sign or send the
// returned tx — fixture is replayed against a stubbed Connection in tests.
const AMOUNT_LAMPORTS = 10_000_000n;
const SLIPPAGE_BPS = 50;

async function main() {
  if (!env.JUPITER_API_KEY) {
    console.error(
      "JUPITER_API_KEY is not set. Get one at https://portal.jup.ag/ and re-run.",
    );
    process.exit(1);
  }

  // Use a deterministic well-known pubkey so the fixture is reproducible
  // and reviewers can see exactly which account the route was computed for.
  // Any valid pubkey works — Jupiter routes by mint pair, not taker identity.
  const taker = Keypair.generate().publicKey;

  const url = new URL(`${env.JUPITER_API_URL}/build`);
  url.searchParams.set("inputMint", SOL_MINT);
  url.searchParams.set("outputMint", env.USDC_MINT_ADDRESS);
  url.searchParams.set("amount", AMOUNT_LAMPORTS.toString());
  url.searchParams.set("slippageBps", String(SLIPPAGE_BPS));
  url.searchParams.set("taker", taker.toBase58());

  console.log(`▶ GET ${url.toString()}`);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-api-key": env.JUPITER_API_KEY,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`✗ ${res.status} ${res.statusText}\n${body.slice(0, 500)}`);
    process.exit(1);
  }

  const json = (await res.json()) as Record<string, unknown>;

  // Sanity-check the response has the fields the assembly path needs.
  const required = [
    "swapInstruction",
    "outAmount",
    "otherAmountThreshold",
    "inAmount",
  ];
  const missing = required.filter((k) => !(k in json));
  if (missing.length > 0) {
    console.error(`✗ Response missing required fields: ${missing.join(", ")}`);
    console.error(JSON.stringify(json, null, 2).slice(0, 2000));
    process.exit(1);
  }

  // Stamp the fixture with capture metadata. Tests ignore _meta — it's for
  // humans reading the fixture to understand when/how it was generated.
  const stamped = {
    _meta: {
      capturedAt: new Date().toISOString(),
      capturedBy: "scripts/captureJupiterBuildFixture.ts",
      endpoint: `${env.JUPITER_API_URL}/build`,
      params: {
        inputMint: SOL_MINT,
        outputMint: env.USDC_MINT_ADDRESS,
        amount: AMOUNT_LAMPORTS.toString(),
        slippageBps: SLIPPAGE_BPS,
        taker: taker.toBase58(),
      },
    },
    response: json,
  };

  mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
  writeFileSync(FIXTURE_PATH, JSON.stringify(stamped, null, 2) + "\n");

  console.log(`✓ Fixture written to ${FIXTURE_PATH}`);
  console.log(
    `  inAmount=${json.inAmount} outAmount=${json.outAmount} ` +
      `priceImpactPct=${json.priceImpactPct}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

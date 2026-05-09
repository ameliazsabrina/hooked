import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  APP_ENV: z
    .enum(["development", "staging", "production"])
    .default("development"),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default("0.0.0.0"),
  MONGODB_URI: z.string().startsWith("mongodb"),
  CLIENT_URL: z.string().url().default("http://localhost:5173"),
  ADMIN_CLIENT_URL: z.string().url().default("http://localhost:3000"),
  // Public origin the API is reachable on. Used to build absolute URLs the
  // admin dashboard / player client can load over HTTP (e.g. apex fish
  // images served from `/admin/apex-fish/:id/image`). Default suits local
  // dev where the server listens on PORT 3001; override in deploy envs.
  SERVER_PUBLIC_URL: z.string().url().default("http://localhost:3001"),
  HELIUS_API_KEY: z.string().optional(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  SOLANA_RPC_URL: z.string().default("https://api.mainnet-beta.solana.com"),
  TREASURY_KEYPAIR: z.string().optional(),
  ADMIN_WALLETS: z.string().default(""),
  HOOKED_FISHING_PROGRAM_ID: z
    .string()
    .default("5wmNbyiSign3mt4dG5ufpcRdizBKqyTGbTtRHvFh94cK"),
  HOOKED_ROOMS_PROGRAM_ID: z
    .string()
    .default("4ERUTWVN3aJP5tghEcZNd555NGcK3Jr8B21mnBB8JSMg"),
  FEATURES_LP_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  FEATURES_ER_WIRED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  ER_RPC_URL: z.string().default("https://devnet-router.magicblock.app"),
  ER_WEBHOOK_SECRET: z.string().default("dev-er-webhook-secret"),
  KEEPER_KEYPAIR: z.string().optional(),
  GATEWAY_KEYPAIR: z.string().optional(),
  // Server-held admin keypair for on-chain admin instructions (e.g. set_event,
  // update_program_config). MUST match the `admin` pubkey stored on the
  // ProgramConfig PDA. Distinct from `ADMIN_WALLETS` which authorizes who can
  // *trigger* admin endpoints over tRPC.
  ADMIN_KEYPAIR: z.string().optional(),

  // LP integration (Meteora DLMM SOL/USDC). Off when FEATURES_LP_ENABLED=false;
  // when enabled, LP_MANAGER_KEYPAIR must be set and the manager wallet must
  // hold at least IL_BUFFER_LAMPORTS_MIN to absorb impermanent loss.
  LP_MANAGER_KEYPAIR: z.string().optional(),
  // Meteora DLMM SOL/USDC pool address. Default below is a USDC/USDT pool —
  // PLACEHOLDER ONLY so the schema parses in dev. Override in .env with the
  // real SOL/USDC address from https://dlmm.datapi.meteora.ag/pair/all
  // (filter SOL/USDC, pick a high-volume bin step like 25 or 100).
  // Booting with FEATURES_LP_ENABLED=true on the placeholder will refuse to
  // deploy (validated in lpManager).
  METEORA_POOL_ADDRESS: z
    .string()
    .default("ARwi1S4DaiTG5DX7S4M4ZsrXqpMD1MrTmbu9ue2tpmEq"),
  // Canonical mainnet USDC mint. Override only if running against a devnet
  // test mint or a non-USDC quote token.
  USDC_MINT_ADDRESS: z
    .string()
    .default("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  JUPITER_API_URL: z.string().default("https://quote-api.jup.ag/v6"),
  // Minimum buffer balance LP_MANAGER must hold (in lamports) before
  // the deploy job is allowed to run. Trips kill switch when below.
  IL_BUFFER_LAMPORTS_MIN: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(500_000_000),
  // Hard kill switch — flip to true to halt all new LP deployments without
  // touching deploy/exit code. Existing positions still get exited normally.
  LP_KILL_SWITCH: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Dry-run mode for devnet/testing: still calls withdraw_to_lp_manager to
  // move SOL out of room_vault, but skips DLMM/Jupiter calls and synthesizes
  // a fake yield (0 by default). Set to a positive lamport count to simulate
  // a winning cycle. Useful because Meteora DLMM is mainnet-only.
  LP_DRY_RUN: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  LP_DRY_RUN_YIELD_LAMPORTS: z.coerce.number().int().nonnegative().default(0),
  // Slippage tolerance for Jupiter swaps (basis points, e.g. 50 = 0.5%).
  LP_SWAP_SLIPPAGE_BPS: z.coerce.number().int().nonnegative().default(50),
  // Hours before closes_at to fire the lpExit job.
  LP_EXIT_HOURS_BEFORE_CLOSE: z.coerce.number().nonnegative().default(12),
  // 64-char hex string (32 bytes) used as the HMAC key in the off-chain
  // fishing RNG. Rotated daily in production (Phase 5 audit layer); a single
  // long-lived value is acceptable for dev. If absent, cast.initiate fails
  // with a clear error rather than silently using a weak default.
  FISHING_DAILY_SEED_HEX: z
    .string()
    .regex(
      /^[0-9a-f]{64}$/i,
      "FISHING_DAILY_SEED_HEX must be 64 hex chars (32 bytes)",
    )
    .optional(),
  // Master cutover flag for the off-chain fishing engine. When true, the WS
  // gateway routes cast/resolve/cancel through services/fishing/* (DB only);
  // the on-chain hooked_fishing program is no longer touched. Default true
  // post-Phase-6: the legacy on-chain branches in gateway.ts have been
  // removed. The flag is kept as a kill-switch in case we need to short-
  // circuit gameplay during an incident; flipping it false just disables
  // casting since there is no longer a chain-backed fallback.
  FISHING_OFFCHAIN: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Filesystem path to the apex-fish PNG directory served by the player
  // client. Used by `services/fishing/apexCatalog.ts` to enumerate which
  // fish the admin can pick from for an event. Default resolves to the
  // sibling client package's public folder relative to the server source;
  // override in production where the client is deployed separately.
  APEX_FISH_DIR: z.string().optional(),
});

export const env = envSchema.parse(process.env);

const adminWalletSet = new Set(
  env.ADMIN_WALLETS.split(",")
    .map((w) => w.trim())
    .filter(Boolean),
);

export function isAdminWallet(address: string): boolean {
  return adminWalletSet.has(address);
}

// Normalize via URL.origin so a trailing slash or path in the env value
// (e.g. CLIENT_URL=https://hooked.fish/) doesn't silently mismatch the
// scheme://host[:port] form that browsers send in the Origin header.
function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    throw new Error(`Invalid origin URL in env: ${value}`);
  }
}

const allowedOriginSet = new Set(
  [env.CLIENT_URL, env.ADMIN_CLIENT_URL]
    .filter((u): u is string => Boolean(u))
    .map(normalizeOrigin),
);

// Match CORS semantics: missing Origin header is allowed (covers non-browser
// clients like curl/wscat and same-origin requests that omit it). Browser-only
// CSWSH attacks always send an Origin header, so the explicit-mismatch check
// is what closes the hole.
export function isAllowedOrigin(
  origin: string | string[] | undefined,
): boolean {
  if (!origin) return true;
  const o = Array.isArray(origin) ? origin[0] : origin;
  if (!o) return true;
  return allowedOriginSet.has(o);
}

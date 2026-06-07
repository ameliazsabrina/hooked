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
  ADMIN_KEYPAIR: z.string().optional(),

  ADMIN_SERVICE_TOKEN: z.string().min(32).optional(),
  ADMIN_SERVICE_WALLET: z.string().optional(),

  LP_MANAGER_KEYPAIR: z.string().optional(),
  METEORA_POOL_ADDRESS: z
    .string()
    .default("ARwi1S4DaiTG5DX7S4M4ZsrXqpMD1MrTmbu9ue2tpmEq"),
  USDC_MINT_ADDRESS: z
    .string()
    .default("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  JUPITER_API_URL: z.string().default("https://api.jup.ag/swap/v2"),
  JUPITER_API_KEY: z.string().optional(),
  JUPITER_EXCLUDE_DEXES: z.string().default(""),
  JUPITER_DEXES: z.string().default(""),
  IL_BUFFER_LAMPORTS_MIN: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(500_000_000),
  LP_KILL_SWITCH: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  LP_DRY_RUN: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  LP_DRY_RUN_YIELD_LAMPORTS: z.coerce.number().int().nonnegative().default(0),
  LP_SWAP_SLIPPAGE_BPS: z.coerce.number().int().nonnegative().default(50),
  LP_JUPITER_RETRY_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  LP_JUPITER_RETRY_BASE_DELAY_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(500),
  LP_JUPITER_RETRY_MAX_DELAY_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(5_000),
  LP_JUPITER_RETRY_JITTER_PCT: z.coerce.number().min(0).max(1).default(0.2),
  LP_JUPITER_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  LP_SWAP_SEND_RETRY_ATTEMPTS: z.coerce.number().int().min(1).default(2),
  LP_MAX_DEPLOY_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  LP_MAX_EXIT_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  LP_EXIT_HOURS_BEFORE_CLOSE: z.coerce.number().nonnegative().default(12),
  LP_STRATEGY_TYPE: z.string().default("Spot"),
  LP_BIN_RANGE: z.coerce.number().int().positive().default(10),
  LP_DEPLOY_SLIPPAGE_PCT: z.coerce.number().nonnegative().default(1),
  LP_SOL_USDC_SPLIT_BPS: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(5_000),
  FISHING_DAILY_SEED_HEX: z
    .string()
    .regex(
      /^[0-9a-f]{64}$/i,
      "FISHING_DAILY_SEED_HEX must be 64 hex chars (32 bytes)",
    )
    .optional(),
  FISHING_OFFCHAIN: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
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

if (env.ADMIN_SERVICE_TOKEN) {
  if (!env.ADMIN_SERVICE_WALLET) {
    throw new Error(
      "ADMIN_SERVICE_WALLET must be set when ADMIN_SERVICE_TOKEN is configured",
    );
  }
  if (!adminWalletSet.has(env.ADMIN_SERVICE_WALLET)) {
    throw new Error("ADMIN_SERVICE_WALLET must be one of ADMIN_WALLETS");
  }
}

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

export function isAllowedOrigin(
  origin: string | string[] | undefined,
): boolean {
  if (!origin) return true;
  const o = Array.isArray(origin) ? origin[0] : origin;
  if (!o) return true;
  return allowedOriginSet.has(o);
}

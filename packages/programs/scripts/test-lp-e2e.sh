#!/usr/bin/env bash
# End-to-end test for Jupiter swap + Meteora DLMM LP against a surfpool
# mainnet fork.
#
# What this does:
#   1. Starts surfpool in mainnet-clone mode (NOT --offline) so any account
#      a transaction references is lazy-cloned from a real RPC.
#   2. Funds the LP_MANAGER wallet on the fork with SOL via the standard
#      airdrop flow (surfpool honors getAirdrop in fork mode).
#   3. Exports SOLANA_RPC_URL=fork + the rest of the env the e2e expects.
#   4. Runs the Vitest spec at packages/server/tests/e2e/lpSwap.e2e.test.ts
#      with RUN_LP_E2E=1.
#   5. Always tears surfpool down on exit.
#
# Required env BEFORE running this script:
#   JUPITER_API_KEY              — Jupiter Portal key (https://portal.jup.ag)
#   MAINNET_RPC_URL              — A real mainnet RPC (Helius works), used as
#                                   surfpool's clone source. Higher quality →
#                                   fewer flaky test failures.
#   LP_MANAGER_KEYPAIR           — JSON array form for a funded keypair. The
#                                   wallet doesn't need real funds — we set
#                                   its fork balance via airdrop.
#   METEORA_POOL_ADDRESS         — Real SOL/USDC DLMM pool address (mainnet).
#   ANCHOR_WALLET (optional)     — Defaults to ~/.config/solana/hooked.json
#
# Costs: each test run makes ≤ 100 mainnet RPC calls (lazy clones) +
# 2-3 Jupiter /build calls. Free Helius tier handles this comfortably.
set -euo pipefail

cd "$(dirname "$0")/.."

# ---- preflight ----
: "${JUPITER_API_KEY:?Set JUPITER_API_KEY before running (https://portal.jup.ag)}"
: "${MAINNET_RPC_URL:?Set MAINNET_RPC_URL to a real mainnet RPC (Helius recommended)}"
: "${LP_MANAGER_KEYPAIR:?Set LP_MANAGER_KEYPAIR (JSON array form)}"
: "${METEORA_POOL_ADDRESS:?Set METEORA_POOL_ADDRESS to the real SOL/USDC pool}"

WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/hooked.json}"
RPC_URL="http://127.0.0.1:8899"
LOG_DIR=".surfpool/logs"
PID_FILE=".surfpool/lp-e2e.pid"
USDC_MINT="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

mkdir -p "$LOG_DIR" "$(dirname "$PID_FILE")"

cleanup() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
}
trap cleanup EXIT INT TERM

if [[ ! -f "$WALLET" ]]; then
  echo "❌ Wallet not found at $WALLET" >&2
  exit 1
fi

export PATH="$HOME/.local/bin:$PATH"
if ! command -v surfpool >/dev/null 2>&1; then
  echo "❌ surfpool not installed. Run: curl -sL https://run.surfpool.run/ | bash" >&2
  exit 1
fi

# ---- start surfpool (mainnet-clone mode) ----
# Critical difference from test-surfpool.sh: NO --offline flag, and we
# point --rpc-url at a real mainnet RPC so surfpool can lazy-clone any
# account a tx references. Without this, Jupiter routes through Raydium /
# Orca / Meteora etc. would fail with "AccountNotFound".
#
# -b transaction: same rationale as test-surfpool.sh — advances a slot per
# tx so back-to-back txs don't collide on a single blockhash.
echo "▶ Starting surfpool (mainnet-clone mode, RPC source: $MAINNET_RPC_URL)…"
NO_DNA=1 surfpool start \
  --ci \
  --no-deploy \
  --rpc-url "$MAINNET_RPC_URL" \
  -b transaction \
  --airdrop-keypair-path "$WALLET" \
  > "$LOG_DIR/lp-e2e.out" 2> "$LOG_DIR/lp-e2e.err" &
echo $! > "$PID_FILE"

# Wait for RPC readiness.
for i in $(seq 1 30); do
  if curl -fsS -X POST -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' \
      "$RPC_URL" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
  if [[ $i -eq 30 ]]; then
    echo "❌ surfpool did not become ready within 15s" >&2
    tail -40 "$LOG_DIR/lp-e2e.err" >&2 || true
    exit 1
  fi
done
echo "✓ surfpool ready at $RPC_URL"

# ---- fund LP_MANAGER wallet on the fork ----
# Derive the LP_MANAGER pubkey from the keypair env var, then airdrop SOL.
# We accept both forms the server's parseKeypair supports:
#   * JSON byte array  →  [12,34,...]
#   * base58 secret key  →  any 88-char-ish string
# bs58 is already a server dependency (via @solana/web3.js), so resolve it
# from packages/server/node_modules.
LP_MANAGER_PUBKEY=$(cd ../server && node -e "
  const { Keypair } = require('@solana/web3.js');
  const bs58 = require('bs58').default;
  const raw = process.env.LP_MANAGER_KEYPAIR.trim();
  let kp;
  if (raw.startsWith('[')) {
    kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } else {
    const bytes = bs58.decode(raw);
    if (bytes.length !== 64) throw new Error('base58 secret key must decode to 64 bytes, got ' + bytes.length);
    kp = Keypair.fromSecretKey(bytes);
  }
  console.log(kp.publicKey.toBase58());
")
echo "▶ LP_MANAGER pubkey: $LP_MANAGER_PUBKEY"

# Airdrop 1 SOL — enough for fees + the 0.05 SOL swap test + 0.1 SOL LP
# deploy + room to grow if you increase test amounts later.
echo "▶ Airdropping 1 SOL to LP_MANAGER on the fork…"
solana airdrop 1 "$LP_MANAGER_PUBKEY" --url "$RPC_URL" >/dev/null
# Re-check; surfpool sometimes needs a slot tick.
sleep 1
BALANCE=$(solana balance "$LP_MANAGER_PUBKEY" --url "$RPC_URL" | awk '{print $1}')
echo "✓ LP_MANAGER balance on fork: $BALANCE SOL"

# ---- run the e2e vitest spec ----
# RUN_LP_E2E=1 flips the describe.skip → describe.
# SOLANA_RPC_URL points the service code at the fork.
# JUPITER_API_URL is the v2 base; default matches the env.ts default.
echo "▶ Running e2e vitest spec…"
cd ../server
# Whitelist of fork-safe DEXes. Constrained to Raydium AMM v4 only because:
#   - It's a classic constant-product AMM (no oracle dependency, no spread
#     guard that depends on time-consistent state).
#   - It does NOT use Address Lookup Tables, which surfpool's lazy clone
#     frequently fails to resolve (producing tx > 1232 byte limit).
# Whirlpool / Meteora DLMM / Orca routes all need LUTs in practice and so
# break on a fork; if you need them, run mainnet-dust mode instead (set
# SOLANA_RPC_URL to mainnet directly and leave JUPITER_DEXES empty).
DEXES_DEFAULT="Raydium"

RUN_LP_E2E=1 \
SOLANA_RPC_URL="$RPC_URL" \
JUPITER_API_URL="${JUPITER_API_URL:-https://api.jup.ag/swap/v2}" \
JUPITER_API_KEY="$JUPITER_API_KEY" \
JUPITER_DEXES="${JUPITER_DEXES-$DEXES_DEFAULT}" \
JUPITER_EXCLUDE_DEXES="${JUPITER_EXCLUDE_DEXES:-}" \
LP_MANAGER_KEYPAIR="$LP_MANAGER_KEYPAIR" \
METEORA_POOL_ADDRESS="$METEORA_POOL_ADDRESS" \
USDC_MINT_ADDRESS="$USDC_MINT" \
FEATURES_LP_ENABLED=true \
LP_DRY_RUN=false \
LP_KILL_SWITCH=false \
  npx vitest run tests/e2e/lpSwap.e2e.test.ts --reporter=verbose

echo "✓ E2E suite passed"

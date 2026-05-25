#!/usr/bin/env bash
# Mainnet-dust mode of the LP + swap e2e — bypasses surfpool entirely.
#
# Why this exists: surfpool's clone-on-demand model can't keep AMM state +
# oracles + LUTs all time-consistent. Jupiter's whole job is finding the
# best route, which often needs oracle-priced AMMs and LUT-heavy CLMM
# routes — both fork-hostile. Running against real mainnet sidesteps
# every one of those failure modes.
#
# Costs per run: ~0.05 SOL × 2 swap roundtrips + 0.1 SOL × 1 LP deploy
# + fees. Net out: a few cents in slippage, a few cents in fees. Total
# under $0.20. Most reliable e2e signal available.
#
# Required env BEFORE running:
#   JUPITER_API_KEY              — Jupiter Portal key
#   SOLANA_RPC_URL               — Real mainnet RPC (Helius recommended)
#   LP_MANAGER_KEYPAIR           — Funded keypair (>= 0.2 SOL real funds)
#   METEORA_POOL_ADDRESS         — Real SOL/USDC DLMM pool
#
# Run:
#   pnpm e2e:lp:mainnet
set -euo pipefail

cd "$(dirname "$0")/.."

: "${JUPITER_API_KEY:?Set JUPITER_API_KEY (https://portal.jup.ag)}"
: "${SOLANA_RPC_URL:?Set SOLANA_RPC_URL to a real mainnet RPC}"
: "${LP_MANAGER_KEYPAIR:?Set LP_MANAGER_KEYPAIR (funded, JSON array or base58)}"
: "${METEORA_POOL_ADDRESS:?Set METEORA_POOL_ADDRESS to the real SOL/USDC pool}"

USDC_MINT="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

# Confirmation gate — this WILL spend real SOL.
echo
echo "⚠  This will execute REAL transactions on Solana mainnet."
echo "    Expected cost: < \$0.20 per run (slippage + fees)."
echo "    LP_MANAGER wallet must hold >= 0.2 SOL."
echo
read -r -p "Continue? [y/N] " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

# Derive + show the LP_MANAGER pubkey + balance so the user can verify.
cd ../server
LP_MANAGER_PUBKEY=$(node -e "
  const { Keypair } = require('@solana/web3.js');
  const bs58 = require('bs58').default;
  const raw = process.env.LP_MANAGER_KEYPAIR.trim();
  let kp;
  if (raw.startsWith('[')) {
    kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } else {
    kp = Keypair.fromSecretKey(bs58.decode(raw));
  }
  console.log(kp.publicKey.toBase58());
")
echo "▶ LP_MANAGER pubkey: $LP_MANAGER_PUBKEY"
echo "▶ Mainnet RPC: $SOLANA_RPC_URL"

# Run e2e against mainnet. Critically:
#   - No JUPITER_DEXES whitelist → Jupiter picks the best route.
#   - No JUPITER_EXCLUDE_DEXES → real routing.
#   - Real RPC = real programs, real oracles, real LUTs — all consistent.
echo "▶ Running e2e vitest spec against mainnet…"
RUN_LP_E2E=1 \
SOLANA_RPC_URL="$SOLANA_RPC_URL" \
JUPITER_API_URL="${JUPITER_API_URL:-https://api.jup.ag/swap/v2}" \
JUPITER_API_KEY="$JUPITER_API_KEY" \
JUPITER_DEXES="" \
JUPITER_EXCLUDE_DEXES="" \
LP_MANAGER_KEYPAIR="$LP_MANAGER_KEYPAIR" \
METEORA_POOL_ADDRESS="$METEORA_POOL_ADDRESS" \
USDC_MINT_ADDRESS="$USDC_MINT" \
FEATURES_LP_ENABLED=true \
LP_DRY_RUN=false \
LP_KILL_SWITCH=false \
  npx vitest run tests/e2e/lpSwap.e2e.test.ts --reporter=verbose

echo "✓ Mainnet e2e suite passed"

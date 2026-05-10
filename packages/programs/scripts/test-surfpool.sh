#!/usr/bin/env bash
# Runs the Anchor test suite against a fresh surfpool surfnet.
#
# Why surfpool, not solana-test-validator: sub-second startup, no flaky devnet
# faucet, and `surfnet_*` cheatcodes available for future time-warp tests.
#
# Why not `anchor test`: anchor test would try to spawn solana-test-validator
# itself. We want surfpool. So we drive it manually:
#   1. start surfpool (CI mode, no TUI, airdrop to the hooked test wallet)
#   2. wait for RPC to come up
#   3. anchor build + deploy explicitly
#   4. run the mocha spec
#   5. always tear surfpool down on exit
set -euo pipefail

cd "$(dirname "$0")/.."

WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/hooked.json}"
RPC_URL="http://127.0.0.1:8899"
LOG_DIR=".surfpool/logs"
PID_FILE=".surfpool/test.pid"

mkdir -p "$LOG_DIR" "$(dirname "$PID_FILE")"

cleanup() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      # Give it a moment, then force.
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

# Make sure surfpool is on PATH (default install dir).
export PATH="$HOME/.local/bin:$PATH"
if ! command -v surfpool >/dev/null 2>&1; then
  echo "❌ surfpool not installed. Run: curl -sL https://run.surfpool.run/ | bash" >&2
  exit 1
fi

echo "▶ Starting surfpool (offline, ci mode)…"
# -b transaction: advance a slot only when a tx arrives. Two identical-shape
# back-to-back .rpc() calls can otherwise land in the same 400ms block and
# collapse to the same signature (surfpool rejects the second as "already
# processed"). Transaction-driven slots guarantee fresh blockhashes per tx
# without the slot-time pressure that breaks the program loader.
NO_DNA=1 surfpool start \
  --ci \
  --no-deploy \
  --offline \
  -b transaction \
  --airdrop-keypair-path "$WALLET" \
  > "$LOG_DIR/surfpool.out" 2> "$LOG_DIR/surfpool.err" &
echo $! > "$PID_FILE"

# Wait up to 15s for RPC to respond.
for i in $(seq 1 30); do
  if curl -fsS -X POST -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' \
      "$RPC_URL" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
  if [[ $i -eq 30 ]]; then
    echo "❌ surfpool did not become ready within 15s" >&2
    echo "--- surfpool stderr (tail) ---" >&2
    tail -40 "$LOG_DIR/surfpool.err" >&2 || true
    exit 1
  fi
done
echo "✓ surfpool ready at $RPC_URL"

# Build (anchor build is idempotent; cheap if nothing changed).
echo "▶ anchor build…"
NO_DNA=1 anchor build

# Deploy to surfpool.
echo "▶ Deploying program to surfpool…"
solana program deploy \
  --url "$RPC_URL" \
  --keypair "$WALLET" \
  --program-id target/deploy/hooked_rooms-keypair.json \
  target/deploy/hooked_rooms.so

# Run mocha against surfpool. ANCHOR_PROVIDER_URL/ANCHOR_WALLET tell the
# anchor TS client where to point.
#
# Node 22.6+ ships an experimental native TypeScript loader that intercepts
# .ts files BEFORE ts-mocha can register its CJS hooks. The native loader
# runs them as ESM, which fails on named imports from CommonJS deps
# (@coral-xyz/anchor, @solana/web3.js). Disable it on 22+ via NODE_OPTIONS;
# Node 20 rejects the flag entirely, so gate on the major version.
NODE_MAJOR=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
if (( NODE_MAJOR >= 22 )); then
  export NODE_OPTIONS="${NODE_OPTIONS:-} --no-experimental-strip-types"
fi

echo "▶ Running test suite…"
ANCHOR_PROVIDER_URL="$RPC_URL" \
ANCHOR_WALLET="$WALLET" \
NO_DNA=1 \
pnpm ts-mocha -p ./tsconfig.json -t 1000000 tests/room.ts

echo "✓ All tests passed"

# LP & Swap E2E Testing

Two layers of integration coverage for the Jupiter swap + Meteora DLMM LP
pipeline. Pick the right tool for the question you're answering.

| Layer | Lives in | Runs in CI? | Catches |
|---|---|---|---|
| Unit | `tests/lpJupiterSwap.test.ts`, `tests/lpManager.test.ts` | Yes | Retry policy, error classification, dry-run paths. All fetch + Connection mocked. |
| **Cassette** | `tests/integration/jupiterSwapAssembly.test.ts` | Yes (against fixture) | v2 `/build` response-shape drift, instruction decoding, LUT-aware `compileToV0Message`, VersionedTransaction round-trip. |
| **Surfpool E2E** | `tests/e2e/lpSwap.e2e.test.ts` + `packages/programs/scripts/test-lp-e2e.sh` | No (opt-in) | Real Jupiter routes landing on a mainnet fork; real Meteora DLMM deploy/exit; balance assertions. |

---

## Cassette test — runs in CI today

Replays a recorded Jupiter v2 `/build` response through the assembly path.
Cheap, deterministic, catches any response-shape change on the next CI run.

### Regenerate the fixture

The checked-in fixture at `tests/fixtures/jupiter-build-sol-to-usdc.json`
starts as a hand-crafted placeholder so CI passes on a fresh clone.
**Regenerate it with a real API response** whenever:

- Jupiter announces v2 response-shape changes
- The cassette test starts failing in a way that suggests upstream drift
- You bump the Jupiter SDK version

```bash
cd packages/server
JUPITER_API_KEY=your-portal-key pnpm cassette:capture
```

Commit the regenerated `tests/fixtures/jupiter-build-sol-to-usdc.json`.
The `_meta` block in the fixture records when and how it was captured.

---

## Mainnet-dust E2E — recommended for serious validation

Runs the real swap and LP code paths against actual Solana mainnet using
a funded throwaway wallet. Costs under $0.20 per run; no fork-state
fragility.

### Prereqs

1. **A funded LP_MANAGER wallet** with ≥ 0.2 SOL on mainnet.
2. **Real mainnet RPC URL** in `SOLANA_RPC_URL` (Helius works).
3. **Jupiter API key** in `JUPITER_API_KEY`.
4. **Real Meteora SOL/USDC pool address** in `METEORA_POOL_ADDRESS`.

### Run

```bash
pnpm e2e:lp:mainnet
```

You'll get a confirmation prompt before any tx fires. Each run executes
2 small swaps + 1 LP deploy/exit cycle. Real signal end-to-end.

---

## Surfpool E2E — best-effort, opt-in

Runs the **real** swap and LP code paths against a mainnet fork. Hits the
real Jupiter API; the resulting transactions land on a local surfpool RPC
that lazy-clones mainnet accounts on demand.

**Caveat:** surfpool's clone-on-demand can't keep AMM state, oracles, and
LUTs all time-consistent. In practice this means only Raydium AMM v4
routes work reliably; everything else (Whirlpool, Lifinity, oracle-priced
AMMs, anything LUT-heavy) tends to fail. If you need broader coverage,
use the mainnet-dust mode above.

### One-time prerequisites

1. **surfpool** installed:
   ```bash
   curl -sL https://run.surfpool.run/ | bash
   ```
2. **Anchor wallet** at `~/.config/solana/hooked.json` (or override via
   `ANCHOR_WALLET`).
3. **A mainnet RPC** that supports `getAccountInfo` and `getMultipleAccounts`
   with reasonable rate limits. Helius free tier is sufficient.
4. **A Jupiter Portal API key** from https://portal.jup.ag.

### Per-run env

The script refuses to start without these:

| Var | What it is |
|---|---|
| `JUPITER_API_KEY` | Portal key. v2 `/build` requires it. |
| `MAINNET_RPC_URL` | Source RPC surfpool clones from. Helius URL works. |
| `LP_MANAGER_KEYPAIR` | JSON array form (`[12,34,...]`). The wallet doesn't need real funds — we airdrop on the fork. |
| `METEORA_POOL_ADDRESS` | Real SOL/USDC DLMM pool. Default in env.ts is a placeholder; the deploy path refuses it. |

### Run it

```bash
cd packages/server
pnpm e2e:lp
```

That's a wrapper around `packages/programs/scripts/test-lp-e2e.sh`, which:

1. Starts surfpool with `--rpc-url $MAINNET_RPC_URL` (lazy-clone mode).
2. Airdrops 1 SOL to the LP_MANAGER wallet on the fork.
3. Exports the env the e2e test expects.
4. Runs Vitest with `RUN_LP_E2E=1`.
5. Tears the fork down on exit (trap-handled).

### What the e2e validates

- **SOL → USDC swap** — sends real `/build` instructions through surfpool,
  asserts confirmed signature, balance delta, slippage within
  `LP_SWAP_SLIPPAGE_BPS`.
- **USDC → SOL swap** — round-trip with the USDC the first test left.
- **Meteora DLMM deploy → exit** — opens a position with 0.1 SOL split per
  `LP_SOL_USDC_SPLIT_BPS`, then exits and verifies returned SOL is within
  ±2% of deployed (no yield expected over one test).

### Cost per run

- ~50–100 mainnet RPC calls (Helius lazy clones).
- 3–4 Jupiter `/build` calls (well under any per-second cap).
- Zero on-chain mainnet activity — all txs land on the fork.

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| `LP_MANAGER wallet has only 0 SOL on the fork` | Airdrop didn't land before vitest started. The script sleeps 1s but slow forks may need more; re-run. |
| `AccountNotFound` mid-swap | Surfpool's clone source is rate-limited. Use a paid Helius key as `MAINNET_RPC_URL`. |
| DLMM "invalid pool" | `METEORA_POOL_ADDRESS` is the placeholder. Set the real mainnet SOL/USDC pool. |
| `503` from Jupiter | Transient. The service-layer retry kicks in; if persistent, check `status.jup.ag`. |
| Fixture-cassette test fails after upstream Jupiter change | Regenerate via `pnpm cassette:capture` and commit. |
| Some AMM CPI fails with `invalid instruction data` or `Spread guard triggered` | Oracle-priced AMM seeing stale-cloned state. Don't try to exclude them one by one — use the `JUPITER_DEXES` whitelist instead. The script defaults to `Raydium,Whirlpool,Meteora,Orca` (all fork-safe). |
| `ERR_UNSUPPORTED_DIR_IMPORT` from `@meteora-ag/dlmm` | Already worked around in `vitest.config.ts` via `server.deps.inline`. If it reappears after a SDK bump, add the new internal package path to the inline list. |
| `VersionedTransaction too large: NNNN bytes (max: 1232)` | Jupiter routed through a CLMM that needs LUTs, and surfpool couldn't resolve them. The assembly path now throws a clear `could not resolve N address lookup table(s)` error before this point. Constrain `JUPITER_DEXES=Raydium` or switch to mainnet-dust mode. |
| `could not resolve N address lookup table(s)` | See above — LUT clone failure on the fork. Surfpool can't be made to lazy-clone every LUT Jupiter references; use `JUPITER_DEXES=Raydium` (the script default) or run `pnpm e2e:lp:mainnet`. |
| DLMM round-trip drift >> 2% | Expected on a fork — cloned bin arrays don't match mainnet depth, so DLMM math diverges. The fork test now uses a loose 20% net-cost bound. For real slippage assertions, run `pnpm e2e:lp:mainnet`. |

## Known limitations

**Surfpool + Jupiter aggregator routing is best-effort.** Surfpool clones
accounts on demand from your `MAINNET_RPC_URL`, but Jupiter routes through
many AMMs, and some of them rely on programdata state, runtime feature
gates, or PDA layouts that don't always survive a fork cleanly.

The two failure modes seen in practice:

- `invalid instruction data` — programdata version mismatch or PDA layout
  drift between mainnet and the clone.
- `custom program error: 0x1a0a` + `Spread guard triggered` — the AMM
  cross-checked its pool state against an oracle (Pyth/Switchboard) and
  the two are inconsistent in time on the fork. Every oracle-priced AMM
  (Lifinity, TaurusFi, RipFi, and friends) will fail this way.

There's no point excluding them one at a time — the next route will pick
another oracle-priced AMM. The fix is one of:

1. **Whitelist fork-safe AMMs via `JUPITER_DEXES`.** Constant-product
   (Raydium, Orca) and pool-state-only CLMMs (Whirlpool, Meteora DLMM)
   don't read oracles for swap pricing, so they work on a clone. The
   script defaults to `Raydium,Whirlpool,Meteora,Orca`. Override or set
   to empty as needed.
2. **Run against mainnet with dust amounts** instead. Open a throwaway
   wallet with ~0.05 SOL + ~5 USDC, point `SOLANA_RPC_URL` at mainnet
   directly, and set `JUPITER_DEXES=` empty so Jupiter picks any route.
   Total cost per run: under $0.10 in fees + slippage. Most reliable;
   tests the real programs against the real network.

The **cassette test** (`pnpm test` after `pnpm cassette:capture`) has none
of these problems — it's a deterministic replay of one real `/build`
response and runs in CI. Reserve the surfpool e2e for spot-checks; rely on
the cassette for shape-drift detection.

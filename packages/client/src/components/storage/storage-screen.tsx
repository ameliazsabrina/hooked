import { useMemo, useState } from "react";
import { FishRarity, RARITY_COLORS } from "@hooked/shared";
import type { CaughtFish } from "~/hooks/use-fishing-ws";
import { useSettings } from "~/utils/settings";
import { playSfx } from "~/utils/audio";
import { vibrate } from "~/utils/haptics";
import { formatRelative } from "~/utils/relative-time";
import { AnimatedCounter } from "./animated-counter";
import "./storage-screen.css";

const RARITY_ORDER: FishRarity[] = [
  FishRarity.Apex,
  FishRarity.Legendary,
  FishRarity.Monster,
  FishRarity.Rare,
  FishRarity.Basic,
];

const RARITY_LABELS: Record<FishRarity, string> = {
  [FishRarity.Basic]: "Basic",
  [FishRarity.Rare]: "Rare",
  [FishRarity.Monster]: "Monster",
  [FishRarity.Legendary]: "Legendary",
  [FishRarity.Apex]: "Apex",
};

interface BulkSellResult {
  totalPrice: number;
  soldIds: string[];
  shellBalance: number;
}

interface StorageScreenProps {
  catches: CaughtFish[];
  shellBalance: number;
  onSellFishBulk: (ids: string[]) => Promise<BulkSellResult>;
  onClose: () => void;
}

type ConfirmIntent =
  | {
      kind: "all";
      ids: string[];
      breakdown: Partial<Record<FishRarity, number>>;
      total: number;
    }
  | {
      kind: "tier";
      rarity: FishRarity;
      ids: string[];
      total: number;
    }
  | {
      kind: "selected";
      ids: string[];
      total: number;
      includesApex: boolean;
    };

const BATCH = 100;

function sumValue(items: CaughtFish[]): number {
  return items.reduce((acc, c) => acc + (c.shellValue ?? 0), 0);
}

function isPending(id: string): boolean {
  return id.startsWith("pending:");
}

export function StorageScreen({
  catches,
  shellBalance,
  onSellFishBulk,
  onClose,
}: StorageScreenProps) {
  const [settings] = useSettings();
  const [groupByRarity, setGroupByRarity] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<ConfirmIntent | null>(null);
  const [selling, setSelling] = useState(false);
  const [result, setResult] = useState<{ count: number; total: number } | null>(
    null,
  );

  const sortedCatches = useMemo(() => {
    const copy = [...catches];
    copy.sort(
      (a, b) =>
        new Date(b.caughtAt).getTime() - new Date(a.caughtAt).getTime(),
    );
    return copy;
  }, [catches]);

  const tierGroups = useMemo(() => {
    const map = new Map<FishRarity, CaughtFish[]>();
    for (const r of RARITY_ORDER) map.set(r, []);
    for (const c of sortedCatches) {
      map.get(c.rarity)?.push(c);
    }
    return map;
  }, [sortedCatches]);

  const tierCounts = useMemo(() => {
    const counts: Partial<Record<FishRarity, { count: number; total: number }>> =
      {};
    for (const r of RARITY_ORDER) {
      const items = tierGroups.get(r) ?? [];
      if (items.length > 0) {
        counts[r] = { count: items.length, total: sumValue(items) };
      }
    }
    return counts;
  }, [tierGroups]);

  const sellableForAll = useMemo(
    () =>
      sortedCatches.filter(
        (c) => c.rarity !== FishRarity.Apex && !isPending(c.id),
      ),
    [sortedCatches],
  );

  const exitSelect = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const toggleSelect = (id: string) => {
    if (isPending(id)) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => {
    const next = new Set<string>();
    for (const c of sortedCatches) if (!isPending(c.id)) next.add(c.id);
    setSelectedIds(next);
  };

  const selectedCatches = useMemo(
    () => sortedCatches.filter((c) => selectedIds.has(c.id)),
    [sortedCatches, selectedIds],
  );

  const openSellAll = () => {
    if (sellableForAll.length === 0) return;
    const breakdown: Partial<Record<FishRarity, number>> = {};
    for (const c of sellableForAll) {
      breakdown[c.rarity] = (breakdown[c.rarity] ?? 0) + 1;
    }
    setConfirm({
      kind: "all",
      ids: sellableForAll.map((c) => c.id),
      breakdown,
      total: sumValue(sellableForAll),
    });
  };

  const openSellTier = (rarity: FishRarity) => {
    const items = (tierGroups.get(rarity) ?? []).filter(
      (c) => !isPending(c.id),
    );
    if (items.length === 0) return;
    setConfirm({
      kind: "tier",
      rarity,
      ids: items.map((c) => c.id),
      total: sumValue(items),
    });
  };

  const openSellSelected = () => {
    if (selectedCatches.length === 0) return;
    const includesApex = selectedCatches.some(
      (c) => c.rarity === FishRarity.Apex,
    );
    setConfirm({
      kind: "selected",
      ids: selectedCatches.map((c) => c.id),
      total: sumValue(selectedCatches),
      includesApex,
    });
  };

  const dismissConfirm = () => {
    if (selling) return;
    setConfirm(null);
  };

  const isDestructive = (intent: ConfirmIntent): boolean => {
    if (intent.kind === "all") return true;
    if (intent.kind === "tier" && intent.rarity === FishRarity.Apex) {
      return settings.confirmApexSell;
    }
    if (intent.kind === "selected" && intent.includesApex) {
      return settings.confirmApexSell;
    }
    return false;
  };

  const sellWithBatching = async (ids: string[]): Promise<BulkSellResult> => {
    let totalPrice = 0;
    let lastShellBalance = shellBalance;
    const soldIds: string[] = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const r = await onSellFishBulk(batch);
      totalPrice += r.totalPrice;
      soldIds.push(...r.soldIds);
      lastShellBalance = r.shellBalance;
    }
    return { totalPrice, soldIds, shellBalance: lastShellBalance };
  };

  const executeSell = async () => {
    if (!confirm || selling) return;
    setSelling(true);
    try {
      const r = await sellWithBatching(confirm.ids);
      playSfx("buySell");
      vibrate(50);
      setResult({ count: r.soldIds.length, total: r.totalPrice });
      window.setTimeout(() => {
        setResult(null);
        setConfirm(null);
        setSelling(false);
        if (selectMode) exitSelect();
      }, 1500);
    } catch (err) {
      setSelling(false);
      setResult({
        count: 0,
        total: 0,
      });
      console.error("[storage] sell failed", err);
      window.setTimeout(() => setResult(null), 2000);
    }
  };

  const renderCard = (c: CaughtFish) => {
    const pending = isPending(c.id);
    const selected = selectedIds.has(c.id);
    const apex = c.rarity === FishRarity.Apex;
    return (
      <button
        key={c.id}
        type="button"
        className={`storage-card${selected ? " storage-card-selected" : ""}${
          apex ? " storage-card-apex" : ""
        }${pending ? " storage-card-pending" : ""}`}
        onClick={() => {
          if (selectMode) toggleSelect(c.id);
        }}
        disabled={selectMode && pending}
        aria-pressed={selectMode ? selected : undefined}
      >
        {selectMode && (
          <span
            className={`storage-card-check${
              selected ? " storage-card-check-on" : ""
            }`}
            aria-hidden
          >
            {selected ? "✓" : ""}
          </span>
        )}
        <img
          src={`/assets/Fish/${c.asset}`}
          alt={c.species}
          className="storage-card-art"
        />
        <div className="storage-card-name">{c.species}</div>
        <div className="storage-card-meta">
          <span
            className="storage-card-rarity"
            style={{ color: RARITY_COLORS[c.rarity] }}
          >
            {RARITY_LABELS[c.rarity]}
          </span>
          <span className="storage-card-weight">{c.weightKg.toFixed(1)} kg</span>
        </div>
        <div className="storage-card-footer">
          <span className="storage-card-value">
            <img src="/assets/ui/shell.png" alt="" />
            {(c.shellValue ?? 0).toLocaleString()}
          </span>
          <span className="storage-card-time">{formatRelative(c.caughtAt)}</span>
        </div>
        {pending && <span className="storage-card-syncing">syncing…</span>}
      </button>
    );
  };

  const isEmpty = catches.length === 0;
  const selectedTotal = sumValue(selectedCatches);

  return (
    <div className="storage-overlay" onClick={onClose}>
      <div
        className="storage-frame"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Storage"
      >
        <div className="storage-header">
          <div className="storage-title">Storage</div>
          <div className="storage-balance">
            <img src="/assets/ui/shell.png" alt="Shell" />
            <AnimatedCounter
              value={shellBalance}
              className="storage-balance-num"
            />
          </div>
          <button
            type="button"
            className="storage-close"
            onClick={onClose}
            aria-label="Close storage"
          >
            ✕
          </button>
        </div>

        {!isEmpty && !selectMode && (
          <div className="storage-toolbar">
            <button
              type="button"
              className="storage-btn storage-btn-primary storage-btn-destructive"
              onClick={openSellAll}
              disabled={sellableForAll.length === 0}
            >
              Sell All Fish ({sellableForAll.length}) · {sumValue(sellableForAll)}
            </button>
            <div className="storage-tier-row">
              {RARITY_ORDER.slice()
                .reverse()
                .map((r) => {
                  const c = tierCounts[r];
                  if (!c) return null;
                  return (
                    <button
                      key={r}
                      type="button"
                      className="storage-btn storage-btn-tier"
                      style={{ borderColor: RARITY_COLORS[r] }}
                      onClick={() => openSellTier(r)}
                    >
                      <span
                        className="storage-tier-label"
                        style={{ color: RARITY_COLORS[r] }}
                      >
                        Sell All {RARITY_LABELS[r]} ({c.count})
                      </span>
                      <span className="storage-tier-yield">
                        Earn {c.total.toLocaleString()}
                      </span>
                    </button>
                  );
                })}
            </div>
            <div className="storage-toolbar-end">
              <label className="storage-group-toggle">
                <input
                  type="checkbox"
                  checked={groupByRarity}
                  onChange={(e) => setGroupByRarity(e.target.checked)}
                />
                Group by rarity
              </label>
              <button
                type="button"
                className="storage-btn storage-btn-ghost"
                onClick={() => setSelectMode(true)}
              >
                Select Fish
              </button>
            </div>
          </div>
        )}

        {!isEmpty && selectMode && (
          <div className="storage-toolbar storage-toolbar-select">
            <div className="storage-select-actions">
              <button
                type="button"
                className="storage-btn storage-btn-ghost"
                onClick={selectAllVisible}
              >
                Select All
              </button>
              <button
                type="button"
                className="storage-btn storage-btn-ghost"
                onClick={() => setSelectedIds(new Set())}
                disabled={selectedIds.size === 0}
              >
                Deselect All
              </button>
              <button
                type="button"
                className="storage-btn storage-btn-ghost"
                onClick={exitSelect}
              >
                Cancel
              </button>
            </div>
            <div className="storage-select-summary">
              <span>{selectedIds.size} selected</span>
              <span className="storage-select-value">
                <img src="/assets/ui/shell.png" alt="" />
                {selectedTotal.toLocaleString()}
              </span>
            </div>
            <button
              type="button"
              className="storage-btn storage-btn-primary"
              onClick={openSellSelected}
              disabled={selectedIds.size === 0}
            >
              Sell Selected
            </button>
          </div>
        )}

        <div className="storage-body">
          {isEmpty ? (
            <div className="storage-empty">
              <img
                src="/assets/Fish/FishCatfish.png"
                alt=""
                className="storage-empty-art"
              />
              <div className="storage-empty-title">No fish in storage.</div>
              <div className="storage-empty-sub">
                Cast your line and start catching!
              </div>
              <button
                type="button"
                className="storage-btn storage-btn-primary"
                onClick={onClose}
              >
                Go fishing
              </button>
            </div>
          ) : groupByRarity ? (
            <div className="storage-groups">
              {RARITY_ORDER.map((r) => {
                const items = tierGroups.get(r) ?? [];
                if (items.length === 0) return null;
                return (
                  <section key={r} className="storage-group">
                    <header className="storage-group-header">
                      <span style={{ color: RARITY_COLORS[r] }}>
                        {RARITY_LABELS[r]}
                      </span>
                      <span className="storage-group-count">
                        {items.length} · {sumValue(items).toLocaleString()}
                      </span>
                    </header>
                    <div className="storage-grid">{items.map(renderCard)}</div>
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="storage-grid">{sortedCatches.map(renderCard)}</div>
          )}
        </div>

        {confirm && (
          <div className="sell-confirm-backdrop" onClick={dismissConfirm}>
            <div
              className={`sell-confirm-popup${
                isDestructive(confirm) ? " sell-confirm-popup-destructive" : ""
              }`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sell-confirm-title">
                {confirm.kind === "all" && "Sell All Fish?"}
                {confirm.kind === "tier" &&
                  `Sell All ${RARITY_LABELS[confirm.rarity]} Fish (${
                    confirm.ids.length
                  })?`}
                {confirm.kind === "selected" &&
                  `Sell ${confirm.ids.length} Selected Fish?`}
              </div>

              {confirm.kind === "all" && (
                <ul className="sell-confirm-breakdown">
                  {RARITY_ORDER.slice()
                    .reverse()
                    .map((r) => {
                      const n = confirm.breakdown[r] ?? 0;
                      if (n === 0) return null;
                      return (
                        <li key={r}>
                          <span style={{ color: RARITY_COLORS[r] }}>
                            {RARITY_LABELS[r]}
                          </span>
                          <span>×{n}</span>
                        </li>
                      );
                    })}
                  <li className="sell-confirm-breakdown-note">
                    Apex fish are excluded from Sell All.
                  </li>
                </ul>
              )}

              <div className="sell-confirm-value">
                You'll receive{" "}
                <img src="/assets/ui/shell.png" alt="" /> {confirm.total.toLocaleString()}
              </div>

              {isDestructive(confirm) &&
                (confirm.kind === "tier" &&
                confirm.rarity === FishRarity.Apex ? (
                  <div className="sell-confirm-warn">
                    These are your rarest catches. This cannot be undone.
                  </div>
                ) : confirm.kind === "selected" && confirm.includesApex ? (
                  <div className="sell-confirm-warn">
                    Selection includes Apex fish. This cannot be undone.
                  </div>
                ) : (
                  <div className="sell-confirm-warn">
                    This cannot be undone.
                  </div>
                ))}
              {!isDestructive(confirm) && (
                <div className="sell-confirm-warn-soft">
                  This cannot be undone.
                </div>
              )}

              {result ? (
                <div className="sell-confirm-result">
                  Sold {result.count} fish for {result.total.toLocaleString()} coins
                </div>
              ) : (
                <div className="sell-confirm-actions">
                  <button
                    type="button"
                    className="sell-confirm-btn sell-confirm-cancel"
                    onClick={dismissConfirm}
                    disabled={selling}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className={`sell-confirm-btn sell-confirm-yes${
                      isDestructive(confirm) ? " sell-confirm-yes-destructive" : ""
                    }`}
                    onClick={executeSell}
                    disabled={selling}
                  >
                    {selling ? "Selling…" : "Sell"}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

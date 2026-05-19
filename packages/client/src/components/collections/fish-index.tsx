import { useMemo, useState } from "react";
import {
  FISH_SPECIES,
  FishRarity,
  RARITY_COLORS,
  type FishSpecies,
} from "@hooked/shared";
import { playSfx } from "~/utils/audio";
import type { EventStatus } from "~/components/hud/event-alert";
import "./fish-index.css";

interface CatchEntry {
  id: string;
  species: string;
  rarity: FishRarity;
  asset: string;
  weightKg?: number;
  score?: number;
  shellValue: number;
}

interface ApexFishEntry {
  id: string;
  name: string;
  weightMinKg: number;
  weightMaxKg: number;
  assetUrl: string;
}

interface FishIndexProps {
  catches?: CatchEntry[];
  discoveredSpecies?: Set<string>;
  /** Apex fish the player has caught at any point (lifetime). */
  discoveredApexFish?: ApexFishEntry[];
  onSellFish?: (catchId: string, shellValue: number) => Promise<any>;
  onSellFishBulk?: (catchIds: string[]) => Promise<any>;
  onClose: () => void;
  eventStatus?: EventStatus | null;
}

interface SpeciesEntry {
  species: FishSpecies;
  catches: CatchEntry[];
  bestKg: number;
  latestCatch?: CatchEntry;
  totalShellValue: number;
}

const RARITY_ORDER: FishRarity[] = [
  FishRarity.Basic,
  FishRarity.Rare,
  FishRarity.Monster,
  FishRarity.Legendary,
  FishRarity.Apex,
];

const RARITY_LABELS: Record<FishRarity, string> = {
  [FishRarity.Basic]: "Basic",
  [FishRarity.Rare]: "Rare",
  [FishRarity.Monster]: "Monster",
  [FishRarity.Legendary]: "Legendary",
  [FishRarity.Apex]: "Apex",
};

type ConfirmState =
  | { kind: "one"; entry: SpeciesEntry }
  | { kind: "all"; entry: SpeciesEntry }
  | null;

export function FishIndex({
  catches = [],
  discoveredSpecies,
  discoveredApexFish = [],
  onSellFish,
  onSellFishBulk,
  onClose,
  eventStatus,
}: FishIndexProps) {
  const apexEventLive =
    !!eventStatus?.active &&
    eventStatus.endsAt > Math.floor(Date.now() / 1000);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [selling, setSelling] = useState(false);

  const entries = useMemo<Map<string, SpeciesEntry>>(() => {
    const map = new Map<string, SpeciesEntry>();
    for (const species of FISH_SPECIES) {
      // Apex slots are admin-managed and rendered via `apexSlots` below.
      if (species.rarity === FishRarity.Apex) continue;
      map.set(species.name, {
        species,
        catches: [],
        bestKg: 0,
        latestCatch: undefined,
        totalShellValue: 0,
      });
    }
    for (const c of catches) {
      const entry = map.get(c.species);
      if (!entry) continue;
      entry.catches.push(c);
      const w = c.weightKg ?? 0;
      if (w > entry.bestKg) entry.bestKg = w;
      entry.latestCatch = c;
      entry.totalShellValue += c.shellValue;
    }
    return map;
  }, [catches]);

  // Apex slots: active event pool ∪ player's lifetime catches, de-duped by id.
  const apexSlots = useMemo<ApexFishEntry[]>(() => {
    const byId = new Map<string, ApexFishEntry>();
    if (apexEventLive) {
      for (const f of eventStatus?.apexFishes ?? []) byId.set(f.id, f);
    }
    for (const f of discoveredApexFish) {
      if (!byId.has(f.id)) byId.set(f.id, f);
    }
    return [...byId.values()];
  }, [apexEventLive, eventStatus?.apexFishes, discoveredApexFish]);

  const discoveredApexIds = useMemo(
    () => new Set(discoveredApexFish.map((f) => f.id)),
    [discoveredApexFish],
  );

  const discoveredCount = useMemo(() => {
    let n = 0;
    entries.forEach((e) => {
      if (discoveredSpecies?.has(e.species.name) || e.catches.length > 0) n++;
    });
    return n + discoveredApexIds.size;
  }, [entries, discoveredSpecies, discoveredApexIds]);

  const totalSpecies =
    FISH_SPECIES.filter((s) => s.rarity !== FishRarity.Apex).length +
    apexSlots.length;
  const selected = selectedName ? (entries.get(selectedName) ?? null) : null;
  const selectedApex = useMemo(() => {
    if (!selectedName) return null;
    return apexSlots.find((f) => f.name === selectedName) ?? null;
  }, [selectedName, apexSlots]);

  const dismissConfirm = () => {
    if (!selling) setConfirm(null);
  };

  const doSellOne = async () => {
    if (!confirm || confirm.kind !== "one" || !onSellFish) return;
    const c = confirm.entry.latestCatch;
    if (!c) return;
    setSelling(true);
    try {
      await onSellFish(c.id, c.shellValue);
      playSfx("buySell");
      setConfirm(null);
    } catch {
    } finally {
      setSelling(false);
    }
  };

  const doSellAll = async () => {
    if (!confirm || confirm.kind !== "all" || !onSellFishBulk) return;
    const ids = confirm.entry.catches.map((c) => c.id);
    if (ids.length === 0) return;
    setSelling(true);
    try {
      await onSellFishBulk(ids);
      playSfx("buySell");
      setConfirm(null);
    } catch {
    } finally {
      setSelling(false);
    }
  };

  return (
    <div className="fish-index-overlay" onClick={onClose}>
      <div className="fish-index-frame" onClick={(e) => e.stopPropagation()}>
        <button
          className="fish-index-close"
          onClick={onClose}
          aria-label="Close Fish Index"
        >
          ✕
        </button>

        <div className="fish-index-header">
          <div className="fish-index-title">Fish Collection</div>
          <div className="fish-index-counter">
            {discoveredCount} / {totalSpecies} discovered
          </div>
        </div>

        <div className="fish-index-tiers">
          {RARITY_ORDER.map((rarity) => {
            const rarityColor = RARITY_COLORS[rarity];

            if (rarity === FishRarity.Apex) {
              if (apexSlots.length === 0) {
                return (
                  <div key={rarity} className="fish-index-tier">
                    <span
                      className="fish-index-tier-badge"
                      style={{ backgroundColor: rarityColor }}
                    >
                      {RARITY_LABELS[rarity].toUpperCase()}
                    </span>
                    <div
                      className="fish-index-tier-caption"
                      style={{ borderColor: rarityColor }}
                    >
                      Apex catches surface only during seasonal events — keep
                      an eye out for the next one.
                    </div>
                  </div>
                );
              }
              return (
                <div key={rarity} className="fish-index-tier">
                  <span
                    className="fish-index-tier-badge"
                    style={{ backgroundColor: rarityColor }}
                  >
                    {RARITY_LABELS[rarity].toUpperCase()}
                  </span>
                  <div className="fish-index-tier-slots">
                    {apexSlots.map((apex) => {
                      const caught = discoveredApexIds.has(apex.id);
                      const isSelected = selectedName === apex.name;
                      return (
                        <button
                          key={apex.id}
                          type="button"
                          className={`fish-index-slot fish-index-slot-apex${isSelected ? " fish-index-slot-selected" : ""}${!caught ? " fish-index-slot-locked" : ""}`}
                          style={{
                            borderColor: caught
                              ? rarityColor
                              : "rgba(255, 255, 255, 0.2)",
                          }}
                          onClick={() => setSelectedName(apex.name)}
                          title={caught ? apex.name : "Undiscovered"}
                        >
                          <img
                            src={apex.assetUrl}
                            alt={caught ? apex.name : "Undiscovered"}
                            className="fish-index-slot-art"
                          />
                          {!caught && (
                            <span className="fish-index-slot-lock">???</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            }

            const speciesOfTier = FISH_SPECIES.filter(
              (s) => s.rarity === rarity,
            );
            if (speciesOfTier.length === 0) return null;
            return (
              <div key={rarity} className="fish-index-tier">
                <span
                  className="fish-index-tier-badge"
                  style={{ backgroundColor: rarityColor }}
                >
                  {RARITY_LABELS[rarity].toUpperCase()}
                </span>
                <div className="fish-index-tier-slots">
                  {speciesOfTier.map((sp) => {
                    const entry = entries.get(sp.name)!;
                    const inInventory = entry.catches.length > 0;
                    const caught =
                      (discoveredSpecies?.has(sp.name) ?? false) || inInventory;
                    const isSelected = selectedName === sp.name;
                    const showCount = inInventory && entry.catches.length > 1;
                    return (
                      <button
                        key={sp.name}
                        type="button"
                        className={`fish-index-slot${isSelected ? " fish-index-slot-selected" : ""}${!caught ? " fish-index-slot-locked" : ""}`}
                        style={{
                          borderColor: caught
                            ? rarityColor
                            : "rgba(255, 255, 255, 0.2)",
                        }}
                        onClick={() => setSelectedName(sp.name)}
                        title={caught ? sp.name : "Undiscovered"}
                      >
                        <img
                          src={`/assets/Fish/${sp.asset}`}
                          alt={caught ? sp.name : "Undiscovered"}
                          className="fish-index-slot-art"
                        />
                        {!caught && (
                          <span className="fish-index-slot-lock">???</span>
                        )}
                        {showCount && (
                          <span className="fish-index-slot-count">
                            ×{entry.catches.length}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div className="fish-index-detail">
          {selectedApex ? (
            <ApexDetail
              apex={selectedApex}
              discovered={discoveredApexIds.has(selectedApex.id)}
            />
          ) : !selected ? (
            <div className="fish-index-detail-empty">
              Select a fish to see details
            </div>
          ) : (
            <SpeciesDetail
              entry={selected}
              discovered={
                (discoveredSpecies?.has(selected.species.name) ?? false) ||
                selected.catches.length > 0
              }
              onSellOne={() => setConfirm({ kind: "one", entry: selected })}
              onSellAll={() => setConfirm({ kind: "all", entry: selected })}
            />
          )}
        </div>

        {confirm && (
          <div className="sell-confirm-backdrop" onClick={dismissConfirm}>
            <div
              className="sell-confirm-popup"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sell-confirm-title">
                {confirm.kind === "one"
                  ? "Sell Fish?"
                  : `Sell all ${confirm.entry.catches.length}?`}
              </div>
              <div className="sell-confirm-fish">
                <img
                  src={`/assets/Fish/${confirm.entry.species.asset}`}
                  alt={confirm.entry.species.name}
                  className="sell-confirm-fish-img"
                />
                <div>
                  <div
                    className="sell-confirm-species"
                    style={{
                      color: RARITY_COLORS[confirm.entry.species.rarity],
                    }}
                  >
                    {confirm.entry.species.name}
                  </div>
                  <div className="sell-confirm-rarity">
                    {RARITY_LABELS[confirm.entry.species.rarity]}
                  </div>
                </div>
              </div>
              <div className="sell-confirm-value">
                <img
                  src="/assets/ui/shell.png"
                  alt="Shells"
                  className="sell-confirm-shell-icon"
                />
                <span>
                  +
                  {confirm.kind === "one"
                    ? (confirm.entry.latestCatch?.shellValue ?? 0)
                    : confirm.entry.totalShellValue}{" "}
                  Shells
                </span>
              </div>
              <div className="sell-confirm-actions">
                <button
                  type="button"
                  className="sell-confirm-btn sell-confirm-cancel"
                  onClick={() => setConfirm(null)}
                  disabled={selling}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="sell-confirm-btn sell-confirm-yes"
                  disabled={selling}
                  onClick={confirm.kind === "one" ? doSellOne : doSellAll}
                >
                  {selling ? "Selling..." : "Sell"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface SpeciesDetailProps {
  entry: SpeciesEntry;
  discovered: boolean;
  onSellOne: () => void;
  onSellAll: () => void;
}

function SpeciesDetail({
  entry,
  discovered,
  onSellOne,
  onSellAll,
}: SpeciesDetailProps) {
  const { species, catches, bestKg } = entry;
  const caughtCount = catches.length;
  const inInventory = caughtCount > 0;
  const rarityColor = RARITY_COLORS[species.rarity];
  const isApex = species.rarity === FishRarity.Apex;
  const canSell = inInventory && !isApex;

  return (
    <div className="fish-index-detail-body">
      <img
        src={`/assets/Fish/${species.asset}`}
        alt={discovered ? species.name : "Undiscovered"}
        className={`fish-index-detail-art${!discovered ? " fish-index-detail-art-locked" : ""}`}
      />
      <div className="fish-index-detail-info">
        <div
          className="fish-index-detail-name"
          style={{ color: discovered ? rarityColor : "rgba(255,255,255,0.55)" }}
        >
          {discovered ? species.name : "???"}
        </div>
        <div className="fish-index-detail-rarity">
          {RARITY_LABELS[species.rarity]}
        </div>
        {inInventory ? (
          <>
            <div className="fish-index-detail-row">
              <span>Biggest</span>
              <span>{bestKg.toFixed(2)} kg</span>
            </div>
            <div className="fish-index-detail-row">
              <span>Caught</span>
              <span>{caughtCount}</span>
            </div>
          </>
        ) : discovered ? (
          <div className="fish-index-detail-hint">
            No specimens in inventory
          </div>
        ) : (
          <>
            <div className="fish-index-detail-row">
              <span>Weight range</span>
              <span>
                {species.weightMin}–{species.weightMax} kg
              </span>
            </div>
            <div className="fish-index-detail-hint">Not yet caught</div>
          </>
        )}
        {canSell && (
          <div className="fish-index-detail-actions">
            <button
              type="button"
              className="fish-index-btn"
              onClick={onSellOne}
            >
              <img
                src="/assets/ui/shell.png"
                alt="Shells"
                className="fish-index-btn-icon"
              />
              Sell 1 · {entry.latestCatch?.shellValue ?? 0}
            </button>
            {caughtCount > 1 && (
              <button
                type="button"
                className="fish-index-btn fish-index-btn-all"
                onClick={onSellAll}
              >
                <img
                  src="/assets/ui/shell.png"
                  alt="Shells"
                  className="fish-index-btn-icon"
                />
                Sell all {caughtCount} · {entry.totalShellValue}
              </button>
            )}
          </div>
        )}
        {inInventory && isApex && (
          <div className="fish-index-detail-hint">Apex cannot be sold</div>
        )}
      </div>
    </div>
  );
}

interface ApexDetailProps {
  apex: ApexFishEntry;
  discovered: boolean;
}

function ApexDetail({ apex, discovered }: ApexDetailProps) {
  const rarityColor = RARITY_COLORS[FishRarity.Apex];
  return (
    <div className="fish-index-detail-body">
      <img
        src={apex.assetUrl}
        alt={discovered ? apex.name : "Undiscovered"}
        className={`fish-index-detail-art fish-index-detail-art-apex${!discovered ? " fish-index-detail-art-locked" : ""}`}
      />
      <div className="fish-index-detail-info">
        <div
          className="fish-index-detail-name"
          style={{ color: discovered ? rarityColor : "rgba(255,255,255,0.55)" }}
        >
          {discovered ? apex.name : "???"}
        </div>
        <div className="fish-index-detail-rarity">
          {RARITY_LABELS[FishRarity.Apex]}
        </div>
        <div className="fish-index-detail-row">
          <span>Weight range</span>
          <span>
            {apex.weightMinKg}–{apex.weightMaxKg} kg
          </span>
        </div>
        <div className="fish-index-detail-hint">
          {discovered ? "Apex cannot be sold" : "Not yet caught"}
        </div>
      </div>
    </div>
  );
}

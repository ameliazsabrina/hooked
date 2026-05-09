import { useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { RODS, BAITS, type RodDef, type BaitDef } from "@hooked/shared";
import { trpc } from "~/utils/trpc";
import { useSessionAuth } from "~/providers/session-auth-provider";
import {
  useBuyRod,
  useBuyBait,
  useEquipRod,
  useEquipBait,
} from "./use-shop";
import "./shop-screen.css";

type Tab = "rods" | "baits" | "upcoming1" | "upcoming2";

const TABS: Array<{ id: Tab; label: string; enabled: boolean }> = [
  { id: "rods", label: "Rods", enabled: true },
  { id: "baits", label: "Baits", enabled: true },
  { id: "upcoming1", label: "Upcoming", enabled: false },
  { id: "upcoming2", label: "Upcoming", enabled: false },
];

const GRID_SLOTS = 36;

interface ShopScreenProps {
  onClose: () => void;
  ready?: boolean;
}

export function ShopScreen({ onClose, ready: readyProp }: ShopScreenProps) {
  const { connected } = useWallet();
  const { ready: authReady } = useSessionAuth();
  const [tab, setTab] = useState<Tab>("rods");
  const [selectedRodSlug, setSelectedRodSlug] = useState<string | null>(null);
  const [selectedBaitSlug, setSelectedBaitSlug] = useState<string | null>(null);

  const playerQuery = trpc.player.me.useQuery(undefined, {
    enabled: connected && authReady,
  });

  const buyRod = useBuyRod();
  const buyBait = useBuyBait();
  const equipRod = useEquipRod();
  const equipBait = useEquipBait();

  const shellBalance = playerQuery.data?.exists ? playerQuery.data.shellBalance : 0;
  const equipment = playerQuery.data?.exists ? playerQuery.data.equipment : null;
  const ownedRods = useMemo(() => new Set(equipment?.ownedRods ?? []), [equipment]);
  const ownedBaits = useMemo(() => new Set(equipment?.ownedBaits ?? []), [equipment]);
  const equippedRod = equipment?.rodEquipped ?? "old";
  const equippedBait = equipment?.baitEquipped ?? "fly";

  const rods = RODS;
  const baits = BAITS;
  const ready =
    readyProp ??
    (connected &&
      authReady &&
      playerQuery.data?.exists === true &&
      !!playerQuery.data.depositAmount);

  const busy =
    buyRod.isPending ||
    buyBait.isPending ||
    equipRod.isPending ||
    equipBait.isPending;

  const selectedRod =
    tab === "rods" ? rods.find((r) => r.slug === selectedRodSlug) ?? null : null;
  const selectedBait =
    tab === "baits" ? baits.find((b) => b.slug === selectedBaitSlug) ?? null : null;

  const isUpcoming = tab === "upcoming1" || tab === "upcoming2";

  return (
    <div className="shop-overlay" onClick={onClose}>
      <div className="shop-frame" onClick={(e) => e.stopPropagation()}>
        <button className="shop-close" onClick={onClose} aria-label="Close shop">
          ✕
        </button>

        <div className="shop-balance">
          <img src="/assets/ui/shell.png" alt="Shell" className="shop-shell-icon" />
          <span>{shellBalance.toLocaleString()}</span>
        </div>

        <div className="shop-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`shop-tab${tab === t.id ? " shop-tab-active" : ""}${
                !t.enabled ? " shop-tab-disabled" : ""
              }`}
              onClick={() => {
                if (!t.enabled) return;
                setTab(t.id);
              }}
              aria-disabled={!t.enabled}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="shop-grid">
          {Array.from({ length: GRID_SLOTS }).map((_, i) => {
            if (isUpcoming) {
              return <div key={i} className="shop-slot shop-slot-empty" />;
            }
            if (tab === "rods") {
              const rod = rods[i];
              if (!rod) return <div key={i} className="shop-slot shop-slot-empty" />;
              const owned = ownedRods.has(rod.slug);
              const equipped = equippedRod === rod.slug;
              return (
                <button
                  key={rod.slug}
                  type="button"
                  className={`shop-slot${selectedRodSlug === rod.slug ? " shop-slot-selected" : ""}${
                    equipped ? " shop-slot-equipped" : ""
                  }${!owned ? " shop-slot-locked" : ""}`}
                  onClick={() => setSelectedRodSlug(rod.slug)}
                  title={rod.name}
                >
                  <img
                    src={`/assets/Rod/${rod.asset}`}
                    alt={rod.name}
                    className="shop-slot-art"
                  />
                  {equipped && <span className="shop-slot-badge">E</span>}
                </button>
              );
            }
            const bait = baits[i];
            if (!bait) return <div key={i} className="shop-slot shop-slot-empty" />;
            const owned = ownedBaits.has(bait.slug);
            const equipped = equippedBait === bait.slug;
            return (
              <button
                key={bait.slug}
                type="button"
                className={`shop-slot${selectedBaitSlug === bait.slug ? " shop-slot-selected" : ""}${
                  equipped ? " shop-slot-equipped" : ""
                }${!owned ? " shop-slot-locked" : ""}`}
                onClick={() => setSelectedBaitSlug(bait.slug)}
                title={bait.name}
              >
                <img
                  src={`/assets/Bait/${bait.asset}`}
                  alt={bait.name}
                  className="shop-slot-art"
                />
                {equipped && <span className="shop-slot-badge">E</span>}
              </button>
            );
          })}
        </div>

        <div className="shop-detail">
          {isUpcoming ? (
            <div className="shop-detail-empty">Coming soon…</div>
          ) : tab === "rods" && selectedRod ? (
            <RodDetail
              rod={selectedRod}
              owned={ownedRods.has(selectedRod.slug)}
              equipped={equippedRod === selectedRod.slug}
              affordable={shellBalance >= selectedRod.shellCost}
              busy={busy}
              ready={ready}
              onBuy={() => buyRod.mutate({ slug: selectedRod.slug })}
              onEquip={() => equipRod.mutate({ slug: selectedRod.slug })}
            />
          ) : tab === "baits" && selectedBait ? (
            <BaitDetail
              bait={selectedBait}
              owned={ownedBaits.has(selectedBait.slug)}
              equipped={equippedBait === selectedBait.slug}
              affordable={shellBalance >= selectedBait.shellCost}
              busy={busy}
              ready={ready}
              onBuy={() => buyBait.mutate({ slug: selectedBait.slug })}
              onEquip={() => equipBait.mutate({ slug: selectedBait.slug })}
            />
          ) : (
            <div className="shop-detail-empty">
              Select {tab === "rods" ? "a rod" : "a bait"} to preview
            </div>
          )}
        </div>

        {!ready && !isUpcoming && (
          <div className="shop-notice">
            Connect your wallet and start fishing to purchase.
          </div>
        )}

        {(buyRod.error || buyBait.error || equipRod.error || equipBait.error) && (
          <div className="shop-error">
            {buyRod.error?.message ??
              buyBait.error?.message ??
              equipRod.error?.message ??
              equipBait.error?.message}
          </div>
        )}
      </div>
    </div>
  );
}

interface RodDetailProps {
  rod: RodDef;
  owned: boolean;
  equipped: boolean;
  affordable: boolean;
  busy: boolean;
  ready: boolean;
  onBuy: () => void;
  onEquip: () => void;
}

function RodDetail({ rod, owned, equipped, affordable, busy, ready, onBuy, onEquip }: RodDetailProps) {
  return (
    <div className="shop-detail-body">
      <img src={`/assets/Rod/${rod.asset}`} alt={rod.name} className="shop-detail-art" />
      <div className="shop-detail-info">
        <div className="shop-detail-name">{rod.name}</div>
        <div className="shop-detail-tier">Tier {rod.tier}</div>
        <div className="shop-detail-effect">+{rod.greenBarBonusPx}px green bar</div>
        <div className="shop-detail-action">
          {equipped ? (
            <span className="shop-detail-equipped">Equipped</span>
          ) : owned ? (
            <button className="shop-btn" disabled={busy || !ready} onClick={onEquip}>
              Equip
            </button>
          ) : (
            <button
              className="shop-btn shop-btn-buy"
              disabled={busy || !ready || !affordable || rod.shellCost === 0}
              onClick={onBuy}
            >
              <img src="/assets/ui/shell.png" alt="" className="shop-btn-icon" />
              {rod.shellCost === 0 ? "—" : `Buy · ${rod.shellCost}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface BaitDetailProps {
  bait: BaitDef;
  owned: boolean;
  equipped: boolean;
  affordable: boolean;
  busy: boolean;
  ready: boolean;
  onBuy: () => void;
  onEquip: () => void;
}

function BaitDetail({ bait, owned, equipped, affordable, busy, ready, onBuy, onEquip }: BaitDetailProps) {
  const drainPct = Math.round(bait.progressDrainReduction * 100);
  return (
    <div className="shop-detail-body">
      <img src={`/assets/Bait/${bait.asset}`} alt={bait.name} className="shop-detail-art" />
      <div className="shop-detail-info">
        <div className="shop-detail-name">{bait.name}</div>
        <div className="shop-detail-tier">Tier {bait.tier}</div>
        <div className="shop-detail-effect">
          {drainPct === 0 ? "Progress Bait 0%" : `Progress Bait −${drainPct}%`}
        </div>
        <div className="shop-detail-action">
          {equipped ? (
            <span className="shop-detail-equipped">Equipped</span>
          ) : owned ? (
            <button className="shop-btn" disabled={busy || !ready} onClick={onEquip}>
              Equip
            </button>
          ) : (
            <button
              className="shop-btn shop-btn-buy"
              disabled={busy || !ready || !affordable || bait.shellCost === 0}
              onClick={onBuy}
            >
              <img src="/assets/ui/shell.png" alt="" className="shop-btn-icon" />
              {bait.shellCost === 0 ? "—" : `Buy · ${bait.shellCost}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

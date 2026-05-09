import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { getRod, getBait, type RodDef, type BaitDef } from "@hooked/shared";
import { trpc } from "~/utils/trpc";
import { useSessionAuth } from "~/providers/session-auth-provider";

type SlotKind = "rod" | "bait";

interface CardState {
  kind: SlotKind;
  anchorX: number;
  anchorY: number;
}

function clampToViewport(anchorX: number, anchorY: number, el: HTMLElement) {
  const cw = el.offsetWidth;
  const ch = el.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pad = 8;

  let left = anchorX - cw / 2;
  let top = anchorY;

  if (top + ch + pad > vh) top = anchorY - ch - 56;
  if (left + cw + pad > vw) left = vw - cw - pad;
  if (left < pad) left = pad;
  if (top < pad) top = pad;
  if (top + ch + pad > vh) top = vh - ch - pad;

  return { left, top };
}

function RodCardBody({ rod }: { rod: RodDef }) {
  return (
    <>
      <div className="collectible-card-species">{rod.name}</div>
      <div className="collectible-card-rarity">Tier {rod.tier}</div>
      <div className="collectible-card-row">
        <span>Green Bar</span>
        <span>+{rod.greenBarBonusPx}px</span>
      </div>
    </>
  );
}

function BaitCardBody({ bait }: { bait: BaitDef }) {
  const drainPct = Math.round(bait.progressDrainReduction * 100);
  return (
    <>
      <div className="collectible-card-species">{bait.name}</div>
      <div className="collectible-card-rarity">Tier {bait.tier}</div>
      <div className="collectible-card-row">
        <span>Progress Bait</span>
        <span>{drainPct === 0 ? "0%" : `−${drainPct}%`}</span>
      </div>
    </>
  );
}

export function EquippedGear() {
  const { connected } = useWallet();
  const { ready: authReady } = useSessionAuth();
  const playerQuery = trpc.player.me.useQuery(undefined, {
    enabled: connected && authReady,
  });

  const equipment = playerQuery.data?.exists
    ? playerQuery.data.equipment
    : null;
  const rod = getRod(equipment?.rodEquipped);
  const bait = getBait(equipment?.baitEquipped);

  const [card, setCard] = useState<CardState | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const handleEnter =
    (kind: SlotKind) => (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      setCard({
        kind,
        anchorX: rect.left + rect.width / 2,
        anchorY: rect.bottom + 6,
      });
      setPos(null);
    };

  const handleLeave = () => {
    setCard(null);
    setPos(null);
  };

  useLayoutEffect(() => {
    if (!card || !cardRef.current) {
      setPos(null);
      return;
    }
    setPos(clampToViewport(card.anchorX, card.anchorY, cardRef.current));
  }, [card]);

  return (
    <>
      <div className="equipped-gear-hud">
        <div
          className="equipped-slot"
          onMouseEnter={handleEnter("rod")}
          onMouseLeave={handleLeave}
        >
          <img src={`/assets/Rod/${rod.asset}`} alt={rod.name} />
        </div>
        <div
          className="equipped-slot"
          onMouseEnter={handleEnter("bait")}
          onMouseLeave={handleLeave}
        >
          <img src={`/assets/Bait/${bait.asset}`} alt={bait.name} />
        </div>
      </div>
      {card &&
        createPortal(
          <div
            ref={cardRef}
            className="collectible-card collectible-card-floating collectible-card-hover"
            style={{
              left: pos ? pos.left : card.anchorX,
              top: pos ? pos.top : card.anchorY,
              transform: pos ? "none" : "translateX(-50%)",
              visibility: pos ? "visible" : "hidden",
            }}
          >
            {card.kind === "rod" ? (
              <RodCardBody rod={rod} />
            ) : (
              <BaitCardBody bait={bait} />
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

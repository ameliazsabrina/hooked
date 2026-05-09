interface BottomNavProps {
  onOpenShop: () => void;
  onOpenCollection: () => void;
  onOpenStorage: () => void;
}

export function BottomNav({
  onOpenShop,
  onOpenCollection,
  onOpenStorage,
}: BottomNavProps) {
  return (
    <nav className="bottom-nav">
      <button className="bottom-nav-tab" onClick={onOpenStorage}>
        Storage
      </button>
      <button className="bottom-nav-tab" onClick={onOpenShop}>
        Shop
      </button>
      <button
        className="bottom-nav-tab bottom-nav-tab-collection"
        onClick={onOpenCollection}
      >
        Fish Index
      </button>
    </nav>
  );
}

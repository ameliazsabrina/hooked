import { useEffect, useRef } from "react";
import Phaser from "phaser";
import { gameConfig } from "./config";

interface PhaserGameProps {
  onGameReady?: (game: Phaser.Game) => void;
}

export function PhaserGame({ onGameReady }: PhaserGameProps) {
  const gameRef = useRef<Phaser.Game | null>(null);
  const onGameReadyRef = useRef(onGameReady);
  onGameReadyRef.current = onGameReady;

  useEffect(() => {
    if (gameRef.current) return;

    const game = new Phaser.Game(gameConfig);
    gameRef.current = game;
    onGameReadyRef.current?.(game);

    return () => {
      game.destroy(true);
      gameRef.current = null;
    };
  }, []);

  return <div id="phaser-container" />;
}

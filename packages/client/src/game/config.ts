import Phaser from "phaser";
import { MainScene } from "./scenes/main-scene";

export const gameConfig: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: "phaser-container",
  backgroundColor: "#0A2E4E",
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: "100%",
    height: "100%",
  },
  // DOM layer overlays the animated fishing.gif — Phaser textures can't
  // decode multi-frame GIFs.
  dom: {
    createContainer: true,
  },
  scene: [MainScene],
};

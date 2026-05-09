import Phaser from "phaser";

export class MainScene extends Phaser.Scene {
  private water!: Phaser.GameObjects.Sprite;
  private ship!: Phaser.GameObjects.Sprite;
  private shipGroup!: Phaser.GameObjects.Container;
  private driftTween!: Phaser.Tweens.Tween;
  private rockTween!: Phaser.Tweens.Tween;
  private characterSprite!: Phaser.GameObjects.Sprite;
  private fishingDom!: Phaser.GameObjects.DOMElement;
  private waitingDom!: Phaser.GameObjects.DOMElement;
  private castTimer: Phaser.Time.TimerEvent | null = null;
  private isFishing = false;
  private mode: "day" | "night" = "day";

  // fishing.gif natural duration: 9 frames × 200ms.
  private static readonly FISHING_GIF_DURATION_MS = 1800;

  constructor() {
    super("MainScene");
  }

  preload() {
    for (let i = 1; i <= 5; i++) {
      this.load.image(`water${i}`, `assets/Water/Water${i}.png`);
      this.load.image(`water-night${i}`, `assets/Water/night/Water${i}.png`);
    }
    for (let i = 1; i <= 2; i++) {
      this.load.image(`ship${i}`, `assets/Ship/Ship${i}.png`);
      this.load.image(`ship-night${i}`, `assets/Ship/night/Ship${i}.png`);
    }

    const charDir = "assets/character/";
    this.load.image("check-1", `${charDir}check1.png`);
    this.load.image("check-2", `${charDir}check2.png`);
    this.load.once(Phaser.Loader.Events.COMPLETE, () => {
      this.textures
        .get("check-1")
        .setFilter(Phaser.Textures.FilterMode.NEAREST);
      this.textures
        .get("check-2")
        .setFilter(Phaser.Textures.FilterMode.NEAREST);
    });
  }

  create() {
    this.anims.create({
      key: "water-anim",
      frames: [
        { key: "water1" },
        { key: "water2" },
        { key: "water3" },
        { key: "water4" },
        { key: "water5" },
      ],
      frameRate: 1,
      repeat: -1,
    });
    this.anims.create({
      key: "water-anim-night",
      frames: [
        { key: "water-night1" },
        { key: "water-night2" },
        { key: "water-night3" },
        { key: "water-night4" },
        { key: "water-night5" },
      ],
      frameRate: 1,
      repeat: -1,
    });

    this.water = this.add.sprite(0, 0, "water1");
    this.water.setOrigin(0.5, 0.5);
    this.water.setDepth(0);
    this.water.play("water-anim");

    this.anims.create({
      key: "ship-idle",
      frames: [{ key: "ship1" }, { key: "ship2" }],
      frameRate: 1.5,
      repeat: -1,
    });
    this.anims.create({
      key: "ship-idle-night",
      frames: [{ key: "ship-night1" }, { key: "ship-night2" }],
      frameRate: 1.5,
      repeat: -1,
    });

    this.ship = this.add.sprite(0, 0, "ship1");
    this.ship.setOrigin(0.5, 0.5);
    this.ship.play("ship-idle");

    // Match ship's frameRate (1.5, no yoyo) so check frames swap in lockstep
    // with ship frames.
    this.anims.create({
      key: "character-idle",
      frames: [{ key: "check-2" }, { key: "check-1" }],
      frameRate: 1.5,
      repeat: -1,
    });

    this.characterSprite = this.add.sprite(0, 0, "check-1");
    this.characterSprite.setOrigin(0.5, 0.5);
    this.characterSprite.play("character-idle");

    // DOM <img> overlays because Phaser textures only decode the first frame
    // of an animated GIF.
    const makeGifOverlay = (src: string) => {
      const img = document.createElement("img");
      img.src = src;
      img.style.imageRendering = "pixelated";
      img.style.width = "92px";
      img.style.height = "92px";
      img.style.pointerEvents = "none";
      const dom = this.add.dom(0, 0, img);
      dom.setOrigin(0.5, 0.5);
      dom.setVisible(false);
      return dom;
    };
    this.fishingDom = makeGifOverlay("assets/character/fishing.gif");
    this.waitingDom = makeGifOverlay("assets/character/waiting.gif");

    this.shipGroup = this.add.container(0, 0, [
      this.ship,
      this.characterSprite,
      this.fishingDom,
      this.waitingDom,
    ]);
    this.shipGroup.setDepth(1);

    this.layoutAssets();
    this.scale.on("resize", this.onResize, this);

    this.game.events.on("castLine", this.startFishing, this);
    this.game.events.on("fishBite", this.onFishBite, this);
    this.game.events.on("stopFishing", this.stopFishing, this);
    this.game.events.on("setMode", this.setMode, this);

    const initialMode = this.game.registry.get("mode") as
      | "day"
      | "night"
      | undefined;
    if (initialMode) this.setMode(initialMode);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.game.events.off("castLine", this.startFishing, this);
      this.game.events.off("fishBite", this.onFishBite, this);
      this.game.events.off("stopFishing", this.stopFishing, this);
      this.game.events.off("setMode", this.setMode, this);
    });
  }

  private setMode(mode: "day" | "night") {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode === "night") {
      this.water.play("water-anim-night");
      this.ship.play("ship-idle-night");
    } else {
      this.water.play("water-anim");
      this.ship.play("ship-idle");
    }
  }

  private startFishing() {
    if (this.isFishing) return;
    this.isFishing = true;

    // Let the idle cycle finish once before the cast animation kicks in,
    // so the pose doesn't snap mid-frame.
    this.characterSprite.once(
      Phaser.Animations.Events.ANIMATION_REPEAT,
      this.playFishingClip,
      this,
    );
  }

  private onFishBite() {
    if (!this.isFishing) return;

    // If bite fires before the idle cycle completed, skip the wait and swap now.
    this.characterSprite.off(
      Phaser.Animations.Events.ANIMATION_REPEAT,
      this.playFishingClip,
      this,
    );
    this.playFishingClip();
  }

  private playFishingClip() {
    if (!this.isFishing) return;

    // Clear any prior timer so this clip's follow-up waiting swap wins.
    if (this.castTimer) {
      this.castTimer.remove(false);
      this.castTimer = null;
    }

    // Reassign src to restart the GIF from frame 1 even if it played before.
    const img = this.fishingDom.node as HTMLImageElement;
    img.src = `assets/character/fishing.gif?t=${Date.now()}`;

    this.fishingDom.setVisible(true);
    this.waitingDom.setVisible(false);
    this.characterSprite.setVisible(false);

    this.castTimer = this.time.delayedCall(
      MainScene.FISHING_GIF_DURATION_MS,
      () => {
        this.castTimer = null;
        if (!this.isFishing) return;
        this.waitingDom.setVisible(true);
        this.fishingDom.setVisible(false);
      },
    );
  }

  private stopFishing() {
    if (!this.isFishing) return;
    this.isFishing = false;

    // Cancel pending swap if player dismissed before the idle cycle finished.
    this.characterSprite.off(
      Phaser.Animations.Events.ANIMATION_REPEAT,
      this.playFishingClip,
      this,
    );
    if (this.castTimer) {
      this.castTimer.remove(false);
      this.castTimer = null;
    }

    this.characterSprite.setVisible(true);
    this.fishingDom.setVisible(false);
    this.waitingDom.setVisible(false);
  }

  private onResize(gameSize: Phaser.Structs.Size) {
    this.cameras.main.setSize(gameSize.width, gameSize.height);
    this.layoutAssets();
  }

  private layoutAssets() {
    const { width, height } = this.scale;

    // Water texture is 3413x1920 — scale uniformly to cover both axes.
    this.water.setPosition(width / 2, height / 2);
    const waterScale = Math.max(width / 3413, height / 1920) * 1.05;
    this.water.setScale(waterScale);

    // Canvas spans full viewport but play area is inside .game-viewport
    // (between sidebars, above bottom panels). Read its DOM rect so the ship
    // centers on the water the player sees, not the hidden-behind-UI midpoint.
    const viewportEl = document.querySelector(
      ".game-viewport",
    ) as HTMLElement | null;
    const canvasEl = this.game.canvas as HTMLCanvasElement | undefined;
    let centerX = width / 2;
    let centerY = height / 2;
    if (viewportEl && canvasEl) {
      const vpRect = viewportEl.getBoundingClientRect();
      const canvasRect = canvasEl.getBoundingClientRect();
      centerX = vpRect.left - canvasRect.left + vpRect.width / 2;
      centerY = vpRect.top - canvasRect.top + vpRect.height / 1.8;
    }

    const baseDim = Math.min(width, height);
    const isDesktop = width >= 768;
    const shipMultiplier = isDesktop ? 0.75 : 0.85;
    const charMultiplier = isDesktop ? 0.185 : 0.22;
    const shipScale = (baseDim * shipMultiplier) / 1086;
    this.ship.setScale(shipScale);
    const charX = -baseDim * 0.1;
    const charY = baseDim * 0.07;
    const charScale = (baseDim * charMultiplier) / 92;
    if (this.characterSprite) {
      this.characterSprite.setScale(charScale);
      this.characterSprite.setPosition(charX, charY);
    }

    if (this.fishingDom) {
      this.fishingDom.setScale(charScale);
      this.fishingDom.setPosition(charX, charY);
    }
    if (this.waitingDom) {
      this.waitingDom.setScale(charScale);
      this.waitingDom.setPosition(charX, charY);
    }

    this.shipGroup.setPosition(centerX, centerY);

    if (this.driftTween) this.driftTween.destroy();
    if (this.rockTween) this.rockTween.destroy();

    this.driftTween = this.tweens.add({
      targets: this.shipGroup,
      x: centerX + 3,
      y: centerY + 1.5,
      duration: 5000,
      ease: "Sine.easeInOut",
      yoyo: true,
      loop: -1,
    });

    // Rock the ship sprite only — rocking shipGroup would swing the captain
    // through an arc and desync him from the ship's bob.
    this.rockTween = this.tweens.add({
      targets: this.ship,
      angle: { from: -1.5, to: 1.5 },
      duration: 6000,
      ease: "Sine.easeInOut",
      yoyo: true,
      loop: -1,
    });
  }
}

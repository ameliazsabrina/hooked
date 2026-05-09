import type Phaser from "phaser";

export class Bobber {
  constructor(_scene: Phaser.Scene) {
    void _scene;
  }

  setScale(_scale: number): void {
    void _scale;
  }

  cast(
    _fromX: number,
    _fromY: number,
    _toX: number,
    _toY: number,
    _durationMs = 700,
  ): Promise<void> {
    void _fromX;
    void _fromY;
    void _toX;
    void _toY;
    void _durationMs;
    return Promise.resolve();
  }

  startIdleLoop(): void {}

  playNibble(): void {}

  playHookYank(): void {}

  playEscape(): void {}

  reset(): void {}

  setHomePosition(_x: number, _y: number): void {
    void _x;
    void _y;
  }

  destroy(): void {}
}

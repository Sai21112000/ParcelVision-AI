import { DEFAULT_THRESHOLDS } from './thresholds.mjs';

export class StabilityTracker {
  constructor({
    frames = DEFAULT_THRESHOLDS.stableFrameCount,
    maxPixelMove = DEFAULT_THRESHOLDS.maxCornerMovePx,
  } = {}) {
    this.frames = frames;
    this.maxPixelMove = maxPixelMove;
    this.history = [];
  }

  update(cornersNormalized, videoWidth = 1280, videoHeight = 720) {
    if (!cornersNormalized?.length) {
      this.history = [];
      return { stability: 0, durationMs: 0, locked: false, frameCount: 0, maxMove: 0 };
    }
    this.history.push({ corners: cornersNormalized.map(p => ({ x: p.x, y: p.y })) });
    if (this.history.length > this.frames) this.history.shift();
    const latest = this.history[this.history.length - 1];
    let maxMove = 0;
    for (const sample of this.history) {
      for (let i = 0; i < 4; i += 1) {
        const dx = ((sample.corners[i]?.x || 0) - (latest.corners[i]?.x || 0)) * videoWidth;
        const dy = ((sample.corners[i]?.y || 0) - (latest.corners[i]?.y || 0)) * videoHeight;
        maxMove = Math.max(maxMove, Math.hypot(dx, dy));
      }
    }
    const locked = this.history.length >= this.frames && maxMove < this.maxPixelMove;
    return {
      stability: locked ? 1 : Math.max(0, Math.min(1, 1 - maxMove / 24)),
      durationMs: locked ? 500 : 0,
      locked,
      frameCount: this.history.length,
      maxMove,
    };
  }

  reset() {
    this.history = [];
  }
}

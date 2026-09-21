export class StabilityTracker {
  constructor(windowMs = 700) {
    this.windowMs = windowMs;
    this.history = [];
  }

  update(cornersNormalized) {
    const now = performance.now();
    if (!cornersNormalized?.length) {
      this.history = [];
      return { stability: 0, durationMs: 0 };
    }
    this.history.push({ t: now, corners: cornersNormalized.map(p => ({ x: p.x, y: p.y })) });
    this.history = this.history.filter(item => now - item.t <= this.windowMs * 2);
    if (this.history.length < 2) return { stability: 0, durationMs: 0 };
    const latest = this.history[this.history.length - 1];
    let maxMove = 0;
    for (const sample of this.history) {
      for (let i = 0; i < 4; i += 1) {
        const dx = (sample.corners[i]?.x || 0) - (latest.corners[i]?.x || 0);
        const dy = (sample.corners[i]?.y || 0) - (latest.corners[i]?.y || 0);
        maxMove = Math.max(maxMove, Math.hypot(dx, dy));
      }
    }
    const stability = Math.max(0, Math.min(1, 1 - maxMove / 0.08));
    const firstStable = this.history.find(sample => {
      let move = 0;
      for (let i = 0; i < 4; i += 1) {
        const dx = (sample.corners[i]?.x || 0) - (latest.corners[i]?.x || 0);
        const dy = (sample.corners[i]?.y || 0) - (latest.corners[i]?.y || 0);
        move = Math.max(move, Math.hypot(dx, dy));
      }
      return move < 0.025;
    });
    return {
      stability,
      durationMs: firstStable ? now - firstStable.t : 0,
    };
  }

  reset() {
    this.history = [];
  }
}

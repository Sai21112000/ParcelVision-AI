export class PerspectiveCropEditor {
  constructor(canvas, onChange) {
    this.canvas = canvas;
    this.onChange = onChange;
    this.corners = [];
    this.dragIndex = -1;
    this.boundMove = this.move.bind(this);
    this.boundUp = this.up.bind(this);
    canvas.addEventListener('pointerdown', this.down.bind(this));
    canvas.addEventListener('pointermove', this.boundMove);
    canvas.addEventListener('pointerup', this.boundUp);
    canvas.addEventListener('pointerleave', this.boundUp);
  }

  setImage(image, cornersNormalized) {
    this.image = image;
    this.corners = cornersNormalized.map(p => ({ x: p.x, y: p.y }));
    this.draw();
  }

  getCorners() {
    return this.corners.map(p => ({ x: p.x, y: p.y }));
  }

  localPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  }

  down(event) {
    const p = this.localPoint(event);
    let best = -1, bestD = 0.08;
    this.corners.forEach((c, i) => {
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bestD) { bestD = d; best = i; }
    });
    this.dragIndex = best;
    if (best >= 0) this.canvas.setPointerCapture(event.pointerId);
  }

  move(event) {
    if (this.dragIndex < 0) return;
    const p = this.localPoint(event);
    this.corners[this.dragIndex] = {
      x: Math.max(0, Math.min(1, p.x)),
      y: Math.max(0, Math.min(1, p.y)),
    };
    this.draw();
  }

  up() {
    if (this.dragIndex < 0) return;
    this.dragIndex = -1;
    this.onChange?.(this.getCorners());
  }

  draw() {
    const c = this.canvas;
    const ctx = c.getContext('2d');
    if (!this.image) return;
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.image, 0, 0, w, h);
    ctx.beginPath();
    this.corners.forEach((p, i) => {
      const x = p.x * w, y = p.y * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(56,56,162,.18)';
    ctx.fill();
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 3;
    ctx.stroke();
    this.corners.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, 10, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = '#3838a2';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }
}

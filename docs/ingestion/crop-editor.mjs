export class PerspectiveCropEditor {
  constructor(canvas, onChange) {
    this.canvas = canvas;
    this.onChange = onChange;
    this.corners = [];
    this.dragIndex = -1;
    this.dragAll = false;
    this.dragOrigin = null;
    this.dragStartCorners = null;
    this.boundMove = this.move.bind(this);
    this.boundUp = this.up.bind(this);
    canvas.style.touchAction = 'none';
    canvas.style.userSelect = 'none';
    canvas.addEventListener('pointerdown', this.down.bind(this));
    canvas.addEventListener('pointermove', this.boundMove);
    canvas.addEventListener('pointerup', this.boundUp);
    canvas.addEventListener('pointercancel', this.boundUp);
    canvas.addEventListener('lostpointercapture', this.boundUp);
  }

  setImage(image, cornersNormalized) {
    this.image = image;
    this.corners = cornersNormalized.map(p => ({ x: p.x, y: p.y }));
    this.dragIndex = -1;
    this.dragAll = false;
    this.draw();
  }

  getCorners() {
    return this.corners.map(p => ({ x: p.x, y: p.y }));
  }

  localPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || 1;
    const h = rect.height || 1;
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / w)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / h)),
    };
  }

  hitRadius() {
    const rect = this.canvas.getBoundingClientRect();
    const minSide = Math.min(rect.width || 1, rect.height || 1);
    return Math.max(0.08, 28 / minSide);
  }

  down(event) {
    if (!this.corners.length) return;
    event.preventDefault();
    event.stopPropagation();
    const p = this.localPoint(event);
    const radius = this.hitRadius();
    let best = -1;
    let bestD = radius;
    this.corners.forEach((c, i) => {
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    this.dragIndex = best;
    this.dragAll = false;
    this.dragOrigin = p;
    this.dragStartCorners = this.corners.map(c => ({ x: c.x, y: c.y }));
    const inside = best < 0 && pointInQuad(p, this.corners);
    if (inside) this.dragAll = true;
    const dragging = this.dragIndex >= 0 || this.dragAll;
    if (dragging) {
      this.canvas.setPointerCapture(event.pointerId);
      this.canvas.style.cursor = 'grabbing';
    }
  }

  move(event) {
    if (this.dragIndex < 0 && !this.dragAll) return;
    event.preventDefault();
    const p = this.localPoint(event);
    if (this.dragAll && this.dragOrigin && this.dragStartCorners) {
      const dx = p.x - this.dragOrigin.x;
      const dy = p.y - this.dragOrigin.y;
      this.corners = shiftQuad(this.dragStartCorners, dx, dy);
    } else if (this.dragIndex >= 0) {
      this.corners[this.dragIndex] = { x: p.x, y: p.y };
    }
    this.draw();
  }

  up() {
    if (this.dragIndex < 0 && !this.dragAll) return;
    this.dragIndex = -1;
    this.dragAll = false;
    this.dragOrigin = null;
    this.dragStartCorners = null;
    this.canvas.style.cursor = 'grab';
    this.onChange?.(this.getCorners());
  }

  draw() {
    const c = this.canvas;
    const ctx = c.getContext('2d');
    if (!this.image) return;
    const w = c.width;
    const h = c.height;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.image, 0, 0, w, h);
    ctx.beginPath();
    this.corners.forEach((p, i) => {
      const x = p.x * w;
      const y = p.y * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(56,56,162,.18)';
    ctx.fill();
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 3;
    ctx.stroke();
    this.corners.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, Math.max(10, Math.round(Math.min(w, h) * 0.018)), 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = '#3838a2';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }
}

function pointInQuad(p, corners) {
  let inside = false;
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
    const a = corners[i];
    const b = corners[j];
    const intersect = ((a.y > p.y) !== (b.y > p.y))
      && (p.x < ((b.x - a.x) * (p.y - a.y) / ((b.y - a.y) || 1e-12)) + a.x);
    if (intersect) inside = !inside;
  }
  return inside;
}

function shiftQuad(start, dx, dy) {
  let next = start.map(c => ({ x: c.x + dx, y: c.y + dy }));
  const xs = next.map(c => c.x);
  const ys = next.map(c => c.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  let ox = 0;
  let oy = 0;
  if (minX < 0) ox = -minX;
  if (maxX > 1) ox = 1 - maxX;
  if (minY < 0) oy = -minY;
  if (maxY > 1) oy = 1 - maxY;
  return next.map(c => ({
    x: Math.max(0, Math.min(1, c.x + ox)),
    y: Math.max(0, Math.min(1, c.y + oy)),
  }));
}

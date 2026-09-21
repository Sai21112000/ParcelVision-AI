import { DEFAULT_THRESHOLDS } from './thresholds.mjs';
import { isOpenCvReady } from './opencv-loader.mjs';
import { orderCorners } from './perspective.mjs';

const clamp01 = v => Math.max(0, Math.min(1, v));

function sourceSize(source) {
  return {
    width: source.videoWidth || source.naturalWidth || source.width,
    height: source.videoHeight || source.naturalHeight || source.height,
  };
}

function polygonArea(pts) {
  let area = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const j = (i + 1) % pts.length;
    area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(area) / 2;
}

function pointInQuad(p, quad) {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const yi = quad[i].y, yj = quad[j].y, xi = quad[i].x, xj = quad[j].x;
    if ((yi > p.y) !== (yj > p.y) && p.x < (xj - xi) * (p.y - yi) / ((yj - yi) || 1e-6) + xi) inside = !inside;
  }
  return inside;
}

function scaleBarcodes(barcodes, sourceW, sourceH, canvasW, canvasH) {
  const sx = canvasW / (sourceW || 1);
  const sy = canvasH / (sourceH || 1);
  return (barcodes || []).map(code => {
    if (!code.boundingBox) return code;
    return {
      ...code,
      boundingBox: {
        x: code.boundingBox.x * sx,
        y: code.boundingBox.y * sy,
        width: code.boundingBox.width * sx,
        height: code.boundingBox.height * sy,
      },
    };
  });
}

function regionStats(gray, width, height, quadPx) {
  const minX = Math.max(0, Math.floor(Math.min(...quadPx.map(p => p.x))));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(...quadPx.map(p => p.x))));
  const minY = Math.max(0, Math.floor(Math.min(...quadPx.map(p => p.y))));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(...quadPx.map(p => p.y))));
  let n = 0, sum = 0, clip = 0, edge = 0, edgeN = 0, varAcc = 0;
  for (let y = minY; y <= maxY; y += 2) {
    for (let x = minX; x <= maxX; x += 2) {
      if (!pointInQuad({ x, y }, quadPx)) continue;
      const v = gray[y * width + x];
      sum += v;
      n += 1;
      if (v > 248) clip += 1;
      if (x > minX && y > minY && x < maxX && y < maxY) {
        const i = y * width + x;
        edge += Math.min(255, Math.abs((gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width]) - 4 * gray[i]));
        edgeN += 1;
      }
    }
  }
  const mean = n ? sum / n : 0;
  for (let y = minY; y <= maxY; y += 4) {
    for (let x = minX; x <= maxX; x += 4) {
      if (!pointInQuad({ x, y }, quadPx)) continue;
      const d = gray[y * width + x] - mean;
      varAcc += d * d;
    }
  }
  return {
    brightness: clamp01(mean / 255),
    glareRisk: n ? clip / n : 0,
    sharpness: clamp01((edge / Math.max(1, edgeN)) / 42),
    contrast: clamp01(Math.sqrt(varAcc / Math.max(1, n)) / 48),
  };
}

function scoreCandidate(norm, px, frameW, frameH, stats, barcodes = []) {
  const coverage = Math.max(
    Math.hypot(px[1].x - px[0].x, px[1].y - px[0].y) / frameW,
    Math.hypot(px[2].x - px[3].x, px[2].y - px[3].y) / frameW,
  );
  const area = polygonArea(norm);
  const width = Math.hypot(norm[1].x - norm[0].x, norm[1].y - norm[0].y);
  const height = Math.hypot(norm[3].x - norm[0].x, norm[3].y - norm[0].y);
  const aspect = width / (height || 1e-6);
  const marginOk = norm.every(p => p.x > 0.02 && p.x < 0.98 && p.y > 0.02 && p.y < 0.98);
  if (area < 0.06 || area > 0.9) return null;
  if (aspect < 0.35 || aspect > 3.6) return null;
  const barcodeBoost = barcodes.some(code => {
    const box = code.boundingBox;
    if (!box) return false;
    const cx = (box.x + box.width / 2) / frameW;
    const cy = (box.y + box.height / 2) / frameH;
    return pointInQuad({ x: cx, y: cy }, norm);
  }) ? 0.12 : 0;
  const aspectScore = 1 - Math.min(1, Math.abs(aspect - 1.6) / 2);
  const coverageScore = clamp01((coverage - 0.25) / 0.5);
  const areaScore = area > 0.12 && area < 0.7 ? 1 : 0.45;
  const confidence = clamp01(
    0.28 * coverageScore
    + 0.16 * aspectScore
    + 0.12 * areaScore
    + 0.10 * (marginOk ? 1 : 0)
    + 0.12 * stats.sharpness
    + 0.08 * stats.contrast
    + 0.10
    + barcodeBoost,
  );
  return {
    corners: orderCorners(norm),
    coverage,
    allCornersInsideSafeMargin: marginOk,
    confidence,
    stats,
    barcodeInside: barcodeBoost > 0,
  };
}

function readQuad(approx) {
  const pts = [];
  const data = approx.data32S || approx.data32F;
  if (!data || approx.rows !== 4) return null;
  for (let r = 0; r < 4; r += 1) {
    pts.push({ x: data[r * 2], y: data[r * 2 + 1] });
  }
  return pts;
}

function detectWithOpenCv(cv, canvas, barcodes) {
  const mats = [];
  const remember = mat => { mats.push(mat); return mat; };
  try {
    const src = remember(cv.imread(canvas));
    const gray = remember(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const blur = remember(new cv.Mat());
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    const edges = remember(new cv.Mat());
    cv.Canny(blur, edges, 50, 150);
    const kernel = remember(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
    cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
    const contours = remember(new cv.MatVector());
    const hierarchy = remember(new cv.Mat());
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const grayArr = gray.data ? new Uint8Array(gray.data) : new Uint8Array(0);
    const candidates = [];
    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i);
      const approx = new cv.Mat();
      try {
        const peri = cv.arcLength(contour, true);
        cv.approxPolyDP(contour, approx, 0.03 * peri, true);
        const convex = typeof cv.isContourConvex === 'function' ? cv.isContourConvex(approx) : true;
        if (approx.rows === 4 && convex) {
          const pts = readQuad(approx);
          if (pts) {
            const norm = pts.map(p => ({ x: p.x / canvas.width, y: p.y / canvas.height }));
            const stats = regionStats(grayArr, canvas.width, canvas.height, pts);
            const scored = scoreCandidate(norm, pts, canvas.width, canvas.height, stats, barcodes);
            if (scored) candidates.push(scored);
          }
        }
      } finally {
        approx.delete();
        contour.delete();
      }
    }
    candidates.sort((a, b) => b.confidence - a.confidence);
    const best = candidates[0] || null;
    const runnerUp = candidates[1];
    const ambiguous = !!(best && runnerUp && Math.abs(best.confidence - runnerUp.confidence) < 0.05 && runnerUp.confidence > 0.55);
    return {
      best,
      ambiguous,
      brightness: best?.stats.brightness,
      glareRisk: best?.stats.glareRisk,
      sharpness: best?.stats.sharpness,
    };
  } finally {
    mats.forEach(mat => { try { mat.delete(); } catch { /* already freed */ } });
  }
}

export class LabelCandidateDetector {
  constructor(config = {}) {
    this.config = { ...DEFAULT_THRESHOLDS, ...config };
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  detect(source, barcodes = []) {
    const { width: sw, height: sh } = sourceSize(source);
    if (!sw || !sh) return null;
    const width = Math.min(this.config.analysisWidth, sw);
    const height = Math.round(width * sh / sw);
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx.drawImage(source, 0, 0, width, height);
    if (!isOpenCvReady()) return null;
    try {
      return detectWithOpenCv(
        globalThis.cv,
        this.canvas,
        scaleBarcodes(barcodes, sw, sh, width, height),
      );
    } catch {
      return null;
    }
  }
}

import { DEFAULT_THRESHOLDS } from './thresholds.mjs';
import { loadImage } from './crop.mjs';
import { isOpenCvReady } from './opencv-loader.mjs';

export function orderCorners(points) {
  const pts = points.map(p => ({ x: p.x, y: p.y }));
  const byY = [...pts].sort((a, b) => a.y - b.y);
  const top = byY.slice(0, 2).sort((a, b) => a.x - b.x);
  const bottom = byY.slice(2).sort((a, b) => a.x - b.x);
  return [top[0], top[1], bottom[1], bottom[0]];
}

export function guideCorners(guide = DEFAULT_THRESHOLDS.guide) {
  return [
    { x: guide.x, y: guide.y },
    { x: guide.x + guide.width, y: guide.y },
    { x: guide.x + guide.width, y: guide.y + guide.height },
    { x: guide.x, y: guide.y + guide.height },
  ];
}

function solveHomography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i += 1) {
    const s = src[i], d = dst[i];
    A.push([s.x, s.y, 1, 0, 0, 0, -d.x * s.x, -d.x * s.y]);
    b.push(d.x);
    A.push([0, 0, 0, s.x, s.y, 1, -d.y * s.x, -d.y * s.y]);
    b.push(d.y);
  }
  const h = gaussian(A, b);
  return [...h, 1];
}

function gaussian(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i += 1) {
    let max = i;
    for (let r = i + 1; r < n; r += 1) if (Math.abs(M[r][i]) > Math.abs(M[max][i])) max = r;
    [M[i], M[max]] = [M[max], M[i]];
    const pivot = M[i][i] || 1e-12;
    for (let c = i; c <= n; c += 1) M[i][c] /= pivot;
    for (let r = 0; r < n; r += 1) {
      if (r === i) continue;
      const f = M[r][i];
      for (let c = i; c <= n; c += 1) M[r][c] -= f * M[i][c];
    }
  }
  return M.map(row => row[n]);
}

function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8] || 1;
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

export async function warpQuadToRect(dataUrl, cornersNormalized, config = DEFAULT_THRESHOLDS) {
  const image = typeof dataUrl === 'string' ? await loadImage(dataUrl) : dataUrl;
  const ordered = orderCorners(cornersNormalized);
  const src = ordered.map(p => ({ x: p.x * image.naturalWidth, y: p.y * image.naturalHeight }));
  const widthA = Math.hypot(src[1].x - src[0].x, src[1].y - src[0].y);
  const widthB = Math.hypot(src[2].x - src[3].x, src[2].y - src[3].y);
  const heightA = Math.hypot(src[3].x - src[0].x, src[3].y - src[0].y);
  const heightB = Math.hypot(src[2].x - src[1].x, src[2].y - src[1].y);
  let dw = Math.max(widthA, widthB);
  let dh = Math.max(heightA, heightB);
  const scale = Math.min(1, config.maxCaptureEdge / Math.max(dw, dh));
  dw = Math.max(32, Math.round(dw * scale));
  dh = Math.max(32, Math.round(dh * scale));
  if (isOpenCvReady()) {
    try {
      return warpWithOpenCv(image, ordered, dw, dh, config.captureJpegQuality);
    } catch { /* fall through to JS homography */ }
  }
  const dst = [{ x: 0, y: 0 }, { x: dw, y: 0 }, { x: dw, y: dh }, { x: 0, y: dh }];
  const H = solveHomography(dst, src);
  const canvas = document.createElement('canvas');
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext('2d');
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = image.naturalWidth;
  srcCanvas.height = image.naturalHeight;
  srcCanvas.getContext('2d').drawImage(image, 0, 0);
  const srcData = srcCanvas.getContext('2d').getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const out = ctx.createImageData(dw, dh);
  for (let y = 0; y < dh; y += 1) {
    for (let x = 0; x < dw; x += 1) {
      const p = applyH(H, x + 0.5, y + 0.5);
      const sx = Math.round(p.x);
      const sy = Math.round(p.y);
      const di = (y * dw + x) * 4;
      if (sx < 0 || sy < 0 || sx >= srcCanvas.width || sy >= srcCanvas.height) continue;
      const si = (sy * srcCanvas.width + sx) * 4;
      out.data[di] = srcData.data[si];
      out.data[di + 1] = srcData.data[si + 1];
      out.data[di + 2] = srcData.data[si + 2];
      out.data[di + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas.toDataURL('image/jpeg', config.captureJpegQuality);
}

function warpWithOpenCv(image, ordered, dw, dh, quality) {
  const cv = globalThis.cv;
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = image.naturalWidth;
  srcCanvas.height = image.naturalHeight;
  srcCanvas.getContext('2d').drawImage(image, 0, 0);
  const srcMat = cv.imread(srcCanvas);
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, ordered.flatMap(p => [
    p.x * image.naturalWidth,
    p.y * image.naturalHeight,
  ]));
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, dw, 0, dw, dh, 0, dh]);
  const transform = cv.getPerspectiveTransform(srcTri, dstTri);
  const dstMat = new cv.Mat();
  cv.warpPerspective(srcMat, dstMat, transform, new cv.Size(dw, dh));
  const outCanvas = document.createElement('canvas');
  outCanvas.width = dw;
  outCanvas.height = dh;
  cv.imshow(outCanvas, dstMat);
  srcMat.delete();
  dstMat.delete();
  transform.delete();
  srcTri.delete();
  dstTri.delete();
  return outCanvas.toDataURL('image/jpeg', quality);
}

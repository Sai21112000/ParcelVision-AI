import { DEFAULT_THRESHOLDS } from './thresholds.mjs';
import { loadImage } from './crop.mjs';
import { isOpenCvReady } from './opencv-loader.mjs';
import { processStill } from './final-processor.mjs';

export class BlurRejectedError extends Error {
  constructor(variance = 0) {
    super('Too blurry — hold still');
    this.name = 'BlurRejectedError';
    this.variance = variance;
  }
}

function canvasLaplacianVariance(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width: w, height: h } = canvas;
  const data = ctx.getImageData(0, 0, w, h).data;
  const gray = new Float64Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  let n = 0, sum = 0, sum2 = 0;
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      const i = y * w + x;
      const lap = gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w] - 4 * gray[i];
      sum += lap;
      sum2 += lap * lap;
      n += 1;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return (sum2 / n) - mean * mean;
}

function openCvLaplacianVariance(canvas) {
  const cv = globalThis.cv;
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  const lap = new cv.Mat();
  const mean = new cv.Mat();
  const std = new cv.Mat();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
    cv.Laplacian(gray, lap, cv.CV_64F);
    cv.meanStdDev(lap, mean, std);
    const sigma = std.data64F ? std.data64F[0] : std.data32F[0];
    return sigma * sigma;
  } finally {
    src.delete(); gray.delete(); lap.delete(); mean.delete(); std.delete();
  }
}

export async function laplacianVariance(dataUrl, maxEdge = 640) {
  const image = await loadImage(dataUrl);
  const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(32, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(32, Math.round(image.naturalHeight * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  if (isOpenCvReady()) {
    try {
      return openCvLaplacianVariance(canvas);
    } catch { /* canvas fallback */ }
  }
  return canvasLaplacianVariance(canvas);
}

export async function preProcessScannedDocument(originalDataUrl, options = {}) {
  const config = { ...DEFAULT_THRESHOLDS, ...options.config };
  const processed = await processStill(originalDataUrl, options);
  const variance = await laplacianVariance(processed.warped || processed.crop);
  if (variance < config.minLaplacianVariance) {
    throw new BlurRejectedError(variance);
  }

  // FUTURE: runLocalTesseractOCR(processed.crop)
  // e.g. check text density before network upload.

  return { ...processed, laplacianVariance: variance };
}

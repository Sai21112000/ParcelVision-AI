import { DEFAULT_THRESHOLDS } from './thresholds.mjs';
import { loadImage } from './crop.mjs';
import { guideCorners, warpQuadToRect } from './perspective.mjs';
import { isOpenCvReady } from './opencv-loader.mjs';
import { LabelCandidateDetector } from './label-detector.mjs';
import { qualityFailures } from './quality.mjs';

const detector = new LabelCandidateDetector();

export async function processStill(originalDataUrl, options = {}) {
  const config = { ...DEFAULT_THRESHOLDS, ...options.config };
  let corners = options.cornersNormalized?.length === 4 ? options.cornersNormalized : null;
  let detected = null;
  if (!corners) {
    const image = await loadImage(originalDataUrl);
    detected = detector.detect(image, options.barcodes || []);
    if (detected?.best?.corners) corners = detected.best.corners;
  }
  const usedGuide = !corners;
  if (!corners) corners = guideCorners(config.guide);
  const crop = await warpQuadToRect(originalDataUrl, corners, config);
  const cleaned = await binarizeDataUrl(crop, config);
  const quality = options.quality || {
    sharpness: detected?.sharpness ?? 0.5,
    brightness: detected?.brightness ?? 0.5,
    glareRisk: detected?.glareRisk ?? 0.05,
    stability: 1,
    stabilityDurationMs: config.stableDurationMs,
    labelCoverage: detected?.best?.coverage ?? config.guide.width,
    documentBoundaryConfidence: detected?.best?.confidence ?? (usedGuide ? 0.5 : 0.9),
    allCornersInsideSafeMargin: detected?.best?.allCornersInsideSafeMargin ?? true,
    forced: false,
    ambiguous: !!detected?.ambiguous,
  };
  const failures = qualityFailures(quality, config);
  return {
    crop: cleaned,
    warped: crop,
    original: originalDataUrl,
    cornersNormalized: corners,
    usedGuide,
    opencv: isOpenCvReady(),
    quality,
    failures,
    detectedLabel: {
      confidence: quality.documentBoundaryConfidence,
      cornersNormalized: corners,
      labelCoverage: quality.labelCoverage,
      wasManuallyAdjusted: !!options.wasManuallyAdjusted,
      ambiguous: !!quality.ambiguous,
    },
  };
}

export async function rewarp(originalDataUrl, cornersNormalized, config) {
  return processStill(originalDataUrl, { cornersNormalized, wasManuallyAdjusted: true, config });
}

export async function binarizeDataUrl(dataUrl, config = DEFAULT_THRESHOLDS) {
  const image = await loadImage(dataUrl);
  const maxEdge = Math.min(1600, config.maxCaptureEdge || 1920);
  const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
  const w = Math.max(32, Math.round(image.naturalWidth * scale));
  const h = Math.max(32, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, w, h);
  if (isOpenCvReady()) {
    try {
      const cv = globalThis.cv;
      const src = cv.imread(canvas);
      const gray = new cv.Mat();
      const dst = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
      const block = w > 800 ? 21 : 15;
      cv.adaptiveThreshold(gray, dst, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, 10);
      cv.imshow(canvas, dst);
      src.delete(); gray.delete(); dst.delete();
      return canvas.toDataURL('image/jpeg', config.captureJpegQuality);
    } catch { /* canvas fallback */ }
  }
  const data = ctx.getImageData(0, 0, w, h);
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = y > 150 ? 255 : y < 90 ? 0 : Math.round((y - 90) / 60 * 255);
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL('image/jpeg', config.captureJpegQuality);
}

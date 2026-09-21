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
    crop,
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

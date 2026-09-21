export const DEFAULT_THRESHOLDS = Object.freeze({
  analysisWidth: 640,
  analysisFps: 20,
  stableFrameCount: 10,
  maxCornerMovePx: 5,
  minSharpness: 0.12,
  minBrightness: 0.18,
  maxBrightness: 0.92,
  maxGlareRisk: 0.18,
  minLabelCoverage: 0.55,
  minBoundaryConfidence: 0.85,
  minStability: 0.86,
  stableDurationMs: 700,
  captureJpegQuality: 0.88,
  maxCaptureEdge: 1920,
  minLaplacianVariance: 50,
  guide: Object.freeze({ x: 0.10, y: 0.15, width: 0.80, height: 0.70 }),
});

export function thresholds(overrides = {}) {
  return {
    ...DEFAULT_THRESHOLDS,
    ...overrides,
    guide: { ...DEFAULT_THRESHOLDS.guide, ...(overrides.guide || {}) },
  };
}

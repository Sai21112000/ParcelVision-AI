export const DEFAULT_THRESHOLDS = Object.freeze({
  analysisWidth: 640,
  analysisFps: 6,
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
  guide: Object.freeze({ x: 0.10, y: 0.13, width: 0.80, height: 0.74 }),
});

export function thresholds(overrides = {}) {
  return {
    ...DEFAULT_THRESHOLDS,
    ...overrides,
    guide: { ...DEFAULT_THRESHOLDS.guide, ...(overrides.guide || {}) },
  };
}

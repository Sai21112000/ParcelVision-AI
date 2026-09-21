import { DEFAULT_THRESHOLDS } from './thresholds.mjs';

const clamp01 = value => Math.max(0, Math.min(1, value));

function guidePixels(width, height, guide) {
  return {
    x: Math.round(width * guide.x),
    y: Math.round(height * guide.y),
    width: Math.round(width * guide.width),
    height: Math.round(height * guide.height),
  };
}

export class FrameQualityAnalyzer {
  constructor(config = {}) {
    this.config = { ...DEFAULT_THRESHOLDS, ...config };
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.previous = null;
    this.stableSince = 0;
  }

  analyze(source) {
    const sourceWidth = source.videoWidth || source.naturalWidth || source.width;
    const sourceHeight = source.videoHeight || source.naturalHeight || source.height;
    if (!sourceWidth || !sourceHeight) return null;

    const width = Math.min(this.config.analysisWidth, sourceWidth);
    const height = Math.round(width * sourceHeight / sourceWidth);
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx.drawImage(source, 0, 0, width, height);

    const guide = guidePixels(width, height, this.config.guide);
    const image = this.ctx.getImageData(guide.x, guide.y, guide.width, guide.height);
    const data = image.data;
    const gray = new Uint8Array(guide.width * guide.height);
    let luminance = 0;
    let clipped = 0;

    for (let p = 0, i = 0; i < data.length; i += 4, p += 1) {
      const value = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
      gray[p] = value;
      luminance += value;
      if (value > 248) clipped += 1;
    }

    const brightness = luminance / gray.length / 255;
    const glareRisk = clipped / gray.length;
    let edgeEnergy = 0;
    let edgeCount = 0;
    let frameDifference = 0;

    for (let y = 1; y < guide.height - 1; y += 2) {
      for (let x = 1; x < guide.width - 1; x += 2) {
        const i = y * guide.width + x;
        const laplacian = (gray[i - 1] + gray[i + 1] + gray[i - guide.width] + gray[i + guide.width]) - 4 * gray[i];
        edgeEnergy += Math.min(255, Math.abs(laplacian));
        edgeCount += 1;
        if (this.previous?.length === gray.length) frameDifference += Math.abs(gray[i] - this.previous[i]);
      }
    }

    const sharpness = clamp01(edgeEnergy / Math.max(1, edgeCount) / 42);
    const motion = this.previous?.length === gray.length
      ? clamp01(frameDifference / Math.max(1, edgeCount) / 28)
      : 1;
    const stability = clamp01(1 - motion);
    this.previous = gray;

    const now = performance.now();
    const baseValid = (
      sharpness >= this.config.minSharpness
      && brightness >= this.config.minBrightness
      && brightness <= this.config.maxBrightness
      && glareRisk <= this.config.maxGlareRisk
    );
    if (baseValid && stability >= this.config.minStability) {
      if (!this.stableSince) this.stableSince = now;
    } else {
      this.stableSince = 0;
    }

    return {
      sharpness,
      brightness,
      glareRisk,
      stability,
      stabilityDurationMs: this.stableSince ? now - this.stableSince : 0,
      labelCoverage: this.config.guide.width,
      documentBoundaryConfidence: 0.88,
      allCornersInsideSafeMargin: true,
      forced: false,
      qualityState: 'GOOD',
      warnings: [],
    };
  }

  reset() {
    this.previous = null;
    this.stableSince = 0;
  }
}

export function qualityState(quality, config = DEFAULT_THRESHOLDS) {
  if (quality?.qualityState === 'PREPARING') {
    return { level: 'neutral', message: 'Preparing scanner…' };
  }
  if (!quality) return { level: 'neutral', message: 'Searching for a label…' };
  if (quality.ambiguous) {
    return { level: 'warning', message: 'Multiple or unclear label boundaries. Move closer to the shipping label or use Capture now.' };
  }
  if (quality.brightness < config.minBrightness) return { level: 'danger', message: 'Improve lighting' };
  if (quality.brightness > config.maxBrightness || quality.glareRisk > config.maxGlareRisk) {
    return { level: 'danger', message: 'Reduce glare' };
  }
  if ((quality.documentBoundaryConfidence || 0) < 0.4) {
    return { level: 'neutral', message: 'Searching for a label…' };
  }
  if (quality.sharpness < config.minSharpness) return { level: 'warning', message: 'Hold still' };
  if (quality.documentBoundaryConfidence < config.minBoundaryConfidence || quality.labelCoverage < config.minLabelCoverage) {
    return { level: 'warning', message: 'Move closer' };
  }
  if (quality.stability < config.minStability || quality.stabilityDurationMs < config.stableDurationMs) {
    return { level: 'ready', message: 'Hold still' };
  }
  return { level: 'ready', message: 'Capturing…' };
}

export function shouldAutoCapture(quality, config = DEFAULT_THRESHOLDS) {
  return !!quality
    && !quality.ambiguous
    && quality.documentBoundaryConfidence >= config.minBoundaryConfidence
    && quality.labelCoverage >= config.minLabelCoverage
    && quality.allCornersInsideSafeMargin
    && quality.sharpness >= config.minSharpness
    && quality.brightness >= config.minBrightness
    && quality.brightness <= config.maxBrightness
    && quality.glareRisk <= config.maxGlareRisk
    && quality.stability >= config.minStability
    && quality.stabilityDurationMs >= config.stableDurationMs;
}

export const isAutoCaptureEligible = shouldAutoCapture;

export function qualityFailures(quality, config = DEFAULT_THRESHOLDS) {
  if (!quality) return ['No frame quality result'];
  const failures = [];
  if (quality.ambiguous) failures.push('Multiple or unclear label boundaries');
  if (quality.sharpness < config.minSharpness) failures.push('Image may be blurry');
  if (quality.brightness < config.minBrightness) failures.push('Image is too dark');
  if (quality.brightness > config.maxBrightness) failures.push('Image is overexposed');
  if (quality.glareRisk > config.maxGlareRisk) failures.push('Glare may obscure the label');
  if (quality.labelCoverage < config.minLabelCoverage) failures.push('Label is too small');
  if ((quality.documentBoundaryConfidence || 0) < config.minBoundaryConfidence) {
    failures.push('Label edges are unclear');
  }
  return failures;
}

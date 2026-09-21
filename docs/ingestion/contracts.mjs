export const IngestionStatus = Object.freeze({
  CAPTURED: 'CAPTURED',
  PENDING_EXTRACTION: 'PENDING_EXTRACTION',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  READY_FOR_REVIEW: 'READY_FOR_REVIEW',
  FAILED: 'FAILED',
  CONFIRMED: 'CONFIRMED',
});

export const CaptureSource = Object.freeze({
  CAMERA: 'camera',
  UPLOAD: 'upload',
  MANUAL: 'manual',
});

export const SCANNER_VERSION = '2.2.0';

export const emptyDetectedLabel = () => ({
  confidence: 0,
  cornersNormalized: [],
  labelCoverage: 0,
  wasManuallyAdjusted: false,
  ambiguous: false,
});

export const emptyQuality = () => ({
  sharpness: 0,
  brightness: 0,
  glareRisk: 0,
  stability: 0,
  labelCoverage: 0,
  documentBoundaryConfidence: 0,
  allCornersInsideSafeMargin: true,
  forced: false,
  qualityState: 'SEARCHING',
  warnings: [],
});

export const emptyExtraction = () => ({
  labelUsable: false,
  labelCount: 0,
  carrier: { rawValue: null, normalizedValue: null, confidence: 0 },
  trackingNumber: {
    rawValue: null,
    normalizedValue: null,
    confidence: 0,
    visible: false,
    barcodeMatch: null,
  },
  recipient: {
    name: { rawValue: null, confidence: 0 },
    addressLines: [],
    postalCode: { rawValue: null, confidence: 0 },
    phone: { rawValue: null, confidence: 0 },
  },
  sender: { name: { rawValue: null, confidence: 0 }, addressLines: [] },
  referenceNumbers: [],
  serviceType: { rawValue: null, confidence: 0 },
  additionalFields: [],
  missingCriticalFields: [],
  requiresHumanReview: true,
  reviewReasons: [],
});

export function createIngestionRequest(source, deviceClass = 'mobile') {
  return {
    source,
    captureIntent: 'shipping_label',
    clientContext: {
      platform: 'web',
      deviceClass,
      scannerVersion: SCANNER_VERSION,
    },
  };
}

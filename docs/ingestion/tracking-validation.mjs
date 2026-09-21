const GENERIC_TRACKING = /^[A-Z0-9]{8,35}$/;

const CARRIER_PATTERNS = [
  { carrier: /Thailand Post|ไปรษณีย์ไทย/i, pattern: /^[A-Z]{2}\d{9}[A-Z]{2}$|^[A-Z0-9]{10,25}$/ },
  { carrier: /DHL/i, pattern: /^[A-Z0-9]{10,20}$/ },
  { carrier: /J&T/i, pattern: /^[A-Z0-9]{10,20}$/ },
  { carrier: /Flash/i, pattern: /^[A-Z0-9]{10,25}$/ },
  { carrier: /LEL|Lazada/i, pattern: /^[A-Z0-9]{10,25}$/ },
];

export const normalizeTracking = value => (value || '').toUpperCase().replace(/[\s-]/g, '');

export function validateTracking(value, carrier = '') {
  const normalized = normalizeTracking(value);
  if (!GENERIC_TRACKING.test(normalized)) {
    return { valid: false, normalized, reason: 'Tracking number has an invalid length or characters' };
  }
  const rule = CARRIER_PATTERNS.find(item => item.carrier.test(carrier));
  if (rule && !rule.pattern.test(normalized)) {
    return { valid: false, normalized, reason: 'Tracking number does not match the carrier format' };
  }
  return { valid: true, normalized, reason: '' };
}

export function compareTracking(ocrValue, barcodeValues = [], carrier = '') {
  const validated = validateTracking(ocrValue, carrier);
  const normalizedBarcodes = barcodeValues
    .map(value => normalizeTracking(value.rawValue))
    .filter(value => GENERIC_TRACKING.test(value));
  if (!normalizedBarcodes.length) {
    return { ...validated, barcodeMatch: null, barcodeValue: null, conflict: false };
  }
  const barcodeMatch = normalizedBarcodes.includes(validated.normalized);
  return {
    ...validated,
    barcodeMatch,
    barcodeValue: normalizedBarcodes[0],
    conflict: !!validated.normalized && !barcodeMatch,
  };
}

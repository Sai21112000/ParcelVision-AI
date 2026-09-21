import { GENERIC_TRACKING, normalizeTracking } from './tracking-validation.mjs';

const CARRIER_TERMS = [
  { name: 'Thailand Post', re: /thailand\s*post|ไปรษณีย์ไทย|thailandpost/i },
  { name: 'Kerry Express', re: /\bkerry\b/i },
  { name: 'J&T Express', re: /j\s*&\s*t|\bj&t\b|\bjnt\b/i },
  { name: 'Flash Express', re: /\bflash\b/i },
  { name: 'DHL Express', re: /\bdhl\b/i },
  { name: 'Lazada', re: /\blazada\b|\blel\b/i },
  { name: 'Shopee', re: /\bshopee\b/i },
  { name: 'Best Express', re: /\bbest\s*express\b/i },
  { name: 'Ninja Van', re: /\bninja\b/i },
  { name: 'SCG Express', re: /\bscg\b/i },
  { name: 'FedEx Express', re: /\bfedex\b/i },
];

const DATE_RE = /\b(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})\b/;
const WEIGHT_RE = /\b\d+(?:[.,]\d+)?\s?(?:kg|g|lb|oz)\b/i;

export function trackingCandidatesFrom(text) {
  const upper = (text || '').toUpperCase();
  const found = new Set();
  for (const token of upper.match(/[A-Z0-9]{8,35}/g) || []) {
    const normalized = normalizeTracking(token);
    if (GENERIC_TRACKING.test(normalized) && /\d/.test(normalized)) found.add(normalized);
  }
  return [...found];
}

export function analyzeLabelText(text) {
  const raw = text || '';
  const trackingCandidates = trackingCandidatesFrom(raw);
  const carriers = CARRIER_TERMS.filter(term => term.re.test(raw)).map(term => term.name);
  const date = raw.match(DATE_RE)?.[0] || '';
  const weight = raw.match(WEIGHT_RE)?.[0] || '';
  const ok = trackingCandidates.length > 0 || carriers.length > 0;
  return {
    ok,
    trackingCandidates,
    carriers,
    date,
    weight,
    warning: ok
      ? ''
      : 'No tracking number or carrier name was found. Center the shipping label and retake.',
  };
}

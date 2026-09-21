// Local preview + Gemini proxy for ParcelVision AI.
// Run from the repo root:  node serve.mjs
// Reads .env next to this file. API key never ships to GitHub Pages.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IngestionStatus, emptyDetectedLabel } from './docs/ingestion/contracts.mjs';
import { compareTracking, normalizeTracking } from './docs/ingestion/tracking-validation.mjs';
import { MOCK_SHOTS, mockToExtraction } from './docs/ingestion/mock-shots.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DOCS = join(ROOT, 'docs');

function loadEnv() {
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch { /* no .env — OCR falls back to demo mode */ }
}
loadEnv();

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.mjs': 'text/javascript' };

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const KEY = process.env.GEMINI_API_KEY;
const MAX_BODY = 12 * 1024 * 1024;
const ingestions = new Map();
let ingestSeq = 0;

const PROMPT = `You are reading a still photograph of a shipping label from a mail room in Bangkok.
Extract only text visibly present in the image. Never invent, complete, or guess unreadable values.
Return empty strings when a field is absent. Preserve raw visible text separately from any normalised value.
Confidence is 0..1: >= 0.9 only when plainly legible, 0.6..0.89 when readable but blurry, below 0.6 when guessing.
Flag labelCount > 1 if more than one shipping label is visible. Set labelUsable false if no label is readable.
unit_raw, parcel_type, condition, and cod_amount are ParcelVision extensions: copy the floor/department line verbatim; judge parcel type and condition from the parcel in the photo.`;

const scored = (description, values) => ({
  type: 'OBJECT',
  properties: {
    rawValue: { type: 'STRING', description },
    normalizedValue: values ? { type: 'STRING', enum: values } : { type: 'STRING' },
    confidence: { type: 'NUMBER' },
  },
  required: ['rawValue', 'normalizedValue', 'confidence'],
});

const schemaFrom = (e = {}) => ({
  type: 'OBJECT',
  properties: {
    labelUsable: { type: 'BOOLEAN' },
    labelCount: { type: 'INTEGER' },
    carrier: scored('carrier as printed', e.carriers),
    trackingNumber: {
      type: 'OBJECT',
      properties: {
        rawValue: { type: 'STRING' },
        normalizedValue: { type: 'STRING' },
        confidence: { type: 'NUMBER' },
        visible: { type: 'BOOLEAN' },
      },
      required: ['rawValue', 'normalizedValue', 'confidence', 'visible'],
    },
    recipientName: scored('addressee name'),
    recipientAddress: { type: 'STRING' },
    senderName: scored('sender or shop name'),
    unit_raw: scored('floor / department line, verbatim'),
    parcel_type: scored('parcel size or kind', e.types),
    condition: scored('visible parcel condition', e.conditions),
    cod_amount: scored('cash-on-delivery amount, digits only'),
    missingCriticalFields: { type: 'ARRAY', items: { type: 'STRING' } },
    requiresHumanReview: { type: 'BOOLEAN' },
    reviewReasons: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['labelUsable', 'labelCount', 'carrier', 'trackingNumber', 'recipientName', 'unit_raw', 'parcel_type', 'condition', 'senderName', 'requiresHumanReview', 'reviewReasons', 'missingCriticalFields'],
});

const json = (res, obj, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function publicIngestion(row) {
  return {
    ingestionId: row.id,
    status: row.status,
    captureQuality: { overall: row.forced || row.status === IngestionStatus.REVIEW_REQUIRED ? 'REVIEW' : 'GOOD', ...(row.captureQuality || {}) },
    barcodeValues: row.barcodeValues || [],
    detectedLabel: row.detectedLabel || emptyDetectedLabel(),
    scannerVersion: row.scannerVersion || row.clientContext?.scannerVersion || '2.0.0',
    extraction: row.extraction,
  };
}

function toExtraction(model) {
  const blank = (obj = {}) => ({
    rawValue: obj.rawValue || obj.normalizedValue || '',
    normalizedValue: obj.normalizedValue || obj.rawValue || '',
    confidence: typeof obj.confidence === 'number' ? obj.confidence : 0,
  });
  const tracking = blank(model.trackingNumber);
  tracking.normalizedValue = normalizeTracking(tracking.normalizedValue || tracking.rawValue);
  if (!tracking.normalizedValue) tracking.confidence = 0;
  return {
    labelUsable: !!model.labelUsable && !!tracking.normalizedValue,
    labelCount: model.labelCount || 1,
    carrier: blank(model.carrier),
    trackingNumber: { ...tracking, visible: !!tracking.normalizedValue, barcodeMatch: null },
    recipient: {
      name: { rawValue: model.recipientName?.rawValue || model.recipientName?.normalizedValue || '', confidence: model.recipientName?.confidence || 0 },
      addressLines: model.recipientAddress ? [{ value: model.recipientAddress, confidence: 0.7 }] : [],
      postalCode: { rawValue: null, confidence: 0 },
      phone: { rawValue: null, confidence: 0 },
    },
    sender: { name: { rawValue: model.senderName?.rawValue || '', confidence: model.senderName?.confidence || 0 }, addressLines: [] },
    referenceNumbers: [],
    serviceType: { rawValue: null, confidence: 0 },
    additionalFields: [
      { key: 'unit_raw', value: model.unit_raw?.rawValue || '', confidence: model.unit_raw?.confidence || 0 },
      { key: 'parcel_type', value: model.parcel_type?.normalizedValue || model.parcel_type?.rawValue || '', confidence: model.parcel_type?.confidence || 0 },
      { key: 'condition', value: model.condition?.normalizedValue || model.condition?.rawValue || '', confidence: model.condition?.confidence || 0 },
      { key: 'cod_amount', value: model.cod_amount?.rawValue || '', confidence: model.cod_amount?.confidence || 0 },
    ],
    missingCriticalFields: model.missingCriticalFields || [],
    requiresHumanReview: !!model.requiresHumanReview,
    reviewReasons: model.reviewReasons || [],
  };
}

async function geminiExtract(images, enums, ocrHint) {
  const parts = images.map(image => ({ inline_data: { mime_type: image.mimeType, data: image.data } }));
  if (ocrHint) {
    parts.push({
      text: 'A local Tesseract.js pass produced this hint. Prefer the photograph when they disagree.\n'
        + String(ocrHint).slice(0, 2500),
    });
  }
  parts.push({ text: PROMPT });
  const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schemaFrom(enums),
        temperature: 0,
      },
    }),
  });
  const text = await upstream.text();
  if (!upstream.ok) throw new Error('Gemini: ' + text.slice(0, 600));
  const data = JSON.parse(text);
  const cand = data.candidates?.[0];
  const out = (cand?.content?.parts || []).map(p => p.text).filter(Boolean).join('');
  if (!out) throw new Error('Gemini returned no data (finishReason: ' + (cand?.finishReason || 'unknown') + ')');
  return toExtraction(JSON.parse(out));
}

function finalizeExtraction(row, extraction) {
  const compared = compareTracking(
    extraction.trackingNumber?.normalizedValue,
    row.barcodeValues,
    extraction.carrier?.normalizedValue || extraction.carrier?.rawValue,
  );
  extraction.trackingNumber.barcodeMatch = compared.barcodeMatch;
  if (compared.normalized && compared.valid) extraction.trackingNumber.normalizedValue = compared.normalized;
  const reasons = [...(extraction.reviewReasons || [])];
  if (row.forced) reasons.push('Image was submitted despite a quality failure');
  if (row.labelMetrics && row.labelMetrics.ok === false) {
    reasons.push('Local OCR did not find a tracking number or carrier name');
  }
  if (compared.conflict) reasons.push('Barcode and OCR tracking numbers conflict');
  if (!extraction.trackingNumber.normalizedValue) reasons.push('Tracking number is missing or invalid');
  if (extraction.labelCount > 1) reasons.push('Multiple labels visible');
  extraction.reviewReasons = [...new Set(reasons)];
  extraction.requiresHumanReview = extraction.requiresHumanReview
    || extraction.reviewReasons.length > 0
    || compared.conflict
    || (extraction.trackingNumber.confidence || 0) < 0.9;
  row.extraction = extraction;
  row.status = extraction.requiresHumanReview ? IngestionStatus.REVIEW_REQUIRED : IngestionStatus.READY_FOR_REVIEW;
}

function splitDataUrl(dataUrl) {
  if (!dataUrl) return null;
  const match = String(dataUrl).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (match) return { mimeType: match[1], data: match[2] };
  return { mimeType: 'image/jpeg', data: String(dataUrl).split(',')[1] || dataUrl };
}

async function extractIngestion(row, enums) {
  row.status = IngestionStatus.PENDING_EXTRACTION;
  const crop = splitDataUrl(row.crop || row.original);
  if (!crop?.data) throw new Error('No image in the request');
  let extraction;
  if (!KEY) {
    const shot = MOCK_SHOTS[row.mockIndex % MOCK_SHOTS.length];
    extraction = mockToExtraction(shot);
    if (shot.barcode && !row.barcodeValues?.length) {
      row.barcodeValues = [{ format: 'CODE_128', rawValue: shot.barcode }];
    }
  } else {
    const images = [{ mimeType: crop.mimeType, data: crop.data }];
    const confidence = row.detectedLabel?.confidence ?? row.captureQuality?.documentBoundaryConfidence ?? 1;
    const original = splitDataUrl(row.original);
    if (confidence < 0.85 && original?.data && original.data !== crop.data) {
      images.push({ mimeType: original.mimeType, data: original.data });
    }
    extraction = await geminiExtract(images, enums, row.localOcrText);
  }
  finalizeExtraction(row, extraction);
  return publicIngestion(row);
}

createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  if (url === '/api/ocr-status') return json(res, { enabled: !!KEY, model: MODEL });

  if (url === '/api/parcel-ingestions' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req).catch(() => '{}') || '{}');
    const id = 'ing_' + (++ingestSeq);
    ingestions.set(id, {
      id,
      status: IngestionStatus.CAPTURED,
      source: body.source || 'camera',
      captureIntent: body.captureIntent || 'shipping_label',
      clientContext: body.clientContext || {},
      scannerVersion: body.clientContext?.scannerVersion || '2.0.0',
      mockIndex: ingestSeq - 1,
      barcodeValues: [],
      captureQuality: {},
      detectedLabel: emptyDetectedLabel(),
      forced: false,
      localOcrText: '',
      labelMetrics: null,
      original: '',
      crop: '',
      extraction: null,
    });
    return json(res, { ingestionId: id, uploadUrl: '/api/parcel-ingestions/' + id + '/images', status: IngestionStatus.CAPTURED });
  }

  const match = url.match(/^\/api\/parcel-ingestions\/([^/]+)(?:\/(images|metadata|extract))?$/);
  if (match) {
    const row = ingestions.get(match[1]);
    if (!row) return json(res, { error: 'ingestion not found' }, 404);
    const action = match[2];
    if (!action && req.method === 'GET') return json(res, publicIngestion(row));
    if (action === 'images' && req.method === 'PUT') {
      const body = JSON.parse(await readBody(req));
      row.original = body.original || '';
      row.crop = body.crop || body.original || '';
      return json(res, { ok: true, ingestionId: row.id });
    }
    if (action === 'metadata' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      row.barcodeValues = body.barcodeValues || [];
      row.captureQuality = body.captureQuality || {};
      row.forced = !!body.forced;
      row.detectedLabel = body.detectedLabel || row.detectedLabel || emptyDetectedLabel();
      row.scannerVersion = body.scannerVersion || row.scannerVersion || '2.0.0';
      row.localOcrText = body.localOcrText || '';
      row.labelMetrics = body.labelMetrics || null;
      return json(res, { ok: true, ingestionId: row.id });
    }
    if (action === 'extract' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req).catch(() => '{}') || '{}');
      try {
        return json(res, await extractIngestion(row, body.enums || {}));
      } catch (e) {
        row.status = IngestionStatus.FAILED;
        return json(res, { error: e.message || String(e) }, 502);
      }
    }
    return json(res, { error: 'Method not allowed' }, 405);
  }

  if (url === '/api/ocr') {
    if (req.method !== 'POST') return json(res, { error: 'Use POST' }, 405);
    const body = JSON.parse(await readBody(req));
    const id = 'ing_' + (++ingestSeq);
    const row = {
      id, status: IngestionStatus.CAPTURED, source: 'upload', mockIndex: ingestSeq - 1,
      barcodeValues: [], captureQuality: {}, forced: false,
      original: 'data:' + (body.mimeType || 'image/jpeg') + ';base64,' + body.imageBase64,
      crop: 'data:' + (body.mimeType || 'image/jpeg') + ';base64,' + body.imageBase64,
      extraction: null,
    };
    ingestions.set(id, row);
    try {
      const result = await extractIngestion(row, body.enums || {});
      const add = key => (result.extraction.additionalFields || []).find(f => f.key === key) || {};
      return json(res, {
        tracking_no: result.extraction.trackingNumber,
        carrier: result.extraction.carrier,
        recipient: result.extraction.recipient.name,
        unit_raw: { value: add('unit_raw').value, confidence: add('unit_raw').confidence },
        parcel_type: { value: add('parcel_type').value, confidence: add('parcel_type').confidence },
        condition: { value: add('condition').value, confidence: add('condition').confidence },
        sender: result.extraction.sender.name,
      });
    } catch (e) {
      return json(res, { error: e.message || String(e) }, 502);
    }
  }

  const requested = url === '/' ? 'index.html' : url.replace(/^\//, '');
  const filePath = resolve(DOCS, requested);
  if (!filePath.startsWith(resolve(DOCS) + '/') && filePath !== resolve(DOCS)) {
    res.writeHead(404).end('not found');
    return;
  }

  let file, body;
  try {
    body = await readFile(filePath);
    file = requested;
  } catch {
    res.writeHead(404).end('not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}).listen(8899, () => console.log(`preview server on http://localhost:8899 — OCR ${KEY ? 'ready (' + MODEL + ')' : 'off (no GEMINI_API_KEY) → demo mode'}`));

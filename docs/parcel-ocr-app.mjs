import { CameraSession, fileToDataUrl } from './ingestion/camera.mjs';
import { FrameQualityAnalyzer, qualityFailures } from './ingestion/quality.mjs';
import { DEFAULT_THRESHOLDS } from './ingestion/thresholds.mjs';
import { BarcodeScanner } from './ingestion/barcode.mjs';
import { cropGuideRegion, loadImage } from './ingestion/crop.mjs';
import { IngestionClient } from './ingestion/client.mjs';
import { CaptureSource, SCANNER_VERSION } from './ingestion/contracts.mjs';
import { compareTracking, normalizeTracking } from './ingestion/tracking-validation.mjs';
import { track } from './ingestion/telemetry.mjs';
import { MOCK_SHOTS } from './ingestion/mock-shots.mjs';
import { loadOpenCv } from './ingestion/opencv-loader.mjs';
import { processStill, rewarp } from './ingestion/final-processor.mjs';
import { PerspectiveCropEditor } from './ingestion/crop-editor.mjs';
import { guideCorners, fullFrameCorners } from './ingestion/perspective.mjs';
import { enhanceForUpload, highContrastForOcr } from './ingestion/enhance.mjs';
import { recognizeLabel, disposeOcrWorker, isOcrReady } from './ingestion/tesseract-ocr.mjs';
import { analyzeLabelText } from './ingestion/label-metrics.mjs';

const CARRIERS = [
  'Thailand Post (001/2021)', 'Kerry Express (002/2021)',
  'J&T Express (003/2021)', 'Flash Express (004/2021)',
  'DHL Express (005/2021)', 'Lazada (006/2021)',
  'Shopee (007/2021)', 'Best Express (008/2021)',
  'LEL Express (009/2021)', 'Ninja Van (010/2021)',
  'SCG Express (011/2021)', 'FedEx Express (012/2021)',
];
const TYPES = ['Small parcel', 'Medium parcel', 'Large parcel (>5 kg)', 'Envelope', 'Bag', 'Small Box'];
const CONDITIONS = ['Appears Fine', 'Minor Damage', 'Moderate Damage', 'Major Damage', 'Water Damage'];
const UNITS = [
  { code: '21F-MKT', name: 'Floor 21 · Marketing' },
  { code: '18F-FIN', name: 'Floor 18 · Finance' },
  { code: '24F-ENG', name: 'Floor 24 · Engineering' },
  { code: '12F-HRD', name: 'Floor 12 · HR' },
  { code: '9F-CS',   name: 'Floor 9 · Customer Service' },
];
const STAFF = {
  '21F-MKT': ['K.Tomoya Sakai', 'K.Ratchadawan P.', 'K.Nattapong S.'],
  '18F-FIN': ['K.Pitcha W.', 'K.Somchai T.', 'K.Ornuma L.'],
  '24F-ENG': ['K.Priwach T.', 'K.Theerapat K.', 'K.Aphirak N.'],
  '12F-HRD': ['K.Monthartip K.', 'K.Sasithorn B.'],
  '9F-CS':   ['K.Jirayu M.', 'K.Benjaporn R.'],
};
const EXISTING_TRACKINGS = ['LEXPU0703471485'];
const T_AUTO = 0.90, T_CHECK = 0.60;
const FIELDS = [
  { k: 'tracking',  label: 'Tracking number' },
  { k: 'carrier',   label: 'Carrier' },
  { k: 'recipient', label: 'Recipient' },
  { k: 'unit',      label: 'Floor / department' },
  { k: 'type',      label: 'Type / size' },
  { k: 'condition', label: 'Condition' },
  { k: 'sender',    label: 'Sender / shop', opt: true },
];
const ENUMS = { carriers: CARRIERS, types: TYPES, conditions: CONDITIONS };

function fieldState(confidence) {
  if (confidence >= T_AUTO) return 'auto';
  if (confidence >= T_CHECK) return 'check';
  return 'pick';
}
const norm = s => (s || '').toString().toLowerCase().replace(/[^a-z0-9ก-๙]+/g, ' ').trim();
function unitScore(raw, unit) {
  const r = norm(raw), t = norm(unit.code + ' ' + unit.name);
  const rd = r.match(/\d+/g) || [], td = t.match(/\d+/g) || [];
  let score = rd.filter(d => td.includes(d)).length * 2;
  const tw = new Set(t.split(' ').filter(w => w.length > 2));
  score += r.split(' ').filter(w => w.length > 2 && tw.has(w)).length;
  return score;
}
const unitText = u => u.name + ' (' + u.code + ')';
function matchUnits(raw, n = 3) {
  return UNITS.map(u => ({ u, s: unitScore(raw, u) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map(x => unitText(x.u));
}

function parcelPhoto(seed) {
  const hue = [28, 34, 20, 40, 15, 45][seed % 6];
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180">' +
    '<rect width="240" height="180" fill="#2b2f33"/>' +
    '<rect x="26" y="34" width="188" height="120" rx="6" fill="hsl(' + hue + ',45%,58%)"/>' +
    '<rect x="26" y="78" width="188" height="10" fill="hsl(' + hue + ',40%,48%)" opacity=".7"/>' +
    '<rect x="58" y="52" width="124" height="74" rx="3" fill="#fdfdfd"/>' +
    '<rect x="66" y="60" width="70" height="6" fill="#9aa0a6"/>' +
    '<rect x="66" y="72" width="46" height="5" fill="#c3c7cb"/>' +
    Array.from({ length: 22 }, (_, i) =>
      '<rect x="' + (67 + i * 5) + '" y="88" width="' + (i % 3 ? 2 : 3) + '" height="22" fill="#1c1f23"/>').join('') +
    '<rect x="66" y="114" width="86" height="5" fill="#9aa0a6"/>' +
    '</svg>';
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

let queue = [], seq = 0, openId = null, batchNo = 1621, parcelSeq = 15630;
let OCR = { enabled: false, model: '' };
let pendingCapture = null;
let analyzing = false;
let cropEditor = null;
let cropEditorSnapshot = null;
let previewFailures = [];

const client = new IngestionClient();
const camera = new CameraSession(document.getElementById('sm-cam'));
const analyzer = new FrameQualityAnalyzer();
const barcodes = new BarcodeScanner();

function buildItem(shot, id, photo) {
  const unitTop = matchUnits(shot.unit_raw[0] || '');
  const unitCode = (unitTop[0] || '').match(/\(([^)]+)\)$/)?.[1] || '';
  const fields = {
    tracking:  { value: shot.tracking[0],  conf: shot.tracking[1],  alts: [] },
    carrier:   { value: shot.carrier[0],   conf: shot.carrier[1],   alts: altsFor(CARRIERS, shot.carrier[0]) },
    recipient: { value: shot.recipient[0], conf: shot.recipient[1], alts: (STAFF[unitCode] || []) },
    unit:      { value: unitTop[0] || '',  conf: shot.unit_raw[1],  alts: unitTop, raw: shot.unit_raw[0] },
    type:      { value: shot.type[0],      conf: shot.type[1],      alts: altsFor(TYPES, shot.type[0]) },
    condition: { value: shot.condition[0], conf: shot.condition[1], alts: altsFor(CONDITIONS, shot.condition[0]) },
    sender:    { value: shot.sender[0],    conf: shot.sender[1],    alts: [] },
  };
  Object.values(fields).forEach(f => { f.resolved = false; });
  return { id, photo: photo || parcelPhoto(id), fields, acknowledged: false, dupOk: false, status: 'reading', barcodeConflict: false, conflictResolved: false, reviewRequired: false, reviewReasons: [] };
}
const altsFor = (list, value) => {
  const i = Math.max(0, list.indexOf(value));
  return [list[i], list[(i + 1) % list.length], list[(i + 2) % list.length]];
};
function needsAttention(f) { return fieldState(f.conf) !== 'auto' && !f.resolved; }
function pendingPick(item) { return FIELDS.some(({ k }) => fieldState(item.fields[k].conf) === 'pick' && !item.fields[k].resolved); }
function itemStatus(item) {
  if (item.status === 'reading' || item.status === 'error') return item.status;
  if (item.barcodeConflict && !item.conflictResolved) return 'review';
  if (pendingPick(item)) return 'review';
  const hasCheck = FIELDS.some(({ k }) => fieldState(item.fields[k].conf) === 'check' && !item.fields[k].resolved);
  return (hasCheck && !item.acknowledged) || item.reviewRequired && !item.acknowledged ? 'review' : 'ready';
}
const isDuplicate = tracking => EXISTING_TRACKINGS.includes(tracking);

function additional(extraction, key) {
  return (extraction.additionalFields || []).find(f => f.key === key) || { value: '', confidence: 0 };
}
function fromExtraction(extraction) {
  const tracking = normalizeTracking(extraction.trackingNumber?.normalizedValue || extraction.trackingNumber?.rawValue || '');
  const conf = tracking ? (extraction.trackingNumber?.confidence || 0) : 0;
  const unit = additional(extraction, 'unit_raw');
  const type = additional(extraction, 'parcel_type');
  const condition = additional(extraction, 'condition');
  return {
    tracking:  [tracking, tracking ? conf : 0],
    carrier:   [extraction.carrier?.normalizedValue || extraction.carrier?.rawValue || '', extraction.carrier?.confidence || 0],
    recipient: [extraction.recipient?.name?.rawValue || '', extraction.recipient?.name?.confidence || 0],
    unit_raw:  [unit.value || extraction.recipient?.addressLines?.[0]?.value || '', unit.confidence || extraction.recipient?.addressLines?.[0]?.confidence || 0],
    type:      [type.value || '', type.confidence || 0],
    condition: [condition.value || '', condition.confidence || 0],
    sender:    [extraction.sender?.name?.rawValue || '', extraction.sender?.name?.confidence || 0],
  };
}

async function loadOcrStatus() {
  try { OCR = await (await fetch('/api/ocr-status')).json(); } catch { OCR = { enabled: false, model: '' }; }
  document.getElementById('sm-mode').innerHTML = OCR.enabled
    ? '<span class="tis-badge-outline-success tis-badge-sm">Gemini · ' + OCR.model + '</span>'
    : '<span class="tis-badge-outline-warning tis-badge-sm">Demo mode · no API key</span>';
}

function showPanel(name) {
  document.getElementById('sm-camera-entry').hidden = name !== 'entry';
  document.getElementById('sm-scanner').hidden = name !== 'scanner';
  document.getElementById('sm-capture-preview').hidden = name !== 'preview';
}

const camMessage = err => {
  const safariHint = '<br>On iPhone/iPad: Settings → Safari → Camera. On Mac: allow the camera, or connect Continuity Camera, then try again. You can also Upload an image.';
  if (!navigator.mediaDevices) return 'The camera needs https or localhost.' + safariHint;
  if (err && err.name === 'NotAllowedError') return 'Camera permission was blocked.' + safariHint;
  if (err && err.name === 'NotFoundError') return 'No camera was found. Use Continuity Camera, plug in a webcam, or Upload an image.';
  if (err && err.name === 'NotReadableError') return 'The camera is in use by another app. Close it, or try Continuity Camera / Upload.';
  return 'Could not open the camera: ' + ((err && err.message) || 'unknown error') + safariHint;
};

function stopCameraTracks() {
  camera.stop();
  document.getElementById('sm-view').classList.remove('is-live', 'is-quad');
  setBusy(false);
}

function closeScanner() {
  stopCameraTracks();
  document.getElementById('sm-crop-editor').hidden = true;
  showPanel('entry');
  track('camera_closed');
}

function setBusy(on, message) {
  analyzing = on;
  const overlay = document.getElementById('sm-capture-processing');
  const col = document.querySelector('.sm-capture-col');
  const snap = document.getElementById('sm-snap');
  if (overlay) overlay.hidden = !on;
  if (col) col.classList.toggle('is-busy', on);
  if (snap) snap.disabled = on;
  if (message) {
    const processing = document.getElementById('sm-processing-text');
    if (processing) processing.textContent = message;
    const quality = document.getElementById('sm-quality-text');
    if (quality) quality.textContent = message;
  }
}

function idleScannerMessage() {
  document.getElementById('sm-quality-text').textContent = 'Align the label, then tap SNAP LABEL';
  document.getElementById('sm-quality').dataset.level = 'neutral';
  const coach = document.getElementById('sm-view-coach');
  if (coach) coach.textContent = 'Center the shipping label in the frame';
  document.getElementById('sm-view').dataset.quality = 'neutral';
}

async function continueToCamera() {
  hideManualEntry();
  document.getElementById('sm-crop-editor').hidden = true;
  showPanel('scanner');
  track('camera_opened');
  const view = document.getElementById('sm-view');
  idleScannerMessage();
  try {
    await camera.start('environment');
    view.classList.add('is-live');
    await barcodes.initialize();
    track('camera_permission_granted');
  } catch (err) {
    view.classList.remove('is-live');
    document.getElementById('sm-cam-msg').innerHTML = camMessage(err);
    track('camera_permission_denied', { reason: err.name || String(err) });
  }
}

function fallbackQuality() {
  return {
    sharpness: 0.5, brightness: 0.5, glareRisk: 0.05, stability: 1,
    labelCoverage: DEFAULT_THRESHOLDS.guide.width, documentBoundaryConfidence: 0.5,
    allCornersInsideSafeMargin: true, forced: false,
  };
}

function renderPreviewOcr(text, metrics) {
  const pre = document.getElementById('sm-ocr-text');
  const warn = document.getElementById('sm-ocr-warning');
  const extra = document.getElementById('sm-ocr-extras');
  if (pre) pre.textContent = text || 'No text detected in the frame.';
  if (warn) {
    warn.hidden = !metrics || metrics.ok;
    warn.textContent = metrics?.warning || '';
  }
  if (extra) {
    const bits = [];
    if (metrics?.trackingCandidates?.length) bits.push('Tracking-like: ' + metrics.trackingCandidates[0]);
    if (metrics?.carriers?.length) bits.push('Carrier: ' + metrics.carriers.join(', '));
    if (metrics?.date) bits.push('Date: ' + metrics.date);
    if (metrics?.weight) bits.push('Weight: ' + metrics.weight);
    if (metrics?.ocrConfidence > 0) bits.push('OCR ' + Math.round(metrics.ocrConfidence) + '%');
    extra.textContent = bits.join(' · ');
    extra.hidden = !bits.length;
  }
}

async function runLocalOcr(geometricCrop, onStatus) {
  try {
    const ocrImage = await highContrastForOcr(geometricCrop);
    return await recognizeLabel(ocrImage, onStatus);
  } catch (err) {
    console.error('Local OCR failed', err);
    return { text: '', confidence: 0, trackingText: '' };
  }
}

async function applyEnhancementAndOcr(pending) {
  pending.crop = await enhanceForUpload(pending.geometricCrop);
  const probe = await loadImage(pending.crop).catch(() => null);
  pending.barcodeValues = probe ? await barcodes.detect(probe) : [];
  const ocr = await runLocalOcr(pending.geometricCrop, msg => setBusy(true, msg));
  pending.localOcrText = ocr.text || '';
  pending.labelMetrics = analyzeLabelText(pending.localOcrText);
  pending.labelMetrics.ocrConfidence = ocr.confidence || 0;
  const failures = qualityFailures(pending.quality);
  if (!pending.labelMetrics.ok) failures.push(pending.labelMetrics.warning);
  document.getElementById('sm-preview-crop').src = pending.crop;
  document.getElementById('sm-preview-original').src = pending.original;
  renderPreviewQuality(failures, pending.barcodeValues);
  renderPreviewOcr(pending.localOcrText, pending.labelMetrics);
  return failures;
}

function previewImageSrc(kind) {
  if (kind === 'original') {
    return pendingCapture?.original || document.getElementById('sm-preview-original')?.src || '';
  }
  return pendingCapture?.crop || document.getElementById('sm-preview-crop')?.src || '';
}

async function downloadImage(src, basename = 'parcel-label') {
  if (!src) return;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const ext = /image\/png/i.test(src) ? 'png' : 'jpg';
  const name = `${basename}-${stamp}.${ext}`;
  try {
    const blob = await (await fetch(src)).blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1500);
  } catch {
    const a = document.createElement('a');
    a.href = src;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

async function downloadPreviewImage(kind) {
  await downloadImage(
    previewImageSrc(kind),
    kind === 'original' ? 'parcel-original' : 'parcel-enhanced',
  );
}

function sheetPhotoSrc() {
  const item = queue.find(i => i.id === openId);
  return item?.photo
    || document.getElementById('sm-sheet-photo')?.src
    || document.getElementById('sm-photo-lightbox-img')?.src
    || '';
}

async function downloadSheetPhoto() {
  await downloadImage(sheetPhotoSrc(), 'parcel-review');
}

function previewSheetPhoto() {
  const src = sheetPhotoSrc();
  if (!src) return;
  document.getElementById('sm-photo-lightbox-img').src = src;
  document.getElementById('sm-photo-lightbox').hidden = false;
}

function closePhotoPreview() {
  const host = document.getElementById('sm-photo-lightbox');
  if (host) host.hidden = true;
}

async function prepareCapture(original, source, mode, options = {}) {
  hideManualEntry();
  camera.stop();
  document.getElementById('sm-view').classList.remove('is-live', 'is-quad');
  analyzer.reset();
  if (source === CaptureSource.CAMERA) showPanel('scanner');
  const findingLabel = source === CaptureSource.UPLOAD && options.detect;
  setBusy(true, findingLabel ? 'Finding the label…' : 'Checking the label…');
  try {
    let geometricCrop;
    let cornersNormalized;
    let detectedLabel;
    let quality;

    if (source === CaptureSource.UPLOAD) {
      geometricCrop = original;
      cornersNormalized = fullFrameCorners();
      const probe = await loadImage(original).catch(() => null);
      quality = (probe && analyzer.analyze(probe)) || fallbackQuality();
      quality.documentBoundaryConfidence = Math.max(quality.documentBoundaryConfidence || 0, 0.88);
      quality.labelCoverage = 1;
      detectedLabel = {
        confidence: quality.documentBoundaryConfidence || 0.5,
        cornersNormalized,
        labelCoverage: 1,
        wasManuallyAdjusted: false,
        ambiguous: false,
      };
      if (options.detect) {
        await loadOpenCv().catch(() => {});
        const processed = await processStill(original, {
          quality: options.quality,
          allowGuide: false,
        });
        const conf = processed.detectedLabel?.confidence || 0;
        const strong = !processed.usedGuide
          && !processed.detectedLabel?.ambiguous
          && conf >= DEFAULT_THRESHOLDS.minBoundaryConfidence;
        if (strong) {
          geometricCrop = processed.crop;
          cornersNormalized = processed.cornersNormalized;
          detectedLabel = processed.detectedLabel;
          quality = processed.quality;
        }
      }
    } else {
      geometricCrop = await cropGuideRegion(original);
      cornersNormalized = guideCorners();
      const probe = await loadImage(original).catch(() => null);
      quality = (probe && analyzer.analyze(probe)) || fallbackQuality();
      quality.documentBoundaryConfidence = Math.max(quality.documentBoundaryConfidence || 0, 0.88);
      quality.labelCoverage = DEFAULT_THRESHOLDS.guide.width;
      detectedLabel = {
        confidence: quality.documentBoundaryConfidence,
        cornersNormalized,
        labelCoverage: quality.labelCoverage,
        wasManuallyAdjusted: false,
        ambiguous: false,
      };
    }

    setBusy(true, isOcrReady() ? 'Reading label text…' : 'Preparing text reader…');
    pendingCapture = {
      original,
      crop: geometricCrop,
      geometricCrop,
      quality: { ...quality },
      source,
      mode,
      barcodeValues: [],
      forced: false,
      cornersNormalized,
      detectedLabel,
      localOcrText: '',
      labelMetrics: null,
    };
    await applyEnhancementAndOcr(pendingCapture);
    showPanel('preview');
    track('capture_completed', {
      mode,
      failures: previewFailures.length,
      ocrOk: !!pendingCapture.labelMetrics?.ok,
    });
  } catch (err) {
    if (source === CaptureSource.UPLOAD) showPanel('entry');
    else idleScannerMessage();
    document.getElementById('sm-quality-text').textContent = err.message || 'Capture failed';
    throw err;
  } finally {
    setBusy(false);
  }
}

async function captureNow() {
  if (analyzing) return;
  setBusy(true, 'Checking the label…');
  track('manual_capture_started');
  try {
    const original = await camera.takePhoto();
    await prepareCapture(original, CaptureSource.CAMERA, 'manual', { detect: false });
  } catch (err) {
    setBusy(false);
    idleScannerMessage();
    document.getElementById('sm-quality-text').textContent = err.message || 'Capture failed';
    if (!camera.hasLiveTrack() && !document.getElementById('sm-scanner').hidden) continueToCamera();
  }
}

function renderPreviewQuality(failures, barcodeValues) {
  previewFailures = failures || [];
  const okLines = [
    'Label framed',
    barcodeValues.length ? 'Barcode detected' : 'No barcode detected',
  ];
  document.getElementById('sm-preview-quality').innerHTML = [
    ...okLines.map(line => '<div class="ok">✓ ' + line + '</div>'),
    ...previewFailures.map(line => '<div class="bad">✗ ' + line + '</div>'),
  ].join('');
}

function ensureCropEditor() {
  if (cropEditor) return cropEditor;
  cropEditor = new PerspectiveCropEditor(document.getElementById('sm-crop-canvas'), corners => {
    if (pendingCapture) pendingCapture.cornersNormalized = corners;
  });
  return cropEditor;
}

async function openCropEditor() {
  if (!pendingCapture) return;
  cropEditorSnapshot = {
    crop: pendingCapture.geometricCrop,
    enhanced: pendingCapture.crop,
    corners: pendingCapture.cornersNormalized,
    detectedLabel: { ...pendingCapture.detectedLabel },
    localOcrText: pendingCapture.localOcrText,
    labelMetrics: pendingCapture.labelMetrics,
    barcodeValues: pendingCapture.barcodeValues,
  };
  const image = await loadImage(pendingCapture.original);
  const canvas = document.getElementById('sm-crop-canvas');
  const host = document.getElementById('sm-crop-editor');
  host.hidden = false;
  const card = host.querySelector('.sm-crop-editor-card');
  const maxW = Math.min(640, Math.max(240, (card?.clientWidth || 560) - 8));
  const maxH = Math.max(180, Math.min(360, Math.round(window.innerHeight * 0.42)));
  const scale = Math.min(maxW / image.naturalWidth, maxH / image.naturalHeight, 1);
  canvas.width = Math.max(160, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(140, Math.round(image.naturalHeight * scale));
  canvas.style.width = `${canvas.width}px`;
  canvas.style.height = `${canvas.height}px`;
  const startCorners = guideCorners();
  ensureCropEditor().setImage(image, startCorners);
}

async function applyCropEdit() {
  if (!pendingCapture) return;
  const corners = cropEditor?.getCorners?.() || pendingCapture.cornersNormalized;
  document.getElementById('sm-crop-editor').hidden = true;
  cropEditorSnapshot = null;
  setBusy(true, 'Checking the label…');
  try {
    const result = await rewarp(pendingCapture.original, corners);
    pendingCapture.geometricCrop = result.crop;
    pendingCapture.cornersNormalized = result.cornersNormalized;
    pendingCapture.detectedLabel = result.detectedLabel;
    pendingCapture.quality = {
      ...pendingCapture.quality,
      ...result.quality,
      documentBoundaryConfidence: result.detectedLabel.confidence,
    };
    await applyEnhancementAndOcr(pendingCapture);
  } finally {
    setBusy(false);
  }
}

function approveCapture() {
  useThisLabel(previewFailures.length > 0);
}

function approveCropEdit() {
  applyCropEdit();
}

function retakeFromCropEditor() {
  document.getElementById('sm-crop-editor').hidden = true;
  cropEditorSnapshot = null;
  retakeCapture();
}

function cancelCropEdit() {
  if (cropEditorSnapshot && pendingCapture) {
    pendingCapture.geometricCrop = cropEditorSnapshot.crop;
    pendingCapture.crop = cropEditorSnapshot.enhanced || cropEditorSnapshot.crop;
    pendingCapture.cornersNormalized = cropEditorSnapshot.corners;
    pendingCapture.detectedLabel = cropEditorSnapshot.detectedLabel;
    pendingCapture.localOcrText = cropEditorSnapshot.localOcrText;
    pendingCapture.labelMetrics = cropEditorSnapshot.labelMetrics;
    pendingCapture.barcodeValues = cropEditorSnapshot.barcodeValues || [];
    document.getElementById('sm-preview-crop').src = pendingCapture.crop;
    const failures = qualityFailures(pendingCapture.quality);
    if (pendingCapture.labelMetrics && !pendingCapture.labelMetrics.ok) {
      failures.push(pendingCapture.labelMetrics.warning);
    }
    renderPreviewQuality(failures, pendingCapture.barcodeValues);
    renderPreviewOcr(pendingCapture.localOcrText, pendingCapture.labelMetrics);
  }
  document.getElementById('sm-crop-editor').hidden = true;
  cropEditorSnapshot = null;
}

function retakeCapture() {
  pendingCapture = null;
  document.getElementById('sm-crop-editor').hidden = true;
  track('capture_retake');
  continueToCamera();
}

async function useThisLabel(forced) {
  if (!pendingCapture) return;
  document.getElementById('sm-crop-editor').hidden = true;
  pendingCapture.forced = !!forced;
  pendingCapture.quality.forced = !!forced;
  const capture = pendingCapture;
  pendingCapture = null;
  showPanel('entry');
  await ingestCapture(capture);
}

async function ingestCapture(capture) {
  const id = ++seq;
  const item = {
    id, photo: capture.crop || capture.original || parcelPhoto(id), fields: null,
    acknowledged: false, dupOk: false, status: 'reading', error: '',
    barcodeConflict: false, conflictResolved: false, reviewRequired: !!capture.forced,
    reviewReasons: [
      ...(capture.forced ? ['Image was submitted despite a quality failure'] : []),
      ...(capture.labelMetrics && !capture.labelMetrics.ok
        ? ['Local OCR did not find a tracking number or carrier name']
        : []),
    ],
    barcodeValues: capture.barcodeValues || [],
  };
  queue.push(item);
  render();
  try {
    const session = await client.create(capture.source, window.matchMedia('(max-width: 991px)').matches ? 'mobile' : 'desktop');
    item.ingestionId = session.ingestionId;
    await client.uploadImages(session.ingestionId, { original: capture.original, crop: capture.crop });
    await client.addMetadata(session.ingestionId, {
      barcodeValues: capture.barcodeValues || [],
      captureQuality: capture.quality,
      forced: !!capture.forced,
      detectedLabel: capture.detectedLabel,
      scannerVersion: SCANNER_VERSION,
      localOcrText: capture.localOcrText || '',
      labelMetrics: capture.labelMetrics || null,
    });
    track('image_uploaded', { ingestionId: session.ingestionId });
    track('extraction_started', { ingestionId: session.ingestionId });
    const result = await client.extract(session.ingestionId, ENUMS);
    applyIngestion(item, result);
    track('extraction_completed', { ingestionId: session.ingestionId, status: result.status });
  } catch (err) {
    item.status = 'error';
    item.error = err.message || String(err);
    track('extraction_failed', { message: item.error });
    render();
  }
}

function applyIngestion(item, result) {
  const shot = fromExtraction(result.extraction || {});
  Object.assign(item, buildItem(shot, item.id, item.photo));
  item.status = 'read';
  item.error = '';
  item.reviewReasons = result.extraction?.reviewReasons || item.reviewReasons || [];
  item.reviewRequired = result.status === 'REVIEW_REQUIRED' || !!result.extraction?.requiresHumanReview || item.reviewRequired;
  const compared = compareTracking(shot.tracking[0], item.barcodeValues, shot.carrier[0]);
  item.barcodeConflict = !!compared.conflict;
  item.barcodeValue = compared.barcodeValue;
  if (item.barcodeConflict) {
    item.reviewRequired = true;
    item.reviewReasons = [...new Set([...(item.reviewReasons || []), 'Barcode and OCR tracking numbers conflict'])];
    track('barcode_ocr_conflict', { ocr: shot.tracking[0], barcode: compared.barcodeValue });
  } else if (compared.barcodeMatch) {
    track('barcode_ocr_match', { tracking: shot.tracking[0] });
  }
  render();
}

function pickFiles() { document.getElementById('sm-file').click(); }
async function filesPicked(input) {
  const files = [...input.files];
  input.value = '';
  if (analyzing) return;
  for (const file of files) {
    try {
      const original = await fileToDataUrl(file);
      await prepareCapture(original, CaptureSource.UPLOAD, 'upload', { detect: false });
    } catch (err) {
      showPanel('entry');
      document.getElementById('sm-quality-text').textContent = err.message || 'Capture failed';
    }
  }
}
async function dropFiles(e) {
  e.preventDefault();
  if (analyzing) return;
  const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
  if (!files.length) return;
  try {
    const original = await fileToDataUrl(files[0]);
    await prepareCapture(original, CaptureSource.UPLOAD, 'upload', { detect: false });
  } catch (err) {
    showPanel('entry');
    document.getElementById('sm-quality-text').textContent = err.message || 'Capture failed';
  }
}

function showManualEntry() {
  closeScanner();
  document.getElementById('sm-manual-entry').hidden = false;
  document.getElementById('sm-manual-tracking').focus();
}
function hideManualEntry() { document.getElementById('sm-manual-entry').hidden = true; }
function submitManualEntry() {
  const value = normalizeTracking(document.getElementById('sm-manual-tracking').value);
  hideManualEntry();
  const shot = {
    tracking: [value, value ? 1 : 0],
    carrier: ['', 0], recipient: ['', 0], unit_raw: ['', 0],
    type: ['', 0], condition: ['', 0], sender: ['', 0],
  };
  const id = ++seq;
  const item = buildItem(shot, id, parcelPhoto(id));
  item.status = 'read';
  item.reviewRequired = true;
  item.reviewReasons = ['Manual tracking entry — remaining fields need operator input'];
  queue.push(item);
  render();
  openSheet(id);
}

function retry(id) {
  const it = queue.find(i => i.id === id);
  if (!it?.ingestionId) return;
  it.status = 'reading'; it.error = '';
  render();
  client.extract(it.ingestionId, ENUMS).then(result => applyIngestion(it, result)).catch(err => {
    it.status = 'error'; it.error = err.message || String(err); render();
  });
}

function seedDemo(n) {
  for (let i = 0; i < n; i++) {
    const id = ++seq;
    const it = buildItem(MOCK_SHOTS[(id - 1) % MOCK_SHOTS.length], id);
    it.status = 'read';
    if (MOCK_SHOTS[(id - 1) % MOCK_SHOTS.length].barcode
      && MOCK_SHOTS[(id - 1) % MOCK_SHOTS.length].barcode !== MOCK_SHOTS[(id - 1) % MOCK_SHOTS.length].tracking[0]) {
      it.barcodeConflict = true;
      it.barcodeValue = MOCK_SHOTS[(id - 1) % MOCK_SHOTS.length].barcode;
      it.reviewRequired = true;
      it.reviewReasons = ['Barcode and OCR tracking numbers conflict'];
    }
    queue.push(it);
  }
}
function resetDemo() { queue = []; seq = 0; openId = null; closeSheet(); closeConfirm(); closeScanner(); hideManualEntry(); go('capture'); }
function clearQueue() { queue = []; seq = 0; openId = null; closeSheet(); render(); }
function dropItem() { queue = queue.filter(i => i.id !== openId); closeSheet(); render(); }

function render() {
  renderQueue();
  renderApprove();
  if (openId) renderSheet();
}

function renderQueue() {
  const host = document.getElementById('sm-queue');
  const empty = document.getElementById('sm-queue-empty');
  empty.style.display = queue.length ? 'none' : '';
  host.innerHTML = queue.map(item => {
    const st = itemStatus(item);
    if (st === 'reading') {
      return '<div class="sm-qcard is-reading"><img class="sm-thumb" src="' + item.photo + '" alt="">' +
        '<div class="sm-qcard-body"><div class="sm-qcard-title tis-text-gray">AI is reading the label…</div>' +
        '<div class="sm-bar" style="margin:8px 0 6px;width:70%"></div><div class="sm-bar" style="width:45%"></div></div></div>';
    }
    if (st === 'error') {
      return '<div class="sm-qcard is-error"><img class="sm-thumb" src="' + item.photo + '" alt="">' +
        '<div class="sm-qcard-body">' +
          '<div class="sm-qcard-title tis-text-danger">Could not read the label</div>' +
          '<div class="sm-qcard-meta tis-text-gray" style="word-break:break-word">' + esc(item.error) + '</div>' +
          '<div style="margin-top:8px">' +
            '<button class="sm-choice" onclick="retry(' + item.id + ')">Try again</button> ' +
            '<button class="sm-choice" onclick="removeItem(' + item.id + ')">Delete</button>' +
          '</div>' +
        '</div></div>';
    }
    const f = item.fields;
    const flagged = FIELDS.filter(({ k }) => needsAttention(f[k])).length;
    const badge = st === 'ready'
      ? '<span class="tis-badge-success tis-badge-sm tis-badge-round">Ready</span>'
      : '<span class="tis-badge-warning tis-badge-sm tis-badge-round">Needs review ' + flagged + '</span>';
    const dup = isDuplicate(f.tracking.value) && !item.dupOk
      ? ' <span class="tis-badge-danger tis-badge-sm tis-badge-round">Duplicate</span>' : '';
    const conflict = item.barcodeConflict && !item.conflictResolved
      ? ' <span class="tis-badge-danger tis-badge-sm tis-badge-round">Barcode does not match OCR</span>' : '';
    return '<div class="sm-qcard ' + (st === 'ready' ? '' : 'is-review') + '" onclick="openSheet(' + item.id + ')">' +
      '<img class="sm-thumb" src="' + item.photo + '" alt="">' +
      '<div class="sm-qcard-body">' +
        '<div class="sm-qcard-title">' + (f.tracking.value || '— No tracking number —') + '</div>' +
        '<div class="sm-qcard-meta">' + (f.recipient.value || '— No recipient —') + ' · ' + f.unit.value + '</div>' +
        '<div class="sm-qcard-meta tis-text-gray">' + f.type.value + ' · ' + shortCarrier(f.carrier.value) + '</div>' +
        '<div style="margin-top:6px">' + badge + dup + conflict + '</div>' +
        '<div style="margin-top:8px;display:flex;gap:6px" onclick="event.stopPropagation()">' +
          '<button class="sm-choice" onclick="openSheet(' + item.id + ')">Edit</button>' +
          '<button class="sm-choice" onclick="removeItem(' + item.id + ')">Delete</button>' +
        '</div>' +
      '</div>' +
      '<mat-icon class="mat-icon material-icons tis-text-light">chevron_right</mat-icon></div>';
  }).join('');

  const count = st => queue.filter(i => itemStatus(i) === st).length;
  document.getElementById('sm-queue-counts').innerHTML =
    '<span class="tis-badge-outline-primary tis-badge-sm">In queue ' + queue.length + '</span>' +
    '<span class="tis-badge-outline-success tis-badge-sm">Ready ' + count('ready') + '</span>' +
    (count('review') ? '<span class="tis-badge-outline-warning tis-badge-sm">Needs review ' + count('review') + '</span>' : '') +
    (count('error') ? '<span class="tis-badge-outline-danger tis-badge-sm">Unreadable ' + count('error') + '</span>' : '');
  const toApprove = document.getElementById('sm-to-approve');
  toApprove.disabled = !queue.some(i => i.fields);
  toApprove.querySelector('.mdc-button__label').textContent = 'Review and Approve' + (queue.length ? ' (' + queue.length + ')' : '');
}
const shortCarrier = c => {
  const base = (c || '').replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();
  return base.split(' / ').pop() || base;
};

function openSheet(id) {
  openId = id;
  renderSheet();
  document.body.classList.add('sm-sheet-open');
  track('review_opened', { id });
}
function closeSheet() {
  closePhotoPreview();
  document.body.classList.remove('sm-sheet-open');
  openId = null;
}

function renderSheet() {
  const item = queue.find(i => i.id === openId);
  if (!item || !item.fields) { closeSheet(); return; }
  document.getElementById('sm-sheet-photo').src = item.photo;
  const flagged = FIELDS.filter(({ k }) => needsAttention(item.fields[k])).length;
  document.getElementById('sm-sheet-sub').textContent = flagged
    ? 'AI filled ' + (FIELDS.length - flagged) + ' of ' + FIELDS.length + ' fields · tap ' + flagged + ' remaining'
    : 'AI filled every field · you can confirm';

  const alerts = [];
  if (item.reviewReasons?.length) {
    alerts.push('<div class="tis-alert tis-alert-warning" style="margin:10px 0"><mat-icon class="mat-icon material-icons">warning_amber</mat-icon>' + item.reviewReasons.map(esc).join('<br>') + '</div>');
  }
  if (item.barcodeConflict && !item.conflictResolved) {
    alerts.push(
      '<div class="tis-alert tis-alert-danger" style="margin:10px 0"><mat-icon class="mat-icon material-icons">compare_arrows</mat-icon>' +
      'Barcode and OCR tracking numbers do not match — pick one before saving' +
      '<div class="sm-chiprow" style="margin-top:8px">' +
        '<button class="sm-choice" onclick="resolveConflict(' + item.id + ',\'' + esc(item.fields.tracking.value) + '\')">OCR: ' + esc(item.fields.tracking.value || '—') + '</button>' +
        '<button class="sm-choice" onclick="resolveConflict(' + item.id + ',\'' + esc(item.barcodeValue) + '\')">Barcode: ' + esc(item.barcodeValue || '—') + '</button>' +
      '</div></div>'
    );
  }
  document.getElementById('sm-sheet-alerts').innerHTML = alerts.join('');

  document.getElementById('sm-sheet-fields').innerHTML = FIELDS.map(({ k, label, opt }) => {
    const f = item.fields[k];
    const st = f.resolved ? 'auto' : fieldState(f.conf);
    const pct = Math.round(f.conf * 100);
    const badge = f.resolved
      ? '<span class="tis-badge-outline-primary tis-badge-xs">Confirmed by staff</span>'
      : st === 'auto'  ? '<span class="tis-badge-success tis-badge-xs tis-badge-round">AI ' + pct + '%</span>'
      : st === 'check' ? '<span class="tis-badge-warning tis-badge-xs tis-badge-round">Glance ' + pct + '%</span>'
      :                  '<span class="tis-badge-danger tis-badge-xs tis-badge-round">Choose ' + pct + '%</span>';
    const value = f.value
      ? '<div class="sm-field-value">' + f.value + '</div>'
      : '<div class="sm-field-value is-empty">AI could not read this — choose below</div>';
    const raw = k === 'unit' && f.raw ? '<div class="tis-text-gray" style="font-size:11.5px">AI read: “' + f.raw + '”</div>' : '';
    const chips = '<div class="sm-chiprow">' + (f.alts.length
      ? f.alts.map(a => '<button class="sm-choice ' + (a === f.value ? 'active' : '') +
          '" onclick="pick(' + item.id + ',\'' + k + '\',this.dataset.v)" data-v="' + esc(a) + '">' + a + '</button>').join('') +
        '<button class="sm-choice" onclick="pick(' + item.id + ',\'' + k + '\',\'Other (full list)\')">Other…</button>'
      : '<input class="sm-choice" style="min-width:190px;text-align:left" value="' + esc(f.value) + '" placeholder="Type over if AI is wrong"' +
          ' onchange="typeIn(' + item.id + ',\'' + k + '\',this.value)">' +
        (opt ? '<button class="sm-choice" onclick="pick(' + item.id + ',\'' + k + '\',\'—\')">Not specified</button>' : '')
    ) + '</div>';
    return '<div class="sm-field sm-field--' + st + '">' +
      '<div class="sm-field-head"><span class="sm-field-label">' + label + '</span>' + badge + '</div>' +
      value + raw + chips + '</div>';
  }).join('');

  const blocked = pendingPick(item) || (item.barcodeConflict && !item.conflictResolved);
  const btn = document.getElementById('sm-sheet-confirm');
  btn.disabled = blocked;
  btn.querySelector('.mdc-button__label').textContent = blocked
    ? (item.barcodeConflict && !item.conflictResolved ? 'Still need a tracking number' : 'Still need every required field')
    : 'Confirm';
}
const esc = s => (s || '').toString().replace(/[<>"]/g, c => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function pick(id, key, value) {
  const item = queue.find(i => i.id === id);
  item.fields[key].value = value;
  item.fields[key].resolved = true;
  track('field_edited', { id, key });
  render();
}
function typeIn(id, key, value) {
  const f = queue.find(i => i.id === id).fields[key];
  f.value = value.trim();
  f.resolved = !!f.value;
  track('field_edited', { id, key });
  render();
}
function resolveConflict(id, value) {
  const item = queue.find(i => i.id === id);
  item.fields.tracking.value = value;
  item.fields.tracking.resolved = true;
  item.conflictResolved = true;
  render();
}
function confirmItem() {
  const item = queue.find(i => i.id === openId);
  if (!item || pendingPick(item) || (item.barcodeConflict && !item.conflictResolved)) return;
  item.acknowledged = true;
  item.reviewRequired = false;
  closeSheet();
  render();
}

function renderApprove() {
  const rows = document.getElementById('sm-approve-rows');
  const cards = document.getElementById('sm-approve-cards');
  const done = queue.filter(i => i.fields);

  rows.innerHTML = done.map(item => {
    const f = item.fields, st = itemStatus(item), dup = isDuplicate(f.tracking.value) && !item.dupOk;
    return '<tr class="' + (dup || item.barcodeConflict && !item.conflictResolved ? 'is-danger' : st === 'review' ? 'is-review' : '') + '">' +
      '<td><img class="sm-thumb" style="width:56px;height:42px" src="' + item.photo + '" alt=""></td>' +
      '<td><span class="tis-a">' + (f.tracking.value || '—') + '</span>' + (dup ? '<div><span class="tis-badge-danger tis-badge-xs">Already in system</span></div>' : '') + '</td>' +
      '<td class="tis-overflow-ellipsis" style="max-width:150px">' + shortCarrier(f.carrier.value) + '</td>' +
      '<td>' + (f.recipient.value || '<span class="tis-text-danger">Not set</span>') + '</td>' +
      '<td>' + f.unit.value + '</td>' +
      '<td>' + f.type.value + '</td>' +
      '<td>' + conditionBadge(f.condition.value) + '</td>' +
      '<td>' + statusBadge(st) + '</td>' +
      '<td class="text-right">' + rowActions(item, dup) + '</td></tr>';
  }).join('');

  cards.innerHTML = done.map(item => {
    const f = item.fields, st = itemStatus(item), dup = isDuplicate(f.tracking.value) && !item.dupOk;
    return '<div class="sm-qcard ' + (dup || st === 'review' ? 'is-review' : '') + '">' +
      '<img class="sm-thumb" src="' + item.photo + '" alt="">' +
      '<div class="sm-qcard-body">' +
        '<div class="sm-qcard-title">' + (f.tracking.value || '—') + '</div>' +
        '<div class="sm-qcard-meta">' + (f.recipient.value || 'Recipient not set') + ' · ' + f.unit.value + '</div>' +
        '<div class="sm-qcard-meta tis-text-gray">' + f.type.value + ' · ' + shortCarrier(f.carrier.value) + '</div>' +
        '<div style="margin-top:6px">' + statusBadge(st) + ' ' + conditionBadge(f.condition.value) + '</div>' +
        '<div style="margin-top:8px">' + rowActions(item, dup) + '</div>' +
      '</div></div>';
  }).join('');

  const totalFields = done.length * FIELDS.length;
  const autoFields = done.reduce((n, i) => n + FIELDS.filter(({ k }) => fieldState(i.fields[k].conf) === 'auto').length, 0);
  document.getElementById('kpi-total').textContent = done.length;
  document.getElementById('kpi-auto').textContent = totalFields ? Math.round(autoFields / totalFields * 100) + '%' : '—';
  document.getElementById('kpi-auto-sub').textContent = autoFields + ' of ' + totalFields + ' fields';
  document.getElementById('kpi-review').textContent = done.filter(i => itemStatus(i) === 'review').length;
  document.getElementById('kpi-saved').textContent = autoFields;
  document.getElementById('done-count').textContent = done.length;

  const review = done.filter(i => itemStatus(i) === 'review');
  const dups = done.filter(i => isDuplicate(i.fields.tracking.value) && !i.dupOk);
  const conflicts = done.filter(i => i.barcodeConflict && !i.conflictResolved);
  const alert = document.getElementById('sm-approve-alert');
  alert.innerHTML =
    (conflicts.length ? '<div class="tis-alert tis-alert-danger"><mat-icon class="mat-icon material-icons">compare_arrows</mat-icon>' +
      conflicts.length + ' item(s) have a barcode/OCR mismatch — pick a tracking number before Approve</div>' : '') +
    (dups.length ? '<div class="tis-alert tis-alert-danger"><mat-icon class="mat-icon material-icons">error_outline</mat-icon>' +
      dups.length + ' tracking number(s) already exist — delete them or tap “Not a duplicate”</div>' : '') +
    (review.length ? '<div class="tis-alert tis-alert-warning"><mat-icon class="mat-icon material-icons">warning_amber</mat-icon>' +
      review.length + ' item(s) need a glance — tap Review before Approve</div>' : '') +
    (!dups.length && !review.length && !conflicts.length && done.length ? '<div class="tis-alert tis-alert-success"><mat-icon class="mat-icon material-icons">check_circle</mat-icon>' +
      'Every item is ready — tap Approve to create parcels and notify recipients</div>' : '');

  const blocked = !done.length || review.length > 0 || dups.length > 0 || conflicts.length > 0;
  document.getElementById('sm-approve-btn').disabled = blocked;
  document.getElementById('sm-approve-note').textContent = blocked
    ? (done.length ? 'Clear blocked items before you can Approve' : 'No parcels in this batch yet')
    : 'Will create ' + done.length + ' parcel(s) as Ready for Pick-up and notify recipients';
}
function rowActions(item, dup) {
  return (dup ? '<button class="sm-choice" onclick="markNotDup(' + item.id + ')">Not a duplicate</button> ' : '') +
    '<button class="sm-choice" onclick="openSheet(' + item.id + ')">' + (itemStatus(item) === 'review' ? 'Review' : 'Edit') + '</button> ' +
    '<button class="sm-choice" onclick="removeItem(' + item.id + ')">Delete</button>';
}
function markNotDup(id) { queue.find(i => i.id === id).dupOk = true; render(); }
function removeItem(id) { queue = queue.filter(i => i.id !== id); render(); }

function openConfirm() {
  const done = queue.filter(i => i.fields);
  document.getElementById('sm-confirm-text').innerHTML =
    'This will create <b>' + done.length + ' parcel(s)</b> in <b>AIS Tower 1</b>, storage <b>Lobby (002)</b>, ' +
    'status <b>Ready for Pick-up</b>, and notify every recipient.';
  document.body.classList.add('sm-dialog-open');
}
function closeConfirm() { document.body.classList.remove('sm-dialog-open'); }

function doApprove() {
  closeConfirm();
  const done = queue.filter(i => i.fields);
  document.getElementById('done-batch').textContent = batchNo;
  document.getElementById('done-rows').innerHTML = done.map(item => {
    const f = item.fields;
    return '<tr><td><span class="tis-a">' + (parcelSeq++) + '</span></td><td>' + f.tracking.value + '</td>' +
      '<td>' + f.recipient.value + '</td><td>' + f.unit.value + '</td>' +
      '<td><span class="tis-badge-outline-success tis-badge-sm">Ready for Pick-up</span></td></tr>';
  }).join('');
  track('parcel_confirmed', { count: done.length });
  go('done');
}

const conditionBadge = c => c === 'Appears Fine'
  ? '<span class="tis-badge-outline-success tis-badge-xs">' + c + '</span>'
  : '<span class="tis-badge-outline-warning tis-badge-xs">' + (c || '—') + '</span>';
const statusBadge = st => st === 'ready'
  ? '<span class="tis-badge-sr-so-approved tis-badge-sm tis-badge-round">Ready to save</span>'
  : '<span class="tis-badge-sr-so-onhold tis-badge-sm tis-badge-round">Needs review</span>';

function go(screen) {
  if (screen === 'review') {
    if (!queue.length) { seedDemo(4); render(); }
    show('capture');
    const target = queue.find(i => itemStatus(i) === 'review') || queue.find(i => i.fields);
    if (target) openSheet(target.id);
  } else {
    closeSheet();
    if (screen !== 'capture' && !queue.length) { seedDemo(4); render(); }
    show(screen);
  }
  markSteps(screen);
}
function markSteps(screen) {
  const pills = [...document.querySelectorAll('#sm-steps .tis-pill')];
  const at = pills.findIndex(p => p.dataset.screen === screen);
  pills.forEach((p, i) => {
    p.classList.toggle('active', i === at);
    p.classList.toggle('is-done', i < at);
  });
}
function show(screen) {
  document.querySelectorAll('.sm-screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + screen);
  if (el) el.classList.add('active');
  document.getElementById('pv-main').scrollIntoView({ block: 'start' });
}

function flipCamera() { return camera.flip(); }
function toggleTorch() { return camera.toggleTorch(); }

window.addEventListener('pagehide', () => {
  stopCameraTracks();
  disposeOcrWorker();
});
window.addEventListener('beforeunload', () => stopCameraTracks());
document.addEventListener('keydown', event => {
  const body = document.body.classList;
  if (event.key === 'Escape') {
    const close =
      !document.getElementById('sm-photo-lightbox').hidden ? closePhotoPreview :
      !document.getElementById('sm-crop-editor').hidden ? cancelCropEdit :
      body.contains('sm-dialog-open') ? closeConfirm :
      body.contains('pl-dialog-open') ? window.closeDialog :
      body.contains('sm-sheet-open') ? closeSheet : null;
    if (close) { event.preventDefault(); close(); }
    return;
  }
  const typing = event.target.closest?.('input, textarea, select, button, [contenteditable]');
  const overlay = body.contains('sm-dialog-open') || body.contains('sm-sheet-open');
  if (event.key === ' ' && !typing && !overlay && !analyzing && !document.getElementById('sm-scanner').hidden) {
    event.preventDefault();
    captureNow();
  }
});

document.addEventListener('visibilitychange', () => {
  const scannerOpen = !document.getElementById('sm-scanner').hidden;
  if (document.hidden) return;
  if (scannerOpen && !camera.hasLiveTrack() && !analyzing) continueToCamera();
});

document.querySelectorAll('#sm-steps .tis-pill').forEach(p => p.addEventListener('click', () => go(p.dataset.screen)));

Promise.race([
  document.fonts?.ready ?? Promise.resolve(),
  new Promise(r => setTimeout(r, 3000)),
]).finally(() => document.documentElement.classList.add('fonts-ready'));

Object.assign(window, {
  continueToCamera, closeScanner, captureNow, flipCamera, toggleTorch, retakeCapture, useThisLabel,
  approveCapture, openCropEditor, applyCropEdit, cancelCropEdit, approveCropEdit, retakeFromCropEditor,
  downloadPreviewImage, downloadSheetPhoto, previewSheetPhoto, closePhotoPreview,
  pickFiles, filesPicked, dropFiles, showManualEntry, hideManualEntry, submitManualEntry,
  retry, resetDemo, clearQueue, dropItem, openSheet, closeSheet, pick, typeIn, confirmItem,
  resolveConflict, renderApprove, openConfirm, closeConfirm, doApprove, go, removeItem, markNotDup,
  fieldState, matchUnits, isDuplicate, itemStatus, fromExtraction, MOCK_SHOTS, FIELDS, buildItem, seedDemo, queue,
  prepareCapture, analyzeLabelText,
});

(function selfCheck() {
  let ok = true;
  const is = (cond, msg) => { if (!cond) { ok = false; console.assert(cond, msg); } };
  is(fieldState(0.97) === 'auto',  'above threshold is auto');
  is(fieldState(0.90) === 'auto',  '0.90 boundary is auto');
  is(fieldState(0.89) === 'check', 'below 0.90 is glance');
  is(fieldState(0.60) === 'check', '0.60 boundary is glance');
  is(fieldState(0.59) === 'pick',  'below 0.60 must choose');
  is(matchUnits('Floor 21 Marketing')[0].includes('21F-MKT'), 'floor digits should win');
  is(matchUnits('Floor 18 Finance')[0].includes('18F-FIN'),     'English unit names should match');
  is(isDuplicate('LEXPU0703471485'), 'existing tracking should be flagged');
  const dirty = buildItem(MOCK_SHOTS[4], 98); dirty.status = 'read';
  is(itemStatus(dirty) === 'review', 'unreadable field needs review');
  const conflicted = buildItem(MOCK_SHOTS[0], 97); conflicted.status = 'read'; conflicted.barcodeConflict = true;
  is(itemStatus(conflicted) === 'review', 'barcode conflict needs review');
  conflicted.conflictResolved = true; conflicted.acknowledged = true;
  is(itemStatus(conflicted) === 'ready', 'resolved conflict is ready');
  is(analyzeLabelText('Kerry Express LEXPU0703623961').ok, 'carrier and tracking pass local OCR check');
  is(analyzeLabelText('FLASH EXPRESS').ok, 'carrier name alone passes local OCR check');
  is(!!analyzeLabelText('DHL 12/09/2026 1.2kg').date, 'date is recorded as extra context');
  is(!analyzeLabelText('steering wheel dashboard').ok, 'non-label text fails local OCR check');
  markSteps('approve');
  const step = s => document.querySelector('#sm-steps [data-screen="' + s + '"]').classList;
  is(step('capture').contains('is-done') && step('approve').contains('active') && !step('done').contains('is-done'), 'stepper marks earlier steps done');
  markSteps('capture');
  is(!step('capture').contains('is-done') && step('capture').contains('active'), 'stepper resets on capture');
  console.log(ok ? '✓ self-check passed (confidence, units, duplicates, barcode conflict, local OCR, stepper)' : '✗ self-check failed');
})();

render();
loadOcrStatus();

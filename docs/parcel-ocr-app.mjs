import { CameraSession, fileToDataUrl } from './ingestion/camera.mjs';
import { FrameQualityAnalyzer, qualityState, shouldAutoCapture, qualityFailures } from './ingestion/quality.mjs';
import { DEFAULT_THRESHOLDS } from './ingestion/thresholds.mjs';
import { BarcodeScanner } from './ingestion/barcode.mjs';
import { loadImage } from './ingestion/crop.mjs';
import { IngestionClient } from './ingestion/client.mjs';
import { CaptureSource, SCANNER_VERSION } from './ingestion/contracts.mjs';
import { compareTracking, normalizeTracking } from './ingestion/tracking-validation.mjs';
import { track } from './ingestion/telemetry.mjs';
import { MOCK_SHOTS } from './ingestion/mock-shots.mjs';
import { loadOpenCv, isOpenCvReady } from './ingestion/opencv-loader.mjs';
import { LabelCandidateDetector } from './ingestion/label-detector.mjs';
import { StabilityTracker } from './ingestion/stability.mjs';
import { processStill, rewarp } from './ingestion/final-processor.mjs';
import { PerspectiveCropEditor } from './ingestion/crop-editor.mjs';
import { guideCorners } from './ingestion/perspective.mjs';

const CARRIERS = [
  'ไปรษณีย์ไทย / Thailand Post (001/2021)', 'เคอรี่ เอ็กซ์เพรส / Kerry Express (002/2021)',
  'J&T Express (003/2021)', 'แฟลช เอ็กซ์เพรส / Flash Express (004/2021)',
  'ดีเอชแอล เอ๊กซ์เพรส / DHL Express (005/2021)', 'ลาซาด้า / Lazada (006/2021)',
  'ช้อปปี้ / Shopee (007/2021)', 'เบสท์ เอ็กซ์เพรส / Best Express (008/2021)',
  'LEL Express (009/2021)', 'NINJA VAN (010/2021)',
  'เอสซีจี เอ็กซ์เพรส / SCG Express (011/2021)', 'เฟดเอ็กซ์ เอ๊กซ์เพรส / FedEx Express (012/2021)',
];
const TYPES = ['ห่อเล็ก', 'ห่อกลาง', 'ห่อใหญ่ (มากกว่า 5 กก.)', 'Envelope', 'Bag', 'Small Box (Box)'];
const CONDITIONS = ['Appears Fine', 'Minor Damage', 'Moderate Damage', 'Major Damage', 'Water Damage'];
const UNITS = [
  { code: '21F-MKT', name: 'ชั้น 21 · Marketing' },
  { code: '18F-FIN', name: 'ชั้น 18 · Finance' },
  { code: '24F-ENG', name: 'ชั้น 24 · Engineering' },
  { code: '12F-HRD', name: 'ชั้น 12 · HR' },
  { code: '9F-CS',   name: 'ชั้น 9 · Customer Service' },
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
  { k: 'tracking',  label: 'Tracking No. / เลขพัสดุ' },
  { k: 'carrier',   label: 'Carrier / ขนส่ง' },
  { k: 'recipient', label: 'ผู้รับ' },
  { k: 'unit',      label: 'ชั้น / แผนก' },
  { k: 'type',      label: 'ประเภท / ขนาด' },
  { k: 'condition', label: 'สภาพพัสดุ' },
  { k: 'sender',    label: 'ผู้ส่ง / ร้าน', opt: true },
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
let loopTimer = 0;
let loopBusy = false;
let opencvState = 'idle';
let liveCorners = null;
let liveBarcodes = [];
let lastQuality = null;
let cropEditor = null;
let cropEditorSnapshot = null;
let loopPaused = false;
let previewFailures = [];

const client = new IngestionClient();
const camera = new CameraSession(document.getElementById('sm-cam'));
const analyzer = new FrameQualityAnalyzer();
const detector = new LabelCandidateDetector();
const stability = new StabilityTracker(DEFAULT_THRESHOLDS.stableDurationMs);
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
    : '<span class="tis-badge-outline-warning tis-badge-sm">โหมดสาธิต · ไม่มี API key</span>';
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
  stopQualityLoop();
  camera.stop();
  document.getElementById('sm-view').classList.remove('is-live', 'is-quad');
}

function stopQualityLoop() {
  if (loopTimer) cancelAnimationFrame(loopTimer);
  loopTimer = 0;
  loopBusy = false;
  analyzer.reset();
  stability.reset();
  liveCorners = null;
  liveBarcodes = [];
  lastQuality = null;
}

function closeScanner() {
  stopCameraTracks();
  document.getElementById('sm-crop-editor').hidden = true;
  showPanel('entry');
  track('camera_closed');
}

async function continueToCamera() {
  hideManualEntry();
  document.getElementById('sm-crop-editor').hidden = true;
  showPanel('scanner');
  track('camera_opened');
  const view = document.getElementById('sm-view');
  loopPaused = false;
  opencvState = isOpenCvReady() ? 'ready' : 'loading';
  setQualityUi({ documentBoundaryConfidence: 0, sharpness: 1, brightness: 0.5, glareRisk: 0 });
  try {
    await camera.start('environment');
    view.classList.add('is-live');
    await barcodes.initialize();
    track('camera_permission_granted');
    startQualityLoop();
    if (opencvState !== 'ready') {
      loadOpenCv().then(() => { opencvState = 'ready'; }).catch(() => { opencvState = 'fallback'; });
    }
  } catch (err) {
    view.classList.remove('is-live');
    document.getElementById('sm-cam-msg').innerHTML = camMessage(err);
    track('camera_permission_denied', { reason: err.name || String(err) });
  }
}

function overlayPoints(corners, video, view) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const bw = view.clientWidth, bh = view.clientHeight;
  if (!vw || !vh || !bw || !bh) return corners;
  const scale = Math.min(bw / vw, bh / vh);
  const w = vw * scale, h = vh * scale;
  const left = (bw - w) / 2, top = (bh - h) / 2;
  return corners.map(p => ({
    x: (left + p.x * w) / bw,
    y: (top + p.y * h) / bh,
  }));
}

function setOverlay(corners, level) {
  const view = document.getElementById('sm-view');
  const poly = document.getElementById('sm-poly');
  const cut = document.getElementById('sm-poly-cut');
  const video = document.getElementById('sm-cam');
  const showQuad = !!(corners?.length === 4 && opencvState === 'ready');
  view.classList.toggle('is-quad', showQuad);
  if (!showQuad || !poly || !cut) return;
  const mapped = overlayPoints(corners, video, view);
  const points = mapped.map(p => p.x.toFixed(4) + ',' + p.y.toFixed(4)).join(' ');
  poly.setAttribute('points', points);
  cut.setAttribute('points', points);
  view.dataset.quality = level;
}

function setQualityUi(quality) {
  const state = qualityState(quality);
  const view = document.getElementById('sm-view');
  const box = document.getElementById('sm-quality');
  const coach = document.getElementById('sm-view-coach');
  view.dataset.quality = state.level;
  box.dataset.level = state.level;
  const message = analyzing ? 'Capturing…' : state.message;
  document.getElementById('sm-quality-text').textContent = message;
  if (coach) {
    coach.textContent = analyzing
      ? 'Capturing…'
      : (state.level === 'ready' ? 'Hold still — capturing' : 'Fill the frame with the full shipping label. ' + state.message);
  }
}

async function runLivePass() {
  const video = document.getElementById('sm-cam');
  const guideQuality = analyzer.analyze(video);
  liveBarcodes = await barcodes.detect(video);
  let quality = guideQuality;
  liveCorners = null;
  if (opencvState === 'ready') {
    const detected = detector.detect(video, liveBarcodes);
    const best = detected?.best;
    if (best?.corners) {
      const stab = stability.update(best.corners);
      liveCorners = best.corners;
      quality = {
        sharpness: detected.sharpness ?? guideQuality?.sharpness ?? 0,
        brightness: detected.brightness ?? guideQuality?.brightness ?? 0.5,
        glareRisk: detected.glareRisk ?? guideQuality?.glareRisk ?? 0,
        stability: stab.stability,
        stabilityDurationMs: stab.durationMs,
        labelCoverage: best.coverage,
        documentBoundaryConfidence: best.confidence,
        allCornersInsideSafeMargin: best.allCornersInsideSafeMargin,
        ambiguous: !!detected.ambiguous,
        forced: false,
      };
    } else {
      stability.reset();
    }
  }
  lastQuality = quality;
  const state = qualityState(quality);
  setOverlay(liveCorners, state.level);
  setQualityUi(quality);
  if (shouldAutoCapture(quality) && !analyzing) {
    track('auto_capture_started');
    await captureStill('auto', quality, liveCorners);
  }
}

function startQualityLoop() {
  stopQualityLoop();
  let last = 0;
  const interval = 1000 / DEFAULT_THRESHOLDS.analysisFps;
  const tick = now => {
    loopTimer = requestAnimationFrame(tick);
    if (now - last < interval || analyzing || loopBusy || loopPaused) return;
    last = now;
    loopBusy = true;
    Promise.resolve(runLivePass()).finally(() => { loopBusy = false; });
  };
  loopTimer = requestAnimationFrame(tick);
}

async function captureNow() {
  track('manual_capture_started');
  const video = document.getElementById('sm-cam');
  const quality = lastQuality || analyzer.analyze(video) || {
    sharpness: 0, brightness: 0, glareRisk: 1, stability: 0,
    labelCoverage: DEFAULT_THRESHOLDS.guide.width, documentBoundaryConfidence: 0.5,
    allCornersInsideSafeMargin: true, forced: true,
  };
  await captureStill('manual', quality, liveCorners);
}

async function captureStill(mode, quality, cornersNormalized) {
  if (analyzing) return;
  analyzing = true;
  document.getElementById('sm-quality-text').textContent = 'Capturing…';
  try {
    const original = await camera.takePhoto();
    await showPreview(original, quality, CaptureSource.CAMERA, mode, cornersNormalized);
  } catch (err) {
    document.getElementById('sm-quality-text').textContent = err.message || 'Capture failed';
  } finally {
    analyzing = false;
  }
}

function renderPreviewQuality(failures, barcodeValues) {
  previewFailures = failures || [];
  document.getElementById('sm-preview-quality').innerHTML = (failures.length ? failures : [
    'In focus', 'Full label visible', barcodeValues.length ? 'Barcode detected' : 'No barcode detected',
  ]).map(line => '<div class="' + (failures.length ? 'bad' : 'ok') + '">' + (failures.length ? '✗ ' : '✓ ') + line + '</div>').join('');
}

async function showPreview(original, quality, source, mode, cornersNormalized) {
  stopQualityLoop();
  camera.stop();
  document.getElementById('sm-view').classList.remove('is-live', 'is-quad');
  const processed = await processStill(original, {
    cornersNormalized,
    quality,
    barcodes: liveBarcodes,
  });
  const crop = processed.crop;
  const probe = await loadImage(crop).catch(() => null);
  const barcodeValues = probe ? await barcodes.detect(probe) : [];
  const failures = processed.failures.length ? processed.failures : qualityFailures(processed.quality);
  pendingCapture = {
    original,
    crop,
    quality: { ...processed.quality },
    source,
    mode,
    barcodeValues,
    forced: false,
    cornersNormalized: processed.cornersNormalized,
    detectedLabel: processed.detectedLabel,
  };
  document.getElementById('sm-preview-crop').src = crop;
  document.getElementById('sm-preview-original').src = original;
  renderPreviewQuality(failures, barcodeValues);
  showPanel('preview');
  track('capture_completed', { mode, failures: failures.length, opencv: processed.opencv });
}

function ensureCropEditor() {
  if (cropEditor) return cropEditor;
  cropEditor = new PerspectiveCropEditor(document.getElementById('sm-crop-canvas'), async corners => {
    if (!pendingCapture) return;
    const result = await rewarp(pendingCapture.original, corners);
    pendingCapture.crop = result.crop;
    pendingCapture.cornersNormalized = result.cornersNormalized;
    pendingCapture.detectedLabel = result.detectedLabel;
    pendingCapture.quality = {
      ...pendingCapture.quality,
      ...result.quality,
      documentBoundaryConfidence: result.detectedLabel.confidence,
    };
    document.getElementById('sm-preview-crop').src = result.crop;
    renderPreviewQuality(result.failures, pendingCapture.barcodeValues || []);
  });
  return cropEditor;
}

async function openCropEditor() {
  if (!pendingCapture) return;
  cropEditorSnapshot = {
    crop: pendingCapture.crop,
    corners: pendingCapture.cornersNormalized,
    detectedLabel: { ...pendingCapture.detectedLabel },
  };
  const image = await loadImage(pendingCapture.original);
  const canvas = document.getElementById('sm-crop-canvas');
  const host = document.getElementById('sm-crop-editor');
  host.hidden = false;
  const maxW = Math.min(720, Math.max(280, host.querySelector('.sm-crop-editor-card')?.clientWidth || 640));
  canvas.width = maxW;
  canvas.height = Math.max(180, Math.round(maxW * image.naturalHeight / image.naturalWidth));
  ensureCropEditor().setImage(image, pendingCapture.cornersNormalized || guideCorners());
}

function applyCropEdit() {
  document.getElementById('sm-crop-editor').hidden = true;
  cropEditorSnapshot = null;
}

function approveCapture() {
  useThisLabel(previewFailures.length > 0);
}

function approveCropEdit() {
  document.getElementById('sm-crop-editor').hidden = true;
  cropEditorSnapshot = null;
  approveCapture();
}

function retakeFromCropEditor() {
  document.getElementById('sm-crop-editor').hidden = true;
  cropEditorSnapshot = null;
  retakeCapture();
}

function cancelCropEdit() {
  if (cropEditorSnapshot && pendingCapture) {
    pendingCapture.crop = cropEditorSnapshot.crop;
    pendingCapture.cornersNormalized = cropEditorSnapshot.corners;
    pendingCapture.detectedLabel = cropEditorSnapshot.detectedLabel;
    document.getElementById('sm-preview-crop').src = pendingCapture.crop;
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
    reviewReasons: capture.forced ? ['Image was submitted despite a quality failure'] : [],
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
  for (const file of files) {
    const original = await fileToDataUrl(file);
    await showPreview(original, null, CaptureSource.UPLOAD, 'upload');
  }
}
async function dropFiles(e) {
  e.preventDefault();
  const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
  if (files.length) {
    const original = await fileToDataUrl(files[0]);
    await showPreview(original, null, CaptureSource.UPLOAD, 'upload');
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
        '<div class="sm-qcard-body"><div class="sm-qcard-title tis-text-gray">AI กำลังอ่านฉลาก…</div>' +
        '<div class="sm-bar" style="margin:8px 0 6px;width:70%"></div><div class="sm-bar" style="width:45%"></div></div></div>';
    }
    if (st === 'error') {
      return '<div class="sm-qcard is-error"><img class="sm-thumb" src="' + item.photo + '" alt="">' +
        '<div class="sm-qcard-body">' +
          '<div class="sm-qcard-title tis-text-danger">อ่านฉลากไม่สำเร็จ</div>' +
          '<div class="sm-qcard-meta tis-text-gray" style="word-break:break-word">' + esc(item.error) + '</div>' +
          '<div style="margin-top:8px">' +
            '<button class="sm-choice" onclick="retry(' + item.id + ')">ลองอ่านอีกครั้ง</button> ' +
            '<button class="sm-choice" onclick="removeItem(' + item.id + ')">ลบ</button>' +
          '</div>' +
        '</div></div>';
    }
    const f = item.fields;
    const flagged = FIELDS.filter(({ k }) => needsAttention(f[k])).length;
    const badge = st === 'ready'
      ? '<span class="tis-badge-success tis-badge-sm tis-badge-round"><mat-icon class="mat-icon material-icons">check_circle</mat-icon>พร้อม</span>'
      : '<span class="tis-badge-warning tis-badge-sm tis-badge-round"><mat-icon class="mat-icon material-icons">touch_app</mat-icon>ต้องตรวจ ' + flagged + '</span>';
    const dup = isDuplicate(f.tracking.value) && !item.dupOk
      ? ' <span class="tis-badge-danger tis-badge-sm tis-badge-round"><mat-icon class="mat-icon material-icons">error_outline</mat-icon>เลขซ้ำ</span>' : '';
    const conflict = item.barcodeConflict && !item.conflictResolved
      ? ' <span class="tis-badge-danger tis-badge-sm tis-badge-round"><mat-icon class="mat-icon material-icons">compare_arrows</mat-icon>Barcode ไม่ตรง OCR</span>' : '';
    return '<div class="sm-qcard ' + (st === 'ready' ? '' : 'is-review') + '" onclick="openSheet(' + item.id + ')">' +
      '<img class="sm-thumb" src="' + item.photo + '" alt="">' +
      '<div class="sm-qcard-body">' +
        '<div class="sm-qcard-title">' + (f.tracking.value || '— ไม่พบเลขพัสดุ —') + '</div>' +
        '<div class="sm-qcard-meta">' + (f.recipient.value || '— ไม่พบผู้รับ —') + ' · ' + f.unit.value + '</div>' +
        '<div class="sm-qcard-meta tis-text-gray">' + f.type.value + ' · ' + shortCarrier(f.carrier.value) + '</div>' +
        '<div style="margin-top:6px">' + badge + dup + conflict + '</div>' +
        '<div style="margin-top:8px;display:flex;gap:6px" onclick="event.stopPropagation()">' +
          '<button class="sm-choice" onclick="openSheet(' + item.id + ')">แก้</button>' +
          '<button class="sm-choice" onclick="removeItem(' + item.id + ')">ลบ</button>' +
        '</div>' +
      '</div>' +
      '<mat-icon class="mat-icon material-icons tis-text-light">chevron_right</mat-icon></div>';
  }).join('');

  const count = st => queue.filter(i => itemStatus(i) === st).length;
  document.getElementById('sm-queue-counts').innerHTML =
    '<span class="tis-badge-outline-primary tis-badge-sm">ในคิว ' + queue.length + '</span>' +
    '<span class="tis-badge-outline-success tis-badge-sm">พร้อม ' + count('ready') + '</span>' +
    (count('review') ? '<span class="tis-badge-outline-warning tis-badge-sm">ต้องตรวจ ' + count('review') + '</span>' : '') +
    (count('error') ? '<span class="tis-badge-outline-danger tis-badge-sm">อ่านไม่ได้ ' + count('error') + '</span>' : '');
  document.getElementById('sm-to-approve').disabled = !queue.some(i => i.fields);
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
function closeSheet() { document.body.classList.remove('sm-sheet-open'); openId = null; }

function renderSheet() {
  const item = queue.find(i => i.id === openId);
  if (!item || !item.fields) { closeSheet(); return; }
  document.getElementById('sm-sheet-photo').src = item.photo;
  const flagged = FIELDS.filter(({ k }) => needsAttention(item.fields[k])).length;
  document.getElementById('sm-sheet-sub').textContent = flagged
    ? 'AI เติมให้แล้ว ' + (FIELDS.length - flagged) + ' จาก ' + FIELDS.length + ' ฟิลด์ · เหลือให้แตะ ' + flagged
    : 'AI เติมครบทุกฟิลด์ · กดยืนยันได้เลย';

  const alerts = [];
  if (item.reviewReasons?.length) {
    alerts.push('<div class="tis-alert tis-alert-warning" style="margin:10px 0"><mat-icon class="mat-icon material-icons">warning_amber</mat-icon>' + item.reviewReasons.map(esc).join('<br>') + '</div>');
  }
  if (item.barcodeConflict && !item.conflictResolved) {
    alerts.push(
      '<div class="tis-alert tis-alert-danger" style="margin:10px 0"><mat-icon class="mat-icon material-icons">compare_arrows</mat-icon>' +
      'Barcode และ OCR อ่านเลขพัสดุไม่ตรงกัน — เลือกค่าที่จะใช้ก่อนบันทึก' +
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
      ? '<span class="tis-badge-outline-primary tis-badge-xs"><mat-icon class="mat-icon material-icons">how_to_reg</mat-icon>คนยืนยันแล้ว</span>'
      : st === 'auto'  ? '<span class="tis-badge-success tis-badge-xs tis-badge-round"><mat-icon class="mat-icon material-icons">auto_awesome</mat-icon>AI ' + pct + '%</span>'
      : st === 'check' ? '<span class="tis-badge-warning tis-badge-xs tis-badge-round"><mat-icon class="mat-icon material-icons">visibility</mat-icon>เหลือบดู ' + pct + '%</span>'
      :                  '<span class="tis-badge-danger tis-badge-xs tis-badge-round"><mat-icon class="mat-icon material-icons">error_outline</mat-icon>เลือกเอง ' + pct + '%</span>';
    const value = f.value
      ? '<div class="sm-field-value">' + f.value + '</div>'
      : '<div class="sm-field-value is-empty">AI อ่านไม่ออก — เลือกด้านล่าง</div>';
    const raw = k === 'unit' && f.raw ? '<div class="tis-text-gray" style="font-size:11.5px">AI อ่านได้: “' + f.raw + '”</div>' : '';
    const chips = '<div class="sm-chiprow">' + (f.alts.length
      ? f.alts.map(a => '<button class="sm-choice ' + (a === f.value ? 'active' : '') +
          '" onclick="pick(' + item.id + ',\'' + k + '\',this.dataset.v)" data-v="' + esc(a) + '">' + a + '</button>').join('') +
        '<button class="sm-choice" onclick="pick(' + item.id + ',\'' + k + '\',\'อื่น ๆ (เลือกจากรายการเต็ม)\')">อื่น ๆ…</button>'
      : '<input class="sm-choice" style="min-width:190px;text-align:left" value="' + esc(f.value) + '" placeholder="พิมพ์ทับถ้า AI อ่านผิด"' +
          ' onchange="typeIn(' + item.id + ',\'' + k + '\',this.value)">' +
        (opt ? '<button class="sm-choice" onclick="pick(' + item.id + ',\'' + k + '\',\'—\')">ไม่ระบุ</button>' : '')
    ) + '</div>';
    return '<div class="sm-field sm-field--' + st + '">' +
      '<div class="sm-field-head"><span class="sm-field-label">' + label + '</span>' + badge + '</div>' +
      value + raw + chips + '</div>';
  }).join('');

  const blocked = pendingPick(item) || (item.barcodeConflict && !item.conflictResolved);
  const btn = document.getElementById('sm-sheet-confirm');
  btn.disabled = blocked;
  btn.querySelector('.mdc-button__label').textContent = blocked
    ? (item.barcodeConflict && !item.conflictResolved ? 'ยังต้องเลือกเลขพัสดุ' : 'ยังต้องเลือกให้ครบ')
    : 'ยืนยัน';
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
    return '<tr style="' + (dup || item.barcodeConflict && !item.conflictResolved ? 'background:#fef2f2' : st === 'review' ? 'background:#fffbeb' : '') + '">' +
      '<td><img class="sm-thumb" style="width:56px;height:42px" src="' + item.photo + '" alt=""></td>' +
      '<td><span class="tis-a">' + (f.tracking.value || '—') + '</span>' + (dup ? '<div><span class="tis-badge-danger tis-badge-xs">มีในระบบแล้ว</span></div>' : '') + '</td>' +
      '<td class="tis-overflow-ellipsis" style="max-width:150px">' + shortCarrier(f.carrier.value) + '</td>' +
      '<td>' + (f.recipient.value || '<span class="tis-text-danger">ยังไม่ระบุ</span>') + '</td>' +
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
        '<div class="sm-qcard-meta">' + (f.recipient.value || 'ยังไม่ระบุผู้รับ') + ' · ' + f.unit.value + '</div>' +
        '<div class="sm-qcard-meta tis-text-gray">' + f.type.value + ' · ' + shortCarrier(f.carrier.value) + '</div>' +
        '<div style="margin-top:6px">' + statusBadge(st) + ' ' + conditionBadge(f.condition.value) + '</div>' +
        '<div style="margin-top:8px">' + rowActions(item, dup) + '</div>' +
      '</div></div>';
  }).join('');

  const totalFields = done.length * FIELDS.length;
  const autoFields = done.reduce((n, i) => n + FIELDS.filter(({ k }) => fieldState(i.fields[k].conf) === 'auto').length, 0);
  document.getElementById('kpi-total').textContent = done.length;
  document.getElementById('kpi-auto').textContent = totalFields ? Math.round(autoFields / totalFields * 100) + '%' : '—';
  document.getElementById('kpi-auto-sub').textContent = autoFields + ' จาก ' + totalFields + ' ฟิลด์';
  document.getElementById('kpi-review').textContent = done.filter(i => itemStatus(i) === 'review').length;
  document.getElementById('kpi-saved').textContent = autoFields;
  document.getElementById('done-count').textContent = done.length;

  const review = done.filter(i => itemStatus(i) === 'review');
  const dups = done.filter(i => isDuplicate(i.fields.tracking.value) && !i.dupOk);
  const conflicts = done.filter(i => i.barcodeConflict && !i.conflictResolved);
  const alert = document.getElementById('sm-approve-alert');
  alert.innerHTML =
    (conflicts.length ? '<div class="tis-alert tis-alert-danger"><mat-icon class="mat-icon material-icons">compare_arrows</mat-icon>' +
      'มี ' + conflicts.length + ' รายการที่ barcode ไม่ตรง OCR — ต้องเลือกเลขพัสดุก่อน Approve</div>' : '') +
    (dups.length ? '<div class="tis-alert tis-alert-danger"><mat-icon class="mat-icon material-icons">error_outline</mat-icon>' +
      'พบเลขพัสดุที่มีในระบบแล้ว ' + dups.length + ' รายการ — ลบทิ้งหรือกด “ไม่ซ้ำ” เพื่อยืนยันว่าเป็นพัสดุคนละชิ้น</div>' : '') +
    (review.length ? '<div class="tis-alert tis-alert-warning"><mat-icon class="mat-icon material-icons">warning_amber</mat-icon>' +
      'มี ' + review.length + ' รายการที่ AI ไม่มั่นใจ — แตะ “ตรวจ” เพื่อยืนยันก่อน Approve</div>' : '') +
    (!dups.length && !review.length && !conflicts.length && done.length ? '<div class="tis-alert tis-alert-success"><mat-icon class="mat-icon material-icons">check_circle</mat-icon>' +
      'ทุกรายการพร้อมบันทึก — กด Approve เพื่อสร้างพัสดุและแจ้งเตือนผู้รับ</div>' : '');

  const blocked = !done.length || review.length > 0 || dups.length > 0 || conflicts.length > 0;
  document.getElementById('sm-approve-btn').disabled = blocked;
  document.getElementById('sm-approve-note').textContent = blocked
    ? (done.length ? 'ต้องเคลียร์รายการที่ติดปัญหาก่อนจึงจะ Approve ได้' : 'ยังไม่มีพัสดุในชุดนี้')
    : 'จะสร้าง ' + done.length + ' รายการเป็นสถานะ Ready for Pick-up และแจ้งเตือนผู้รับทันที';
}
function rowActions(item, dup) {
  return (dup ? '<button class="sm-choice" onclick="markNotDup(' + item.id + ')">ไม่ซ้ำ</button> ' : '') +
    '<button class="sm-choice" onclick="openSheet(' + item.id + ')">' + (itemStatus(item) === 'review' ? 'ตรวจ' : 'แก้') + '</button> ' +
    '<button class="sm-choice" onclick="removeItem(' + item.id + ')">ลบ</button>';
}
function markNotDup(id) { queue.find(i => i.id === id).dupOk = true; render(); }
function removeItem(id) { queue = queue.filter(i => i.id !== id); render(); }

function openConfirm() {
  const done = queue.filter(i => i.fields);
  document.getElementById('sm-confirm-text').innerHTML =
    'ระบบจะสร้างพัสดุ <b>' + done.length + ' รายการ</b> ในโครงการ <b>AIS Tower 1</b> จุดเก็บ <b>ล็อบบี้ (002)</b> ' +
    'สถานะ <b>Ready for Pick-up</b> และส่งแจ้งเตือนถึงผู้รับทุกคนทันที';
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
  ? '<span class="tis-badge-sr-so-approved tis-badge-sm tis-badge-round"><mat-icon class="mat-icon material-icons">check_circle</mat-icon>พร้อมบันทึก</span>'
  : '<span class="tis-badge-sr-so-onhold tis-badge-sm tis-badge-round"><mat-icon class="mat-icon material-icons">touch_app</mat-icon>ต้องตรวจ</span>';

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
  document.querySelectorAll('#sm-steps .tis-pill').forEach(p => p.classList.toggle('active', p.dataset.screen === screen));
}
function show(screen) {
  document.querySelectorAll('.sm-screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + screen);
  if (el) el.classList.add('active');
  document.querySelector('mat-drawer-content').scrollTop = 0;
}

function flipCamera() { return camera.flip(); }
function toggleTorch() { return camera.toggleTorch(); }

window.addEventListener('pagehide', () => stopCameraTracks());
window.addEventListener('beforeunload', () => stopCameraTracks());
document.addEventListener('visibilitychange', () => {
  const scannerOpen = !document.getElementById('sm-scanner').hidden;
  if (document.hidden) {
    loopPaused = true;
    return;
  }
  loopPaused = false;
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
  pickFiles, filesPicked, dropFiles, showManualEntry, hideManualEntry, submitManualEntry,
  retry, resetDemo, clearQueue, dropItem, openSheet, closeSheet, pick, typeIn, confirmItem,
  resolveConflict, renderApprove, openConfirm, closeConfirm, doApprove, go, removeItem, markNotDup,
  fieldState, matchUnits, isDuplicate, itemStatus, fromExtraction, MOCK_SHOTS, FIELDS, buildItem, seedDemo, queue,
});

(function selfCheck() {
  let ok = true;
  const is = (cond, msg) => { if (!cond) { ok = false; console.assert(cond, msg); } };
  is(fieldState(0.97) === 'auto',  'สูงกว่าเกณฑ์ต้องเติมอัตโนมัติ');
  is(fieldState(0.90) === 'auto',  'ขอบ 0.90 นับเป็น auto');
  is(fieldState(0.89) === 'check', 'ต่ำกว่า 0.90 ต้องให้คนเหลือบ');
  is(fieldState(0.60) === 'check', 'ขอบ 0.60 นับเป็น check');
  is(fieldState(0.59) === 'pick',  'ต่ำกว่า 0.60 ต้องบังคับเลือก');
  is(matchUnits('ชั้น 21 ฝ่ายการตลาด')[0].includes('21F-MKT'), 'ตัวเลขชั้นต้องชนะ');
  is(matchUnits('Floor 18 Finance')[0].includes('18F-FIN'),     'คำภาษาอังกฤษต้อง match ได้');
  is(isDuplicate('LEXPU0703471485'), 'ต้องจับเลขพัสดุที่มีในระบบแล้วได้');
  const dirty = buildItem(MOCK_SHOTS[4], 98); dirty.status = 'read';
  is(itemStatus(dirty) === 'review', 'มีฟิลด์ที่อ่านไม่ออก = ต้องตรวจ');
  const conflicted = buildItem(MOCK_SHOTS[0], 97); conflicted.status = 'read'; conflicted.barcodeConflict = true;
  is(itemStatus(conflicted) === 'review', 'barcode conflict ต้องบังคับตรวจ');
  conflicted.conflictResolved = true; conflicted.acknowledged = true;
  is(itemStatus(conflicted) === 'ready', 'แก้ conflict แล้วต้องพร้อม');
  console.log(ok ? '✓ self-check ผ่าน (confidence, units, duplicates, barcode conflict)' : '✗ self-check ล้มเหลว');
})();

render();
loadOcrStatus();

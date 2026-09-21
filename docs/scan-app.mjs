import { CameraSession } from './ingestion/camera.mjs';
import { FrameQualityAnalyzer } from './ingestion/quality.mjs';
import { DEFAULT_THRESHOLDS } from './ingestion/thresholds.mjs';
import { loadOpenCv, isOpenCvReady } from './ingestion/opencv-loader.mjs';
import { LabelCandidateDetector } from './ingestion/label-detector.mjs';
import { StabilityTracker } from './ingestion/stability.mjs';
import { preProcessScannedDocument, BlurRejectedError } from './ingestion/preprocess.mjs';
import { IngestionClient } from './ingestion/client.mjs';
import { CaptureSource, SCANNER_VERSION } from './ingestion/contracts.mjs';

const video = document.getElementById('sm-cam');
const guideEl = document.getElementById('scan-guide');
const coach = document.getElementById('scan-coach');
const spinner = document.getElementById('scan-spinner');
const torchBtn = document.getElementById('scan-torch');
const ring = document.getElementById('scan-ring');
const ringSvg = ring.querySelector('.scan-ring');
const live = document.getElementById('screen-live');
const result = document.getElementById('screen-result');
const done = document.getElementById('screen-done');
const preview = document.getElementById('scan-preview');
const statusEl = document.getElementById('scan-status');
const confirmBtn = document.getElementById('scan-confirm');
const doneNote = document.getElementById('done-note');

const camera = new CameraSession(video);
const analyzer = new FrameQualityAnalyzer();
const detector = new LabelCandidateDetector();
const stability = new StabilityTracker();
const client = new IngestionClient();

let loopTimer = 0;
let loopBusy = false;
let capturing = false;
let countdown = 0;
let pending = null;
let torchAsked = false;
let darkFrames = 0;
let lastCorners = null;
let lastQuality = null;

function show(screen) {
  live.hidden = screen !== 'live';
  result.hidden = screen !== 'result';
  done.hidden = screen !== 'done';
}

function setAligned(on) {
  guideEl.classList.toggle('is-aligned', !!on);
}

function startCountdown() {
  if (countdown) return;
  ring.hidden = false;
  ringSvg.classList.remove('is-on');
  void ringSvg.offsetWidth;
  ringSvg.classList.add('is-on');
  countdown = setTimeout(() => {
    countdown = 0;
    capture();
  }, 500);
}

function cancelCountdown() {
  if (countdown) clearTimeout(countdown);
  countdown = 0;
  ring.hidden = true;
  ringSvg.classList.remove('is-on');
}

async function capture() {
  if (capturing || !isOpenCvReady() || !camera.hasLiveTrack()) return;
  capturing = true;
  cancelCountdown();
  coach.textContent = 'CAPTURING…';
  stopLoop();
  try {
    const original = await camera.takePhoto();
    const processed = await preProcessScannedDocument(original, {
      cornersNormalized: lastCorners,
      quality: lastQuality,
    });
    camera.stop();
    pending = processed;
    preview.src = processed.crop;
    statusEl.textContent = '';
    show('result');
  } catch (err) {
    capturing = false;
    if (err instanceof BlurRejectedError) {
      coach.textContent = 'Too blurry — hold still';
      setAligned(false);
      startLoop();
      return;
    }
    coach.textContent = err.message || 'Capture failed. Hold steady and try again.';
    startLoop();
    return;
  }
  capturing = false;
}

async function tick() {
  if (!isOpenCvReady() || capturing) return;
  const quality = analyzer.analyze(video);
  lastQuality = quality;
  if (quality?.brightness != null && quality.brightness < DEFAULT_THRESHOLDS.minBrightness) {
    darkFrames += 1;
    if (darkFrames > 20 && !torchAsked) {
      torchAsked = true;
      try {
        const on = await camera.setTorch(true);
        if (!on) torchBtn.hidden = false;
      } catch {
        torchBtn.hidden = false;
      }
    }
  } else {
    darkFrames = 0;
  }

  const detected = detector.detect(video, []);
  const best = detected?.best;
  lastCorners = best?.corners || null;
  const aligned = !!best?.corners;
  setAligned(aligned);

  if (!aligned) {
    cancelCountdown();
    stability.reset();
    coach.textContent = 'Hold the receipt in view';
    return;
  }

  const stab = stability.update(best.corners, video.videoWidth, video.videoHeight);
  const dark = (quality?.brightness || 0) < DEFAULT_THRESHOLDS.minBrightness;
  const ready = stab.locked && !dark;

  if (ready) {
    coach.textContent = 'HOLD STEADY… CAPTURING';
    startCountdown();
  } else {
    cancelCountdown();
    coach.textContent = dark ? 'Need more light' : 'HOLD STEADY… CAPTURING';
  }
}

function startLoop() {
  stopLoop();
  const interval = 1000 / DEFAULT_THRESHOLDS.analysisFps;
  let last = 0;
  const frame = now => {
    loopTimer = requestAnimationFrame(frame);
    if (now - last < interval || loopBusy || capturing) return;
    last = now;
    loopBusy = true;
    Promise.resolve(tick()).finally(() => { loopBusy = false; });
  };
  loopTimer = requestAnimationFrame(frame);
}

function stopLoop() {
  if (loopTimer) cancelAnimationFrame(loopTimer);
  loopTimer = 0;
  loopBusy = false;
  cancelCountdown();
  analyzer.reset();
  stability.reset();
}

async function startScanner() {
  capturing = false;
  pending = null;
  torchAsked = false;
  darkFrames = 0;
  torchBtn.hidden = true;
  setAligned(false);
  show('live');
  spinner.hidden = false;
  coach.textContent = 'Hold the receipt in view';
  try {
    await camera.start('environment');
  } catch (err) {
    spinner.hidden = true;
    coach.textContent = err.name === 'NotAllowedError'
      ? 'Allow the camera to scan receipts.'
      : (err.message || 'Could not open the camera. Use HTTPS.');
    return;
  }
  startLoop();
  try {
    await loadOpenCv();
  } catch {
    coach.textContent = 'Scanner engine failed to load. Check your connection and retry.';
  }
  spinner.hidden = true;
}

async function confirmUpload() {
  if (!pending) return;
  confirmBtn.disabled = true;
  statusEl.textContent = 'Uploading…';
  try {
    const session = await client.create(CaptureSource.CAMERA, 'mobile');
    await client.preprocess(session.ingestionId, {
      original: pending.original,
      crop: pending.crop,
      laplacianVariance: pending.laplacianVariance,
      cornersNormalized: pending.cornersNormalized,
    });
    await client.addMetadata(session.ingestionId, {
      captureQuality: pending.quality,
      detectedLabel: pending.detectedLabel,
      scannerVersion: SCANNER_VERSION,
    });
    doneNote.textContent = 'Sent to the ingestion API.';
  } catch (err) {
    if (/blurry/i.test(err?.message || '')) {
      statusEl.textContent = err.message;
      confirmBtn.disabled = false;
      return;
    }
    doneNote.textContent = 'Saved on this device. Gemini upload needs the local server.';
  }
  confirmBtn.disabled = false;
  show('done');
}

torchBtn.addEventListener('click', async () => {
  const on = await camera.setTorch(true);
  if (on) torchBtn.hidden = true;
});
document.getElementById('scan-confirm').addEventListener('click', confirmUpload);
document.getElementById('scan-retake').addEventListener('click', startScanner);
document.getElementById('scan-again').addEventListener('click', startScanner);
window.addEventListener('pagehide', () => { stopLoop(); camera.stop(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopLoop();
    return;
  }
  if (!live.hidden && !camera.hasLiveTrack()) startScanner();
});

startScanner();

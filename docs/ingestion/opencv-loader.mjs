import { track } from './telemetry.mjs';

const SOURCES = [
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
  'https://docs.opencv.org/4.10.0/opencv.js',
];

let loading = null;

function cvReady() {
  const cv = globalThis.cv;
  return !!(cv && (cv.Mat || cv.imread));
}

function waitForCv(timeoutMs) {
  return new Promise((resolve, reject) => {
    if (cvReady()) return resolve(globalThis.cv);
    const started = Date.now();
    const prev = globalThis.cv?.onRuntimeInitialized;
    const finish = () => {
      clearInterval(poll);
      resolve(globalThis.cv);
    };
    if (globalThis.cv) {
      globalThis.cv.onRuntimeInitialized = () => {
        if (typeof prev === 'function') prev();
        finish();
      };
    }
    const poll = setInterval(() => {
      if (cvReady()) {
        clearInterval(poll);
        resolve(globalThis.cv);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(poll);
        reject(new Error('OpenCV runtime timed out'));
      }
    }, 50);
  });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-opencv-src="${src}"]`);
    if (existing) return resolve();
    const script = document.createElement('script');
    script.async = true;
    script.src = src;
    script.dataset.opencvSrc = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(script);
  });
}

export function isOpenCvReady() {
  return cvReady();
}

export async function loadOpenCv(timeoutMs = 25000) {
  if (cvReady()) return globalThis.cv;
  if (loading) return loading;
  loading = (async () => {
    track('opencv_load_started');
    let lastError = null;
    for (const src of SOURCES) {
      try {
        await loadScript(src);
        const cv = await waitForCv(timeoutMs);
        track('opencv_load_succeeded', { src });
        return cv;
      } catch (err) {
        lastError = err;
      }
    }
    track('opencv_load_failed', { message: lastError?.message || 'unknown' });
    throw lastError || new Error('OpenCV.js failed to load');
  })();
  try {
    return await loading;
  } catch (err) {
    loading = null;
    throw err;
  }
}

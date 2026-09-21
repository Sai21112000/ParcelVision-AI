const TESSERACT_JS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1';
const TESSERACT_CORE = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1';
const LANG_PATH = 'https://tessdata.projectnaptha.com/4.0.0';

/** Page segmentation: 3 auto, 4 single column, 6 uniform block, 11 sparse text. */
export const OCR_DEFAULTS = Object.freeze({
  langs: 'tha+eng',
  oem: 1,
  psm: '4',
  trackingPsm: '11',
  trackingWhitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-',
  preserveInterwordSpaces: '1',
  userDefinedDpi: '300',
  doInvert: '0',
  secondPass: true,
  charBlacklist: '|~«»<>{}[]',
});

let worker = null;
let loading = null;
let workerKey = '';

export function isOcrReady() {
  return !!worker;
}

async function loadCreateWorker() {
  const mod = await import(`${TESSERACT_JS}/dist/tesseract.esm.min.js`);
  return mod.createWorker || mod.default?.createWorker || mod.default;
}

function workerOptions(onStatus) {
  return {
    workerPath: `${TESSERACT_JS}/dist/worker.min.js`,
    corePath: `${TESSERACT_CORE}/tesseract-core.wasm.js`,
    langPath: LANG_PATH,
    logger: message => {
      const status = message?.status || '';
      if (/loading|initializing|loaded/i.test(status)) onStatus?.('Preparing text reader…');
      else if (/recogniz/i.test(status)) onStatus?.('Reading label text…');
    },
  };
}

async function getWorker(onStatus, config) {
  const key = `${config.langs}:${config.oem}`;
  if (worker && workerKey === key) return worker;
  if (loading) return loading;
  loading = (async () => {
    if (worker && workerKey !== key) {
      await worker.terminate().catch(() => {});
      worker = null;
    }
    onStatus?.('Preparing text reader…');
    const createWorker = await loadCreateWorker();
    const options = workerOptions(onStatus);
    let next;
    try {
      next = await createWorker(config.langs, config.oem, options);
    } catch {
      next = await createWorker('eng', config.oem, options);
    }
    worker = next;
    workerKey = key;
    return next;
  })();
  try {
    return await loading;
  } catch (err) {
    loading = null;
    throw err;
  } finally {
    if (worker) loading = null;
  }
}

async function applyBaseParams(active, config) {
  await active.setParameters({
    tessedit_pageseg_mode: String(config.psm),
    tessedit_char_whitelist: '',
    tessedit_char_blacklist: config.charBlacklist,
    tessedit_do_invert: config.doInvert,
    preserve_interword_spaces: config.preserveInterwordSpaces,
    user_defined_dpi: config.userDefinedDpi,
    classify_bln_numeric_mode: '0',
  });
}

function hasTrackingLike(text) {
  const upper = (text || '').toUpperCase();
  return /[A-Z0-9]{8,35}/.test(upper) && /\d/.test(upper);
}

function readResult(result) {
  return {
    text: (result?.data?.text || '').trim(),
    confidence: Number(result?.data?.confidence) || 0,
  };
}

export async function recognizeLabel(imageSrc, onStatus, overrides = {}) {
  const config = { ...OCR_DEFAULTS, ...overrides };
  const active = await getWorker(onStatus, config);
  await applyBaseParams(active, config);
  onStatus?.('Reading label text…');
  const first = readResult(await active.recognize(imageSrc));
  if (!config.secondPass || hasTrackingLike(first.text)) {
    return { ...first, trackingText: '' };
  }

  onStatus?.('Reading tracking number…');
  await active.setParameters({
    tessedit_pageseg_mode: String(config.trackingPsm),
    tessedit_char_whitelist: config.trackingWhitelist,
    tessedit_char_blacklist: '',
    classify_bln_numeric_mode: '1',
  });
  try {
    const second = readResult(await active.recognize(imageSrc));
    return {
      text: [first.text, second.text].filter(Boolean).join('\n'),
      confidence: Math.max(first.confidence, second.confidence),
      trackingText: second.text,
    };
  } finally {
    await applyBaseParams(active, config);
  }
}

export async function disposeOcrWorker() {
  const active = worker;
  worker = null;
  loading = null;
  workerKey = '';
  if (active) await active.terminate().catch(() => {});
}

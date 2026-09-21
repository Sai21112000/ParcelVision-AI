import { DEFAULT_THRESHOLDS } from './thresholds.mjs';

export async function cropGuideRegion(dataUrl, config = DEFAULT_THRESHOLDS) {
  const image = await loadImage(dataUrl);
  const guide = config.guide;
  const sx = Math.round(image.naturalWidth * guide.x);
  const sy = Math.round(image.naturalHeight * guide.y);
  const sw = Math.round(image.naturalWidth * guide.width);
  const sh = Math.round(image.naturalHeight * guide.height);
  const scale = Math.min(1, config.maxCaptureEdge / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  canvas.getContext('2d').drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', config.captureJpegQuality);
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not decode the selected image'));
    image.src = src;
  });
}

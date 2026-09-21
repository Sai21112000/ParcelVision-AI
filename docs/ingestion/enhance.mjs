import { DEFAULT_THRESHOLDS } from './thresholds.mjs';
import { loadImage } from './crop.mjs';

const clampByte = value => value < 0 ? 0 : value > 255 ? 255 : value | 0;

function canvasFromImage(image, maxEdge = 0) {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const scale = maxEdge > 0 ? Math.min(1, maxEdge / Math.max(width, height)) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}

function luminanceOf(data) {
  const y = new Float32Array(data.length / 4);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    y[p] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
  }
  return y;
}

function boxBlur(src, width, height, radius) {
  const window = radius * 2 + 1;
  const tmp = new Float32Array(src.length);
  const dst = new Float32Array(src.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1) {
      sum += src[row + Math.max(0, Math.min(width - 1, x))];
    }
    for (let x = 0; x < width; x += 1) {
      tmp[row + x] = sum / window;
      sum += src[row + Math.max(0, Math.min(width - 1, x + radius + 1))]
        - src[row + Math.max(0, Math.min(width - 1, x - radius))];
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) {
      sum += tmp[Math.max(0, Math.min(height - 1, y)) * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      dst[y * width + x] = sum / window;
      sum += tmp[Math.max(0, Math.min(height - 1, y + radius + 1)) * width + x]
        - tmp[Math.max(0, Math.min(height - 1, y - radius)) * width + x];
    }
  }
  return dst;
}

function percentileBounds(y, low = 0.02, high = 0.98) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < y.length; i += 1) hist[clampByte(Math.round(y[i]))] += 1;
  const n = y.length;
  const at = t => {
    let acc = 0;
    const target = n * t;
    for (let i = 0; i < 256; i += 1) {
      acc += hist[i];
      if (acc >= target) return i;
    }
    return 255;
  };
  const lo = at(low);
  const hi = at(high);
  return hi > lo ? { lo, hi } : { lo: 0, hi: 255 };
}

function applyAdaptiveContrast(imageData) {
  const { data, width, height } = imageData;
  const y = luminanceOf(data);
  const radius = Math.max(8, Math.min(32, Math.floor(Math.min(width, height) / 20)));
  const blurred = boxBlur(y, width, height, radius);
  const adapted = new Float32Array(y.length);
  for (let i = 0; i < y.length; i += 1) {
    const local = blurred[i] < 8 ? 8 : blurred[i];
    const flattened = y[i] / local * 128;
    adapted[i] = y[i] * 0.18 + flattened * 0.82;
  }
  const { lo, hi } = percentileBounds(adapted);
  const scale = 255 / Math.max(1, hi - lo);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const srcY = Math.max(y[p], 1);
    const stretched = clampByte((adapted[p] - lo) * scale);
    const chroma = stretched / srcY;
    data[i] = clampByte(data[i] * chroma);
    data[i + 1] = clampByte(data[i + 1] * chroma);
    data[i + 2] = clampByte(data[i + 2] * chroma);
  }
  return imageData;
}

export async function enhanceForUpload(dataUrl, config = DEFAULT_THRESHOLDS) {
  const image = await loadImage(dataUrl);
  const { canvas, ctx } = canvasFromImage(image);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  applyAdaptiveContrast(pixels);
  ctx.putImageData(pixels, 0, 0);
  return canvas.toDataURL('image/jpeg', config.captureJpegQuality);
}

export async function highContrastForOcr(dataUrl) {
  const image = await loadImage(dataUrl);
  const { canvas, ctx } = canvasFromImage(image, 1280);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = pixels;
  const y = luminanceOf(data);
  const radius = Math.max(6, Math.min(24, Math.floor(Math.min(width, height) / 28)));
  const mean = boxBlur(y, width, height, radius);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const value = y[p] > mean[p] - 10 ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = value;
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas.toDataURL('image/png');
}

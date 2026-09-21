import { DEFAULT_THRESHOLDS } from './thresholds.mjs';

function isWebKit() {
  const ua = navigator.userAgent || '';
  return /AppleWebKit/i.test(ua) && !/Chrom(e|ium)/i.test(ua);
}

function isMac() {
  return /Macintosh|Mac OS X/i.test(navigator.userAgent || '') || navigator.platform === 'MacIntel';
}

const CONSTRAINT_LADDER = [
  { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  { facingMode: { ideal: 'environment' } },
  true,
  { facingMode: { ideal: 'user' } },
];

function continuityDevice(devices) {
  const video = (devices || []).filter(d => d.kind === 'videoinput');
  const match = video.find(d => /iphone|continuity|desk view|iphone usb|continuity camera/i.test(d.label || ''));
  return match?.deviceId || '';
}

export class CameraSession {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.facingMode = 'environment';
    this.torchOn = false;
    this.deviceId = '';
    this.pickedContinuity = false;
  }

  prepareVideo() {
    if (!this.video) return;
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('webkit-playsinline', '');
    this.video.setAttribute('muted', '');
    this.video.setAttribute('autoplay', '');
  }

  async attachStream(stream) {
    this.stream = stream;
    this.prepareVideo();
    this.video.srcObject = stream;
    try {
      await this.video.play();
    } catch {
      /* iOS may require a second play after metadata */
      await new Promise(resolve => {
        this.video.onloadedmetadata = () => resolve();
        setTimeout(resolve, 400);
      });
      await this.video.play().catch(() => {});
    }
    return stream;
  }

  async getStream(constraints) {
    return navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
  }

  async startWithLadder() {
    let lastError = null;
    for (const video of CONSTRAINT_LADDER) {
      try {
        return await this.getStream(video);
      } catch (err) {
        lastError = err;
        if (err?.name !== 'OverconstrainedError' && err?.name !== 'NotFoundError' && err?.name !== 'NotReadableError') {
          throw err;
        }
      }
    }
    throw lastError || new Error('Camera requires HTTPS or localhost');
  }

  async preferContinuityCamera() {
    if (this.pickedContinuity || !isMac() || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const deviceId = continuityDevice(devices);
      if (!deviceId || deviceId === this.deviceId) return;
      const next = await this.getStream({ deviceId: { exact: deviceId } });
      this.stopTracksOnly();
      this.deviceId = deviceId;
      this.pickedContinuity = true;
      await this.attachStream(next);
    } catch {
      this.pickedContinuity = true;
    }
  }

  async start(facingMode = this.facingMode) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera requires HTTPS or localhost');
    }
    this.stop();
    this.facingMode = facingMode;
    this.prepareVideo();
    const preferred = this.deviceId
      ? { deviceId: { exact: this.deviceId } }
      : facingMode === 'user'
        ? { facingMode: { ideal: 'user' } }
        : null;
    let stream;
    try {
      stream = preferred ? await this.getStream(preferred) : await this.startWithLadder();
    } catch (err) {
      if (preferred) stream = await this.startWithLadder();
      else throw err;
    }
    await this.attachStream(stream);
    await this.preferContinuityCamera();
    return this.stream;
  }

  stopTracksOnly() {
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.torchOn = false;
  }

  stop() {
    this.stopTracksOnly();
    if (this.video) this.video.srcObject = null;
  }

  hasLiveTrack() {
    return !!this.stream?.getVideoTracks().some(track => track.readyState === 'live');
  }

  async flip() {
    this.deviceId = '';
    this.pickedContinuity = false;
    return this.start(this.facingMode === 'environment' ? 'user' : 'environment');
  }

  async toggleTorch() {
    const track = this.stream?.getVideoTracks()[0];
    const capabilities = track?.getCapabilities?.();
    if (!track || !capabilities?.torch) return false;
    this.torchOn = !this.torchOn;
    await track.applyConstraints({ advanced: [{ torch: this.torchOn }] });
    return this.torchOn;
  }

  async takePhoto(config = DEFAULT_THRESHOLDS) {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) throw new Error('Camera is not running');
    if (!isWebKit() && 'ImageCapture' in globalThis) {
      try {
        const blob = await new globalThis.ImageCapture(track).takePhoto();
        return blobToDataUrl(blob);
      } catch { /* canvas fallback below */ }
    }
    return sourceToJpeg(this.video, config.maxCaptureEdge, config.captureJpegQuality);
  }
}

export function sourceToJpeg(source, maxEdge = 1920, quality = 0.88) {
  const width = source.videoWidth || source.naturalWidth || source.width;
  const height = source.videoHeight || source.naturalHeight || source.height;
  if (!width || !height) throw new Error('Image frame is not ready');
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

export function fileToDataUrl(file) {
  return blobToDataUrl(file);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read image'));
    reader.readAsDataURL(blob);
  });
}

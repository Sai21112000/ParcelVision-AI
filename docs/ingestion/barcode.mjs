const FORMATS = ['code_128', 'code_39', 'ean_13', 'ean_8', 'itf', 'qr_code', 'data_matrix', 'pdf417'];

export class BarcodeScanner {
  constructor() {
    this.detector = null;
  }

  async initialize() {
    if (!('BarcodeDetector' in globalThis)) return false;
    try {
      const supported = await globalThis.BarcodeDetector.getSupportedFormats();
      this.detector = new globalThis.BarcodeDetector({ formats: FORMATS.filter(f => supported.includes(f)) });
      return true;
    } catch {
      return false;
    }
  }

  async detect(source) {
    if (!this.detector) return [];
    try {
      const values = await this.detector.detect(source);
      return values.map(value => ({
        format: value.format,
        rawValue: value.rawValue,
        boundingBox: value.boundingBox ? {
          x: value.boundingBox.x,
          y: value.boundingBox.y,
          width: value.boundingBox.width,
          height: value.boundingBox.height,
        } : null,
      }));
    } catch {
      return [];
    }
  }
}

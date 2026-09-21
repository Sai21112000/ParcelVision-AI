# ParcelVision AI

ScanKit-style landing plus an in-browser receipt scanner. Open the demo, allow the camera, hold a receipt steady — it auto-captures, flattens, and cleans the scan.

**Live:** https://sai21112000.github.io/ParcelVision-AI/

GitHub Pages is static (HTTPS for camera). Local `serve.mjs` records preprocess (warp / threshold / blur) and optional Gemini extract. Do not commit `.env`.

## Local

```bash
# .env next to serve.mjs — never commit this file
# GEMINI_API_KEY=...
node serve.mjs
```

- Landing: http://localhost:8899/
- Scanner: http://localhost:8899/demo.html

## Layout

- `docs/index.html` — product landing
- `docs/demo.html` — full-screen auto-scan
- `docs/scan-app.mjs` — camera loop, overlay, countdown, confirm
- `docs/ingestion/` — OpenCV.js detect (full frame), warp, adaptive threshold, blur check
- `serve.mjs` — local preview, `POST /api/parcel-ingestions/:id/preprocess`, optional Gemini

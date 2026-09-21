# ParcelVision AI

ScanKit-style parcel receiving: a marketing home page, plus a browser demo with Snap & Approve and parcel management.

**Live site:** https://sai21112000.github.io/ParcelVision-AI/

On GitHub Pages, Gemini is off (static host). The demo still captures, crops, and queues labels.

## Local (real Gemini)

```bash
# .env next to serve.mjs — never commit this file
# GEMINI_API_KEY=...
node serve.mjs
```

Open http://localhost:8899/

## Layout

- `docs/index.html` — home
- `docs/demo.html` — Demo (`#scan` Snap & Approve, `#parcels` parcel list)
- `docs/parcel-list.html` — redirect to `demo.html#parcels`
- `docs/ingestion/` — camera / OpenCV / crop
- `serve.mjs` — local preview and Gemini proxy

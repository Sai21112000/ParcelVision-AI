# ParcelVision AI

Phone-friendly shipping-label scanner. Open the live demo on a device over HTTPS, allow the camera, then Approve / Retake / Adjust crop.

**Live demo:** https://github.com/ — Pages URL is printed after deploy (`https://<user>.github.io/ParcelVision-AI/`).

On GitHub Pages, Gemini is off (static host). The UI still captures, crops, and queues labels in demo mode.

## Local (real Gemini)

```bash
# .env next to serve.mjs — never commit this file
# GEMINI_API_KEY=...
# GEMINI_MODEL=gemini-3.8-flash
node serve.mjs
```

Open http://localhost:8899/

## Layout

- `docs/` — GitHub Pages site (scanner + parcel list + CSS + modules)
- `serve.mjs` — local preview and `/api/parcel-ingestions` proxy

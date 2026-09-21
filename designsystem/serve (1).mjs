// Tiny static server, used only to preview the design system in a browser
// (file:// is blocked by the browser tooling).
// It also proxies the parcel-OCR call to Gemini so the API key stays on the
// server: run with  $env:GEMINI_API_KEY="..."; node "serve (1).mjs"
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.mjs': 'text/javascript' };

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const KEY = process.env.GEMINI_API_KEY;
const MAX_BODY = 12 * 1024 * 1024; // ~12 MB, a 1600px JPEG base64 is ~0.3 MB

const PROMPT = `You are reading a photo of a parcel taken at the mail room of an office tower in Bangkok.
Extract the fields defined by the response schema from the shipping label and from the parcel itself.

Rules:
- tracking_no: exactly the characters printed as the tracking / barcode number, uppercase, no spaces or dashes.
- carrier: pick from the allowed list using the logo, wording or label design. If no logo is readable, still pick the closest one but report a low confidence.
- recipient: the addressee name as printed (keep the "K." prefix if present).
- unit_raw: copy the line that says the floor / department / room, verbatim, Thai or English as printed. Do not translate, do not normalise.
- parcel_type and condition: judge from the parcel in the photo, not from the label.
- cod_amount: the cash-on-delivery amount if the label shows one, otherwise empty.
- sender: sender name or shop name.
- If a field does not appear in the photo, return value "" and confidence 0. Never guess a tracking number.
- confidence is 0..1 and must be >= 0.9 only when the characters are plainly legible; use 0.6..0.89 when readable but blurry/ambiguous, below 0.6 when you are mostly guessing.
Return JSON only.`;

/* Field = { value, confidence }. Fields with a master list get an enum so the
   answer always lands inside the list the UI can offer — no mapping afterwards. */
const field = (description, values) => ({
  type: 'OBJECT',
  properties: {
    value: values ? { type: 'STRING', enum: values, description } : { type: 'STRING', description },
    confidence: { type: 'NUMBER', description: '0..1, 0 when the field is not visible' },
  },
  required: ['value', 'confidence'],
});

const schemaFrom = (e = {}) => {
  const props = {
    tracking_no: field('tracking number as printed'),
    carrier: field('delivery company', e.carriers),
    recipient: field('addressee name'),
    unit_raw: field('floor / department line, verbatim'),
    parcel_type: field('size or kind of the parcel', e.types),
    condition: field('visible condition of the parcel', e.conditions),
    cod_amount: field('cash-on-delivery amount, digits only'),
    sender: field('sender or shop name'),
  };
  const keys = Object.keys(props);
  return { type: 'OBJECT', properties: props, propertyOrdering: keys, required: keys };
};

const json = (res, obj, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function ocr(req, res) {
  if (!KEY) return json(res, { error: 'GEMINI_API_KEY ไม่ได้ตั้งไว้ในเซิร์ฟเวอร์' }, 503);
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return json(res, { error: 'อ่าน request ไม่ได้: ' + e.message }, 400);
  }
  const { imageBase64, mimeType = 'image/jpeg', enums } = body;
  if (typeof imageBase64 !== 'string' || imageBase64.length < 100) return json(res, { error: 'ไม่มีรูปในคำขอ' }, 400);
  if (!/^image\/(jpeg|png|webp)$/.test(mimeType)) return json(res, { error: 'ชนิดไฟล์ไม่รองรับ: ' + mimeType }, 400);

  let upstream, text;
  try {
    upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({
        contents: [{ parts: [
          { inline_data: { mime_type: mimeType, data: imageBase64 } },
          { text: PROMPT },
        ] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: schemaFrom(enums),
          temperature: 0,
        },
      }),
    });
    text = await upstream.text();
  } catch (e) {
    return json(res, { error: 'ต่อ Gemini ไม่ได้: ' + e.message }, 502);
  }
  // Google's own error message goes straight through — a wrong key or a model
  // without access is then readable on the card instead of a generic 500.
  if (!upstream.ok) return json(res, { error: 'Gemini: ' + text.slice(0, 600) }, upstream.status);

  try {
    const data = JSON.parse(text);
    const cand = data.candidates?.[0];
    const out = (cand?.content?.parts || []).map(p => p.text).filter(Boolean).join('');
    if (!out) return json(res, { error: 'Gemini ไม่คืนข้อมูล (finishReason: ' + (cand?.finishReason || 'unknown') + ')' }, 502);
    return json(res, JSON.parse(out));
  } catch (e) {
    return json(res, { error: 'อ่านคำตอบของ Gemini ไม่ได้: ' + e.message }, 502);
  }
}

createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  if (url === '/api/ocr-status') return json(res, { enabled: !!KEY, model: MODEL });
  if (url === '/api/ocr') {
    if (req.method !== 'POST') return json(res, { error: 'ใช้ POST' }, 405);
    return ocr(req, res);
  }

  const file = url === '/' ? 'servicemind-design-system.html' : url.replace(/^\//, '');
  try {
    const body = await readFile(join(process.cwd(), file));
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(8899, () => console.log(`preview server on http://localhost:8899 — OCR ${KEY ? 'พร้อม (' + MODEL + ')' : 'ปิด (ไม่มี GEMINI_API_KEY) → โหมดสาธิต'}`));

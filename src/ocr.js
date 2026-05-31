import { gatewayConfig } from './config.js';

const MAX_BYTES = 1024 * 1024; // OCR.space free + worker limit

function canvasToBlob(canvas, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
}

// Downscale + JPEG-compress a captured photo to keep it under the 1 MB ceiling.
// Returns { blob, width, height, quality }.
export async function compressImage(file, { maxEdge = 1000, quality = 0.6, maxBytes = MAX_BYTES } = {}) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  let q = quality;
  let blob = await canvasToBlob(canvas, q);
  // Step quality down (and finally dimensions) until under the byte ceiling.
  while (blob && blob.size > maxBytes && q > 0.3) {
    q -= 0.1;
    blob = await canvasToBlob(canvas, q);
  }
  if (blob && blob.size > maxBytes) {
    throw new Error(`Image still ${(blob.size / 1024).toFixed(0)} KB after compression (limit 1 MB). Try a tighter crop.`);
  }
  return { blob, width, height, quality: q };
}

// Send a compressed image blob to the gateway's OCR route. Returns extracted text.
export async function runOcr(blob) {
  const { base, token } = gatewayConfig();
  if (!base || !token) throw new Error('Set the gateway URL and access token in the Koofr Sync tab first.');
  const res = await fetch(base + '/ocr', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'image/jpeg' },
    body: blob,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error((data && data.error) || `OCR failed (${res.status})`);
  return data.text || '';
}

// Best-effort structured fields from raw receipt text. The user confirms/edits afterward.
export function parseReceiptText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Total: prefer a line mentioning total/amount due/grand; else the largest money value.
  let total = null;
  const moneyRe = /(?:rm|myr|\$)?\s*([0-9]{1,3}(?:[, ]?[0-9]{3})*(?:\.[0-9]{2}))/i;
  const totalLine = lines.find(l => /\b(grand\s*total|total\s*due|amount\s*due|total)\b/i.test(l) && moneyRe.test(l));
  if (totalLine) {
    const m = totalLine.match(moneyRe);
    if (m) total = parseFloat(m[1].replace(/[, ]/g, ''));
  }
  if (total == null) {
    const all = [];
    for (const l of lines) {
      const m = l.match(moneyRe);
      if (m) all.push(parseFloat(m[1].replace(/[, ]/g, '')));
    }
    if (all.length) total = Math.max(...all);
  }

  // Date: dd/mm/yyyy, yyyy-mm-dd, dd-mm-yy, etc.
  let date = null;
  for (const l of lines) {
    let m = l.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) { date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`; break; }
    m = l.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (m) {
      let y = m[3].length === 2 ? '20' + m[3] : m[3];
      date = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      break;
    }
  }

  // Merchant: first reasonably alphabetic line near the top.
  const merchant = (lines.find(l => /[a-z]/i.test(l) && l.replace(/[^a-z]/gi, '').length >= 3) || '').slice(0, 60);

  return { merchant, date, total };
}

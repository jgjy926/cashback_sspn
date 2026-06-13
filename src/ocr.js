import { gatewayConfig } from './config.js';
import { database } from './state.js';

// All merchant names you've configured across card rules, longest first (more specific wins).
function knownMerchants() {
  const set = new Set();
  for (const c of (database.cards || [])) {
    for (const r of (c.rules || [])) {
      (r.merchants || '').split(',').map(s => s.trim()).filter(Boolean).forEach(m => set.add(m));
    }
  }
  return [...set].sort((a, b) => b.length - a.length);
}

// Lines that are almost never the merchant name.
const MERCHANT_JUNK = /(\b(tel|fax|no|reg|gst|sst|inv|invoice|receipt|resit|cukai|salinan|tax|cash|change|sub\s*total|total|jumlah|qty|table|order|www|http|jalan|lorong|taman|persiaran|lot|kuala|selangor)\b|@|^\d|\d{2,}\s*-\s*\d)/i;

function guessMerchant(lines) {
  let best = '', bestScore = -Infinity;
  lines.slice(0, 6).forEach((l, i) => {
    const letters = (l.match(/[a-z]/gi) || []).length;
    if (letters < 3) return;
    const digits = (l.match(/\d/g) || []).length;
    const upper = (l.match(/[A-Z]/g) || []).length;
    let score = letters / l.length          // alphabetic density
      + (upper / letters) * 0.5             // brand names are often UPPERCASE
      + (6 - i) * 0.15                      // nearer the top of the receipt
      - digits * 0.15;                      // digits => address / phone / reg no
    if (MERCHANT_JUNK.test(l)) score -= 1.2;
    if (l.length > 40) score -= 0.5;
    if (score > bestScore) { bestScore = score; best = l; }
  });
  const name = best.replace(/[^\w&'.\- ]+$/, '').slice(0, 40);
  // Map the raw heuristic score (roughly 0.5–1.8 for a real name) onto a 0.30–0.60 confidence band.
  const confidence = name ? Math.max(0.3, Math.min(0.6, 0.3 + (bestScore - 0.5) * 0.2)) : 0;
  return { name, confidence };
}

// ---------- self-learning merchant aliases ----------
// Words that appear on most receipts and carry no brand identity.
const TOKEN_STOPWORDS = new Set([
  'receipt', 'resit', 'invoice', 'tax', 'cash', 'total', 'jumlah', 'change', 'baki',
  'table', 'order', 'sales', 'salinan', 'cukai', 'copy', 'customer', 'welcome',
  'thank', 'thanks', 'sdn', 'bhd', 'enterprise', 'trading', 'tel', 'fax', 'gst', 'sst',
]);

// Distinctive UPPERCASE-normalized tokens from the receipt header (where the brand lives).
function headerTokens(lines) {
  const toks = new Set();
  lines.slice(0, 8).forEach(l => {
    l.toUpperCase().split(/[^A-Z0-9&]+/).forEach(t => {
      if (t.length >= 4 && /[A-Z]/.test(t) && !TOKEN_STOPWORDS.has(t.toLowerCase())) toks.add(t);
    });
  });
  return toks;
}

// Record the merchant the user settled on, keyed by the receipt's header tokens.
// Called on save and on edit so corrections feed straight back into recognition.
export function learnMerchant(ocrText, merchant) {
  if (!ocrText || !merchant) return;
  const lines = ocrText.split('\n').map(l => l.trim()).filter(Boolean);
  const tokens = [...headerTokens(lines)];
  if (!tokens.length) return;
  if (!database.settings) database.settings = {};
  const aliases = database.settings.merchantAliases || (database.settings.merchantAliases = []);
  let entry = aliases.find(a => a.merchant.toLowerCase() === merchant.toLowerCase());
  if (!entry) { entry = { merchant, tokens: [] }; aliases.push(entry); }
  entry.tokens = [...new Set([...tokens, ...entry.tokens])].slice(0, 12); // freshest tokens first, capped
}

// Best learned merchant for this receipt: needs ≥2 shared tokens; score = fraction of learned tokens present.
function matchAlias(lines) {
  const aliases = (database.settings && database.settings.merchantAliases) || [];
  if (!aliases.length) return null;
  const cur = headerTokens(lines);
  if (!cur.size) return null;
  let best = null, bestScore = 0;
  for (const a of aliases) {
    const at = a.tokens || [];
    if (!at.length) continue;
    let inter = 0;
    for (const t of at) if (cur.has(t)) inter++;
    const score = inter / at.length;
    if (inter >= 2 && score > bestScore) { bestScore = score; best = { merchant: a.merchant, score }; }
  }
  return best;
}

const MAX_BYTES = 1024 * 1024; // OCR.space free + worker limit

function canvasToBlob(canvas, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
}

// Draw a file onto a canvas downscaled so its longest edge is <= maxEdge (never upscales).
async function renderScaled(file, maxEdge) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  return { canvas, width, height };
}

// Compress a captured photo to stay under the 1 MB OCR ceiling. Starts fairly large
// (more detail = better OCR) and steps quality, then dimensions, until it fits.
// Returns { blob, width, height, quality }.
export async function compressImage(file, { maxEdge = 1500, quality = 0.6, maxBytes = MAX_BYTES } = {}) {
  let edge = maxEdge;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { canvas, width, height } = await renderScaled(file, edge);
    let q = quality;
    let blob = await canvasToBlob(canvas, q);
    while (blob && blob.size > maxBytes && q > 0.3) {
      q -= 0.1;
      blob = await canvasToBlob(canvas, q);
    }
    if (blob && blob.size <= maxBytes) return { blob, width, height, quality: q };
    if (edge <= 600) {
      throw new Error(`Image still ${(blob.size / 1024).toFixed(0)} KB after compression (limit 1 MB). Try a tighter crop.`);
    }
    edge = Math.round(edge * 0.8); // shrink dimensions and retry
  }
  throw new Error('Could not compress image under 1 MB. Try a tighter crop.');
}

// High-resolution copy for permanent storage in Koofr — stays sharp when zoomed.
// This is NOT sent to OCR (which has the 1 MB cap); it's only what we keep.
// Returns { blob, width, height }.
export async function compressForStorage(file, { maxEdge = 2400, quality = 0.85 } = {}) {
  const { canvas, width, height } = await renderScaled(file, maxEdge);
  const blob = await canvasToBlob(canvas, quality);
  return { blob, width, height };
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

// ---------- AI review (free Cloudflare Workers AI fallback) ----------
// Below this overall confidence a scan is worth a (free) AI second opinion.
export const AI_REVIEW_THRESHOLD = 0.6;
// Only let the AI override a field the heuristics were NOT already confident about.
const AI_FIELD_CEILING = 0.7;
// Confidence we assign to a field the AI supplied.
const AI_CONFIDENCE = 0.8;

// User toggle, stored device-local. Default ON.
export function aiReviewEnabled() {
  return localStorage.getItem('aiReview') !== '0';
}
export function setAiReview(on) {
  localStorage.setItem('aiReview', on ? '1' : '0');
}

// Ask the gateway's free Workers AI route to re-extract fields from noisy OCR text.
// Returns { merchant, date, total } (any may be null/'') or null on any failure —
// the AI path must never break a scan, so all errors degrade to "no opinion".
export async function runAiReview(text) {
  const { base, token } = gatewayConfig();
  if (!base || !token || !text) return null;
  try {
    const res = await fetch(base + '/ai-extract', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json().catch(() => null);
    return res.ok ? data : null;
  } catch {
    return null;
  }
}

// Merge an AI second opinion into the heuristic result, overriding only the
// fields the heuristics were unsure about. Mutates and returns `parsed`, plus a
// flag of whether anything actually changed.
export function mergeAiReview(parsed, ai) {
  if (!ai) return { parsed, changed: false };
  const c = parsed.confidence;
  let changed = false;
  if (ai.merchant && c.merchant < AI_FIELD_CEILING) {
    parsed.merchant = ai.merchant; parsed.merchantSource = 'ai'; c.merchant = AI_CONFIDENCE; changed = true;
  }
  if (ai.date && c.date < AI_FIELD_CEILING) {
    parsed.date = ai.date; c.date = AI_CONFIDENCE; changed = true;
  }
  if (typeof ai.total === 'number' && c.total < AI_FIELD_CEILING) {
    parsed.total = ai.total; c.total = AI_CONFIDENCE; changed = true;
  }
  if (changed) c.overall = (c.merchant + c.total + c.date) / 3;
  return { parsed, changed };
}

const MONEY_RE = /(?:rm|myr|\$)?\s*([0-9]{1,3}(?:[,\s]?[0-9]{3})*(?:\.[0-9]{2}))/i;
// Lines whose money value IS the bill total.
const TOTAL_POS = /\b(grand\s*total|total\s*(?:due|amount|sales)?|amount\s*(?:due|payable)|balance\s*due|nett?\s*total|jumlah)\b/i;
// Lines whose money value is NOT the bill total (subtotals, tax, change, etc.).
const TOTAL_NEG = /\b(sub\s*-?\s*total|cash|tunai|change|baki|tender|rounding|round|gst|sst|tax|service|svc|discount|qty|unit|item)\b/i;

// Best-effort structured fields from raw receipt text. The user confirms/edits afterward.
// Returns { merchant, date, total, merchantSource, confidence: { merchant, total, date, overall } }.
export function parseReceiptText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // ---- Total ----
  let total = null, totalConfidence = 0;
  const moneyLines = [];
  for (const l of lines) {
    const m = l.match(MONEY_RE);
    if (m) moneyLines.push({ l, val: parseFloat(m[1].replace(/[,\s]/g, '')) });
  }
  // Prefer the LAST line that names a total and isn't a subtotal/tax/change line — totals sit at the bottom.
  const totalHits = moneyLines.filter(x => TOTAL_POS.test(x.l) && !TOTAL_NEG.test(x.l));
  if (totalHits.length) {
    total = totalHits[totalHits.length - 1].val;
    totalConfidence = 0.9;
  } else {
    const clean = moneyLines.filter(x => !TOTAL_NEG.test(x.l));
    if (clean.length) { total = Math.max(...clean.map(x => x.val)); totalConfidence = 0.55; }
    else if (moneyLines.length) { total = Math.max(...moneyLines.map(x => x.val)); totalConfidence = 0.4; }
  }

  // ---- Date ----
  let date = null, dateConfidence = 0;
  for (const l of lines) {
    let m = l.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) { date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`; dateConfidence = 0.85; break; }
    m = l.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (m) {
      let y = m[3].length === 2 ? '20' + m[3] : m[3];
      date = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      dateConfidence = 0.85;
      break;
    }
  }

  // ---- Merchant: learned alias > configured retailer > heuristic guess ----
  let merchant = '', merchantSource = 'none', merchantConfidence = 0;
  const alias = matchAlias(lines);
  if (alias) {
    merchant = alias.merchant;
    merchantSource = 'learned';
    merchantConfidence = Math.min(0.97, 0.65 + 0.32 * alias.score);
  } else {
    const lc = text.toLowerCase();
    const hit = knownMerchants().find(m => m.length >= 3 && lc.includes(m.toLowerCase()));
    if (hit) {
      merchant = hit;
      merchantSource = 'known';
      merchantConfidence = 0.85;
    } else {
      const g = guessMerchant(lines);
      merchant = g.name;
      merchantSource = g.name ? 'guess' : 'none';
      merchantConfidence = g.confidence;
    }
  }

  const overall = (merchantConfidence + totalConfidence + dateConfidence) / 3;
  return {
    merchant, date, total, merchantSource,
    confidence: { merchant: merchantConfidence, total: totalConfidence, date: dateConfidence, overall },
  };
}

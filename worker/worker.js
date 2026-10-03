/**
 * Cashback/SSPN gateway — Cloudflare Worker (module syntax).
 *
 * Single authenticated gateway in front of Koofr (WebDAV) + an OCR provider, so that
 * no secret ever reaches the public GitHub Pages frontend.
 *
 * Routes (all require `Authorization: Bearer <APP_TOKEN>` except OPTIONS):
 *   GET    /sync            -> read the ledger JSON
 *   PUT    /sync            -> write the ledger JSON atomically (+ one dated backup per day)
 *   GET    /receipt/:id     -> read a stored receipt image
 *   PUT    /receipt/:id     -> store a compressed receipt image (<= 1 MB)
 *   POST   /ocr             -> forward an image to OCR.space, return parsed text
 *   POST   /ai-extract      -> free Workers AI second opinion on noisy OCR text
 *
 * Secrets (wrangler secret put ...): KOOFR_USER, KOOFR_PASS, OCR_API_KEY, APP_TOKEN
 * Vars (wrangler.toml [vars]):       ALLOWED_ORIGIN, KOOFR_BASE, LEDGER_FILE
 * Bindings (wrangler.toml):          AI (Workers AI, for /ai-extract)
 */

const MAX_IMAGE_BYTES = 1024 * 1024;       // OCR.space free tier hard limit (1 MB)
const MAX_STORE_BYTES = 6 * 1024 * 1024;   // stored receipt images may be hi-res (sharp on zoom)
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      return json({ error: err.message }, 500, env);
    }
  },
};

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: cors(env) });
  }

  // ---- auth gate (constant-time) ----
  if (!env.APP_TOKEN) return json({ error: 'Worker not configured: APP_TOKEN missing' }, 500, env);
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!safeEqual(token, env.APP_TOKEN)) {
    return json({ error: 'Unauthorized' }, 401, env);
  }

  const koofrAuth = 'Basic ' + btoa(`${env.KOOFR_USER}:${env.KOOFR_PASS}`);
  const base = (env.KOOFR_BASE || '').replace(/\/+$/, '');
  const ledgerFile = env.LEDGER_FILE || 'cashback_ledger_sync.json';

  // ---- /sync ----
  if (path === '/sync') {
    const ledgerUrl = `${base}/${ledgerFile}`;
    if (request.method === 'GET') {
      const res = await fetch(ledgerUrl, { headers: { Authorization: koofrAuth } });
      if (res.status === 404) return json({ empty: true }, 200, env);
      if (!res.ok) return json({ error: `WebDAV read failed (${res.status})` }, res.status, env);
      // Surface the storage ETag so the client can do a conditional (If-Match) PUT.
      const etag = res.headers.get('ETag') || res.headers.get('etag') || '';
      const text = await res.text();
      // A 0-byte file would otherwise reach the client as an empty 200 body.
      if (!text.trim()) return new Response(JSON.stringify({ empty: true }), { headers: cors(env, 'application/json', etag) });
      return new Response(text, { headers: cors(env, 'application/json', etag) });
    }
    if (request.method === 'PUT') {
      const payload = await request.text();
      // Never let an empty or cut-off body replace the ledger. The client always
      // sends one JSON object, so anything not shaped like {...} is rejected.
      const trimmed = payload.trim();
      if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        return json({ error: 'Refusing to store an empty or incomplete ledger' }, 400, env);
      }
      await mkcol(base, koofrAuth); // ensure the base folder exists (e.g. /Koofr/cashback_sspn)

      // Optimistic concurrency: the client sends the ETag it based its merge on.
      // Checked immediately before the swap, so a write built on a stale copy is
      // rejected with 409 + the current ledger and the client re-merges and retries.
      // (A write landing in the instant between this check and the MOVE is still
      // safe: the merge on the next sync restores anything it overwrote.)
      const ifMatch = normEtag(request.headers.get('If-Match'));
      const conflictCheck = !ifMatch ? null : async () => {
        const cur = await fetch(ledgerUrl, { headers: { Authorization: koofrAuth } });
        const curEtag = cur.headers.get('ETag') || cur.headers.get('etag') || '';
        if (cur.status === 404 || (cur.ok && normEtag(curEtag) && normEtag(curEtag) !== ifMatch)) {
          const body = cur.ok ? await cur.text() : JSON.stringify({ conflict: true });
          return new Response(body, { status: 409, headers: cors(env, 'application/json', curEtag) });
        }
        if (!cur.ok) return json({ error: `WebDAV read failed (${cur.status})` }, 502, env);
        await cur.body?.cancel();
        return null;
      };

      const w = await atomicWrite(base, ledgerUrl, payload, koofrAuth, conflictCheck);
      if (w.response) return w.response;
      if (!w.ok) return json({ error: w.error }, 502, env);

      // one dated backup per day (idempotent within a day -> bounded Koofr growth),
      // written the same safe way so a failed backup never leaves a truncated file.
      const day = new Date().toISOString().slice(0, 10);
      const bakDir = `${base}/backups`;
      await mkcol(bakDir, koofrAuth);
      await atomicWrite(bakDir, `${bakDir}/${ledgerFile}.${day}.bak`, payload, koofrAuth).catch(() => {});
      return new Response(JSON.stringify({ status: 'success', backup: `${day}`, atomic: w.atomic }),
        { status: 200, headers: cors(env, 'application/json', w.etag) });
    }
    return json({ error: 'Method not allowed' }, 405, env);
  }

  // ---- /receipt/:id ----
  if (path.startsWith('/receipt/')) {
    const id = path.slice('/receipt/'.length);
    if (!ID_RE.test(id)) return json({ error: 'Invalid receipt id' }, 400, env);
    const recDir = `${base}/receipts`;
    const recUrl = `${recDir}/${id}.jpg`;

    if (request.method === 'GET') {
      const res = await fetch(recUrl, { headers: { Authorization: koofrAuth } });
      if (!res.ok) return json({ error: `Receipt not found (${res.status})` }, res.status, env);
      return new Response(res.body, {
        headers: { ...cors(env), 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' },
      });
    }
    if (request.method === 'PUT') {
      const buf = await request.arrayBuffer();
      if (buf.byteLength === 0) return json({ error: 'Empty body' }, 400, env);
      if (buf.byteLength > MAX_STORE_BYTES) {
        return json({ error: `Image too large (${buf.byteLength} > ${MAX_STORE_BYTES})` }, 413, env);
      }
      await mkcol(base, koofrAuth);   // ensure base folder first
      await mkcol(recDir, koofrAuth);
      const res = await fetch(recUrl, {
        method: 'PUT',
        headers: { Authorization: koofrAuth, 'Content-Type': 'image/jpeg' },
        body: buf,
      });
      if (!res.ok) return json({ error: `Receipt write failed (${res.status})` }, res.status, env);
      return json({ status: 'success', id, bytes: buf.byteLength }, 200, env);
    }
    if (request.method === 'DELETE') {
      const res = await fetch(recUrl, { method: 'DELETE', headers: { Authorization: koofrAuth } });
      // 404 = already gone; treat as success so the client can clean up its record either way.
      if (!res.ok && res.status !== 404) return json({ error: `Receipt delete failed (${res.status})` }, res.status, env);
      return json({ status: 'deleted', id }, 200, env);
    }
    return json({ error: 'Method not allowed' }, 405, env);
  }

  // ---- /ocr ----
  if (path === '/ocr' && request.method === 'POST') {
    if (!env.OCR_API_KEY) return json({ error: 'Worker not configured: OCR_API_KEY missing' }, 500, env);
    const buf = await request.arrayBuffer();
    if (buf.byteLength === 0) return json({ error: 'Empty body' }, 400, env);
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      return json({ error: `Image too large for OCR (${buf.byteLength} > ${MAX_IMAGE_BYTES})` }, 413, env);
    }
    // Try OCR.space Engine 2 (best accuracy) first, then fall back to Engine 1 (faster and more
    // reliable on the free tier) if Engine 2 errors or times out. Each attempt is time-boxed so a
    // stalled engine fails fast to the fallback instead of hanging the request.
    async function ocrSpace(engine) {
      const form = new FormData();
      form.append('apikey', env.OCR_API_KEY);
      form.append('language', 'eng');
      form.append('scale', 'true');
      form.append('OCREngine', String(engine));
      form.append('isTable', 'true');
      form.append('file', new Blob([buf], { type: 'image/jpeg' }), 'receipt.jpg');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      try {
        const res = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body: form, signal: ctrl.signal });
        const data = await res.json().catch(() => null);
        if (!data || data.IsErroredOnProcessing) {
          return { ok: false, error: data ? [].concat(data.ErrorMessage || 'OCR failed').join('; ') : 'OCR provider error' };
        }
        return { ok: true, text: (data.ParsedResults || []).map(r => r.ParsedText || '').join('\n').trim(), exitCode: data.OCRExitCode };
      } catch (e) {
        return { ok: false, error: e && e.name === 'AbortError' ? 'OCR engine timed out' : String(e && e.message || e) };
      } finally {
        clearTimeout(timer);
      }
    }

    // Last-resort OCR via Cloudflare Workers AI vision (free, on-account) when OCR.space is fully
    // down. Best-effort and fully wrapped, so it can only ever ADD a result — never break the flow.
    async function ocrWorkersAI() {
      if (!env.AI) return { ok: false, error: 'AI OCR unavailable (no AI binding)' };
      try {
        const out = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
          image: [...new Uint8Array(buf)],
          prompt: 'Transcribe every line of text in this receipt exactly as printed — shop name, date, item lines and totals. Output only the raw text, no commentary.',
          max_tokens: 1024,
        });
        const text = ((out && out.description) || '').trim();
        return text ? { ok: true, text, exitCode: 'AI' } : { ok: false, error: 'AI OCR returned no text' };
      } catch (e) {
        return { ok: false, error: 'AI OCR failed: ' + String((e && e.message) || e) };
      }
    }

    let result = await ocrSpace(2);            // best accuracy
    if (!result.ok) result = await ocrSpace(1); // faster, steadier engine
    if (!result.ok) result = await ocrWorkersAI(); // free on-account net if OCR.space is down
    if (!result.ok) return json({ error: result.error }, 502, env);
    return json({ text: result.text, exitCode: result.exitCode }, 200, env);
  }

  // ---- /ai-extract ----
  // Free, gated "AI review": the client calls this only for low-confidence scans.
  // Re-extracts structured fields from the (already OCR'd) text with a small
  // Workers AI text model — no image re-upload, so it sidesteps the 1 MB OCR cap
  // and stays well inside the free daily Neuron allocation.
  if (path === '/ai-extract' && request.method === 'POST') {
    if (!env.AI) return json({ error: 'Worker not configured: AI binding missing' }, 500, env);
    const body = await request.json().catch(() => null);
    const text = (body && typeof body.text === 'string') ? body.text.slice(0, 4000) : '';
    if (!text.trim()) return json({ error: 'Empty text' }, 400, env);

    const system =
      'You extract structured data from noisy OCR text of a retail receipt. ' +
      'Receipts often mix English and Malay (Bahasa Malaysia). ' +
      'Reply with ONLY a JSON object with exactly these keys: ' +
      '"merchant" (the store/brand name as a string), ' +
      '"date" (the purchase date as "YYYY-MM-DD", or null), ' +
      '"total" (the final amount paid, as a number with no currency symbol, or null). ' +
      'The total is the grand total / amount due / "jumlah" — never a sub-total, tax/GST/SST, ' +
      'rounding, change ("baki") or cash tendered ("tunai"). ' +
      'If a field is not clearly present, use null. Do not invent values.';

    let parsed = null;
    try {
      const out = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: text },
        ],
        max_tokens: 200,
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: {
            type: 'object',
            properties: {
              merchant: { type: ['string', 'null'] },
              date: { type: ['string', 'null'] },
              total: { type: ['number', 'null'] },
            },
            required: ['merchant', 'date', 'total'],
          },
        },
      });
      parsed = coerceJson(out && out.response);
    } catch (err) {
      return json({ error: 'AI extract failed: ' + err.message }, 502, env);
    }
    if (!parsed) return json({ error: 'AI returned no usable JSON' }, 502, env);

    const merchant = typeof parsed.merchant === 'string' ? parsed.merchant.trim().slice(0, 60) : '';
    const total = toNumber(parsed.total);
    return json({ merchant, date: normalizeDate(parsed.date), total }, 200, env);
  }

  return json({ error: 'Not found' }, 404, env);
}

// Workers AI may return `response` already parsed (json_schema mode) or as a
// string that wraps the JSON in prose — handle both, never throw.
function coerceJson(resp) {
  if (resp == null) return null;
  if (typeof resp === 'object') return resp;
  if (typeof resp !== 'string') return null;
  try { return JSON.parse(resp); } catch { /* fall through */ }
  const m = resp.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* give up */ } }
  return null;
}

function toNumber(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[^0-9.]/g, ''));
    if (isFinite(n)) return n;
  }
  return null;
}

function normalizeDate(d) {
  if (typeof d !== 'string') return null;
  const m = d.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}

// ---- helpers ----
// A browser Origin is scheme+host(+port) only, never a path. Normalize whatever
// ALLOWED_ORIGIN is configured to (even a full page URL) down to its bare origin.
function allowedOrigin(env) {
  const raw = env.ALLOWED_ORIGIN || '*';
  if (raw === '*') return '*';
  try { return new URL(raw).origin; } catch { return raw.replace(/\/.*$/, ''); }
}

function cors(env, contentType, etag) {
  const h = {
    'Access-Control-Allow-Origin': allowedOrigin(env),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, If-Match',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Vary': 'Origin',
  };
  if (contentType) h['Content-Type'] = contentType;
  // Expose the ETag so browser JS (cross-origin) can read it for conditional PUTs.
  if (etag) { h['ETag'] = etag; h['Access-Control-Expose-Headers'] = 'ETag'; }
  return h;
}

function json(obj, status, env) {
  return new Response(JSON.stringify(obj), { status, headers: cors(env, 'application/json') });
}

// WebDAV MKCOL is idempotent enough for our needs: 201 created, 405 already exists.
async function mkcol(dirUrl, auth) {
  try {
    await fetch(dirUrl, { method: 'MKCOL', headers: { Authorization: auth } });
  } catch { /* ignore — the subsequent PUT surfaces real errors */ }
}

// Crash-safe write. A plain WebDAV PUT truncates the target and then streams into
// it, so an interrupted PUT leaves a 0-byte or half-written file. Instead: PUT to a
// unique temp file beside the target, read it back to confirm every byte landed,
// then MOVE it over the target in one server-side step — the target only ever holds
// a complete old or complete new copy. `beforeSwap` may return a Response to abort
// just before the swap (the ETag conflict check). The temp file is always removed.
// Returns { ok, atomic, etag, error?, response? }.
async function atomicWrite(dirUrl, targetUrl, body, auth, beforeSwap) {
  const name = targetUrl.slice(targetUrl.lastIndexOf('/') + 1);
  const tmpUrl = `${dirUrl}/${name}.${crypto.randomUUID()}.tmp`;   // unique: concurrent writers never share one
  const headers = { Authorization: auth, 'Content-Type': 'application/json' };
  let moved = false;
  try {
    const put = await fetch(tmpUrl, { method: 'PUT', headers, body });
    if (!put.ok) return { ok: false, error: `WebDAV write failed (${put.status})` };

    const check = await fetch(tmpUrl, { headers: { Authorization: auth } });
    if (!check.ok || (await check.text()) !== body) {
      return { ok: false, error: `WebDAV write could not be verified (${check.status})` };
    }

    if (beforeSwap) {
      const abort = await beforeSwap();
      if (abort) return { ok: false, response: abort };
    }

    const mv = await fetch(tmpUrl, {
      method: 'MOVE',
      headers: { Authorization: auth, Destination: targetUrl, Overwrite: 'T' },
    });
    if (mv.ok) {
      moved = true;
      return { ok: true, atomic: true, etag: mv.headers.get('ETag') || '' };
    }
    // Storage without MOVE support: fall back to the old direct PUT so sync keeps
    // working instead of stalling. Every other MOVE failure leaves the target intact.
    if (mv.status === 405 || mv.status === 501) {
      const direct = await fetch(targetUrl, { method: 'PUT', headers, body });
      if (!direct.ok) return { ok: false, error: `WebDAV write failed (${direct.status})` };
      return { ok: true, atomic: false, etag: direct.headers.get('ETag') || '' };
    }
    return { ok: false, error: `WebDAV move failed (${mv.status})` };
  } finally {
    if (!moved) await fetch(tmpUrl, { method: 'DELETE', headers: { Authorization: auth } }).catch(() => {});
  }
}

// Compare ETags by value: ignore the weak-validator prefix and surrounding quotes.
function normEtag(e) {
  return (e || '').replace(/^W\//, '').replace(/"/g, '').trim();
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

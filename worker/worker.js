/**
 * Cashback/SSPN gateway — Cloudflare Worker (module syntax).
 *
 * Single authenticated gateway in front of Koofr (WebDAV) + an OCR provider, so that
 * no secret ever reaches the public GitHub Pages frontend.
 *
 * Routes (all require `Authorization: Bearer <APP_TOKEN>` except OPTIONS):
 *   GET    /sync            -> read the ledger JSON
 *   PUT    /sync            -> write the ledger JSON (+ one dated backup per day)
 *   GET    /receipt/:id     -> read a stored receipt image
 *   PUT    /receipt/:id     -> store a compressed receipt image (<= 1 MB)
 *   POST   /ocr             -> forward an image to OCR.space, return parsed text
 *
 * Secrets (wrangler secret put ...): KOOFR_USER, KOOFR_PASS, OCR_API_KEY, APP_TOKEN
 * Vars (wrangler.toml [vars]):       ALLOWED_ORIGIN, KOOFR_BASE, LEDGER_FILE
 */

const MAX_IMAGE_BYTES = 1024 * 1024; // OCR.space free tier hard limit (1 MB)
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
      return new Response(await res.text(), { headers: cors(env, 'application/json') });
    }
    if (request.method === 'PUT') {
      const payload = await request.text();
      const res = await fetch(ledgerUrl, {
        method: 'PUT',
        headers: { Authorization: koofrAuth, 'Content-Type': 'application/json' },
        body: payload,
      });
      if (!res.ok) return json({ error: `WebDAV write failed (${res.status})` }, res.status, env);
      // one dated backup per day (idempotent within a day -> bounded Koofr growth)
      const day = new Date().toISOString().slice(0, 10);
      const bakDir = `${base}/backups`;
      await mkcol(bakDir, koofrAuth);
      await fetch(`${bakDir}/${ledgerFile}.${day}.bak`, {
        method: 'PUT',
        headers: { Authorization: koofrAuth, 'Content-Type': 'application/json' },
        body: payload,
      }).catch(() => {});
      return json({ status: 'success', backup: `${day}` }, 200, env);
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
      if (buf.byteLength > MAX_IMAGE_BYTES) {
        return json({ error: `Image too large (${buf.byteLength} > ${MAX_IMAGE_BYTES})` }, 413, env);
      }
      await mkcol(recDir, koofrAuth);
      const res = await fetch(recUrl, {
        method: 'PUT',
        headers: { Authorization: koofrAuth, 'Content-Type': 'image/jpeg' },
        body: buf,
      });
      if (!res.ok) return json({ error: `Receipt write failed (${res.status})` }, res.status, env);
      return json({ status: 'success', id, bytes: buf.byteLength }, 200, env);
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
    const form = new FormData();
    form.append('apikey', env.OCR_API_KEY);
    form.append('language', 'eng');
    form.append('scale', 'true');
    form.append('OCREngine', '2');
    form.append('isTable', 'true');
    form.append('file', new Blob([buf], { type: 'image/jpeg' }), 'receipt.jpg');

    const res = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body: form });
    const data = await res.json().catch(() => null);
    if (!data || data.IsErroredOnProcessing) {
      const msg = data ? [].concat(data.ErrorMessage || 'OCR failed').join('; ') : 'OCR provider error';
      return json({ error: msg }, 502, env);
    }
    const text = (data.ParsedResults || []).map(r => r.ParsedText || '').join('\n').trim();
    return json({ text, exitCode: data.OCRExitCode }, 200, env);
  }

  return json({ error: 'Not found' }, 404, env);
}

// ---- helpers ----
function cors(env, contentType) {
  const h = {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Vary': 'Origin',
  };
  if (contentType) h['Content-Type'] = contentType;
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

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

# Credit Card Cashback & SSPN Wallet

A zero-cost personal finance tracker: multi-card cashback optimization, SSPN savings
ledger, and **phone-camera receipt capture with OCR**. Static frontend on GitHub Pages,
an authenticated Cloudflare Worker gateway, and Koofr (WebDAV) for storage.

## Architecture

```
Phone browser ──► GitHub Pages (static frontend, public)
                        │  Bearer APP_TOKEN
                        ▼
                 Cloudflare Worker (gateway, holds all secrets)
                    │            │
            Koofr (WebDAV)   OCR.space
        ledger.json, /receipts, /backups
```

The frontend never holds a secret. The Worker is the only thing that knows the Koofr
credentials and the OCR key, and it rejects any request without the shared `APP_TOKEN`.

## Repository layout

```
index.html          App shell (markup only)
styles/app.css       Extracted styles
src/                 ES modules (no build step — served as-is)
  main.js            Bootstrap; mirrors module exports onto window for inline handlers
  state.js           database seed + shared state (live bindings + setters)
  storage.js         localStorage load/save, schema migration, quota guard
  config.js          gateway URL + token accessor
  sync.js            cloud push/pull with version-based conflict detection
  ocr.js             client-side image compression + OCR call + field parsing
  receipts.js        receipt capture/upload/list, ledger linking
  calc, dashboard, transactions, cards, optimizer, sspn, charts, excel, ui, dropdowns
worker/
  worker.js          Cloudflare Worker (routed, authenticated gateway)
  wrangler.toml      config + secret documentation
build/split.mjs      one-shot tool that generated src/ from the legacy cc.html
cc.html              LEGACY single-file original, kept for reference (not deployed)
```

## Run locally

ES modules don't load over `file://`, so use any static server:

```bash
npx serve .         # or: python -m http.server 8000
```

Open the printed URL. Cloud sync / OCR need the Worker (below); everything else
(cards, transactions, optimizer, charts, Excel export) works fully offline.

## Deploy

### 1. Cloudflare Worker (gateway)

```bash
cd worker
npx wrangler deploy
# set secrets (prompted for each value):
npx wrangler secret put KOOFR_USER     # Koofr account email
npx wrangler secret put KOOFR_PASS     # Koofr *app password* (Preferences → Password → App passwords)
npx wrangler secret put OCR_API_KEY    # free key from https://ocr.space/ocrapi
npx wrangler secret put APP_TOKEN      # any long random string (e.g. `openssl rand -hex 24`)
```

Edit `wrangler.toml` `[vars]`:
- `ALLOWED_ORIGIN` → your Pages origin, e.g. `https://yourname.github.io` (locks CORS).
- `KOOFR_BASE` → your Koofr WebDAV base folder, e.g. `https://app.koofr.net/dav/Koofr`.
- `LEDGER_FILE` → ledger filename (default `cashback_ledger_sync.json`).

The `[ai]` binding (Workers AI) is already in `wrangler.toml` and powers the free
"AI review" fallback (`POST /ai-extract`) — no key or secret to set.

### 2. Frontend (GitHub Pages)

Push the repo and enable Pages (Settings → Pages → deploy from branch, root).
Deploys `index.html` + `styles/` + `src/`. (`cc.html` and `build/` are harmless if present.)

### 3. Connect the app

Open the app → **Koofr Sync** tab → enter:
- **Gateway Base URL**: your Worker URL (e.g. `https://cashback-gateway.yourname.workers.dev`).
- **Access Token**: the same string you set as `APP_TOKEN`.

Save. Use **Sync** (push) / **Load** (pull) in the header, and the **Receipts** tab to scan.

## Receipt flow

Capture → client compresses to ≤ 1 MB (JPEG, ~1000px long edge) → `POST /ocr` →
regex/heuristic field parse (merchant/date/total + confidence) → **if overall
confidence < 0.6 and AI review is on**, the OCR *text* is sent to `POST /ai-extract`
for a free Workers AI second opinion that overrides only the low-confidence fields →
editable confirm form → `PUT /receipt/<id>` stores the image in Koofr `/receipts/` →
ledger keeps only `{ merchant, date, total, …, imagePath }` (no image bytes). Optionally
the receipt is also logged as a credit-card transaction.

The AI review is **gated** (only fires on low-confidence scans), **text-only** (no
image re-upload, so it ignores the 1 MB OCR cap), and can be toggled off per device
from the Receipts tab. It runs on Cloudflare Workers AI's free daily Neuron allowance,
so it adds **$0** for personal volumes.

## Free-tier budget (shared-quota friendly)

| Service | Free limit | Load | Notes |
|---|---|---|---|
| Cloudflare Workers | 100k req/day | ~3 subreq/push, 1/OCR, 1/receipt | huge headroom |
| OCR.space | 25k req/mo, 1 MB/file | 1 per scan | images forced < 1 MB client-side |
| Workers AI | 10k Neurons/day | ~200/AI review, low-conf scans only | ~50 reviews/day free; gated + toggleable |
| Koofr | 10 GB | ~100 KB/receipt + 1 backup/day | ~100k receipts |
| GitHub Pages | 1 GB / 100 GB-mo | static | fine |

Cost controls: client compression, separate image files (no re-upload on sync), OCR
called once per receipt (never per sync), locked CORS + token auth to prevent quota abuse.

## Security notes

- Secrets live only on the Worker (`wrangler secret`); the public frontend never sees them.
- All gateway data routes require `Authorization: Bearer <APP_TOKEN>` (constant-time check).
- CORS is locked to `ALLOWED_ORIGIN`. Use a Koofr **app password**, not your login password.

## Sync conflict handling

The ledger carries `meta.{version, updatedAt, deviceId, lastSyncedAt}`. Push warns before
overwriting a cloud copy that another device updated since your last sync; pull warns before
discarding unsynced local edits. Every push also writes a dated `/backups/*.bak` copy.

## Verify a change end-to-end

1. `npx serve .`, open the app — confirm cards/transactions/optimizer/charts/Excel work (parity).
2. Koofr Sync tab: Sync without a token → error; with token → success. Check Koofr for
   `cashback_ledger_sync.json` and `backups/…bak`.
3. Receipts tab on a phone: capture → size shows < 1 MB → Scan → fields populate → Save →
   appears in Stored Receipts and in Koofr `/receipts/`; localStorage stays small.
4. Edit on two browsers to confirm the conflict warning fires instead of silent overwrite.

## Regenerating modules from the legacy file

`src/` is now the source of truth. `build/split.mjs` documents how it was mechanically
derived from `cc.html` (run `node build/split.mjs` to regenerate — it overwrites `src/`,
so only use it if starting over from the legacy file).

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
  receipts.js        receipt capture/upload/list, ledger linking; Claude enrich -> syncs ledger tx + claim
  claims.js          claim tracker; Claude enrich fills title/amount/period/reference from linked receipts
  enrich.js          shared Claude copy/paste panel, forgiving JSON parse, file export/import helpers
  medical.js         Medicine & Records: OCR -> export JSON -> enrich in Claude -> import
  vehicle.js         Vehicle & Transport: same enrichment flow, per-vehicle running costs
  mobile.js          phone lifecycle: flush sync on background, re-sync on resume/online,
                     Android Back button, in-app image viewer, native file export
  calc, dashboard, transactions, cards, optimizer, sspn, savings, charts, excel, ui, dropdowns
mobile/              Android app (Capacitor) wrapping the same files — see "Android app"
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

### 4. Android app (optional)

`mobile/` wraps the **same** `index.html` + `src/` + `styles/` in a Capacitor WebView — no
forked code, so the web app and the phone app always have the same features. The build copies
those files into `mobile/www`, vendors the CDN libraries (boots offline), and enables pinch-zoom
and edge-to-edge dark system bars.

- **Worker / CORS**: the app is served from `https://jgjy926.github.io` inside the WebView
  (`server.hostname` in `mobile/capacitor.config.json`), so the Worker's existing
  `ALLOWED_ORIGIN` accepts it — no Worker change or redeploy. If the Pages origin ever changes,
  change it in both places.
- **Gateway settings**: enter the Worker URL + token once in the app's Koofr Sync tab, or put
  `{ "endpoint": "...", "token": "..." }` in `mobile/gateway.local.json` (gitignored) to pre-fill
  them at build time. An APK built with that file contains the token — don't share it.
- **Uninterrupted sync**: pending edits are pushed the moment the app is backgrounded, and a
  convergent sync runs on resume and when the network returns (`src/mobile.js`).
- **Back button**: closes the image viewer / open modal → nav menu → returns to Dashboard →
  backgrounds the app (never kills it mid-sync). Exports (JSON, Excel) open the share sheet.

Build (needs Android Studio for its JDK + Android SDK):
```bash
cd mobile
npm install
# PowerShell: $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
npm run android:apk
# -> mobile/android/app/build/outputs/apk/debug/app-debug.apk
```
Rebuild after any web change (bump `APP_VERSION` as usual). Copy the APK to the phone and open
it (allow "install unknown apps" for your file manager).

## Receipt flow

Capture → client compresses to ≤ 1 MB (JPEG, ~1000px long edge) → `POST /ocr` →
regex/heuristic field parse (merchant/date/total + confidence) → **if overall
confidence < 0.6 and AI review is on**, the OCR *text* is sent to `POST /ai-extract`
for a free Workers AI second opinion that overrides only the low-confidence fields →
editable confirm form → `PUT /receipt/<id>` stores the image in Koofr `/receipts/` →
ledger keeps only `{ merchant, date, total, …, imagePath }` (no image bytes). Optionally
the receipt is also logged as a credit-card transaction.

## Import transactions from a bank-app screenshot

**Import Screenshot** (Processed Ledger header, or the button on Quick Log) opens a panel:
pick the card → **Copy prompt** (it lists that card's cashback categories + merchant hints and
the reply schema) → paste it into Claude / ChatGPT / Gemini with the screenshot(s) attached →
paste the JSON reply back → **Parse**. Each row can be ticked and re-categorised before
**Commit to ledger**. Credits (refunds, incoming transfers) and rows already in the ledger for
that card (same date + amount) start unticked; unknown categories fall back to a merchant-list
match, then the card's "other" rule. The parser tolerates code fences, `"- RM 1,122.00"`
amounts and `04 OCT 2026` dates. Lives in `src/statement.js`.

## Vehicle & Transport

Capture a workshop / petrol / road tax receipt in the **Receipts** tab and tick **Record into
Vehicle** (choose the vehicle, category and, optionally, the odometer). The record lands in the
**Vehicle** tab as *Raw*, carrying every photo and the combined OCR text.

Enrichment is optional and can happen any time later: **Export** (Selected / New / All) produces
one JSON file, Claude turns each `rawOcr` into an itemised record, and **Import JSON** writes it
back by `id`. Nothing is ever required — every field stays editable by hand.

"Log to credit-card ledger" is an independent tick: a card-paid repair is logged for cashback
*and* recorded against the vehicle, cross-linked by `txId`. Vehicle totals count only vehicle
records, so the two views never double count, and cash / e-wallet spend is tracked just as well.

Optional extras, all blank-by-default: odometer (drives distance + cost/km), next-service date or
mileage, road tax / insurance expiry, and part warranty — the ones that fall due within 60 days
(or 1,000 km) surface as a banner at the top of the tab.

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

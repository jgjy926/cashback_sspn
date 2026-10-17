// Builds mobile/www — the web bundle the Android app ships — from the same files
// GitHub Pages serves (index.html, src/, styles/). No source is forked: the phone
// app and the web app are the same code.
//
// Extras applied to the copy only:
//   - CDN libraries (Tailwind, Chart.js, SheetJS, Font Awesome) are downloaded into
//     www/vendor so the app boots offline. Cached in mobile/.vendor-cache; if a
//     download fails the original CDN tag is kept.
//   - viewport-fit=cover, so the dark page fills behind the status/gesture bars.
//   - If mobile/gateway.local.json exists ({ "endpoint": "...", "token": "..." }),
//     it pre-fills the Worker URL + access token on first launch so sync starts
//     immediately. That file is gitignored and so is every APK built with it.
import { cp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mobile = resolve(here, '..');
const repo = resolve(mobile, '..');
const www = join(mobile, 'www');
const cacheDir = join(mobile, '.vendor-cache');

const exists = (p) => access(p).then(() => true, () => false);

async function download(url, name) {
  const cached = join(cacheDir, name);
  if (await exists(cached)) return readFile(cached);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(cached), { recursive: true });
  await writeFile(cached, buf);
  return buf;
}

// [CDN url as written in index.html, local file name]
const scripts = [
  ['https://cdn.tailwindcss.com', 'tailwind.js'],
  ['https://cdn.jsdelivr.net/npm/chart.js', 'chart.js'],
  ['https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', 'xlsx.full.min.js'],
];
const FA_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';

async function vendor(html) {
  await mkdir(join(www, 'vendor'), { recursive: true });
  for (const [url, name] of scripts) {
    if (!html.includes(`src="${url}"`)) continue;
    try {
      await writeFile(join(www, 'vendor', name), await download(url, name));
      html = html.replace(`src="${url}"`, `src="./vendor/${name}"`);
    } catch (e) { console.warn(`! keeping CDN for ${url}: ${e.message}`); }
  }
  if (html.includes(FA_CSS)) {
    try {
      const css = (await download(FA_CSS, 'fa/css/all.min.css')).toString();
      const fonts = [...new Set([...css.matchAll(/url\(\.\.\/webfonts\/([^)?#]+)/g)].map((m) => m[1]))];
      await mkdir(join(www, 'vendor', 'fa', 'css'), { recursive: true });
      await mkdir(join(www, 'vendor', 'fa', 'webfonts'), { recursive: true });
      for (const f of fonts) {
        const buf = await download(FA_CSS.replace('css/all.min.css', `webfonts/${f}`), `fa/webfonts/${f}`);
        await writeFile(join(www, 'vendor', 'fa', 'webfonts', f), buf);
      }
      await writeFile(join(www, 'vendor', 'fa', 'css', 'all.min.css'), css);
      html = html.replace(FA_CSS, './vendor/fa/css/all.min.css');
    } catch (e) { console.warn(`! keeping CDN for Font Awesome: ${e.message}`); }
  }
  return html;
}

async function gatewaySeed(html) {
  const file = join(mobile, 'gateway.local.json');
  if (!(await exists(file))) {
    console.log('  (no gateway.local.json — enter the Worker URL + token once in the app\'s Sync tab)');
    return html;
  }
  const { endpoint = '', token = '' } = JSON.parse(await readFile(file, 'utf8'));
  const seed = `<script>(function(){try{` +
    `if(!localStorage.getItem('koofr_endpoint'))localStorage.setItem('koofr_endpoint',${JSON.stringify(endpoint)});` +
    `if(!localStorage.getItem('koofr_token'))localStorage.setItem('koofr_token',${JSON.stringify(token)});` +
    `}catch(e){}})();</script>`;
  console.log('  gateway settings pre-filled from gateway.local.json');
  return html.replace('<head>', '<head>\n    ' + seed);
}

await rm(www, { recursive: true, force: true });
await mkdir(www, { recursive: true });
for (const dir of ['src', 'styles', 'icons']) await cp(join(repo, dir), join(www, dir), { recursive: true });

let html = await readFile(join(repo, 'index.html'), 'utf8');
// Draw edge-to-edge under the (dark) system bars; styles/app.css pads the sticky
// header and page with env(safe-area-inset-*) so nothing sits under them.
html = html.replace('content="width=device-width, initial-scale=1.0"',
  'content="width=device-width, initial-scale=1.0, viewport-fit=cover"');
html = await vendor(html);
html = await gatewaySeed(html);
await writeFile(join(www, 'index.html'), html);
console.log(`www built from ${repo} (APP_VERSION ${(html.match(/APP_VERSION = '([^']+)'/) || [])[1]})`);

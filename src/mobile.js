// Phone lifecycle glue, shared by the mobile browser and the Android (Capacitor) app.
//
// Phones freeze background pages: timers stop, so a debounced push can be stranded
// and the 60 s poll goes quiet. To keep sync continuous we
//   - flush any pending push the moment the app is hidden / backgrounded,
//   - run a convergent sync as soon as it is shown again or the network returns.
// In the Android app the hardware Back button also closes an open modal, then
// closes the nav menu, then returns to the Dashboard, then backgrounds the app (never kills it mid-sync).
import { flushAutoPush, autoSyncTick } from './autosync.js';
import { switchTab } from './ui.js';

const RESUME_MIN_GAP_MS = 5000; // ignore show/hide flapping

let lastResumeSync = 0;

function onHidden() {
  flushAutoPush();
}

function onShown() {
  const now = Date.now();
  if (now - lastResumeSync < RESUME_MIN_GAP_MS) return;
  lastResumeSync = now;
  autoSyncTick();
}

function nativeApp() {
  const cap = window.Capacitor;
  return cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform() ? cap : null;
}

// Topmost visible full-screen modal (all modals are `fixed inset-0` overlays toggled with `hidden`).
function openModal() {
  const open = [...document.querySelectorAll('div.fixed.inset-0[id]')]
    .filter((el) => !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none');
  return open[open.length - 1] || null;
}

function closeModal(el) {
  // Prefer the modal's own Cancel/Close control so its cleanup runs.
  const btn = [...el.querySelectorAll('button')].find((b) =>
    /cancel|close|dismiss/i.test(b.textContent + ' ' + (b.getAttribute('onclick') || '')) ||
    b.querySelector('.fa-xmark, .fa-times'));
  if (btn) btn.click();
  else el.classList.add('hidden');
}

function currentTab() {
  const active = document.querySelector('[id^="tabBtn-"].bg-indigo-600');
  return active ? active.id.slice('tabBtn-'.length) : 'dashboard';
}

// ---- full-screen image viewer ---------------------------------------------
// Used instead of window.open(blobUrl): a new tab strands the Android app (and is a
// dead end on phones). The image is fitted to width; pinch-zoom works as anywhere
// else in the app, and Back / ✕ / tapping outside closes it.
export function openImageViewer(url, onClose) {
  closeImageViewer();
  const el = document.createElement('div');
  el.id = 'imageViewerModal';
  el.className = 'fixed inset-0 z-[60] bg-black/95 overflow-auto';
  el.innerHTML = `
    <button type="button" onclick="closeImageViewer()" aria-label="Close"
      class="fixed top-3 right-3 z-[61] h-10 w-10 rounded-full bg-gray-900/80 border border-gray-700 text-slate-100 flex items-center justify-center">
      <i class="fa-solid fa-xmark text-lg"></i></button>
    <div class="min-h-full flex items-center justify-center p-2">
      <img alt="Receipt" class="w-full h-auto rounded-lg" style="max-width:100%">
    </div>`;
  el.querySelector('img').src = url;
  el.addEventListener('click', (e) => { if (e.target === el || e.target === el.lastElementChild) closeImageViewer(); });
  el._onClose = onClose;
  document.body.appendChild(el);
}

export function closeImageViewer() {
  const el = document.getElementById('imageViewerModal');
  if (!el) return;
  el.remove();
  if (typeof el._onClose === 'function') el._onClose();
}

// ---- native downloads -------------------------------------------------------
// Android's WebView ignores <a download> for blob:/data: URLs, so exports (JSON,
// Excel) would silently do nothing. In the app we write the file to the cache and
// open the share sheet, where it can be saved to Files/Drive or sent anywhere.
function blobToBase64(blob) {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1] || '');
    r.onerror = () => fail(r.error);
    r.readAsDataURL(blob);
  });
}

async function nativeSaveFile(href, filename, Plugins) {
  const { Filesystem, Share } = Plugins;
  try {
    const blob = await (await fetch(href)).blob();
    const name = (filename || 'export').replace(/[\\/:*?"<>|]+/g, '_');
    const { uri } = await Filesystem.writeFile({ path: name, data: await blobToBase64(blob), directory: 'CACHE' });
    await Share.share({ title: name, files: [uri], dialogTitle: `Save ${name}` });
  } catch (err) {
    if (!/cancel/i.test(String(err && err.message))) {
      console.error('Native save failed', err);
      window.showToast && window.showToast(`Could not save file: ${err.message || err}`, 'error');
    }
  }
}

function patchDownloads(Plugins) {
  if (!Plugins.Filesystem || !Plugins.Share) return;
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute('download') && /^(blob|data):/.test(this.href)) {
      nativeSaveFile(this.href, this.getAttribute('download'), Plugins);
      return;
    }
    return origClick.call(this);
  };
}

function initNative(cap) {
  document.documentElement.classList.add('native-app');
  if (cap.Plugins) patchDownloads(cap.Plugins);
  const App = cap.Plugins && cap.Plugins.App;
  if (!App) return;
  App.addListener('appStateChange', ({ isActive }) => (isActive ? onShown() : onHidden()));
  App.addListener('backButton', () => {
    const modal = openModal();
    if (modal) return closeModal(modal);
    const menu = document.getElementById('navigationWrapper');
    if (menu && window.innerWidth < 1024 && !menu.classList.contains('hidden')) return window.toggleMobileMenu();
    if (currentTab() !== 'dashboard') return switchTab('dashboard');
    App.minimizeApp();
  });
}

export function initMobile() {
  document.addEventListener('visibilitychange', () =>
    (document.visibilityState === 'hidden' ? onHidden() : onShown()));
  window.addEventListener('pagehide', onHidden);
  window.addEventListener('online', onShown);
  const cap = nativeApp();
  if (cap) initNative(cap);
}

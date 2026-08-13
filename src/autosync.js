// Automatic cloud sync engine.
//
// Replaces the need to click Sync/Load: every trigger runs the same convergent
// syncNow() (pull → merge → adopt/push). It pulls+merges on open, pushes
// (debounced) after every local change, and polls periodically so edits made on
// other devices are merged in on their own. The manual header buttons remain as a
// force-sync fallback that calls the exact same core.
import { gatewayConfig } from './config.js';
import { syncNow } from './sync.js';

const PUSH_DEBOUNCE_MS = 3000;
const POLL_INTERVAL_MS = 60000;

let pushTimer = null;
let pollHandle = null;

function gatewayReady() {
  const { base, token } = gatewayConfig();
  return !!base && !!token;
}

// Tiny header indicator. No-op until the element exists.
export function setSyncStatus(state) {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  const map = {
    synced:  { txt: 'Synced',   cls: 'text-emerald-400', icon: 'fa-circle-check' },
    syncing: { txt: 'Syncing…', cls: 'text-indigo-300',  icon: 'fa-rotate fa-spin' },
    offline: { txt: 'Offline',  cls: 'text-amber-400',   icon: 'fa-cloud-slash' },
    idle:    { txt: 'Auto-sync',cls: 'text-slate-500',   icon: 'fa-cloud' },
  };
  const s = map[state] || map.idle;
  el.className = `flex items-center gap-1 text-[10px] font-semibold ${s.cls}`;
  el.innerHTML = `<i class="fa-solid ${s.icon}"></i><span>${s.txt}</span>`;
}

// Debounced convergent sync, triggered by the cc:dbchanged event after a local edit.
export function scheduleAutoPush() {
  if (!gatewayReady()) return;
  setSyncStatus('syncing');
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    syncNow({ silent: true });
  }, PUSH_DEBOUNCE_MS);
}

// Periodic convergent sync so another device's edits are merged in even while idle.
// Merge means this is always safe: local edits are never discarded, only reconciled.
export async function autoSyncTick() {
  if (!gatewayReady()) return;
  await syncNow({ silent: true });
}

export function initAutoSync() {
  window.addEventListener('cc:dbchanged', scheduleAutoPush);
  if (!gatewayReady()) { setSyncStatus('idle'); return; }
  setSyncStatus('synced');
  autoSyncTick();
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(autoSyncTick, POLL_INTERVAL_MS);
}

// Automatic cloud sync engine.
//
// Replaces the need to click Sync/Load: pulls on open, pushes (debounced) after
// every local change, and polls periodically so other devices' edits appear on
// their own. The manual header buttons remain as a force push/pull fallback.
import { database } from './state.js';
import { ensureMeta } from './storage.js';
import { gatewayConfig } from './config.js';
import { pushToCloud, fetchCloud, applyPull, localIsDirty } from './sync.js';

const PUSH_DEBOUNCE_MS = 3000;
const POLL_INTERVAL_MS = 60000;

let pushTimer = null;
let isApplyingRemote = false; // guards against a pulled-in DB triggering a spurious push
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

// Debounced auto-push, triggered by the cc:dbchanged event.
export function scheduleAutoPush() {
  if (isApplyingRemote || !gatewayReady()) return;
  setSyncStatus('syncing');
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushToCloud({ silent: true });
  }, PUSH_DEBOUNCE_MS);
}

// Pull and adopt the cloud copy only when it is strictly newer and we have no
// unsynced local edits (last-writer-wins, with the local push winning otherwise).
export async function autoPullIfRemoteNewer() {
  if (!gatewayReady() || isApplyingRemote) return;
  ensureMeta();
  try {
    const remote = await fetchCloud();
    if (!remote || remote.empty || !remote.meta) return;
    if (remote.meta.deviceId === database.meta.deviceId && !localIsDirty()) {
      // Same device, nothing newer to learn.
    }
    const remoteNewer = remote.meta.updatedAt
      && (!database.meta.lastSyncedAt || remote.meta.updatedAt > database.meta.lastSyncedAt);
    if (remoteNewer && !localIsDirty()) {
      isApplyingRemote = true;
      try { applyPull(remote, { silent: true }); }
      finally { isApplyingRemote = false; }
    } else if (localIsDirty()) {
      scheduleAutoPush(); // our edits are ahead — push them instead
    } else {
      setSyncStatus('synced');
    }
  } catch (err) {
    console.error('Auto-pull failed', err);
    setSyncStatus('offline');
  }
}

export function initAutoSync() {
  window.addEventListener('cc:dbchanged', scheduleAutoPush);
  if (!gatewayReady()) { setSyncStatus('idle'); return; }
  setSyncStatus('synced');
  autoPullIfRemoteNewer();
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(autoPullIfRemoteNewer, POLL_INTERVAL_MS);
}

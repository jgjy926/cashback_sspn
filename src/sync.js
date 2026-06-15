import { refreshLedgerAndCalculations } from './dashboard.js';
import { populateDropdownOptions } from './dropdowns.js';
import { database, setDatabase } from './state.js';
import { ensureMeta, migrate, persist } from './storage.js';
import { askConfirm, showToast, switchTab } from './ui.js';
import { gatewayConfig } from './config.js';
import { renderReceipts, renderReceiptCalendar } from './receipts.js';
import { renderClaims } from './claims.js';
import { setSyncStatus } from './autosync.js';

function saveSyncSettings() {
  localStorage.setItem('koofr_endpoint', document.getElementById('syncEndpoint').value.trim());
  localStorage.setItem('koofr_token', document.getElementById('syncToken').value.trim());
  showToast('Gateway endpoint and access token saved.');
}

// True when this device has local edits that were never pushed/pulled.
function localIsDirty() {
  ensureMeta();
  const m = database.meta;
  return !!m.updatedAt && (!m.lastSyncedAt || m.updatedAt > m.lastSyncedAt);
}

// ---- Reusable cores (shared by the manual buttons and the auto-sync engine) ----

// Push the whole database to the cloud. Returns true on success.
async function pushToCloud({ silent = false } = {}) {
  const { base, token } = gatewayConfig();
  if (!base || !token) return false;
  if (!silent) showToast('Syncing to cloud...', 'info');
  setSyncStatus('syncing');
  try {
    const res = await fetch(base + '/sync', {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(database),
    });
    if (!res.ok) throw new Error(`Gateway returned ${res.status}`);
    ensureMeta();
    database.meta.lastSyncedAt = database.meta.updatedAt;
    persist();
    if (!silent) showToast('Workspace database backed up successfully!', 'success');
    setSyncStatus('synced');
    return true;
  } catch (err) {
    console.error(err);
    if (!silent) showToast(`Sync Failure: ${err.message}`, 'error');
    setSyncStatus('offline');
    return false;
  }
}

// Fetch the cloud copy. Returns the parsed db, the sentinel { empty:true }, or null on error.
async function fetchCloud() {
  const { base, token } = gatewayConfig();
  if (!base || !token) return null;
  const res = await fetch(base + '/sync', { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error(`Gateway returned ${res.status}`);
  return res.json();
}

// Adopt a cloud copy into local state and refresh every view.
function applyPull(cloudDb, { silent = false } = {}) {
  setDatabase(migrate(cloudDb));
  ensureMeta();
  database.meta.lastSyncedAt = database.meta.updatedAt;
  persist();
  refreshLedgerAndCalculations();
  populateDropdownOptions();
  renderReceipts();          // refresh the Receipts tab with the pulled data
  renderReceiptCalendar();   // keep the calendar in sync
  renderClaims();            // refresh the Claims tab/dashboard
  setSyncStatus('synced');
  if (!silent) showToast('Workspace database sync load complete!', 'success');
}

async function handleCloudSync(action) {
  const { base, token } = gatewayConfig();
  if (!base || !token) {
    showToast('Missing gateway URL or access token.', 'error');
    switchTab('koofrSync');
    return;
  }
  ensureMeta();

  try {
    if (action === 'push') {
      // Peek remote first; warn before clobbering newer changes from another device.
      let remote = null;
      try { remote = await fetchCloud(); } catch { /* offline peek is non-fatal */ }

      const remoteNewer = remote && !remote.empty && remote.meta
        && remote.meta.deviceId !== database.meta.deviceId
        && remote.meta.updatedAt
        && (!database.meta.lastSyncedAt || remote.meta.updatedAt > database.meta.lastSyncedAt);

      if (remoteNewer) {
        askConfirm('The cloud copy has newer changes from another device. Overwrite the cloud with this device\'s data?',
          () => pushToCloud());
        return;
      }
      await pushToCloud();
    } else { // pull
      showToast('Fetching from cloud...', 'info');
      const cloudDb = await fetchCloud();
      if (cloudDb && cloudDb.empty) { showToast('Cloud is empty — nothing to load.', 'info'); return; }
      if (!cloudDb || !cloudDb.transactions || !cloudDb.cards) {
        throw new Error('Downloaded data has an invalid configuration scheme.');
      }
      if (localIsDirty()) {
        askConfirm('You have unsynced local changes. Loading the cloud copy will discard them. Continue?',
          () => applyPull(cloudDb));
      } else {
        applyPull(cloudDb);
      }
    }
  } catch (err) {
    console.error(err);
    showToast(`Sync Failure: ${err.message}`, 'error');
  }
}

export { saveSyncSettings, handleCloudSync, pushToCloud, fetchCloud, applyPull, localIsDirty };

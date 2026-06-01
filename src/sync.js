import { refreshLedgerAndCalculations } from './dashboard.js';
import { populateDropdownOptions } from './dropdowns.js';
import { database, setDatabase } from './state.js';
import { ensureMeta, migrate, persist } from './storage.js';
import { askConfirm, showToast, switchTab } from './ui.js';
import { gatewayConfig } from './config.js';
import { renderReceipts } from './receipts.js';

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

async function doPush(syncUrl, token) {
  showToast('Syncing to cloud...', 'info');
  try {
    const res = await fetch(syncUrl, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(database),
    });
    if (!res.ok) throw new Error(`Gateway returned ${res.status}`);
    ensureMeta();
    database.meta.lastSyncedAt = database.meta.updatedAt;
    persist();
    showToast('Workspace database backed up successfully!', 'success');
  } catch (err) {
    console.error(err);
    showToast(`Sync Failure: ${err.message}`, 'error');
  }
}

function applyPull(cloudDb) {
  setDatabase(migrate(cloudDb));
  ensureMeta();
  database.meta.lastSyncedAt = database.meta.updatedAt;
  persist();
  refreshLedgerAndCalculations();
  populateDropdownOptions();
  renderReceipts();   // refresh the Receipts tab with the pulled data
  showToast('Workspace database sync load complete!', 'success');
}

async function handleCloudSync(action) {
  const { base, token } = gatewayConfig();
  if (!base || !token) {
    showToast('Missing gateway URL or access token.', 'error');
    switchTab('koofrSync');
    return;
  }
  const syncUrl = base + '/sync';
  ensureMeta();

  try {
    if (action === 'push') {
      // Peek remote first; warn before clobbering newer changes from another device.
      let remote = null;
      try {
        const r = await fetch(syncUrl, { headers: { Authorization: 'Bearer ' + token } });
        if (r.ok) remote = await r.json();
      } catch { /* offline peek is non-fatal; fall through to push */ }

      const remoteNewer = remote && !remote.empty && remote.meta
        && remote.meta.deviceId !== database.meta.deviceId
        && remote.meta.updatedAt
        && (!database.meta.lastSyncedAt || remote.meta.updatedAt > database.meta.lastSyncedAt);

      if (remoteNewer) {
        askConfirm('The cloud copy has newer changes from another device. Overwrite the cloud with this device\'s data?',
          () => doPush(syncUrl, token));
        return;
      }
      await doPush(syncUrl, token);
    } else { // pull
      showToast('Fetching from cloud...', 'info');
      const res = await fetch(syncUrl, { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) throw new Error(`Gateway returned ${res.status}`);
      const cloudDb = await res.json();
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

export { saveSyncSettings, handleCloudSync };

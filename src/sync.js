import { refreshLedgerAndCalculations } from './dashboard.js';
import { populateDropdownOptions } from './dropdowns.js';
import { database, setDatabase } from './state.js';
import { ensureMeta, migrate, persist } from './storage.js';
import { showToast, switchTab } from './ui.js';
import { gatewayConfig } from './config.js';
import { renderReceipts, renderReceiptCalendar } from './receipts.js';
import { renderClaims } from './claims.js';
import { renderMedical } from './medical.js';
import { renderSavings } from './savings.js';
import { setSyncStatus } from './autosync.js';
import { mergeLedgers, contentSignature } from './merge.js';

const MAX_SYNC_ATTEMPTS = 4; // bounded re-merge retries on optimistic-concurrency conflicts

function saveSyncSettings() {
  localStorage.setItem('koofr_endpoint', document.getElementById('syncEndpoint').value.trim());
  localStorage.setItem('koofr_token', document.getElementById('syncToken').value.trim());
  showToast('Gateway endpoint and access token saved.');
}

// ---- transport ------------------------------------------------------------

// Fetch the cloud copy plus its ETag (the ETag drives optimistic concurrency on
// PUT). Returns { body, etag } or null when the gateway isn't configured.
async function fetchCloud() {
  const { base, token } = gatewayConfig();
  if (!base || !token) return null;
  const res = await fetch(base + '/sync', { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error(`Gateway returned ${res.status}`);
  const etag = res.headers.get('ETag') || res.headers.get('etag') || '';
  return { body: await res.json(), etag };
}

// Write the merged ledger back, guarded by If-Match when the gateway supplied an
// ETag. A 409 means another device wrote first — the caller re-pulls and re-merges.
async function putCloud(db, etag) {
  const { base, token } = gatewayConfig();
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  if (etag) headers['If-Match'] = etag;
  return fetch(base + '/sync', { method: 'PUT', headers, body: JSON.stringify(db) });
}

// Adopt a merged ledger into local state and refresh every view.
function adoptMerged(merged) {
  setDatabase(merged);
  ensureMeta();
  persist();                 // direct write — no cc:dbchanged, so no spurious re-push
  refreshLedgerAndCalculations();
  populateDropdownOptions();
  renderReceipts();
  renderReceiptCalendar();
  renderClaims();
  renderMedical();
  renderSavings();
}

// ---- convergent sync core -------------------------------------------------

let syncing = false;

// One convergent sync pass replaces the old push *and* pull: pull the cloud copy,
// merge it with local (no record ever lost), adopt the result if it changed our
// data, and push it back if the cloud is missing anything we hold. On an
// optimistic-concurrency conflict (409) it re-pulls and re-merges, so concurrent
// writers converge instead of clobbering each other.
async function syncNow({ silent = true, manual = false } = {}) {
  const { base, token } = gatewayConfig();
  if (!base || !token) {
    if (manual) { showToast('Missing gateway URL or access token.', 'error'); switchTab('koofrSync'); }
    return false;
  }
  if (syncing) return false;
  syncing = true;
  setSyncStatus('syncing');

  try {
    for (let attempt = 0; attempt < MAX_SYNC_ATTEMPTS; attempt++) {
      let remote;
      try {
        remote = await fetchCloud();
      } catch (err) {
        console.error('Sync pull failed', err);
        setSyncStatus('offline');
        if (manual) showToast(`Sync Failure: ${err.message}`, 'error');
        return false;
      }

      const remoteEmpty = !remote || !remote.body || remote.body.empty;
      const remoteDb = remoteEmpty ? null : migrate(remote.body);

      ensureMeta();
      const localSig = contentSignature(database);
      const merged = remoteDb ? mergeLedgers(database, remoteDb) : JSON.parse(JSON.stringify(database));
      const mergedSig = contentSignature(merged);
      const remoteSig = remoteDb ? contentSignature(remoteDb) : null;

      // Remote taught us something new → take the merged copy locally and refresh.
      if (mergedSig !== localSig) {
        adoptMerged(merged);
        if (!silent) showToast('Merged changes from another device.', 'info');
      }

      // Cloud is missing data we hold (or is empty) → push the merged superset.
      if (remoteSig === null || mergedSig !== remoteSig) {
        const res = await putCloud(merged, remote && remote.etag);
        if (res.status === 409) continue;         // lost the race — re-pull & re-merge
        if (!res.ok) throw new Error(`Gateway returned ${res.status}`);
      }

      ensureMeta();
      database.meta.lastSyncedAt = database.meta.updatedAt;
      persist();
      setSyncStatus('synced');
      if (manual) showToast('Workspace synced — all devices reconciled.', 'success');
      return true;
    }

    // Exhausted retries against a hot conflict; the next debounce/poll will retry.
    setSyncStatus('offline');
    if (manual) showToast('Sync busy (another device is writing) — will retry shortly.', 'error');
    return false;
  } catch (err) {
    console.error('Sync push failed', err);
    setSyncStatus('offline');
    if (manual) showToast(`Sync Failure: ${err.message}`, 'error');
    return false;
  } finally {
    syncing = false;
  }
}

// The two header buttons now both trigger the same convergent sync — neither can
// discard the other device's data, so "push" and "load" are safe aliases.
async function handleCloudSync(/* action */) {
  await syncNow({ silent: false, manual: true });
}

export { saveSyncSettings, handleCloudSync, syncNow, fetchCloud };

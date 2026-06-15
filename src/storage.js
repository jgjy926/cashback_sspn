import { database, setDatabase, SCHEMA_VERSION } from './state.js';
import { showToast } from './ui.js';

// Persistent per-browser id, used for cross-device sync conflict detection.
export function getDeviceId() {
  let id = localStorage.getItem('cc_device_id');
  if (!id) {
    id = 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('cc_device_id', id);
  }
  return id;
}

// Fill in any fields newer schema versions expect, without clobbering existing data.
export function ensureMeta() {
  if (!database.meta) {
    database.meta = { version: 1, updatedAt: new Date().toISOString(), deviceId: getDeviceId(), lastSyncedAt: null };
  }
}

// Non-destructive migration for ledgers saved by older versions or pulled from cloud.
export function migrate(db) {
  if (typeof db.schemaVersion !== 'number') db.schemaVersion = SCHEMA_VERSION;
  if (!Array.isArray(db.receipts)) db.receipts = [];
  if (!Array.isArray(db.claims)) db.claims = [];
  if (!db.settings) db.settings = {};
  // Config-driven claim taxonomy — adding a type/status here needs no code change.
  if (!Array.isArray(db.settings.claimTypes)) db.settings.claimTypes = ['Medical', 'Insurance', 'Tax Relief'];
  if (!Array.isArray(db.settings.claimStatuses)) db.settings.claimStatuses = ['Not Submitted', 'Submitted', 'Approved', 'Reimbursed', 'Rejected'];
  if (!db.meta) db.meta = { version: 1, updatedAt: new Date().toISOString(), deviceId: getDeviceId(), lastSyncedAt: null };
  return db;
}

// Raw persist with quota guard (no version stamping) — used by sync after adopting a cloud copy.
export function persist() {
  try {
    localStorage.setItem('cc_sspn_db', JSON.stringify(database));
  } catch (e) {
    console.error(e);
    showToast('Local storage full — could not save. Export or sync to free space.', 'error');
  }
}

// Mutation save: stamp a new local version + timestamp, then persist.
export function saveToLocalStorage() {
  ensureMeta();
  database.meta.version = (database.meta.version || 0) + 1;
  database.meta.updatedAt = new Date().toISOString();
  database.meta.deviceId = getDeviceId();
  persist();
  // Notify the auto-sync engine that local data changed (debounced push).
  window.dispatchEvent(new Event('cc:dbchanged'));
}

export function loadFromLocalStorage() {
  const data = localStorage.getItem('cc_sspn_db');
  if (data) {
    try {
      const parsed = JSON.parse(data);
      if (parsed.transactions) setDatabase(migrate(parsed));
    } catch (e) { console.error('Data parameters corrupted.', e); }
  }
  ensureMeta();

  if (database.settings) {
    document.getElementById('settingsPersonalTags').value = (database.settings.internalCategories || []).join(', ');

    if (!database.settings.optimizerCategories) {
      database.settings.optimizerCategories = ['Dining', 'Groceries', 'Utilities', 'Petrol', 'Online/Contactless', 'Other Spending'];
    }
    document.getElementById('settingsOptimizerCategories').value = (database.settings.optimizerCategories || []).join(', ');
    document.getElementById('settingsSspnChannels').value = (database.settings.sspnChannels || []).join(', ');
    document.getElementById('settingsSspnDevices').value = (database.settings.sspnDevices || []).join(', ');
    document.getElementById('settingsSspnMethods').value = (database.settings.sspnMethods || []).join(', ');
    if (document.getElementById('settingsClaimTypes')) {
      document.getElementById('settingsClaimTypes').value = (database.settings.claimTypes || []).join(', ');
    }
    if (document.getElementById('settingsClaimStatuses')) {
      document.getElementById('settingsClaimStatuses').value = (database.settings.claimStatuses || []).join(', ');
    }
  }

  if (document.getElementById('syncEndpoint')) {
    document.getElementById('syncEndpoint').value = localStorage.getItem('koofr_endpoint') || '';
  }
  if (document.getElementById('syncToken')) {
    document.getElementById('syncToken').value = localStorage.getItem('koofr_token') || '';
  }
}

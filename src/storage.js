import { database, setDatabase, SCHEMA_VERSION } from './state.js';
import { showToast } from './ui.js';
import { SYNCED_COLLECTIONS, recordContentEqual } from './merge.js';

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
  if (!Array.isArray(db.transactions)) db.transactions = [];
  if (!Array.isArray(db.sspnRecords)) db.sspnRecords = [];
  if (!Array.isArray(db.receipts)) db.receipts = [];
  if (!Array.isArray(db.claims)) db.claims = [];
  if (!Array.isArray(db.medicalRecords)) db.medicalRecords = [];
  if (!Array.isArray(db.savingsMonths)) db.savingsMonths = [];
  if (!Array.isArray(db.cards)) db.cards = [];
  if (!Array.isArray(db.deletions)) db.deletions = []; // tombstone log for cross-device deletes
  if (!db.settings) db.settings = {};
  // Config-driven claim taxonomy — adding a type/status here needs no code change.
  if (!Array.isArray(db.settings.claimTypes)) db.settings.claimTypes = ['Medical', 'Insurance', 'Tax Relief'];
  if (!Array.isArray(db.settings.claimStatuses)) db.settings.claimStatuses = ['Not Submitted', 'Submitted', 'Approved', 'Reimbursed', 'Rejected'];
  if (!Array.isArray(db.settings.paymentMethods)) db.settings.paymentMethods = ["Touch 'n Go eWallet", 'GrabPay', 'Boost', 'ShopeePay', 'DuitNow QR', 'Cash', 'Bank Transfer'];
  // Saving-account interest forecast config — backfill defaults without clobbering user edits.
  if (!db.settings.savingsConfig || typeof db.settings.savingsConfig !== 'object') db.settings.savingsConfig = {};
  {
    const sc = db.settings.savingsConfig;
    if (typeof sc.startMonth !== 'string') sc.startMonth = '';
    if (typeof sc.startingBalance !== 'number') sc.startingBalance = 0;
    if (typeof sc.monthlyDeposit !== 'number') sc.monthlyDeposit = 0;
    if (typeof sc.horizonMonths !== 'number' || sc.horizonMonths < 1) sc.horizonMonths = 12;
    if (typeof sc.baseRatePA !== 'number') sc.baseRatePA = 0.0005;
    if (typeof sc.aboveTopTierRatePA !== 'number') sc.aboveTopTierRatePA = 0;
    if (sc.interestBasis !== 'daily' && sc.interestBasis !== 'monthEnd') sc.interestBasis = 'monthEnd';
    if (typeof sc.depositDay !== 'number' || sc.depositDay < 1 || sc.depositDay > 31) sc.depositDay = 1;
    if (!Array.isArray(sc.tiers) || sc.tiers.length === 0) {
      sc.tiers = [
        { band: 25000, ratePA: 0.015 },
        { band: 25000, ratePA: 0.0165 },
        { band: 50000, ratePA: 0.0565 },
        { band: 100000, ratePA: 0.0365 },
        { band: 200000, ratePA: 0.0165 }
      ];
    }
  }
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

// Diff the in-memory database against the last persisted snapshot to maintain
// per-record sync metadata *centrally*, so every mutation path (add/edit/delete,
// bulk import, receipt flows…) gets correct sync fields without touching each call
// site. New or content-changed records are stamped with a fresh updatedAt/updBy;
// records deleted since the last save are recorded as tombstones so the delete
// survives a cross-device merge instead of being resurrected.
function stampChangesAndTombstones() {
  const now = new Date().toISOString();
  const by = getDeviceId();

  let prev = null;
  try { prev = JSON.parse(localStorage.getItem('cc_sspn_db') || 'null'); } catch { /* first run */ }

  if (!Array.isArray(database.deletions)) database.deletions = [];

  for (const coll of SYNCED_COLLECTIONS) {
    if (!Array.isArray(database[coll])) database[coll] = [];
    const curr = database[coll];
    const prevArr = prev && Array.isArray(prev[coll]) ? prev[coll] : [];
    const prevById = new Map(prevArr.filter(r => r && r.id != null).map(r => [r.id, r]));

    for (const rec of curr) {
      if (!rec || typeof rec !== 'object') continue;
      if (rec.id == null) rec.id = `${coll}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const before = prevById.get(rec.id);
      if (!before) {
        rec.updatedAt = now; rec.updBy = by;                       // newly added
      } else if (!recordContentEqual(before, rec)) {
        rec.updatedAt = now; rec.updBy = by;                       // edited in place
      } else {
        if (!rec.updatedAt) rec.updatedAt = before.updatedAt || now; // unchanged: keep/backfill
        if (!rec.updBy) rec.updBy = before.updBy || by;
      }
      prevById.delete(rec.id);
    }

    // Whatever id remained in the previous snapshot was deleted this save.
    for (const [id] of prevById) {
      const found = database.deletions.find(t => t.coll === coll && t.id === id);
      if (found) { if (now > found.at) { found.at = now; found.by = by; } }
      else database.deletions.push({ coll, id, at: now, by });
    }
  }
}

// Mutation save: maintain per-record sync metadata, stamp a new local version +
// timestamp, then persist.
export function saveToLocalStorage() {
  ensureMeta();
  stampChangesAndTombstones();
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
    if (document.getElementById('settingsPaymentMethods')) {
      document.getElementById('settingsPaymentMethods').value = (database.settings.paymentMethods || []).join(', ');
    }
  }

  if (document.getElementById('syncEndpoint')) {
    document.getElementById('syncEndpoint').value = localStorage.getItem('koofr_endpoint') || '';
  }
  if (document.getElementById('syncToken')) {
    document.getElementById('syncToken').value = localStorage.getItem('koofr_token') || '';
  }
}

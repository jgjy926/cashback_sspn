// Vehicle & Transport — running costs per vehicle, enriched offline via Claude.
//
// Same zero-cost flow as Medicine & Records: a receipt is photographed, OCR'd (raw text kept),
// synced to Koofr, exported as ONE JSON file, enriched in Claude chat, then imported back as ONE
// JSON file. Enrichment is always OPTIONAL and can be done any time later — a record saves as
// "Raw" and stays fully editable by hand. Every field but date/vehicle/amount is optional.
//
// Counting rule (deliberate): a cost belongs to Vehicle totals ONLY when it is a vehicleRecord.
// The credit-card ledger stays independent — ticking "log to ledger" on the same receipt records
// the card spend for cashback, and the two are cross-linked by txId but never summed together.
import { database } from './state.js';
import { saveToLocalStorage } from './storage.js';
import { askConfirm, showToast } from './ui.js';

// ---- import/export contract ----
const EXPORT_TYPE = 'vehicle-raw-export';
const IMPORT_TYPE = 'vehicle-enriched-import';
const IO_SCHEMA_VERSION = 1;

// Optional reminders: how early a due date / service odometer starts warning.
const DUE_SOON_DAYS = 60;
const DUE_SOON_KM = 1000;

let vehTrendChartObj = null, vehSplitChartObj = null;
// Vehicle being edited in the garage panel ('' = the form adds a new one).
let editingVehicleId = '';

// Imported/enriched data is external + untrusted, so escape every string before it hits innerHTML.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function num(v) { return Number(v) || 0; }
function fmt(n) { return num(n).toFixed(2); }
function today() { return new Date().toISOString().slice(0, 10); }

// Two views of the same bill:
//  - amount:    what was actually paid (canonical, used for every KPI and chart)
//  - breakdown: labour + Σ parts (only a cross-check; blank until enriched)
function recordTotal(r) { return num(r.amount); }
function breakdownTotal(r) { return num(r.labour) + (r.items || []).reduce((s, i) => s + num(i.amount), 0); }
// A record with no breakdown yet is not a mismatch — only a *contradicting* breakdown is.
function reconciles(r) {
  const b = breakdownTotal(r);
  return b === 0 || Math.abs(recordTotal(r) - b) <= 0.01;
}

export function vehicleCategories() {
  return database.settings.vehicleCategories || [];
}
function vehicles() { return database.vehicles || []; }
function vehicleById(id) { return vehicles().find(v => v.id === id) || null; }
function vehicleLabel(id) {
  const v = vehicleById(id);
  if (!v) return '(no vehicle)';
  return v.plate ? `${v.name || v.plate}${v.name && v.name !== v.plate ? ` · ${v.plate}` : ''}` : (v.name || '(unnamed)');
}

// ---------- option lists (also used by the Receipts capture form) ----------
export function vehicleOptionsHtml(selected) {
  return vehicles().map(v =>
    `<option value="${esc(v.id)}"${v.id === selected ? ' selected' : ''}>${esc(vehicleLabel(v.id))}</option>`).join('');
}
export function vehicleCategoryOptionsHtml(selected) {
  return vehicleCategories().map(c =>
    `<option value="${esc(c)}"${c === selected ? ' selected' : ''}>${esc(c)}</option>`).join('');
}

// ---------- create from a receipt (called by the Receipts capture tick) ----------
export function createVehicleRecordFromReceipt(receipt, extra = {}) {
  const now = new Date().toISOString();
  const id = 'veh-' + Date.now() + Math.random().toString(36).slice(2, 5);
  database.vehicleRecords.push({
    id,
    vehicleId: extra.vehicleId || (vehicles()[0] && vehicles()[0].id) || '',
    date: receipt.date || '',
    category: extra.category || vehicleCategories()[0] || '',
    merchant: receipt.merchant || '',
    currency: receipt.currency || 'MYR',
    amount: num(receipt.total),          // seed from the OCR'd total; refine on enrichment
    labour: 0,
    items: [],
    odometer: num(extra.odometer),       // optional; drives cost/km + service reminders
    nextServiceDate: '', nextServiceKm: 0, expiryDate: '', warrantyUntil: '',
    imagePaths: (extra.imagePaths && extra.imagePaths.length) ? extra.imagePaths
      : (receipt.imagePath ? [receipt.imagePath] : []),
    receiptId: receipt.id || null,
    txId: receipt.txId || null,          // cross-link only — never summed into Vehicle totals
    claimId: receipt.claimId || null,
    rawOcr: extra.rawOcr || receipt.ocrText || '',
    enriched: false,                     // enrich whenever you like: Export → Claude → Import
    remark: receipt.remark || '',
    createdAt: now, updatedAt: now,
  });
  return id;
}

// ---------- filters ----------
function allYears() {
  const ys = new Set([String(new Date().getFullYear())]);
  (database.vehicleRecords || []).forEach(r => { if (r.date && r.date.length >= 4) ys.add(r.date.slice(0, 4)); });
  return [...ys].sort().reverse();
}

export function populateVehicleFilters() {
  const y = document.getElementById('vehFilterYear');
  if (y) {
    const prev = y.value || 'ALL';
    y.innerHTML = '<option value="ALL">All Years</option>' + allYears().map(v => `<option value="${v}">${v}</option>`).join('');
    y.value = [...y.options].some(o => o.value === prev) ? prev : 'ALL';
  }
  const v = document.getElementById('vehFilterVehicle');
  if (v) {
    const prev = v.value || 'ALL';
    v.innerHTML = '<option value="ALL">All Vehicles</option>' + vehicleOptionsHtml();
    v.value = [...v.options].some(o => o.value === prev) ? prev : 'ALL';
  }
  const c = document.getElementById('vehFilterCategory');
  if (c) {
    const prev = c.value || 'ALL';
    c.innerHTML = '<option value="ALL">All Categories</option>' + vehicleCategoryOptionsHtml();
    c.value = [...c.options].some(o => o.value === prev) ? prev : 'ALL';
  }
}

function filteredVehicle() {
  const fy = (document.getElementById('vehFilterYear') || {}).value || 'ALL';
  const fm = (document.getElementById('vehFilterMonth') || {}).value || 'ALL';
  const fv = (document.getElementById('vehFilterVehicle') || {}).value || 'ALL';
  const fc = (document.getElementById('vehFilterCategory') || {}).value || 'ALL';
  const term = (((document.getElementById('vehFilterSearch') || {}).value) || '').trim().toLowerCase();
  return (database.vehicleRecords || []).filter(r => {
    const yr = (r.date || '').slice(0, 4), mo = (r.date || '').slice(5, 7);
    if (fy !== 'ALL' && yr !== fy) return false;
    if (fm !== 'ALL' && mo !== fm) return false;
    if (fv !== 'ALL' && (r.vehicleId || '') !== fv) return false;
    if (fc !== 'ALL' && (r.category || '') !== fc) return false;
    if (term) {
      const hit = (r.merchant || '').toLowerCase().includes(term)
        || (r.remark || '').toLowerCase().includes(term)
        || (r.items || []).some(i => (i.name || '').toLowerCase().includes(term));
      if (!hit) return false;
    }
    return true;
  }).sort((a, b) => new Date(b.date) - new Date(a.date));
}

export function onVehicleFilterChange() { renderVehicle(); }

// ---------- row selection (for selective export) ----------
function pickedVehicleIds() {
  return [...document.querySelectorAll('#vehLedgerBody input[data-veh-pick]:checked')].map(cb => cb.value);
}
export function toggleAllVehicle(master) {
  document.querySelectorAll('#vehLedgerBody input[data-veh-pick]').forEach(cb => { cb.checked = master.checked; });
}

// ---------- umbrella render ----------
export function renderVehicle() {
  populateVehicleFilters();
  const list = filteredVehicle();
  renderVehicleKpis(list);
  renderVehicleReminders();
  renderGarage();
  renderVehicleLedger(list);
  renderVehicleCharts(list);
}

// Distance covered = span of odometer readings per vehicle (optional field, so it is
// simply unavailable until at least two readings exist for the same vehicle).
function distanceCovered(list) {
  const byVehicle = {};
  list.forEach(r => {
    const km = num(r.odometer);
    if (!km) return;
    const k = r.vehicleId || '—';
    if (!byVehicle[k]) byVehicle[k] = { min: km, max: km };
    else { byVehicle[k].min = Math.min(byVehicle[k].min, km); byVehicle[k].max = Math.max(byVehicle[k].max, km); }
  });
  return Object.values(byVehicle).reduce((s, v) => s + (v.max - v.min), 0);
}

function renderVehicleKpis(list) {
  const total = list.reduce((s, r) => s + recordTotal(r), 0);
  const km = distanceCovered(list);
  const set = (id, txt) => { const el = document.getElementById(id); if (el) el.innerText = txt; };
  set('vehKpiTotal', `RM ${fmt(total)}`);
  set('vehKpiRecords', String(list.length));
  set('vehKpiKm', km ? `${km.toLocaleString('en-MY')} km` : '—');
  set('vehKpiPerKm', km ? `RM ${(total / km).toFixed(3)}` : '—');
  const raw = list.filter(r => !r.enriched).length;
  set('vehKpiRaw', String(raw));
}

// ---------- optional reminders (service due / road tax / insurance expiry) ----------
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return null;
  return Math.round((d - new Date(today() + 'T00:00:00')) / 86400000);
}
// Highest odometer reading seen for a vehicle — the best "current mileage" we have.
function latestOdometer(vehicleId) {
  return (database.vehicleRecords || [])
    .filter(r => r.vehicleId === vehicleId)
    .reduce((mx, r) => Math.max(mx, num(r.odometer)), 0);
}

function dueItems() {
  const out = [];
  (database.vehicleRecords || []).forEach(r => {
    const label = vehicleLabel(r.vehicleId);
    const push = (what, text, overdue) => out.push({ what, text, overdue, label });
    const nsd = daysUntil(r.nextServiceDate);
    if (nsd !== null && nsd <= DUE_SOON_DAYS) {
      push('Service', `${label} — service due ${r.nextServiceDate}${nsd < 0 ? ` (${-nsd} days overdue)` : ` (in ${nsd} days)`}`, nsd < 0);
    }
    if (num(r.nextServiceKm)) {
      const now = latestOdometer(r.vehicleId);
      const left = num(r.nextServiceKm) - now;
      if (now && left <= DUE_SOON_KM) {
        push('Service', `${label} — service due at ${num(r.nextServiceKm).toLocaleString('en-MY')} km${left < 0 ? ` (${(-left).toLocaleString('en-MY')} km overdue)` : ` (${left.toLocaleString('en-MY')} km to go)`}`, left < 0);
      }
    }
    const exd = daysUntil(r.expiryDate);
    if (exd !== null && exd <= DUE_SOON_DAYS) {
      push('Renewal', `${label} — ${r.category || 'renewal'} expires ${r.expiryDate}${exd < 0 ? ` (${-exd} days overdue)` : ` (in ${exd} days)`}`, exd < 0);
    }
  });
  return out.sort((a, b) => (b.overdue - a.overdue));
}

function renderVehicleReminders() {
  const box = document.getElementById('vehReminders');
  if (!box) return;
  const items = dueItems();
  if (!items.length) { box.innerHTML = ''; box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = items.map(i => {
    const cls = i.overdue
      ? 'bg-rose-500/10 text-rose-300 border-rose-500/25'
      : 'bg-amber-500/10 text-amber-300 border-amber-500/25';
    const icon = i.what === 'Service' ? 'fa-screwdriver-wrench' : 'fa-file-contract';
    return `<div class="flex items-center gap-2 border ${cls} rounded-xl px-3 py-2 text-[11px] font-semibold">
      <i class="fa-solid ${icon}"></i>${esc(i.text)}</div>`;
  }).join('');
}

// ---------- garage (add-your-own vehicles) ----------
function renderGarage() {
  const box = document.getElementById('vehGarageList');
  if (!box) return;
  const list = vehicles();
  box.innerHTML = list.length
    ? list.map(v => {
      const spend = (database.vehicleRecords || []).filter(r => r.vehicleId === v.id).reduce((s, r) => s + recordTotal(r), 0);
      const odo = latestOdometer(v.id);
      return `<div class="flex items-center justify-between gap-2 bg-gray-950 border border-gray-800 rounded-xl px-3 py-2">
        <div class="min-w-0">
          <div class="text-xs font-semibold text-slate-200 truncate">${esc(v.name || v.plate || '(unnamed)')}</div>
          <div class="text-[9px] text-slate-500 font-mono truncate">${esc(v.plate || '—')}${v.model ? ` · ${esc(v.model)}` : ''}${odo ? ` · ${odo.toLocaleString('en-MY')} km` : ''}</div>
          <div class="text-[9px] text-slate-400">RM ${fmt(spend)} total</div>
        </div>
        <div class="flex gap-1 shrink-0">
          <button onclick="editVehicle('${esc(v.id)}')" class="text-indigo-400 hover:text-indigo-300 p-1" title="Edit"><i class="fa-solid fa-pen-to-square"></i></button>
          <button onclick="deleteVehicle('${esc(v.id)}')" class="text-rose-500 hover:text-rose-400 p-1" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>`;
    }).join('')
    : '<p class="text-[10px] text-slate-500 italic">No vehicle yet — add one below, then tick “Record into Vehicle” when you scan a receipt.</p>';
}

export function handleVehicleFormSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('vehGarageName').value.trim();
  const plate = document.getElementById('vehGaragePlate').value.trim();
  const model = document.getElementById('vehGarageModel').value.trim();
  if (!name && !plate) { showToast('Give the vehicle a name or a plate number.', 'error'); return; }
  if (editingVehicleId) {
    const v = vehicleById(editingVehicleId);
    if (v) Object.assign(v, { name, plate, model });
  } else {
    database.vehicles.push({ id: 'vcl-' + Date.now() + Math.random().toString(36).slice(2, 5), name, plate, model });
  }
  cancelVehicleEdit();
  saveToLocalStorage();
  renderVehicle();
  showToast('Vehicle saved.', 'success');
}

export function editVehicle(id) {
  const v = vehicleById(id);
  if (!v) return;
  editingVehicleId = id;
  document.getElementById('vehGarageName').value = v.name || '';
  document.getElementById('vehGaragePlate').value = v.plate || '';
  document.getElementById('vehGarageModel').value = v.model || '';
  document.getElementById('vehGarageSubmit').innerText = 'Update vehicle';
  document.getElementById('vehGarageCancel').classList.remove('hidden');
}

export function cancelVehicleEdit() {
  editingVehicleId = '';
  const f = document.getElementById('vehGarageForm');
  if (f) f.reset();
  const b = document.getElementById('vehGarageSubmit');
  if (b) b.innerText = 'Add vehicle';
  const c = document.getElementById('vehGarageCancel');
  if (c) c.classList.add('hidden');
}

export function deleteVehicle(id) {
  const used = (database.vehicleRecords || []).filter(r => r.vehicleId === id).length;
  const msg = used
    ? `Delete this vehicle? ${used} record(s) stay in the ledger but will show “(no vehicle)” until you reassign them.`
    : 'Delete this vehicle?';
  askConfirm(msg, () => {
    database.vehicles = vehicles().filter(v => v.id !== id);
    if (editingVehicleId === id) cancelVehicleEdit();
    saveToLocalStorage();
    renderVehicle();
    showToast('Vehicle deleted.', 'info');
  });
}

// ---------- ledger table ----------
function statusBadges(r) {
  const badges = [];
  badges.push(r.enriched
    ? '<span class="text-[8px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 rounded font-bold">Enriched</span>'
    : '<span title="Not enriched yet — export it to Claude any time, or type the details in" class="text-[8px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 rounded font-bold">Raw</span>');
  if (!reconciles(r)) badges.push('<span title="Amount paid ≠ labour + parts" class="text-[8px] bg-rose-500/10 text-rose-400 border border-rose-500/20 px-1.5 rounded font-bold">⚠ Mismatch</span>');
  if (r.txId) badges.push('<span title="Also logged to the credit-card ledger" class="text-[8px] bg-sky-500/10 text-sky-300 border border-sky-500/20 px-1.5 rounded font-bold"><i class="fa-solid fa-credit-card"></i></span>');
  const n = (r.imagePaths || []).length;
  if (n) badges.push(`<span class="text-[8px] bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 px-1.5 rounded font-bold"><i class="fa-solid fa-image"></i> ${n}</span>`);
  return badges.join(' ');
}

function renderVehicleLedger(list) {
  const body = document.getElementById('vehLedgerBody');
  if (!body) return;
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="7" class="py-6 text-center text-xs text-slate-500 italic">No vehicle records for this filter.</td></tr>';
    return;
  }
  body.innerHTML = list.map(r => {
    const partLines = (r.items || []).length
      ? `<div class="text-[9px] text-slate-500 mt-0.5 space-y-0.5">${(r.items || []).map(i =>
        `<div><i class="fa-solid fa-gear mr-1 text-slate-600"></i>${esc(i.name || '(unnamed)')}${i.qty ? ` ×${esc(i.qty)}` : ''} — ${esc(r.currency || 'MYR')} ${fmt(i.amount)}</div>`).join('')}</div>`
      : '';
    const labour = num(r.labour)
      ? `<div class="text-[9px] text-slate-500 mt-0.5"><i class="fa-solid fa-screwdriver-wrench mr-1 text-slate-600"></i>Labour — ${esc(r.currency || 'MYR')} ${fmt(r.labour)}</div>` : '';
    const notes = [];
    if (num(r.odometer)) notes.push(`${num(r.odometer).toLocaleString('en-MY')} km`);
    if (r.nextServiceDate) notes.push(`next service ${esc(r.nextServiceDate)}`);
    if (num(r.nextServiceKm)) notes.push(`next service @ ${num(r.nextServiceKm).toLocaleString('en-MY')} km`);
    if (r.expiryDate) notes.push(`expires ${esc(r.expiryDate)}`);
    if (r.warrantyUntil) notes.push(`warranty to ${esc(r.warrantyUntil)}`);
    const noteLine = notes.length ? `<div class="text-[9px] text-slate-500 mt-0.5"><i class="fa-solid fa-circle-info mr-1 text-slate-600"></i>${notes.join(' · ')}</div>` : '';
    const remark = r.remark ? `<div class="text-[9px] text-slate-400 italic">“${esc(r.remark)}”</div>` : '';
    const view = (r.imagePaths || []).length
      ? `<button onclick="viewVehiclePhotos('${esc(r.id)}')" class="text-indigo-400 hover:text-indigo-300 p-1" title="View photos"><i class="fa-solid fa-images"></i></button>` : '';
    return `<tr class="hover:bg-gray-900/40 transition align-top">
      <td class="py-2.5 px-3 text-center"><input type="checkbox" data-veh-pick value="${esc(r.id)}" class="accent-indigo-500"></td>
      <td class="py-2.5 px-4">
        <div class="text-xs font-semibold text-slate-200 flex items-center gap-1.5 flex-wrap">${esc(r.merchant || '(no workshop)')} ${statusBadges(r)}</div>
        <div class="text-[9px] text-slate-500 font-mono">${esc(r.date || '—')} · ${esc(vehicleLabel(r.vehicleId))}</div>
        ${labour}${partLines}${noteLine}${remark}
      </td>
      <td class="py-2.5 px-4 text-[10px] text-slate-300">${esc(r.category || '—')}</td>
      <td class="py-2.5 px-4 text-right font-mono text-[11px] text-slate-400">${num(r.odometer) ? num(r.odometer).toLocaleString('en-MY') : '—'}</td>
      <td class="py-2.5 px-4 text-right font-mono text-xs font-bold text-slate-100">${esc(r.currency || 'MYR')} ${fmt(recordTotal(r))}</td>
      <td class="py-2.5 px-4 text-center text-[11px] text-slate-400">${(r.items || []).length}</td>
      <td class="py-2.5 px-4 text-center">
        <div class="flex gap-1 justify-center">
          ${view}
          <button onclick="openVehicleModal('${esc(r.id)}')" class="text-indigo-400 hover:text-indigo-300 p-1" title="Edit"><i class="fa-solid fa-pen-to-square"></i></button>
          <button onclick="deleteVehicleRecord('${esc(r.id)}')" class="text-rose-500 hover:text-rose-400 p-1" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function renderVehicleCharts(list) {
  // Trend: total spend by month.
  const byMonth = {};
  list.forEach(r => { const k = (r.date || '').slice(0, 7) || 'Unknown'; byMonth[k] = (byMonth[k] || 0) + recordTotal(r); });
  const months = Object.keys(byMonth).sort();
  if (vehTrendChartObj) vehTrendChartObj.destroy();
  const t = document.getElementById('vehTrendChart');
  if (t && typeof Chart !== 'undefined') {
    vehTrendChartObj = new Chart(t, {
      type: 'bar',
      data: { labels: months.length ? months : ['No data'], datasets: [{ label: 'Total (RM)', data: months.length ? months.map(m => byMonth[m]) : [0], backgroundColor: '#14b8a6', borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#9ca3af', font: { size: 9 } } }, y: { ticks: { color: '#9ca3af', font: { size: 9 } } } } },
    });
  }
  // Split: spend by category.
  const byCat = {};
  list.forEach(r => { const k = r.category || 'Uncategorised'; byCat[k] = (byCat[k] || 0) + recordTotal(r); });
  const cats = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]);
  if (vehSplitChartObj) vehSplitChartObj.destroy();
  const s = document.getElementById('vehSplitChart');
  if (s && typeof Chart !== 'undefined') {
    const palette = ['#14b8a6', '#6366f1', '#f59e0b', '#0ea5e9', '#a855f7', '#ef4444', '#84cc16', '#ec4899'];
    vehSplitChartObj = new Chart(s, {
      type: 'doughnut',
      data: {
        labels: cats.length ? cats : ['No data'],
        datasets: [{
          data: cats.length ? cats.map(c => byCat[c]) : [1],
          backgroundColor: cats.length ? cats.map((_, i) => palette[i % palette.length]) : ['#374151'],
          borderWidth: 2, borderColor: '#111827',
        }],
      },
      options: { responsive: true, maintainAspectRatio: false, cutout: '68%', plugins: { legend: { position: 'bottom', labels: { color: '#9ca3af', font: { size: 10, weight: 'bold' }, boxWidth: 12 } } } },
    });
  }
}

// ---------- view photos ----------
export function viewVehiclePhotos(id) {
  const r = (database.vehicleRecords || []).find(x => x.id === id);
  if (!r || !(r.imagePaths || []).length) { showToast('No photos on this record.', 'error'); return; }
  // Open the FIRST image only — a loop of window.open() calls trips popup blockers.
  const rid = String(r.imagePaths[0]).split('/').pop();
  if (rid && typeof window.viewReceipt === 'function') window.viewReceipt(rid);
  if ((r.imagePaths || []).length > 1) showToast('Showing photo 1. Open Edit to view each photo individually.', 'info');
}

// ---------- modal (add / edit, incl. dynamic part rows) ----------
export function openVehicleModal(id) {
  const r = id ? (database.vehicleRecords || []).find(x => x.id === id) : null;
  document.getElementById('vehRecId').value = r ? r.id : '';
  document.getElementById('vehModalTitle').innerText = r ? 'Edit Vehicle Record' : 'New Vehicle Record';
  document.getElementById('vehRecVehicle').innerHTML = '<option value="">— No vehicle —</option>' + vehicleOptionsHtml(r ? r.vehicleId : (vehicles()[0] || {}).id);
  document.getElementById('vehRecCategory').innerHTML = vehicleCategoryOptionsHtml(r ? r.category : '');
  document.getElementById('vehRecDate').value = (r && r.date) || today();
  document.getElementById('vehRecMerchant').value = (r && r.merchant) || '';
  document.getElementById('vehRecCurrency').value = (r && r.currency) || 'MYR';
  document.getElementById('vehRecAmount').value = r ? num(r.amount) : 0;
  document.getElementById('vehRecLabour').value = r ? num(r.labour) : 0;
  document.getElementById('vehRecOdometer').value = r && num(r.odometer) ? num(r.odometer) : '';
  document.getElementById('vehRecNextServiceDate').value = (r && r.nextServiceDate) || '';
  document.getElementById('vehRecNextServiceKm').value = r && num(r.nextServiceKm) ? num(r.nextServiceKm) : '';
  document.getElementById('vehRecExpiry').value = (r && r.expiryDate) || '';
  document.getElementById('vehRecWarranty').value = (r && r.warrantyUntil) || '';
  document.getElementById('vehRecRemark').value = (r && r.remark) || '';
  document.getElementById('vehRecRawOcr').value = (r && r.rawOcr) || '';
  // One clickable icon per attached photo — each opens that single image (no popup-blocked loop).
  const photos = (r && r.imagePaths) || [];
  const pbox = document.getElementById('vehRecPhotos');
  if (pbox) {
    pbox.innerHTML = photos.length
      ? photos.map((p, i) => `<button type="button" onclick="viewReceipt('${esc(String(p).split('/').pop())}')" class="flex items-center gap-1.5 text-[11px] bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 hover:border-indigo-400 rounded-lg px-2.5 py-1.5 transition"><i class="fa-solid fa-image"></i> Photo ${i + 1}</button>`).join('')
      : '<span class="text-[10px] text-slate-500 italic">No photos attached.</span>';
  }
  const rows = document.getElementById('vehPartRows');
  rows.innerHTML = '';
  const items = (r && r.items) || [];
  if (items.length) items.forEach(i => addPartRow(i.name, i.qty, i.amount)); else addPartRow();
  vehRecalc();
  document.getElementById('vehicleModal').classList.remove('hidden');
}

export function closeVehicleModal() { document.getElementById('vehicleModal').classList.add('hidden'); }

export function addPartRow(name = '', qty = '', amount = '') {
  const rows = document.getElementById('vehPartRows');
  const div = document.createElement('div');
  div.className = 'grid grid-cols-12 gap-2 items-center';
  div.innerHTML = `
    <input type="text" data-veh-part-name value="${esc(name)}" placeholder="Part / service item" class="col-span-6 bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-[11px] text-slate-100 focus:outline-none focus:border-indigo-500">
    <input type="number" step="1" data-veh-part-qty value="${esc(qty)}" placeholder="Qty" oninput="vehRecalc()" class="col-span-2 bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-[11px] text-slate-100 focus:outline-none focus:border-indigo-500">
    <input type="number" step="0.01" data-veh-part-amount value="${esc(amount)}" placeholder="Amount" oninput="vehRecalc()" class="col-span-3 bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-[11px] text-slate-100 focus:outline-none focus:border-indigo-500">
    <button type="button" onclick="this.closest('div').remove(); vehRecalc();" class="col-span-1 text-rose-500 hover:text-rose-400 text-xs" title="Remove"><i class="fa-solid fa-xmark"></i></button>`;
  rows.appendChild(div);
}

function readPartRows() {
  return [...document.querySelectorAll('#vehPartRows > div')].map(row => ({
    name: row.querySelector('[data-veh-part-name]').value.trim(),
    qty: num(row.querySelector('[data-veh-part-qty]').value),
    amount: num(row.querySelector('[data-veh-part-amount]').value),
  })).filter(i => i.name || i.amount);
}

// Live breakdown check in the modal. A blank breakdown is normal (not yet enriched), so the
// hint only fires once labour/parts have been filled in and contradict the amount paid.
export function vehRecalc() {
  const amount = num(document.getElementById('vehRecAmount').value);
  const labour = num(document.getElementById('vehRecLabour').value);
  const parts = [...document.querySelectorAll('#vehPartRows [data-veh-part-amount]')].reduce((s, el) => s + num(el.value), 0);
  const cur = document.getElementById('vehRecCurrency').value.trim() || 'MYR';
  document.getElementById('vehRecTotalDisplay').innerText = `${cur} ${fmt(amount)}`;
  const hint = document.getElementById('vehRecReconcile');
  const breakdown = labour + parts;
  if (breakdown > 0 && Math.abs(amount - breakdown) > 0.01) {
    hint.classList.remove('hidden');
    hint.innerText = `⚠ Amount paid (${fmt(amount)}) ≠ labour + parts (${fmt(breakdown)}).`;
  } else {
    hint.classList.add('hidden');
  }
}

export function handleVehicleSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('vehRecId').value;
  const fields = {
    vehicleId: document.getElementById('vehRecVehicle').value,
    date: document.getElementById('vehRecDate').value,
    category: document.getElementById('vehRecCategory').value,
    merchant: document.getElementById('vehRecMerchant').value.trim(),
    currency: document.getElementById('vehRecCurrency').value.trim() || 'MYR',
    amount: num(document.getElementById('vehRecAmount').value),
    labour: num(document.getElementById('vehRecLabour').value),
    items: readPartRows(),
    odometer: num(document.getElementById('vehRecOdometer').value),
    nextServiceDate: document.getElementById('vehRecNextServiceDate').value,
    nextServiceKm: num(document.getElementById('vehRecNextServiceKm').value),
    expiryDate: document.getElementById('vehRecExpiry').value,
    warrantyUntil: document.getElementById('vehRecWarranty').value,
    remark: document.getElementById('vehRecRemark').value.trim(),
  };
  const now = new Date().toISOString();
  if (id) {
    const r = (database.vehicleRecords || []).find(x => x.id === id);
    if (!r) return;
    Object.assign(r, fields, { enriched: true, updatedAt: now });
  } else {
    database.vehicleRecords.push({
      id: 'veh-' + Date.now() + Math.random().toString(36).slice(2, 5),
      ...fields, imagePaths: [], receiptId: null, txId: null, claimId: null, rawOcr: '',
      enriched: true, createdAt: now, updatedAt: now,
    });
  }
  saveToLocalStorage();
  renderVehicle();
  closeVehicleModal();
  showToast('Vehicle record saved.', 'success');
}

export function deleteVehicleRecord(id) {
  askConfirm('Delete this vehicle record? (Linked receipt images in Koofr are kept.)', () => {
    database.vehicleRecords = (database.vehicleRecords || []).filter(r => r.id !== id);
    saveToLocalStorage();
    renderVehicle();
    showToast('Vehicle record deleted.', 'info');
  });
}

// ---------- export (one file) : raw OCR bundle for Claude ----------
function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const CLAUDE_INSTRUCTIONS =
  'You convert raw OCR text from Malaysian workshop / petrol station / road tax / insurance receipts into structured JSON. ' +
  'For EACH record in "records", read its "rawOcr" and produce an enriched record that keeps the SAME "id". ' +
  'Extract: merchant (workshop/station/insurer name), date (YYYY-MM-DD), currency (default MYR), ' +
  'category (choose the best fit from "allowedCategories"), amount (the grand total actually paid, as a number), ' +
  'labour (labour/service/workmanship charge as a number, 0 if none), ' +
  'items as an array of { "name", "qty", "amount" } for each part / fluid / line item, ' +
  'odometer (mileage in km if the receipt shows one, else 0), ' +
  'nextServiceDate and nextServiceKm (if the receipt states the next service due, else "" / 0), ' +
  'expiryDate (road tax / insurance coverage end date as YYYY-MM-DD, else ""), ' +
  'and warrantyUntil (part or workmanship warranty end date as YYYY-MM-DD, else ""). ' +
  'Amounts are the figures printed on the receipt — never invent or estimate a value that is not there; use 0 or "" instead. ' +
  'Return ONLY one JSON object, no prose, of the form: ' +
  '{ "type": "vehicle-enriched-import", "schemaVersion": 1, "records": [ <one enriched record per input record> ] }.';

// Strip the noise that makes OCR dumps token-heavy without helping extraction: runs of blank
// lines, trailing spaces, and repeated separator rows ("-----", "=====", "*****").
function tidyOcr(text) {
  return String(text || '')
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))
    .filter(l => !/^[-=*_.\s]{4,}$/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// scope: 'selected' (ticked rows), 'new' (un-enriched), or 'all'.
export function exportVehicleRaw(scope) {
  const records = database.vehicleRecords || [];
  let src;
  if (scope === 'selected') {
    const ids = new Set(pickedVehicleIds());
    if (!ids.size) { showToast('Tick the records you want to export first (checkboxes on the left).', 'error'); return; }
    src = records.filter(r => ids.has(r.id));
  } else if (scope === 'all') {
    src = records;
  } else { // 'new' — everything not yet enriched
    src = records.filter(r => !r.enriched);
    if (!src.length) { showToast('Nothing new to enrich — every record is already enriched. Use “Selected” or “All”.', 'error'); return; }
  }
  if (!src.length) { showToast('No vehicle records to export yet.', 'error'); return; }
  downloadJson({
    type: EXPORT_TYPE,
    schemaVersion: IO_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    instructions: CLAUDE_INSTRUCTIONS,
    allowedCategories: vehicleCategories(),
    targetSchema: {
      id: '', date: 'YYYY-MM-DD', merchant: '', currency: 'MYR', category: '', amount: 0, labour: 0,
      items: [{ name: '', qty: 1, amount: 0 }], odometer: 0,
      nextServiceDate: '', nextServiceKm: 0, expiryDate: '', warrantyUntil: '', remark: '',
    },
    // imagePaths are deliberately omitted — Claude can't open Koofr paths, so they'd only cost tokens.
    records: src.map(r => ({
      id: r.id, date: r.date, merchant: r.merchant, currency: r.currency,
      category: r.category, amount: num(r.amount), rawOcr: tidyOcr(r.rawOcr),
    })),
  }, `vehicle-raw-${today()}.json`);
  showToast(`Exported ${src.length} record(s). Open Claude, attach this file, then import the JSON it returns.`, 'success');
}

// ---------- import (one file) : enriched JSON back from Claude (or hand-edited) ----------
export function handleVehicleImportFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); }
    catch { showToast('Import failed: the file is not valid JSON.', 'error'); input.value = ''; return; }
    importVehicleEnriched(data);
    input.value = '';
  };
  reader.onerror = () => { showToast('Could not read the file.', 'error'); input.value = ''; };
  reader.readAsText(file);
}

function importVehicleEnriched(data) {
  if (!data || data.type !== IMPORT_TYPE || !Array.isArray(data.records)) {
    showToast(`Import failed: expected a "${IMPORT_TYPE}" file with a "records" array.`, 'error');
    return;
  }
  const cats = vehicleCategories();
  let updated = 0, unknown = 0, mismatch = 0;
  data.records.forEach(rec => {
    if (!rec || !rec.id) { unknown++; return; }
    const r = (database.vehicleRecords || []).find(x => x.id === rec.id);
    if (!r) { unknown++; return; }
    if (rec.merchant != null) r.merchant = String(rec.merchant);
    if (rec.date != null) r.date = String(rec.date);
    if (rec.currency != null) r.currency = String(rec.currency) || 'MYR';
    // Only accept a category that exists in the user's own list — never silently invent one.
    if (rec.category != null && cats.includes(String(rec.category))) r.category = String(rec.category);
    if (rec.labour != null) r.labour = num(rec.labour);
    if (Array.isArray(rec.items)) {
      r.items = rec.items.map(i => ({ name: String((i && i.name) || ''), qty: num(i && i.qty), amount: num(i && i.amount) }));
    }
    // The OCR'd total already on the record is trusted unless the enrichment gives a real number.
    if (rec.amount != null && num(rec.amount) > 0) r.amount = num(rec.amount);
    if (rec.odometer != null && num(rec.odometer) > 0) r.odometer = num(rec.odometer);
    if (rec.nextServiceDate != null) r.nextServiceDate = String(rec.nextServiceDate);
    if (rec.nextServiceKm != null) r.nextServiceKm = num(rec.nextServiceKm);
    if (rec.expiryDate != null) r.expiryDate = String(rec.expiryDate);
    if (rec.warrantyUntil != null) r.warrantyUntil = String(rec.warrantyUntil);
    if (rec.remark != null) r.remark = String(rec.remark);
    // A bill with no amount but an itemised breakdown: adopt the breakdown as the total.
    if (!num(r.amount) && breakdownTotal(r) > 0) r.amount = breakdownTotal(r);
    r.enriched = true; r.updatedAt = new Date().toISOString();
    if (!reconciles(r)) mismatch++;
    updated++;
  });
  saveToLocalStorage();
  renderVehicle();
  let msg = `Imported: ${updated} record(s) updated`;
  if (unknown) msg += ` · ${unknown} unknown id(s) skipped`;
  if (mismatch) msg += ` · ${mismatch} need a total check`;
  showToast(msg, updated ? 'success' : 'error');
}

// Dining — every meal out, with the dishes that were ordered.
//
// Same zero-cost flow as Vehicle & Medical: a receipt is photographed, OCR'd (raw text kept),
// synced to Koofr, and saved as a "Raw" dining record. Enrich it any time later in Claude
// (Export → Import, or the copy/paste panel) to break the bill down into dishes, or type the
// dishes in by hand. Every field but date/amount is optional.
//
// Counting rule (deliberate): a cost belongs to Dining totals ONLY when it is a diningRecord.
// The credit-card ledger stays independent — "log to ledger" on the same receipt records the
// card spend for cashback, and the two are cross-linked by txId but never summed together.
import { database } from './state.js';
import { saveToLocalStorage } from './storage.js';
import { askConfirm, showToast } from './ui.js';
import { openEnrichPanel, parseEnrichedJson, normalizeEnriched } from './enrich.js';

// ---- import/export contract ----
const EXPORT_TYPE = 'dining-raw-export';
const IMPORT_TYPE = 'dining-enriched-import';
const IO_SCHEMA_VERSION = 1;
// Malaysian bills round to the nearest 5 sen, so allow that much drift before flagging.
const RECONCILE_TOLERANCE = 0.05;

let dinTrendChartObj = null, dinSplitChartObj = null;
const openDiningRows = new Set();
let diningExpandAll = false;

// Imported/enriched data is external + untrusted, so escape every string before it hits innerHTML.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function num(v) { return Number(v) || 0; }
function fmt(n) { return num(n).toFixed(2); }
function today() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}
function records() { return database.diningRecords || []; }

// Two views of the same bill:
//  - amount:    what was actually paid (canonical, used for every KPI and chart)
//  - breakdown: Σ dishes + service charge + tax − discount (cross-check; blank until enriched)
function recordTotal(r) { return num(r.amount); }
function dishesTotal(r) { return (r.items || []).reduce((s, i) => s + num(i.amount), 0); }
function breakdownTotal(r) {
  if (!(r.items || []).length) return 0;
  return dishesTotal(r) + num(r.serviceCharge) + num(r.tax) - num(r.discount);
}
function reconciles(r) {
  const b = breakdownTotal(r);
  return b === 0 || Math.abs(recordTotal(r) - b) <= RECONCILE_TOLERANCE + 1e-9;
}
function dishQty(i) { return num(i.qty) || 1; }

export function diningMealTypes() {
  return database.settings.diningMealTypes || [];
}

// ---------- option lists (also used by the Receipts capture form) ----------
export function diningMealTypeOptionsHtml(selected) {
  return diningMealTypes().map(c =>
    `<option value="${esc(c)}"${c === selected ? ' selected' : ''}>${esc(c)}</option>`).join('');
}

// Best-guess meal type from the time printed on the receipt (falls back to the first type).
function guessMealType(ocr) {
  const types = diningMealTypes();
  const m = String(ocr || '').match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)(?:[:.][0-5]\d)?\s*(am|pm)?\b/i);
  let pick = '';
  if (m) {
    let h = Number(m[1]);
    const ap = (m[3] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    pick = h < 4 ? 'Supper' : h < 11 ? 'Breakfast' : h < 15 ? 'Lunch' : h < 18 ? 'Tea / Café' : h < 22 ? 'Dinner' : 'Supper';
  }
  return types.includes(pick) ? pick : (types[0] || '');
}

// ---------- create from a receipt (called by the Receipts capture tick) ----------
export function createDiningRecordFromReceipt(receipt, extra = {}) {
  const now = new Date().toISOString();
  const id = 'din-' + Date.now() + Math.random().toString(36).slice(2, 5);
  const rawOcr = extra.rawOcr || receipt.ocrText || '';
  database.diningRecords.push({
    id,
    date: receipt.date || '',
    restaurant: receipt.merchant || '',
    mealType: extra.mealType || guessMealType(rawOcr),
    currency: receipt.currency || 'MYR',
    amount: num(receipt.total),          // seed from the OCR'd total; refine on enrichment
    pax: num(extra.pax),
    items: [],                           // dishes — filled by enrichment or by hand
    serviceCharge: 0, tax: 0, discount: 0,
    imagePaths: (extra.imagePaths && extra.imagePaths.length) ? extra.imagePaths
      : (receipt.imagePath ? [receipt.imagePath] : []),
    receiptId: receipt.id || null,
    txId: receipt.txId || null,          // cross-link only — never summed into Dining totals
    claimId: receipt.claimId || null,
    rawOcr,
    enriched: false,
    remark: receipt.remark || '',
    createdAt: now, updatedAt: now,
  });
  return id;
}

// ---------- filters ----------
function allYears() {
  const ys = new Set([String(new Date().getFullYear())]);
  records().forEach(r => { if (r.date && r.date.length >= 4) ys.add(r.date.slice(0, 4)); });
  return [...ys].sort().reverse();
}

export function populateDiningFilters() {
  const y = document.getElementById('dinFilterYear');
  if (y) {
    const prev = y.value || 'ALL';
    y.innerHTML = '<option value="ALL">All Years</option>' + allYears().map(v => `<option value="${v}">${v}</option>`).join('');
    y.value = [...y.options].some(o => o.value === prev) ? prev : 'ALL';
  }
  const t = document.getElementById('dinFilterMeal');
  if (t) {
    const prev = t.value || 'ALL';
    t.innerHTML = '<option value="ALL">All Meals</option>' + diningMealTypeOptionsHtml();
    t.value = [...t.options].some(o => o.value === prev) ? prev : 'ALL';
  }
}

function filteredDining() {
  const fy = (document.getElementById('dinFilterYear') || {}).value || 'ALL';
  const fm = (document.getElementById('dinFilterMonth') || {}).value || 'ALL';
  const ft = (document.getElementById('dinFilterMeal') || {}).value || 'ALL';
  const term = (((document.getElementById('dinFilterSearch') || {}).value) || '').trim().toLowerCase();
  return records().filter(r => {
    const yr = (r.date || '').slice(0, 4), mo = (r.date || '').slice(5, 7);
    if (fy !== 'ALL' && yr !== fy) return false;
    if (fm !== 'ALL' && mo !== fm) return false;
    if (ft !== 'ALL' && (r.mealType || '') !== ft) return false;
    if (term) {
      const hit = (r.restaurant || '').toLowerCase().includes(term)
        || (r.remark || '').toLowerCase().includes(term)
        || (r.items || []).some(i => (i.name || '').toLowerCase().includes(term));
      if (!hit) return false;
    }
    return true;
  }).sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export function onDiningFilterChange() { renderDining(); }

// ---------- row selection (for selective export) ----------
function pickedDiningIds() {
  return [...document.querySelectorAll('#dinList input[data-din-pick]:checked')].map(cb => cb.value);
}
export function toggleAllDining(master) {
  document.querySelectorAll('#dinList input[data-din-pick]').forEach(cb => { cb.checked = master.checked; });
}

// ---------- umbrella render ----------
export function renderDining() {
  populateDiningFilters();
  const list = filteredDining();
  renderDiningKpis(list);
  renderDiningList(list);
  renderTopDishes(list);
  renderTopRestaurants(list);
  renderDiningCharts(list);
}

function renderDiningKpis(list) {
  const total = list.reduce((s, r) => s + recordTotal(r), 0);
  const dishes = list.reduce((s, r) => s + (r.items || []).reduce((q, i) => q + dishQty(i), 0), 0);
  const set = (id, txt) => { const el = document.getElementById(id); if (el) el.innerText = txt; };
  set('dinKpiTotal', `RM ${fmt(total)}`);
  set('dinKpiMeals', String(list.length));
  set('dinKpiAvg', list.length ? `RM ${fmt(total / list.length)}` : '—');
  set('dinKpiDishes', String(dishes));
  set('dinKpiRaw', String(list.filter(r => !r.enriched).length));
}

// ---------- list (card layout, breakdown collapsed by default) ----------
export function toggleDiningDetails(id) {
  if (openDiningRows.has(id)) openDiningRows.delete(id); else openDiningRows.add(id);
  const open = openDiningRows.has(id) || diningExpandAll;
  const det = document.getElementById('dinDet-' + id);
  const chev = document.getElementById('dinChev-' + id);
  if (det) det.classList.toggle('hidden', !open);
  if (chev) chev.classList.toggle('rotate-90', open);
}

export function toggleDiningExpandAll() {
  diningExpandAll = !diningExpandAll;
  if (!diningExpandAll) openDiningRows.clear();
  renderDining();
}

function statusBadges(r) {
  const badges = [];
  badges.push(r.enriched
    ? '<span class="text-[8px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 rounded font-bold">Enriched</span>'
    : '<span title="Not enriched yet — export it to Claude any time, or type the dishes in" class="text-[8px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 rounded font-bold">Raw</span>');
  if (!reconciles(r)) badges.push('<span title="Amount paid ≠ dishes + service + tax − discount" class="text-[8px] bg-rose-500/10 text-rose-400 border border-rose-500/20 px-1.5 rounded font-bold">⚠ Mismatch</span>');
  if (r.txId) badges.push('<span title="Also logged to the credit-card ledger" class="text-[8px] bg-sky-500/10 text-sky-300 border border-sky-500/20 px-1.5 rounded font-bold"><i class="fa-solid fa-credit-card"></i></span>');
  const n = (r.imagePaths || []).length;
  if (n) badges.push(`<span class="text-[8px] bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 px-1.5 rounded font-bold"><i class="fa-solid fa-image"></i> ${n}</span>`);
  return badges.join(' ');
}

function breakdownHtml(r) {
  const cur = esc(r.currency || 'MYR');
  const items = r.items || [];
  const line = (label, val, cls = '') =>
    `<div class="flex justify-between gap-3 ${cls}"><span class="min-w-0">${label}</span><span class="font-mono shrink-0">${val}</span></div>`;
  const rows = items.map(i => {
    const q = dishQty(i);
    const unit = q > 1 && num(i.amount) ? `<span class="text-slate-600"> @ ${fmt(num(i.amount) / q)}</span>` : '';
    return line(`<span class="text-slate-500 font-mono mr-1">${q}×</span><span class="text-slate-300">${esc(i.name || '(unnamed)')}</span>${unit}`, `${cur} ${fmt(i.amount)}`);
  }).join('');
  const extras = [];
  if (items.length) extras.push(line('Dishes subtotal', `${cur} ${fmt(dishesTotal(r))}`, 'border-t border-gray-800/80 pt-1 mt-1'));
  if (num(r.serviceCharge)) extras.push(line('Service charge', `${cur} ${fmt(r.serviceCharge)}`));
  if (num(r.tax)) extras.push(line('Tax (SST)', `${cur} ${fmt(r.tax)}`));
  if (num(r.discount)) extras.push(line('Discount', `− ${cur} ${fmt(r.discount)}`, 'text-emerald-400/80'));
  extras.push(line('<b class="text-slate-300">Paid</b>', `<b class="text-slate-200">${cur} ${fmt(recordTotal(r))}</b>`, items.length ? '' : 'border-t border-gray-800/80 pt-1 mt-1'));
  if (num(r.pax) > 1) extras.push(line(`Per person (${num(r.pax)} pax)`, `${cur} ${fmt(recordTotal(r) / num(r.pax))}`, 'text-amber-300/80'));
  const remark = r.remark ? `<div class="text-slate-400 italic pt-1">“${esc(r.remark)}”</div>` : '';
  const empty = items.length ? '' : '<div class="text-slate-500 italic">No dishes yet — enrich with Claude or tap Edit to add them.</div>';
  return empty + rows + extras.join('') + remark;
}

function renderDiningList(list) {
  const box = document.getElementById('dinList');
  if (!box) return;
  const allBtn = document.getElementById('dinExpandAllBtn');
  if (allBtn) allBtn.innerHTML = diningExpandAll
    ? '<i class="fa-solid fa-angles-up mr-1"></i>Collapse all'
    : '<i class="fa-solid fa-angles-down mr-1"></i>Expand all';
  if (!list.length) {
    box.innerHTML = '<p class="py-6 text-center text-xs text-slate-500 italic">No dining records for this filter. Tick “Record into Dining” when you scan a receipt, or tap Add Meal.</p>';
    return;
  }
  box.innerHTML = list.map(r => {
    const id = esc(r.id);
    const items = r.items || [];
    const open = diningExpandAll || openDiningRows.has(r.id);
    const meta = [esc(r.date || '—'), esc(r.mealType || '—')];
    if (num(r.pax)) meta.push(`${num(r.pax)} pax`);
    const chip = items.length ? `${items.length} dish${items.length > 1 ? 'es' : ''}` : 'Breakdown';
    const view = (r.imagePaths || []).length
      ? `<button onclick="viewDiningPhotos('${id}')" class="text-indigo-400 hover:text-indigo-300 p-1" title="View photos"><i class="fa-solid fa-images"></i></button>` : '';
    return `<div class="py-2.5 flex gap-2 sm:gap-3 items-start">
      <input type="checkbox" data-din-pick value="${id}" class="accent-indigo-500 mt-1 shrink-0">
      <div class="min-w-0 flex-1">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="text-xs font-semibold text-slate-200 flex items-center gap-1.5 flex-wrap">${esc(r.restaurant || '(no restaurant)')} ${statusBadges(r)}</div>
            <div class="text-[9px] text-slate-500 font-mono">${meta.join(' · ')}</div>
          </div>
          <div class="text-right shrink-0">
            <div class="font-mono text-xs font-bold text-slate-100 whitespace-nowrap">${esc(r.currency || 'MYR')} ${fmt(recordTotal(r))}</div>
            <div class="flex gap-0.5 justify-end">
              ${view}
              <button onclick="openDiningModal('${id}')" class="text-indigo-400 hover:text-indigo-300 p-1" title="Edit"><i class="fa-solid fa-pen-to-square"></i></button>
              <button onclick="deleteDiningRecord('${id}')" class="text-rose-500 hover:text-rose-400 p-1" title="Delete"><i class="fa-solid fa-trash"></i></button>
            </div>
          </div>
        </div>
        <button type="button" onclick="toggleDiningDetails('${id}')" class="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-indigo-400 hover:text-indigo-300">
          <i id="dinChev-${id}" class="fa-solid fa-chevron-right transition-transform ${open ? 'rotate-90' : ''}"></i>${chip}</button>
        <div id="dinDet-${id}" class="${open ? '' : 'hidden'} mt-1.5 text-[10px] text-slate-500 space-y-0.5 bg-gray-950/60 border border-gray-800/80 rounded-lg px-2.5 py-2">${breakdownHtml(r)}</div>
      </div>
    </div>`;
  }).join('');
}

// ---------- insights: most-ordered dishes + favourite restaurants ----------
function dishKey(name) { return String(name || '').trim().toLowerCase().replace(/\s+/g, ' '); }

function renderTopDishes(list) {
  const box = document.getElementById('dinTopDishes');
  if (!box) return;
  const agg = {};
  list.forEach(r => (r.items || []).forEach(i => {
    const k = dishKey(i.name);
    if (!k) return;
    const a = agg[k] || (agg[k] = { name: String(i.name).trim(), qty: 0, spend: 0, places: new Set() });
    a.qty += dishQty(i); a.spend += num(i.amount);
    if (r.restaurant) a.places.add(r.restaurant);
  }));
  const top = Object.values(agg).sort((a, b) => b.qty - a.qty || b.spend - a.spend).slice(0, 8);
  box.innerHTML = top.length
    ? top.map(d => `<div class="flex items-center justify-between gap-2 text-[11px]">
        <div class="min-w-0"><div class="text-slate-200 font-semibold truncate">${esc(d.name)}</div>
          <div class="text-[9px] text-slate-500 truncate">${esc([...d.places].slice(0, 2).join(', '))}${d.places.size > 2 ? ` +${d.places.size - 2}` : ''}</div></div>
        <div class="text-right shrink-0 font-mono"><div class="text-amber-300">${d.qty}×</div><div class="text-[9px] text-slate-500">RM ${fmt(d.spend)}</div></div>
      </div>`).join('')
    : '<p class="text-[10px] text-slate-500 italic">Dishes show up here once meals are enriched or entered.</p>';
}

function renderTopRestaurants(list) {
  const box = document.getElementById('dinTopRestaurants');
  if (!box) return;
  const agg = {};
  list.forEach(r => {
    const k = (r.restaurant || '').trim();
    if (!k) return;
    const a = agg[k] || (agg[k] = { name: k, visits: 0, spend: 0 });
    a.visits++; a.spend += recordTotal(r);
  });
  const top = Object.values(agg).sort((a, b) => b.spend - a.spend).slice(0, 6);
  box.innerHTML = top.length
    ? top.map(t => `<div class="flex items-center justify-between gap-2 text-[11px]">
        <div class="min-w-0"><div class="text-slate-200 font-semibold truncate">${esc(t.name)}</div>
          <div class="text-[9px] text-slate-500">${t.visits} visit${t.visits > 1 ? 's' : ''} · avg RM ${fmt(t.spend / t.visits)}</div></div>
        <div class="font-mono text-slate-100 shrink-0">RM ${fmt(t.spend)}</div>
      </div>`).join('')
    : '<p class="text-[10px] text-slate-500 italic">No restaurants yet.</p>';
}

function renderDiningCharts(list) {
  const byMonth = {};
  list.forEach(r => { const k = (r.date || '').slice(0, 7) || 'Unknown'; byMonth[k] = (byMonth[k] || 0) + recordTotal(r); });
  const months = Object.keys(byMonth).sort();
  if (dinTrendChartObj) dinTrendChartObj.destroy();
  const t = document.getElementById('dinTrendChart');
  if (t && typeof Chart !== 'undefined') {
    dinTrendChartObj = new Chart(t, {
      type: 'bar',
      data: { labels: months.length ? months : ['No data'], datasets: [{ label: 'Total (RM)', data: months.length ? months.map(m => byMonth[m]) : [0], backgroundColor: '#f97316', borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#9ca3af', font: { size: 9 } } }, y: { ticks: { color: '#9ca3af', font: { size: 9 } } } } },
    });
  }
  const byType = {};
  list.forEach(r => { const k = r.mealType || 'Other'; byType[k] = (byType[k] || 0) + recordTotal(r); });
  const types = Object.keys(byType).sort((a, b) => byType[b] - byType[a]);
  if (dinSplitChartObj) dinSplitChartObj.destroy();
  const s = document.getElementById('dinSplitChart');
  if (s && typeof Chart !== 'undefined') {
    const palette = ['#f97316', '#14b8a6', '#6366f1', '#f59e0b', '#ec4899', '#0ea5e9', '#84cc16', '#a855f7'];
    dinSplitChartObj = new Chart(s, {
      type: 'doughnut',
      data: {
        labels: types.length ? types : ['No data'],
        datasets: [{
          data: types.length ? types.map(c => byType[c]) : [1],
          backgroundColor: types.length ? types.map((_, i) => palette[i % palette.length]) : ['#374151'],
          borderWidth: 2, borderColor: '#111827',
        }],
      },
      options: { responsive: true, maintainAspectRatio: false, cutout: '68%', plugins: { legend: { position: 'bottom', labels: { color: '#9ca3af', font: { size: 10, weight: 'bold' }, boxWidth: 12 } } } },
    });
  }
}

// ---------- view photos ----------
export function viewDiningPhotos(id) {
  const r = records().find(x => x.id === id);
  if (!r || !(r.imagePaths || []).length) { showToast('No photos on this record.', 'error'); return; }
  const rid = String(r.imagePaths[0]).split('/').pop();
  if (rid && typeof window.viewReceipt === 'function') window.viewReceipt(rid);
  if (r.imagePaths.length > 1) showToast('Showing photo 1. Open Edit to view each photo individually.', 'info');
}

// ---------- modal (add / edit, incl. dynamic dish rows) ----------
export function openDiningModal(id) {
  const r = id ? records().find(x => x.id === id) : null;
  const set = (k, v) => { document.getElementById(k).value = v; };
  set('dinRecId', r ? r.id : '');
  document.getElementById('dinModalTitle').innerText = r ? 'Edit Meal' : 'New Meal';
  document.getElementById('dinRecMeal').innerHTML = diningMealTypeOptionsHtml(r ? r.mealType : '');
  set('dinRecDate', (r && r.date) || today());
  set('dinRecRestaurant', (r && r.restaurant) || '');
  set('dinRecCurrency', (r && r.currency) || 'MYR');
  set('dinRecAmount', r ? num(r.amount) : '');
  set('dinRecPax', r && num(r.pax) ? num(r.pax) : '');
  set('dinRecService', r && num(r.serviceCharge) ? num(r.serviceCharge) : '');
  set('dinRecTax', r && num(r.tax) ? num(r.tax) : '');
  set('dinRecDiscount', r && num(r.discount) ? num(r.discount) : '');
  set('dinRecRemark', (r && r.remark) || '');
  set('dinRecRawOcr', (r && r.rawOcr) || '');
  const photos = (r && r.imagePaths) || [];
  const pbox = document.getElementById('dinRecPhotos');
  if (pbox) {
    pbox.innerHTML = photos.map((p, i) => `<button type="button" onclick="viewReceipt('${esc(String(p).split('/').pop())}')" class="flex items-center gap-1.5 text-[11px] bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 hover:border-indigo-400 rounded-lg px-2.5 py-1.5 transition"><i class="fa-solid fa-image"></i> Photo ${i + 1}</button>`).join('');
  }
  const rows = document.getElementById('dinItemRows');
  rows.innerHTML = '';
  const items = (r && r.items) || [];
  if (items.length) items.forEach(i => addDishRow(i.name, i.qty, i.amount)); else addDishRow();
  dinRecalc();
  document.getElementById('diningModal').classList.remove('hidden');
}

export function closeDiningModal() { document.getElementById('diningModal').classList.add('hidden'); }

export function addDishRow(name = '', qty = '', amount = '') {
  const rows = document.getElementById('dinItemRows');
  const div = document.createElement('div');
  div.className = 'grid grid-cols-12 gap-2 items-center';
  div.innerHTML = `
    <input type="text" data-din-dish-name value="${esc(name)}" placeholder="Dish / drink" class="col-span-6 bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-[11px] text-slate-100 focus:outline-none focus:border-orange-500">
    <input type="number" step="1" min="0" inputmode="numeric" data-din-dish-qty value="${esc(qty)}" placeholder="Qty" class="col-span-2 bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-[11px] text-slate-100 focus:outline-none focus:border-orange-500">
    <input type="number" step="0.01" inputmode="decimal" data-din-dish-amount value="${esc(amount)}" placeholder="Total" oninput="dinRecalc()" class="col-span-3 bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-[11px] text-slate-100 focus:outline-none focus:border-orange-500">
    <button type="button" onclick="this.closest('div').remove(); dinRecalc();" class="col-span-1 text-rose-500 hover:text-rose-400 text-xs" title="Remove"><i class="fa-solid fa-xmark"></i></button>`;
  rows.appendChild(div);
}

function readDishRows() {
  return [...document.querySelectorAll('#dinItemRows > div')].map(row => ({
    name: row.querySelector('[data-din-dish-name]').value.trim(),
    qty: num(row.querySelector('[data-din-dish-qty]').value) || 1,
    amount: num(row.querySelector('[data-din-dish-amount]').value),
  })).filter(i => i.name || i.amount);
}

// Live cross-check in the modal: dishes + service + tax − discount vs amount paid.
export function dinRecalc() {
  const val = id => num(document.getElementById(id).value);
  const dishes = [...document.querySelectorAll('#dinItemRows [data-din-dish-amount]')].reduce((s, el) => s + num(el.value), 0);
  const cur = document.getElementById('dinRecCurrency').value.trim() || 'MYR';
  const computed = dishes ? dishes + val('dinRecService') + val('dinRecTax') - val('dinRecDiscount') : 0;
  document.getElementById('dinRecTotalDisplay').innerText = `${cur} ${fmt(computed)}`;
  const hint = document.getElementById('dinRecReconcile');
  const amount = val('dinRecAmount');
  if (computed > 0 && amount > 0 && Math.abs(amount - computed) > RECONCILE_TOLERANCE + 1e-9) {
    hint.classList.remove('hidden');
    hint.innerText = `⚠ Amount paid (${fmt(amount)}) ≠ dishes + service + tax − discount (${fmt(computed)}).`;
  } else {
    hint.classList.add('hidden');
  }
}

// Fill "Amount paid" from the breakdown (handy when typing a bill in by hand).
export function dinUseBreakdownTotal() {
  const t = document.getElementById('dinRecTotalDisplay').innerText.split(' ').pop();
  if (num(t) > 0) { document.getElementById('dinRecAmount').value = t; dinRecalc(); }
}

export function handleDiningSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('dinRecId').value;
  const items = readDishRows();
  const fields = {
    date: document.getElementById('dinRecDate').value,
    restaurant: document.getElementById('dinRecRestaurant').value.trim(),
    mealType: document.getElementById('dinRecMeal').value,
    currency: document.getElementById('dinRecCurrency').value.trim() || 'MYR',
    amount: num(document.getElementById('dinRecAmount').value),
    pax: num(document.getElementById('dinRecPax').value),
    items,
    serviceCharge: num(document.getElementById('dinRecService').value),
    tax: num(document.getElementById('dinRecTax').value),
    discount: num(document.getElementById('dinRecDiscount').value),
    remark: document.getElementById('dinRecRemark').value.trim(),
  };
  if (!fields.amount && items.length) fields.amount = Math.round(breakdownTotal(fields) * 100) / 100;
  const now = new Date().toISOString();
  if (id) {
    const r = records().find(x => x.id === id);
    if (!r) return;
    Object.assign(r, fields, { enriched: true, updatedAt: now });
  } else {
    database.diningRecords.push({
      id: 'din-' + Date.now() + Math.random().toString(36).slice(2, 5),
      ...fields, imagePaths: [], receiptId: null, txId: null, claimId: null, rawOcr: '',
      enriched: true, createdAt: now, updatedAt: now,
    });
  }
  saveToLocalStorage();
  renderDining();
  closeDiningModal();
  showToast('Meal saved.', 'success');
}

export function deleteDiningRecord(id) {
  askConfirm('Delete this meal? (Linked receipt images in Koofr are kept.)', () => {
    database.diningRecords = records().filter(r => r.id !== id);
    openDiningRows.delete(id);
    saveToLocalStorage();
    renderDining();
    showToast('Meal deleted.', 'info');
  });
}

// ---------- export (one file) : raw OCR bundle for Claude ----------
// mobile.js patches <a download> clicks so this also saves/shares natively in the Android app.
function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const CLAUDE_INSTRUCTIONS =
  'You convert raw OCR text from Malaysian restaurant / café / hawker / food-delivery receipts into structured JSON. ' +
  'For EACH record in "records", read its "rawOcr" and produce an enriched record that keeps the SAME "id". ' +
  'Extract: restaurant (the outlet name), date (YYYY-MM-DD), currency (default MYR), ' +
  'mealType (choose the best fit from "allowedMealTypes", using the printed time if any), ' +
  'amount (the grand total actually paid, as a number), pax (number of diners if printed, else 0), ' +
  'items as an array of { "name", "qty", "amount" } — one entry per dish or drink line, where "amount" is the LINE TOTAL ' +
  '(qty × unit price); add-ons printed under a dish may be their own line. ' +
  'serviceCharge (service charge as a number, 0 if none), tax (SST / GST as a number, 0 if none), ' +
  'discount (any discount, voucher or member saving as a POSITIVE number, 0 if none). Ignore rounding adjustments. ' +
  'Write dish names cleanly in title case, expanding obvious OCR abbreviations only when certain. ' +
  'Amounts are the figures printed on the receipt — never invent or estimate a value that is not there; use 0 or "" instead. ' +
  'Return ONLY one strictly valid JSON object, no prose, of the form: ' +
  '{ "type": "dining-enriched-import", "schemaVersion": 1, "records": [ <one enriched record per input record> ] }. ' +
  'Never put a double quote inside a string value — use single quotes instead.';

function tidyOcr(text) {
  return String(text || '')
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))
    .filter(l => !/^[-=*_.\s]{4,}$/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// scope: 'selected' (ticked rows), 'new' (un-enriched), or 'all'. Returns { payload } or { error }.
function diningExportPayload(scope) {
  const all = records();
  let src;
  if (scope === 'selected') {
    const ids = new Set(pickedDiningIds());
    if (!ids.size) return { error: 'Tick the meals you want to export first (checkboxes on the left).' };
    src = all.filter(r => ids.has(r.id));
  } else if (scope === 'all') {
    src = all;
  } else {
    src = all.filter(r => !r.enriched);
    if (!src.length) return { error: 'Nothing new to enrich — every meal is already enriched. Use “Selected” or “All”.' };
  }
  if (!src.length) return { error: 'No dining records to export yet.' };
  return { payload: {
    type: EXPORT_TYPE,
    schemaVersion: IO_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    instructions: CLAUDE_INSTRUCTIONS,
    allowedMealTypes: diningMealTypes(),
    targetSchema: {
      id: '', date: 'YYYY-MM-DD', restaurant: '', mealType: '', currency: 'MYR', amount: 0, pax: 0,
      items: [{ name: '', qty: 1, amount: 0 }], serviceCharge: 0, tax: 0, discount: 0, remark: '',
    },
    // imagePaths are deliberately omitted — Claude can't open Koofr paths, so they'd only cost tokens.
    records: src.map(r => ({
      id: r.id, date: r.date, restaurant: r.restaurant, mealType: r.mealType, currency: r.currency,
      amount: num(r.amount), rawOcr: tidyOcr(r.rawOcr),
    })),
  } };
}

export function exportDiningRaw(scope) {
  const { payload, error } = diningExportPayload(scope);
  if (error) { showToast(error, 'error'); return; }
  downloadJson(payload, `dining-raw-${today()}.json`);
  showToast(`Exported ${payload.records.length} meal(s). Open Claude, attach this file, then import the JSON it returns.`, 'success');
}

// ---------- copy/paste round-trip : prompt out, Claude's reply pasted back ----------
export function openDiningEnrichPanel() {
  openEnrichPanel({
    title: 'Break meals down into dishes with Claude',
    defaultScope: pickedDiningIds().length ? 'selected' : 'new',
    build: diningExportPayload,
    importData: importDiningEnriched,
  });
}

// ---------- import (one file) : enriched JSON back from Claude (or hand-edited) ----------
export function handleDiningImportFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    input.value = '';
    let data;
    try { data = normalizeEnriched(parseEnrichedJson(reader.result)); }
    catch (err) { showToast(`Import failed: ${err.message}`, 'error'); return; }
    const res = importDiningEnriched(data);
    showToast(res.message, res.ok ? 'success' : 'error');
  };
  reader.onerror = () => { showToast('Could not read the file.', 'error'); input.value = ''; };
  reader.readAsText(file);
}

// Returns { ok, message }; the caller decides how to surface it.
export function importDiningEnriched(data) {
  if (!data || (data.type && data.type !== IMPORT_TYPE) || !Array.isArray(data.records)) {
    return { ok: false, message: `Import failed: expected a "${IMPORT_TYPE}" object with a "records" array.` };
  }
  const types = diningMealTypes();
  let updated = 0, unknown = 0, mismatch = 0;
  data.records.forEach(rec => {
    if (!rec || !rec.id) { unknown++; return; }
    const r = records().find(x => x.id === rec.id);
    if (!r) { unknown++; return; }
    const restaurant = rec.restaurant != null ? rec.restaurant : rec.merchant;
    if (restaurant != null && String(restaurant).trim()) r.restaurant = String(restaurant);
    if (rec.date != null && String(rec.date).trim()) r.date = String(rec.date);
    if (rec.currency != null) r.currency = String(rec.currency) || 'MYR';
    // Only accept a meal type from the user's own list — never silently invent one.
    if (rec.mealType != null && types.includes(String(rec.mealType))) r.mealType = String(rec.mealType);
    if (rec.pax != null && num(rec.pax) > 0) r.pax = num(rec.pax);
    if (Array.isArray(rec.items)) {
      r.items = rec.items
        .map(i => ({ name: String((i && i.name) || '').trim(), qty: num(i && i.qty) || 1, amount: num(i && i.amount) }))
        .filter(i => i.name || i.amount);
    }
    if (rec.serviceCharge != null) r.serviceCharge = num(rec.serviceCharge);
    if (rec.tax != null) r.tax = num(rec.tax);
    if (rec.discount != null) r.discount = Math.abs(num(rec.discount));
    // The OCR'd total already on the record is trusted unless the enrichment gives a real number.
    if (rec.amount != null && num(rec.amount) > 0) r.amount = num(rec.amount);
    if (rec.remark != null && String(rec.remark).trim()) r.remark = String(rec.remark);
    if (!num(r.amount) && breakdownTotal(r) > 0) r.amount = Math.round(breakdownTotal(r) * 100) / 100;
    r.enriched = true; r.updatedAt = new Date().toISOString();
    if (!reconciles(r)) mismatch++;
    updated++;
  });
  saveToLocalStorage();
  renderDining();
  let msg = `Imported: ${updated} meal(s) updated`;
  if (unknown) msg += ` · ${unknown} unknown id(s) skipped`;
  if (mismatch) msg += ` · ${mismatch} need a total check`;
  return { ok: updated > 0, message: updated ? msg : `${msg} — none of the ids match your records.` };
}

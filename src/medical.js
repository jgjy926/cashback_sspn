// Medical Records — a standalone medical-claim tracker enriched offline via Claude.
//
// Zero-cost, high-accuracy flow: multi-photo receipts are OCR'd (raw text kept), synced to
// Koofr, exported as ONE JSON file, enriched in Claude chat, then imported back as ONE JSON
// file. Every field is also fully editable/keyable by hand. This tab never disturbs the
// existing Receipts / Claims / Ledger flows (BAU); it is fed by an independent 3rd tick.
import { database } from './state.js';
import { saveToLocalStorage } from './storage.js';
import { askConfirm, showToast } from './ui.js';

// ---- import/export contract ----
const EXPORT_TYPE = 'medical-raw-export';
const IMPORT_TYPE = 'medical-enriched-import';
const IO_SCHEMA_VERSION = 1;

let medTrendChartObj = null, medSplitChartObj = null;

// Imported/enriched data is external + untrusted, so escape every string before it hits innerHTML.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function num(v) { return Number(v) || 0; }
function fmt(n) { return num(n).toFixed(2); }

// Two decompositions of the same visit cost:
//  - by payer:  insurance + patient  (the canonical total used for KPIs)
//  - by type:   consultation + Σ medicines
function recordTotal(r) { return num(r.amountInsurance) + num(r.amountPatient); }
function breakdownTotal(r) {
  return num(r.consultation) + (r.medicines || []).reduce((s, m) => s + num(m.amount), 0);
}
function reconciles(r) { return Math.abs(recordTotal(r) - breakdownTotal(r)) <= 0.01; }

// ---------- create from a receipt (called by the 3rd capture tick) ----------
export function createMedicalRecordFromReceipt(receipt, extra = {}) {
  const now = new Date().toISOString();
  const id = 'med-' + Date.now() + Math.random().toString(36).slice(2, 5);
  database.medicalRecords.push({
    id,
    date: receipt.date || '',
    merchant: receipt.merchant || '',
    currency: receipt.currency || 'MYR',
    amountInsurance: 0,
    amountPatient: num(receipt.total),      // seed from the OCR'd total; refine on enrichment
    consultation: 0,
    medicines: [],
    imagePaths: (extra.imagePaths && extra.imagePaths.length) ? extra.imagePaths
      : (receipt.imagePath ? [receipt.imagePath] : []),
    receiptId: receipt.id || null,
    claimId: receipt.claimId || null,
    rawOcr: extra.rawOcr || receipt.ocrText || '',
    enriched: false,
    remark: receipt.remark || '',
    createdAt: now, updatedAt: now,
  });
  return id;
}

// ---------- filters ----------
function allYears() {
  const ys = new Set([String(new Date().getFullYear())]);
  (database.medicalRecords || []).forEach(r => { if (r.date && r.date.length >= 4) ys.add(r.date.slice(0, 4)); });
  return [...ys].sort().reverse();
}
function allMerchants() {
  return [...new Set((database.medicalRecords || []).map(r => (r.merchant || '').trim()).filter(Boolean))].sort();
}

export function populateMedicalFilters() {
  const y = document.getElementById('medFilterYear');
  if (y) {
    const prev = y.value || 'ALL';
    y.innerHTML = '<option value="ALL">All Years</option>' + allYears().map(v => `<option value="${v}">${v}</option>`).join('');
    y.value = [...y.options].some(o => o.value === prev) ? prev : 'ALL';
  }
  const mSel = document.getElementById('medFilterMerchant');
  if (mSel) {
    const prev = mSel.value || 'ALL';
    mSel.innerHTML = '<option value="ALL">All Merchants</option>' + allMerchants().map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    mSel.value = [...mSel.options].some(o => o.value === prev) ? prev : 'ALL';
  }
}

function filteredMedical() {
  const fy = (document.getElementById('medFilterYear') || {}).value || 'ALL';
  const fm = (document.getElementById('medFilterMonth') || {}).value || 'ALL';
  const merchant = (document.getElementById('medFilterMerchant') || {}).value || 'ALL';
  const medTerm = (((document.getElementById('medFilterMedicine') || {}).value) || '').trim().toLowerCase();
  return (database.medicalRecords || []).filter(r => {
    const yr = (r.date || '').slice(0, 4), mo = (r.date || '').slice(5, 7);
    if (fy !== 'ALL' && yr !== fy) return false;
    if (fm !== 'ALL' && mo !== fm) return false;
    if (merchant !== 'ALL' && (r.merchant || '') !== merchant) return false;
    if (medTerm) {
      const hit = (r.medicines || []).some(m => (m.name || '').toLowerCase().includes(medTerm))
        || (r.merchant || '').toLowerCase().includes(medTerm);
      if (!hit) return false;
    }
    return true;
  }).sort((a, b) => new Date(b.date) - new Date(a.date));
}

export function onMedicalFilterChange() { renderMedical(); }

// ---------- umbrella render ----------
export function renderMedical() {
  populateMedicalFilters();
  const list = filteredMedical();
  renderMedicalKpis(list);
  renderMedicalLedger(list);
  renderMedicalCharts(list);
}

function renderMedicalKpis(list) {
  let total = 0, ins = 0, pat = 0, meds = 0;
  list.forEach(r => { total += recordTotal(r); ins += num(r.amountInsurance); pat += num(r.amountPatient); meds += (r.medicines || []).length; });
  const set = (id, txt) => { const el = document.getElementById(id); if (el) el.innerText = txt; };
  set('medKpiTotal', `RM ${fmt(total)}`);
  set('medKpiInsurance', `RM ${fmt(ins)}`);
  set('medKpiPatient', `RM ${fmt(pat)}`);
  set('medKpiVisits', String(list.length));
  set('medKpiMeds', String(meds));
}

function statusBadges(r) {
  const badges = [];
  if (!r.enriched) badges.push('<span class="text-[8px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 rounded font-bold">Raw</span>');
  else badges.push('<span class="text-[8px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 rounded font-bold">Enriched</span>');
  if (!reconciles(r)) badges.push('<span title="Payer total ≠ consultation + medicines" class="text-[8px] bg-rose-500/10 text-rose-400 border border-rose-500/20 px-1.5 rounded font-bold">⚠ Mismatch</span>');
  const n = (r.imagePaths || []).length;
  if (n) badges.push(`<span class="text-[8px] bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 px-1.5 rounded font-bold"><i class="fa-solid fa-image"></i> ${n}</span>`);
  return badges.join(' ');
}

function renderMedicalLedger(list) {
  const body = document.getElementById('medLedgerBody');
  if (!body) return;
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="7" class="py-6 text-center text-xs text-slate-500 italic">No medical records for this filter.</td></tr>';
    return;
  }
  body.innerHTML = list.map(r => {
    const medLines = (r.medicines || []).length
      ? `<div class="text-[9px] text-slate-500 mt-0.5 space-y-0.5">${(r.medicines || []).map(m =>
        `<div><i class="fa-solid fa-pills mr-1 text-slate-600"></i>${esc(m.name || '(unnamed)')}${m.qty ? ` ×${esc(m.qty)}` : ''} — ${esc(r.currency || 'MYR')} ${fmt(m.amount)}</div>`).join('')}</div>`
      : '';
    const consult = num(r.consultation) ? `<div class="text-[9px] text-slate-500 mt-0.5"><i class="fa-solid fa-stethoscope mr-1 text-slate-600"></i>Consultation — ${esc(r.currency || 'MYR')} ${fmt(r.consultation)}</div>` : '';
    const remark = r.remark ? `<div class="text-[9px] text-slate-400 italic">“${esc(r.remark)}”</div>` : '';
    const view = (r.imagePaths || []).length
      ? `<button onclick="viewMedicalPhotos('${r.id}')" class="text-indigo-400 hover:text-indigo-300 p-1" title="View photos"><i class="fa-solid fa-images"></i></button>` : '';
    return `<tr class="hover:bg-gray-900/40 transition align-top">
      <td class="py-2.5 px-4">
        <div class="text-xs font-semibold text-slate-200 flex items-center gap-1.5 flex-wrap">${esc(r.merchant || '(no merchant)')} ${statusBadges(r)}</div>
        <div class="text-[9px] text-slate-500 font-mono">${esc(r.date || '—')}</div>
        ${consult}${medLines}${remark}
      </td>
      <td class="py-2.5 px-4 text-right font-mono text-xs text-sky-400">${esc(r.currency || 'MYR')} ${fmt(r.amountInsurance)}</td>
      <td class="py-2.5 px-4 text-right font-mono text-xs text-amber-400">${esc(r.currency || 'MYR')} ${fmt(r.amountPatient)}</td>
      <td class="py-2.5 px-4 text-right font-mono text-xs font-bold text-slate-100">${esc(r.currency || 'MYR')} ${fmt(recordTotal(r))}</td>
      <td class="py-2.5 px-4 text-center text-[11px] text-slate-400">${(r.medicines || []).length}</td>
      <td class="py-2.5 px-4 text-center">
        <div class="flex gap-1 justify-center">
          ${view}
          <button onclick="openMedicalModal('${r.id}')" class="text-indigo-400 hover:text-indigo-300 p-1" title="Edit"><i class="fa-solid fa-pen-to-square"></i></button>
          <button onclick="deleteMedicalRecord('${r.id}')" class="text-rose-500 hover:text-rose-400 p-1" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function renderMedicalCharts(list) {
  // Trend: total spend by month.
  const byMonth = {};
  list.forEach(r => { const k = (r.date || '').slice(0, 7) || 'Unknown'; byMonth[k] = (byMonth[k] || 0) + recordTotal(r); });
  const months = Object.keys(byMonth).sort();
  if (medTrendChartObj) medTrendChartObj.destroy();
  const t = document.getElementById('medTrendChart');
  if (t && typeof Chart !== 'undefined') {
    medTrendChartObj = new Chart(t, {
      type: 'bar',
      data: { labels: months.length ? months : ['No data'], datasets: [{ label: 'Total (RM)', data: months.length ? months.map(m => byMonth[m]) : [0], backgroundColor: '#6366f1', borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#9ca3af', font: { size: 9 } } }, y: { ticks: { color: '#9ca3af', font: { size: 9 } } } } },
    });
  }
  // Split: insurance vs patient.
  let ins = 0, pat = 0;
  list.forEach(r => { ins += num(r.amountInsurance); pat += num(r.amountPatient); });
  if (medSplitChartObj) medSplitChartObj.destroy();
  const s = document.getElementById('medSplitChart');
  if (s && typeof Chart !== 'undefined') {
    const hasData = (ins + pat) > 0;
    medSplitChartObj = new Chart(s, {
      type: 'doughnut',
      data: { labels: hasData ? ['Insurance', 'Patient'] : ['No data'], datasets: [{ data: hasData ? [ins, pat] : [1], backgroundColor: hasData ? ['#0ea5e9', '#f59e0b'] : ['#374151'], borderWidth: 2, borderColor: '#111827' }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '68%', plugins: { legend: { position: 'bottom', labels: { color: '#9ca3af', font: { size: 10, weight: 'bold' }, boxWidth: 12 } } } },
    });
  }
}

// ---------- view photos ----------
export function viewMedicalPhotos(id) {
  const r = (database.medicalRecords || []).find(x => x.id === id);
  if (!r || !(r.imagePaths || []).length) { showToast('No photos on this record.', 'error'); return; }
  // Each imagePath is "receipt/<id>"; reuse the receipt image viewer.
  r.imagePaths.forEach(p => {
    const rid = String(p).split('/').pop();
    if (rid && typeof window.viewReceipt === 'function') window.viewReceipt(rid);
  });
}

// ---------- modal (add / edit, incl. dynamic medicine rows) ----------
export function openMedicalModal(id) {
  const r = id ? (database.medicalRecords || []).find(x => x.id === id) : null;
  document.getElementById('medRecId').value = r ? r.id : '';
  document.getElementById('medModalTitle').innerText = r ? 'Edit Medical Record' : 'New Medical Record';
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('medRecDate').value = (r && r.date) || today;
  document.getElementById('medRecMerchant').value = (r && r.merchant) || '';
  document.getElementById('medRecCurrency').value = (r && r.currency) || 'MYR';
  document.getElementById('medRecInsurance').value = r ? num(r.amountInsurance) : 0;
  document.getElementById('medRecPatient').value = r ? num(r.amountPatient) : 0;
  document.getElementById('medRecConsultation').value = r ? num(r.consultation) : 0;
  document.getElementById('medRecRemark').value = (r && r.remark) || '';
  document.getElementById('medRecRawOcr').value = (r && r.rawOcr) || '';
  const rows = document.getElementById('medMedicineRows');
  rows.innerHTML = '';
  const meds = (r && r.medicines) || [];
  if (meds.length) meds.forEach(m => addMedicineRow(m.name, m.qty, m.amount)); else addMedicineRow();
  medRecalc();
  document.getElementById('medicalModal').classList.remove('hidden');
}

export function closeMedicalModal() { document.getElementById('medicalModal').classList.add('hidden'); }

export function addMedicineRow(name = '', qty = '', amount = '') {
  const rows = document.getElementById('medMedicineRows');
  const div = document.createElement('div');
  div.className = 'grid grid-cols-12 gap-2 items-center';
  div.innerHTML = `
    <input type="text" data-med-name value="${esc(name)}" placeholder="Medicine name" class="col-span-6 bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-[11px] text-slate-100 focus:outline-none focus:border-indigo-500">
    <input type="number" step="1" data-med-qty value="${esc(qty)}" placeholder="Qty" oninput="medRecalc()" class="col-span-2 bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-[11px] text-slate-100 focus:outline-none focus:border-indigo-500">
    <input type="number" step="0.01" data-med-amount value="${esc(amount)}" placeholder="Amount" oninput="medRecalc()" class="col-span-3 bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-[11px] text-slate-100 focus:outline-none focus:border-indigo-500">
    <button type="button" onclick="this.closest('div').remove(); medRecalc();" class="col-span-1 text-rose-500 hover:text-rose-400 text-xs" title="Remove"><i class="fa-solid fa-xmark"></i></button>`;
  rows.appendChild(div);
}

function readMedicineRows() {
  return [...document.querySelectorAll('#medMedicineRows > div')].map(row => ({
    name: row.querySelector('[data-med-name]').value.trim(),
    qty: num(row.querySelector('[data-med-qty]').value),
    amount: num(row.querySelector('[data-med-amount]').value),
  })).filter(m => m.name || m.amount);
}

// Live totals + reconciliation hint in the modal.
export function medRecalc() {
  const ins = num(document.getElementById('medRecInsurance').value);
  const pat = num(document.getElementById('medRecPatient').value);
  const consult = num(document.getElementById('medRecConsultation').value);
  const meds = [...document.querySelectorAll('#medMedicineRows [data-med-amount]')].reduce((s, el) => s + num(el.value), 0);
  const cur = document.getElementById('medRecCurrency').value.trim() || 'MYR';
  document.getElementById('medRecTotalDisplay').innerText = `${cur} ${fmt(ins + pat)}`;
  const hint = document.getElementById('medRecReconcile');
  if (Math.abs((ins + pat) - (consult + meds)) > 0.01) {
    hint.classList.remove('hidden');
    hint.innerText = `⚠ Payer total (${fmt(ins + pat)}) ≠ consultation + medicines (${fmt(consult + meds)}).`;
  } else {
    hint.classList.add('hidden');
  }
}

export function handleMedicalSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('medRecId').value;
  const fields = {
    date: document.getElementById('medRecDate').value,
    merchant: document.getElementById('medRecMerchant').value.trim(),
    currency: document.getElementById('medRecCurrency').value.trim() || 'MYR',
    amountInsurance: num(document.getElementById('medRecInsurance').value),
    amountPatient: num(document.getElementById('medRecPatient').value),
    consultation: num(document.getElementById('medRecConsultation').value),
    medicines: readMedicineRows(),
    remark: document.getElementById('medRecRemark').value.trim(),
  };
  const now = new Date().toISOString();
  if (id) {
    const r = (database.medicalRecords || []).find(x => x.id === id);
    if (!r) return;
    Object.assign(r, fields, { enriched: true, updatedAt: now });
  } else {
    database.medicalRecords.push({
      id: 'med-' + Date.now() + Math.random().toString(36).slice(2, 5),
      ...fields, imagePaths: [], receiptId: null, claimId: null, rawOcr: '',
      enriched: true, createdAt: now, updatedAt: now,
    });
  }
  saveToLocalStorage();
  renderMedical();
  closeMedicalModal();
  showToast('Medical record saved.', 'success');
}

export function deleteMedicalRecord(id) {
  askConfirm('Delete this medical record? (Linked receipt images in Koofr are kept.)', () => {
    database.medicalRecords = (database.medicalRecords || []).filter(r => r.id !== id);
    saveToLocalStorage();
    renderMedical();
    showToast('Medical record deleted.', 'info');
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
  'You convert raw OCR text from Malaysian clinic/pharmacy receipts into structured JSON. ' +
  'For EACH record in "records", read its "rawOcr" and produce an enriched record that keeps the SAME "id". ' +
  'Extract: merchant (clinic/pharmacy name), date (YYYY-MM-DD), currency (default MYR), consultation (consultation/doctor fee as a number, 0 if none), ' +
  'and medicines as an array of { "name", "qty", "amount" } for each medicine/drug line. ' +
  'Do NOT invent amounts that are not present in the text. Leave amountInsurance and amountPatient as 0 unless the text clearly states a split — the user sets the coverage split themselves. ' +
  'Return ONLY one JSON object, no prose, of the form: ' +
  '{ "type": "medical-enriched-import", "schemaVersion": 1, "records": [ <one enriched record per input record> ] }.';

export function exportMedicalRaw(allRecords) {
  const src = (database.medicalRecords || []).filter(r => allRecords || !r.enriched);
  if (!src.length) {
    showToast(allRecords ? 'No medical records to export yet.' : 'Nothing new to enrich — every record is already enriched. Use “Export all”.', 'error');
    return;
  }
  downloadJson({
    type: EXPORT_TYPE,
    schemaVersion: IO_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    instructions: CLAUDE_INSTRUCTIONS,
    targetSchema: { id: '', date: 'YYYY-MM-DD', merchant: '', currency: 'MYR', consultation: 0, medicines: [{ name: '', qty: 1, amount: 0 }], amountInsurance: 0, amountPatient: 0, remark: '' },
    records: src.map(r => ({ id: r.id, date: r.date, merchant: r.merchant, currency: r.currency, imagePaths: r.imagePaths || [], rawOcr: r.rawOcr || '' })),
  }, `medical-raw-${new Date().toISOString().slice(0, 10)}.json`);
  showToast(`Exported ${src.length} record(s). Open Claude, attach this file, then import the JSON it returns.`, 'success');
}

// ---------- import (one file) : enriched JSON back from Claude (or hand-edited) ----------
export function handleMedicalImportFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); }
    catch { showToast('Import failed: the file is not valid JSON.', 'error'); input.value = ''; return; }
    importMedicalEnriched(data);
    input.value = '';
  };
  reader.onerror = () => { showToast('Could not read the file.', 'error'); input.value = ''; };
  reader.readAsText(file);
}

function importMedicalEnriched(data) {
  if (!data || data.type !== IMPORT_TYPE || !Array.isArray(data.records)) {
    showToast(`Import failed: expected a "${IMPORT_TYPE}" file with a "records" array.`, 'error');
    return;
  }
  let updated = 0, unknown = 0, mismatch = 0;
  data.records.forEach(rec => {
    if (!rec || !rec.id) { unknown++; return; }
    const r = (database.medicalRecords || []).find(x => x.id === rec.id);
    if (!r) { unknown++; return; }
    if (rec.merchant != null) r.merchant = String(rec.merchant);
    if (rec.date != null) r.date = String(rec.date);
    if (rec.currency != null) r.currency = String(rec.currency) || 'MYR';
    if (rec.consultation != null) r.consultation = num(rec.consultation);
    if (Array.isArray(rec.medicines)) {
      r.medicines = rec.medicines.map(m => ({ name: String((m && m.name) || ''), qty: num(m && m.qty), amount: num(m && m.amount) }));
    }
    const hasSplit = rec.amountInsurance != null || rec.amountPatient != null;
    if (rec.amountInsurance != null) r.amountInsurance = num(rec.amountInsurance);
    if (rec.amountPatient != null) r.amountPatient = num(rec.amountPatient);
    // If Claude didn't provide a payer split but gave a by-type breakdown, default patient = breakdown.
    if (!hasSplit && recordTotal(r) === 0 && breakdownTotal(r) > 0) r.amountPatient = breakdownTotal(r);
    if (rec.remark != null) r.remark = String(rec.remark);
    r.enriched = true; r.updatedAt = new Date().toISOString();
    if (!reconciles(r)) mismatch++;
    updated++;
  });
  saveToLocalStorage();
  renderMedical();
  let msg = `Imported: ${updated} record(s) updated`;
  if (unknown) msg += ` · ${unknown} unknown id(s) skipped`;
  if (mismatch) msg += ` · ${mismatch} need a total check`;
  showToast(msg, updated ? 'success' : 'error');
}

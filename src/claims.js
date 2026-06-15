// Generic, config-driven claim/submission tracker (e.g. medical claims).
//
// Claim types and the status workflow both live in database.settings
// (claimTypes / claimStatuses), so new categories or stages need no code change.
// A claim can group any number of receipts and tracks the reimbursement lifecycle.
import { database } from './state.js';
import { saveToLocalStorage } from './storage.js';
import { askConfirm, showToast } from './ui.js';
import { renderClaimCharts } from './charts.js';

// ---------- helpers ----------
function claimTypes() { return database.settings.claimTypes || []; }
function claimStatuses() { return database.settings.claimStatuses || []; }

function optionList(values, selected) {
  return values.map(v => `<option value="${v}"${v === selected ? ' selected' : ''}>${v}</option>`).join('');
}

// Color a status badge generically by keyword, so custom statuses still look sensible.
function statusStyle(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('reimburs') || s.includes('approved') || s.includes('paid') || s.includes('done')) return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
  if (s.includes('reject') || s.includes('declin') || s.includes('cancel')) return 'bg-rose-500/10 text-rose-400 border-rose-500/20';
  if (s.includes('submit') || s.includes('pending') || s.includes('process') || s.includes('review')) return 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20';
  return 'bg-slate-500/10 text-slate-400 border-slate-500/20';
}

function num(id) { return parseFloat(document.getElementById(id).value) || 0; }
function val(id) { const el = document.getElementById(id); return el ? el.value : ''; }

// Build a clickable checklist of receipts (optionally restricted to a date range)
// with the given ids pre-checked. Used by both the create form and the edit modal.
function buildReceiptChecklist(containerId, selectedIds = [], from = '', to = '') {
  const box = document.getElementById(containerId);
  if (!box) return;
  const sel = new Set(selectedIds);
  const items = [...(database.receipts || [])]
    .filter(r => {
      if (!r.date) return false;
      if (from && r.date < from) return false;
      if (to && r.date > to) return false;
      return true;
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  if (items.length === 0) {
    box.innerHTML = '<p class="text-[10px] text-slate-500 italic py-2">No receipts in this date range.</p>';
    return;
  }
  box.innerHTML = items.map(r => {
    const amt = (typeof r.total === 'number') ? r.total.toFixed(2) : (r.total || '');
    return `<label class="flex items-center gap-2 text-[11px] text-slate-300 py-1 cursor-pointer">
      <input type="checkbox" value="${r.id}" data-receipt-pick ${sel.has(r.id) ? 'checked' : ''} class="accent-indigo-500">
      <span class="truncate">${r.date} · ${r.merchant || '(no merchant)'} · ${r.currency || 'MYR'} ${amt}</span>
    </label>`;
  }).join('');
}

function pickedReceiptIds(containerId) {
  const box = document.getElementById(containerId);
  if (!box) return [];
  return [...box.querySelectorAll('input[data-receipt-pick]:checked')].map(cb => cb.value);
}

// Keep receipt.claimId back-references consistent after a claim's links change.
function syncReceiptLinks(claimId, receiptIds) {
  const want = new Set(receiptIds);
  (database.receipts || []).forEach(r => {
    if (want.has(r.id)) r.claimId = claimId;
    else if (r.claimId === claimId) delete r.claimId;
  });
}

// ---------- dropdown population ----------
export function populateClaimDropdowns() {
  const typeSel = document.getElementById('claimType');
  if (typeSel) typeSel.innerHTML = optionList(claimTypes(), typeSel.value);
  const statSel = document.getElementById('claimStatus');
  if (statSel) statSel.innerHTML = optionList(claimStatuses(), statSel.value || claimStatuses()[0]);

  const fType = document.getElementById('claimFilterType');
  if (fType) {
    const prev = fType.value || 'ALL';
    fType.innerHTML = '<option value="ALL">All Types</option>' + optionList(claimTypes());
    fType.value = [...fType.options].some(o => o.value === prev) ? prev : 'ALL';
  }
  const fStat = document.getElementById('claimFilterStatus');
  if (fStat) {
    const prev = fStat.value || 'ALL';
    fStat.innerHTML = '<option value="ALL">All Statuses</option>' + optionList(claimStatuses());
    fStat.value = [...fStat.options].some(o => o.value === prev) ? prev : 'ALL';
  }
}

// ---------- create ----------
export function refreshClaimReceiptPicker() {
  buildReceiptChecklist('claimReceiptList', pickedReceiptIds('claimReceiptList'),
    val('claimPeriodFrom'), val('claimPeriodTo'));
}

export function handleClaimSubmit(e) {
  e.preventDefault();
  const id = 'claim-' + Date.now();
  const receiptIds = pickedReceiptIds('claimReceiptList');
  const claim = {
    id,
    type: val('claimType') || (claimTypes()[0] || 'Claim'),
    status: val('claimStatus') || (claimStatuses()[0] || ''),
    title: val('claimTitle').trim(),
    submittedDate: val('claimSubmittedDate'),
    periodFrom: val('claimPeriodFrom'),
    periodTo: val('claimPeriodTo'),
    reference: val('claimReference').trim(),
    claimedAmount: num('claimedAmount'),
    reimbursedAmount: num('claimReimbursed'),
    remark: val('claimRemark').trim(),
    receiptIds,
    createdAt: new Date().toISOString(),
  };
  database.claims.push(claim);
  syncReceiptLinks(id, receiptIds);
  saveToLocalStorage();
  renderClaims();
  document.getElementById('claimForm').reset();
  buildReceiptChecklist('claimReceiptList', []);
  showToast('Claim saved.', 'success');
}

// ---------- status workflow ----------
export function advanceClaimStatus(id) {
  const c = database.claims.find(x => x.id === id);
  if (!c) return;
  const stages = claimStatuses();
  if (stages.length === 0) return;
  const i = stages.indexOf(c.status);
  c.status = stages[(i + 1) % stages.length]; // cycle to next stage
  saveToLocalStorage();
  renderClaims();
  showToast(`Claim status: ${c.status}`, 'info');
}

// ---------- delete ----------
export function deleteClaim(id) {
  askConfirm('Delete this claim? Linked receipts are kept, only their claim link is removed.', () => {
    syncReceiptLinks(id, []); // clear back-references
    database.claims = database.claims.filter(c => c.id !== id);
    saveToLocalStorage();
    renderClaims();
    showToast('Claim deleted.', 'info');
  });
}

// ---------- edit ----------
export function openEditClaimModal(id) {
  const c = database.claims.find(x => x.id === id);
  if (!c) return;
  document.getElementById('editClaimId').value = c.id;
  document.getElementById('editClaimType').innerHTML = optionList(claimTypes(), c.type);
  document.getElementById('editClaimStatus').innerHTML = optionList(claimStatuses(), c.status);
  document.getElementById('editClaimTitle').value = c.title || '';
  document.getElementById('editClaimSubmittedDate').value = c.submittedDate || '';
  document.getElementById('editClaimPeriodFrom').value = c.periodFrom || '';
  document.getElementById('editClaimPeriodTo').value = c.periodTo || '';
  document.getElementById('editClaimReference').value = c.reference || '';
  document.getElementById('editClaimedAmount').value = (typeof c.claimedAmount === 'number') ? c.claimedAmount : '';
  document.getElementById('editClaimReimbursed').value = (typeof c.reimbursedAmount === 'number') ? c.reimbursedAmount : '';
  document.getElementById('editClaimRemark').value = c.remark || '';
  buildReceiptChecklist('editClaimReceiptList', c.receiptIds || [], c.periodFrom, c.periodTo);
  document.getElementById('editClaimModal').classList.remove('hidden');
}

export function refreshEditClaimReceiptPicker() {
  buildReceiptChecklist('editClaimReceiptList', pickedReceiptIds('editClaimReceiptList'),
    val('editClaimPeriodFrom'), val('editClaimPeriodTo'));
}

export function closeEditClaimModal() {
  document.getElementById('editClaimModal').classList.add('hidden');
}

export function handleEditClaimSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('editClaimId').value;
  const c = database.claims.find(x => x.id === id);
  if (!c) return;
  c.type = document.getElementById('editClaimType').value;
  c.status = document.getElementById('editClaimStatus').value;
  c.title = document.getElementById('editClaimTitle').value.trim();
  c.submittedDate = document.getElementById('editClaimSubmittedDate').value;
  c.periodFrom = document.getElementById('editClaimPeriodFrom').value;
  c.periodTo = document.getElementById('editClaimPeriodTo').value;
  c.reference = document.getElementById('editClaimReference').value.trim();
  c.claimedAmount = parseFloat(document.getElementById('editClaimedAmount').value) || 0;
  c.reimbursedAmount = parseFloat(document.getElementById('editClaimReimbursed').value) || 0;
  c.remark = document.getElementById('editClaimRemark').value.trim();
  c.receiptIds = pickedReceiptIds('editClaimReceiptList');
  syncReceiptLinks(id, c.receiptIds);
  saveToLocalStorage();
  renderClaims();
  closeEditClaimModal();
  showToast('Claim updated.', 'success');
}

// ---------- render: ledger + dashboard ----------
function filteredClaims() {
  const fType = (document.getElementById('claimFilterType') || {}).value || 'ALL';
  const fStat = (document.getElementById('claimFilterStatus') || {}).value || 'ALL';
  return (database.claims || []).filter(c =>
    (fType === 'ALL' || c.type === fType) && (fStat === 'ALL' || c.status === fStat));
}

function renderClaimsLedger(list) {
  const body = document.getElementById('claimsLedgerBody');
  if (!body) return;
  const sorted = [...list].sort((a, b) => new Date(b.submittedDate || b.createdAt) - new Date(a.submittedDate || a.createdAt));
  if (sorted.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="py-6 text-center text-xs text-slate-500 italic">No claims match this filter.</td></tr>';
    return;
  }
  body.innerHTML = sorted.map(c => {
    const claimed = (c.claimedAmount || 0).toFixed(2);
    const reimb = (c.reimbursedAmount || 0).toFixed(2);
    const nReceipts = (c.receiptIds || []).length;
    const badge = `<button onclick="advanceClaimStatus('${c.id}')" title="Click to advance status" class="px-2 py-0.5 rounded border text-[9px] font-bold ${statusStyle(c.status)}">${c.status || '—'}</button>`;
    return `<tr class="hover:bg-gray-900/40 transition">
      <td class="py-2.5 px-4">
        <div class="text-xs font-semibold text-slate-200">${c.title || '(untitled)'}</div>
        <div class="text-[9px] text-slate-500 font-mono">${c.type} ${c.reference ? '· ' + c.reference : ''} ${nReceipts ? '· ' + nReceipts + ' receipt' + (nReceipts > 1 ? 's' : '') : ''}</div>
        ${c.remark ? `<div class="text-[9px] text-slate-400 italic">“${c.remark}”</div>` : ''}
      </td>
      <td class="py-2.5 px-4 font-mono text-[11px] text-slate-400">${c.submittedDate || '—'}</td>
      <td class="py-2.5 px-4 text-right font-mono text-xs text-slate-200">RM ${claimed}</td>
      <td class="py-2.5 px-4 text-right font-mono text-xs text-emerald-400">RM ${reimb}</td>
      <td class="py-2.5 px-4 text-center">${badge}</td>
      <td class="py-2.5 px-4 text-center">
        <div class="flex gap-1 justify-center">
          <button onclick="openEditClaimModal('${c.id}')" class="text-indigo-400 hover:text-indigo-300 p-1"><i class="fa-solid fa-pen-to-square"></i></button>
          <button onclick="deleteClaim('${c.id}')" class="text-rose-500 hover:text-rose-400 p-1"><i class="fa-solid fa-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function renderClaimsDashboard(list) {
  let claimed = 0, reimbursed = 0, outstanding = 0;
  list.forEach(c => {
    const cl = c.claimedAmount || 0, rb = c.reimbursedAmount || 0;
    claimed += cl;
    reimbursed += rb;
    if (!statusStyle(c.status).includes('rose')) outstanding += Math.max(0, cl - rb); // exclude rejected/cancelled
  });
  const set = (id, txt) => { const el = document.getElementById(id); if (el) el.innerText = txt; };
  set('claimKpiClaimed', `RM ${claimed.toFixed(2)}`);
  set('claimKpiReimbursed', `RM ${reimbursed.toFixed(2)}`);
  set('claimKpiOutstanding', `RM ${outstanding.toFixed(2)}`);
  set('claimKpiCount', String(list.length));
}

// Umbrella refresh used by main bootstrap, CRUD, and cloud load.
export function renderClaims() {
  populateClaimDropdowns();
  const list = filteredClaims();
  renderClaimsLedger(list);
  renderClaimsDashboard(list);
  renderClaimCharts(list, statusStyle);
}

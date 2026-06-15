import { database } from './state.js';
import { saveToLocalStorage } from './storage.js';
import { refreshLedgerAndCalculations } from './dashboard.js';
import { showToast } from './ui.js';
import { compressImage, compressForStorage, runOcr, parseReceiptText, learnMerchant,
  aiReviewEnabled, runAiReview, mergeAiReview, AI_REVIEW_THRESHOLD } from './ocr.js';
import { gatewayConfig } from './config.js';

let pending = null; // { blob (hi-res for storage), ocrBlob (<=1MB for OCR), dataUrl, width, height, ocrText }

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function cardOptions() {
  return database.cards.map(c => `<option value="${c.id}">${c.name}${c.last4 ? ` (•••• ${c.last4})` : ''}</option>`).join('');
}
function tagOptions() {
  return (database.settings.internalCategories || []).map(t => `<option value="${t}">${t}</option>`).join('');
}
function categoryOptions(cardId) {
  const card = database.cards.find(c => c.id === cardId);
  return ((card && card.rules) || []).map(r => `<option value="${r.category}">${r.category}</option>`).join('');
}
function claimTypeOptions(selected) {
  return '<option value="">— None —</option>' +
    (database.settings.claimTypes || []).map(t => `<option value="${t}"${t === selected ? ' selected' : ''}>${t}</option>`).join('');
}
function claimStatusOptions(selected) {
  return (database.settings.claimStatuses || []).map(s => `<option value="${s}"${s === selected ? ' selected' : ''}>${s}</option>`).join('');
}
// Color a claim-status badge generically by keyword (mirrors claims.js statusStyle).
function receiptClaimBadge(status) {
  if (!status) return '';
  const s = status.toLowerCase();
  let cls = 'bg-slate-500/10 text-slate-400 border-slate-500/20';
  if (s.includes('reimburs') || s.includes('approved') || s.includes('paid') || s.includes('done')) cls = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
  else if (s.includes('reject') || s.includes('declin') || s.includes('cancel')) cls = 'bg-rose-500/10 text-rose-400 border-rose-500/20';
  else if (s.includes('submit') || s.includes('pending') || s.includes('process') || s.includes('review')) cls = 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20';
  return `<span class="text-[8px] px-1.5 rounded font-bold border ${cls}">${status}</span>`;
}

// ---------- capture + OCR ----------
export async function handleReceiptFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  try {
    // Two copies: a hi-res one to store (sharp on zoom) and a <=1 MB one for OCR.
    const store = await compressForStorage(file);
    const ocr = await compressImage(file);
    pending = { blob: store.blob, ocrBlob: ocr.blob, dataUrl: await blobToDataUrl(store.blob), width: store.width, height: store.height, ocrText: '' };
    document.getElementById('receiptPreview').src = pending.dataUrl;
    document.getElementById('receiptPreviewWrap').hidden = false;
    document.getElementById('receiptSizeInfo').innerText = `${store.width}×${store.height}px · ${(store.blob.size / 1024).toFixed(0)} KB`;
    document.getElementById('receiptOcrStatus').innerText = '';
    document.getElementById('receiptForm').hidden = true;
    showToast('Photo ready. Tap "Scan with OCR".');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

export async function runReceiptOcr() {
  if (!pending) { showToast('Choose or capture a photo first.', 'error'); return; }
  const status = document.getElementById('receiptOcrStatus');
  status.innerText = 'Scanning… this can take a few seconds.';
  try {
    const text = await runOcr(pending.ocrBlob);
    pending.ocrText = text;
    let parsed = parseReceiptText(text);

    // Free, gated AI second opinion for low-confidence scans (Cloudflare Workers AI).
    let aiUsed = false;
    if (text && aiReviewEnabled() && parsed.confidence.overall < AI_REVIEW_THRESHOLD) {
      status.innerText = 'Low confidence — asking AI to double-check…';
      const merged = mergeAiReview(parsed, await runAiReview(text));
      parsed = merged.parsed;
      aiUsed = merged.changed;
    }
    const { merchant, date, total, merchantSource, confidence } = parsed;
    document.getElementById('recCard').innerHTML = cardOptions();
    document.getElementById('recTag').innerHTML = tagOptions();
    document.getElementById('recClaimType').innerHTML = claimTypeOptions();
    document.getElementById('recClaimStatus').innerHTML = claimStatusOptions();
    recCardChange();
    document.getElementById('recMerchant').value = merchant || '';
    document.getElementById('recDate').value = date || new Date().toISOString().slice(0, 10);
    document.getElementById('recTotal').value = total != null ? total.toFixed(2) : '';
    document.getElementById('recOcrText').value = text;
    document.getElementById('receiptForm').hidden = false;
    if (!text) {
      status.innerText = 'No text detected — enter details manually.';
    } else {
      const pct = n => Math.round(n * 100) + '%';
      const src = { learned: 'learned from your past edits', known: 'matched a configured retailer', ai: 'AI extracted', guess: 'best guess', none: 'not found' }[merchantSource] || 'best guess';
      status.innerText = `Scanned (${pct(confidence.overall)} overall)${aiUsed ? ' · AI-assisted' : ''}. Merchant: ${src} (${pct(confidence.merchant)}) · Amount (${pct(confidence.total)}). Please verify below.`;
    }
  } catch (err) {
    status.innerText = '';
    showToast(err.message, 'error');
  }
}

export function recCardChange() {
  document.getElementById('recCategory').innerHTML = categoryOptions(document.getElementById('recCard').value);
}

export async function saveReceipt(e) {
  e.preventDefault();
  if (!pending) { showToast('Nothing to save.', 'error'); return; }
  const { base, token } = gatewayConfig();
  if (!base || !token) { showToast('Set the gateway URL and access token in the Koofr Sync tab first.', 'error'); return; }

  const id = 'rcpt-' + Date.now() + Math.random().toString(36).slice(2, 6);
  try {
    const res = await fetch(`${base}/receipt/${id}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'image/jpeg' },
      body: pending.blob,
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Upload failed (${res.status})`); }
  } catch (err) {
    showToast(`Image upload failed: ${err.message}`, 'error');
    return;
  }

  const merchant = document.getElementById('recMerchant').value.trim();
  const date = document.getElementById('recDate').value;
  const total = parseFloat(document.getElementById('recTotal').value) || 0;
  const currency = document.getElementById('recCurrency').value.trim() || 'MYR';
  const cardId = document.getElementById('recCard').value;
  const category = document.getElementById('recCategory').value;
  const internalTag = document.getElementById('recTag').value;
  const remark = document.getElementById('recRemark').value.trim();
  const claimType = document.getElementById('recClaimType').value;
  const claimStatus = document.getElementById('recClaimStatus').value;
  const alsoLog = document.getElementById('recAlsoLog').checked;

  let txId = null;
  if (alsoLog && total > 0 && cardId) {
    txId = 'tx-' + Date.now();
    database.transactions.push({ id: txId, date, cardId, category, internalTag, description: merchant || 'Receipt', amount: total, remark, receiptId: id });
  }
  database.receipts.push({
    id, createdAt: new Date().toISOString(), merchant, date, total, currency,
    cardId, category, internalTag, remark, claimType, claimStatus, txId, ocrText: pending.ocrText || '', imagePath: `receipt/${id}`, bytes: pending.blob.size,
  });

  // Self-learning: remember the merchant the user confirmed for these receipt tokens.
  learnMerchant(pending.ocrText, merchant);

  saveToLocalStorage();
  refreshLedgerAndCalculations();
  renderReceipts();

  pending = null;
  const form = document.getElementById('receiptForm');
  form.reset();
  form.hidden = true;
  document.getElementById('receiptPreviewWrap').hidden = true;
  document.getElementById('receiptFile').value = '';
  document.getElementById('receiptOcrStatus').innerText = '';
  showToast(txId ? 'Receipt saved and added to ledger.' : 'Receipt saved.', 'success');
}

// ---------- list + filter ----------
function populateReceiptFilter() {
  const el = document.getElementById('receiptFilterYear');
  if (!el) return;
  const years = new Set([String(new Date().getFullYear())]);
  (database.receipts || []).forEach(r => { if (r.date && r.date.length >= 4) years.add(r.date.slice(0, 4)); });
  const prev = el.value || 'ALL';
  el.innerHTML = '<option value="ALL">All Years</option>' + [...years].sort().reverse().map(y => `<option value="${y}">${y}</option>`).join('');
  el.value = [...el.options].some(o => o.value === prev) ? prev : 'ALL';
}

export function renderReceipts() {
  const list = document.getElementById('receiptsList');
  if (!list) return;
  const aiToggle = document.getElementById('aiReviewToggle');
  if (aiToggle) aiToggle.checked = aiReviewEnabled();
  populateReceiptFilter();
  const fy = (document.getElementById('receiptFilterYear') || {}).value || 'ALL';
  const fm = (document.getElementById('receiptFilterMonth') || {}).value || 'ALL';

  // A selected calendar day overrides the year/month dropdown filter.
  const items = [...(database.receipts || [])]
    .filter(r => {
      if (selectedDay) return r.date === selectedDay;
      const y = (r.date || '').slice(0, 4), m = (r.date || '').slice(5, 7);
      return (fy === 'ALL' || y === fy) && (fm === 'ALL' || m === fm);
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  renderReceiptCalendar();
  renderDayKpi(items);

  if (items.length === 0) {
    list.innerHTML = '<p class="text-xs text-slate-500 italic text-center py-4">No receipts for this period.</p>';
    return;
  }
  list.innerHTML = items.map(r => {
    const amt = (typeof r.total === 'number') ? r.total.toFixed(2) : (r.total || '');
    const linked = r.txId ? '<span class="text-[8px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 rounded font-bold">Ledger</span>' : '';
    const claimBadge = receiptClaimBadge(r.claimStatus);
    const claimedBadge = r.claimId ? '<span class="text-[8px] bg-violet-500/10 text-violet-300 border border-violet-500/20 px-1.5 rounded font-bold">Claimed</span>' : '';
    const remark = r.remark ? `<div class="text-[10px] text-slate-400 italic truncate">“${r.remark}”</div>` : '';
    return `
      <div class="flex items-center justify-between gap-3 p-3 bg-gray-950/40 border border-gray-800/60 rounded-xl">
        <div class="min-w-0">
          <div class="text-xs font-bold text-slate-200 truncate flex items-center gap-1.5">${r.merchant || '(no merchant)'} ${linked} ${claimBadge} ${claimedBadge}</div>
          <div class="text-[10px] text-slate-500 font-mono">${r.date || ''} · ${r.currency || ''} ${amt} · ${(r.bytes / 1024).toFixed(0)} KB</div>
          ${remark}
        </div>
        <div class="flex gap-1.5 shrink-0">
          <button onclick="viewReceipt('${r.id}')" class="text-indigo-400 hover:text-indigo-300 p-1.5 bg-indigo-500/10 rounded transition" title="View image"><i class="fa-solid fa-eye"></i></button>
          <button onclick="editReceipt('${r.id}')" class="text-amber-400 hover:text-amber-300 p-1.5 bg-amber-500/10 rounded transition" title="Edit"><i class="fa-solid fa-pen-to-square"></i></button>
          <button onclick="deleteReceipt('${r.id}')" class="text-rose-500 hover:text-rose-400 p-1.5 bg-rose-500/10 rounded transition" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>`;
  }).join('');
}

export async function viewReceipt(id) {
  const { base, token } = gatewayConfig();
  if (!base || !token) { showToast('Set the gateway URL and access token first.', 'error'); return; }
  try {
    const res = await fetch(`${base}/receipt/${id}`, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) throw new Error(`Not found (${res.status})`);
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    showToast(`Could not load receipt: ${err.message}`, 'error');
  }
}

// ---------- edit ----------
export function editReceipt(id) {
  const r = (database.receipts || []).find(x => x.id === id);
  if (!r) return;
  document.getElementById('editRecId').value = r.id;
  document.getElementById('editRecCard').innerHTML = cardOptions();
  document.getElementById('editRecCard').value = r.cardId || '';
  document.getElementById('editRecTag').innerHTML = tagOptions();
  document.getElementById('editRecTag').value = r.internalTag || '';
  editRecCardChange();
  document.getElementById('editRecCategory').value = r.category || '';
  document.getElementById('editRecMerchant').value = r.merchant || '';
  document.getElementById('editRecDate').value = r.date || '';
  document.getElementById('editRecTotal').value = (typeof r.total === 'number') ? r.total : '';
  document.getElementById('editRecCurrency').value = r.currency || 'MYR';
  document.getElementById('editRecRemark').value = r.remark || '';
  document.getElementById('editRecClaimType').innerHTML = claimTypeOptions(r.claimType || '');
  document.getElementById('editRecClaimStatus').innerHTML = claimStatusOptions(r.claimStatus || '');
  const wrap = document.getElementById('editRecLinkWrap');
  const cb = document.getElementById('editRecApplyTx');
  if (r.txId) { wrap.classList.remove('hidden'); cb.checked = true; } else { wrap.classList.add('hidden'); cb.checked = false; }
  document.getElementById('editReceiptModal').classList.remove('hidden');
}

export function editRecCardChange() {
  document.getElementById('editRecCategory').innerHTML = categoryOptions(document.getElementById('editRecCard').value);
}

export function closeEditReceipt() {
  document.getElementById('editReceiptModal').classList.add('hidden');
}

export function handleReceiptEditSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('editRecId').value;
  const r = (database.receipts || []).find(x => x.id === id);
  if (!r) return;
  r.merchant = document.getElementById('editRecMerchant').value.trim();
  r.date = document.getElementById('editRecDate').value;
  r.total = parseFloat(document.getElementById('editRecTotal').value) || 0;
  r.currency = document.getElementById('editRecCurrency').value.trim() || 'MYR';
  r.cardId = document.getElementById('editRecCard').value;
  r.category = document.getElementById('editRecCategory').value;
  r.internalTag = document.getElementById('editRecTag').value;
  r.remark = document.getElementById('editRecRemark').value.trim();
  r.claimType = document.getElementById('editRecClaimType').value;
  r.claimStatus = document.getElementById('editRecClaimStatus').value;

  // Self-learning: a correction here is the strongest signal of the right merchant.
  learnMerchant(r.ocrText, r.merchant);

  if (r.txId && document.getElementById('editRecApplyTx').checked) {
    const tx = database.transactions.find(t => t.id === r.txId);
    if (tx) {
      tx.date = r.date; tx.amount = r.total; tx.cardId = r.cardId;
      tx.category = r.category; tx.internalTag = r.internalTag;
      tx.description = r.merchant || 'Receipt'; tx.remark = r.remark;
    }
  }

  saveToLocalStorage();
  refreshLedgerAndCalculations();
  renderReceipts();
  closeEditReceipt();
  showToast('Receipt updated.', 'success');
}

// ---------- delete (modal, with image removal + optional tx) ----------
export function deleteReceipt(id) {
  const r = (database.receipts || []).find(x => x.id === id);
  if (!r) return;
  document.getElementById('deleteRecId').value = id;
  const wrap = document.getElementById('deleteRecLinkWrap');
  const cb = document.getElementById('deleteRecAlsoTx');
  cb.checked = false;
  if (r.txId) wrap.classList.remove('hidden'); else wrap.classList.add('hidden');
  document.getElementById('deleteReceiptModal').classList.remove('hidden');
}

export function closeDeleteReceipt() {
  document.getElementById('deleteReceiptModal').classList.add('hidden');
}

export async function confirmDeleteReceipt() {
  const id = document.getElementById('deleteRecId').value;
  const r = (database.receipts || []).find(x => x.id === id);
  const alsoTx = document.getElementById('deleteRecAlsoTx').checked;
  const { base, token } = gatewayConfig();

  if (base && token) {
    try {
      const res = await fetch(`${base}/receipt/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `status ${res.status}`); }
    } catch (err) {
      showToast(`Image delete failed (record still removed): ${err.message}`, 'error');
    }
  } else {
    showToast('Gateway not set — removed record only; image remains in Koofr.', 'error');
  }

  database.receipts = (database.receipts || []).filter(x => x.id !== id);
  if (r && r.txId) {
    if (alsoTx) database.transactions = database.transactions.filter(t => t.id !== r.txId);
    else database.transactions.forEach(t => { if (t.id === r.txId) delete t.receiptId; });
  }

  saveToLocalStorage();
  refreshLedgerAndCalculations();
  renderReceipts();
  closeDeleteReceipt();
  showToast('Receipt deleted.', 'success');
}

// ---------- calendar view + day drill-down ----------
let selectedDay = null; // 'YYYY-MM-DD' when a calendar day is focused, else null

// The calendar follows the year/month filter dropdowns (single source of truth).
function calYearMonth() {
  const now = new Date();
  let y = (document.getElementById('receiptFilterYear') || {}).value || 'ALL';
  let m = (document.getElementById('receiptFilterMonth') || {}).value || 'ALL';
  if (y === 'ALL') y = String(now.getFullYear());
  if (m === 'ALL') m = String(now.getMonth() + 1).padStart(2, '0');
  return { y: parseInt(y, 10), m: parseInt(m, 10) }; // m is 1-12
}

// Clear the day drill-down whenever the year/month filter changes.
export function onReceiptFilterChange() {
  selectedDay = null;
  renderReceipts();
}

export function receiptCalShift(delta) {
  selectedDay = null;
  const { y, m } = calYearMonth();
  const d = new Date(y, m - 1 + delta, 1);
  const ny = String(d.getFullYear());
  const nm = String(d.getMonth() + 1).padStart(2, '0');
  const ySel = document.getElementById('receiptFilterYear');
  if (ySel) {
    if (![...ySel.options].some(o => o.value === ny)) ySel.add(new Option(ny, ny));
    ySel.value = ny;
  }
  const mSel = document.getElementById('receiptFilterMonth');
  if (mSel) mSel.value = nm;
  renderReceipts();
}

export function selectReceiptDay(dateStr) {
  selectedDay = (selectedDay === dateStr) ? null : dateStr; // toggle off if re-clicked
  renderReceipts();
}

export function clearReceiptDay() {
  selectedDay = null;
  renderReceipts();
}

export function renderReceiptCalendar() {
  const grid = document.getElementById('receiptCalendarGrid');
  if (!grid) return;
  const { y, m } = calYearMonth();
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const label = document.getElementById('receiptCalendarLabel');
  if (label) label.innerText = `${monthNames[m - 1]} ${y}`;

  // Aggregate this month's receipts by day.
  const byDay = {}; // 'YYYY-MM-DD' -> { count, total }
  (database.receipts || []).forEach(r => {
    if (!r.date) return;
    if (parseInt(r.date.slice(0, 4), 10) !== y || parseInt(r.date.slice(5, 7), 10) !== m) return;
    const e = byDay[r.date] || { count: 0, total: 0 };
    e.count += 1;
    e.total += (typeof r.total === 'number') ? r.total : 0;
    byDay[r.date] = e;
  });

  const firstDow = new Date(y, m - 1, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(y, m, 0).getDate();
  const dow = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  let html = dow.map(d => `<div class="text-center text-[9px] font-bold text-slate-500 py-1">${d}</div>`).join('');
  for (let i = 0; i < firstDow; i++) html += '<div></div>';
  for (let day = 1; day <= daysInMonth; day++) {
    const ds = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const info = byDay[ds];
    const isSel = selectedDay === ds;
    const base = 'rounded-lg p-1.5 text-center transition border min-h-[3rem] flex flex-col justify-between';
    let cls, click = '';
    if (info) {
      click = `onclick="selectReceiptDay('${ds}')"`;
      cls = isSel
        ? `${base} cursor-pointer bg-indigo-600 border-indigo-400 text-white ring-2 ring-indigo-400`
        : `${base} cursor-pointer bg-indigo-500/10 border-indigo-500/30 hover:border-indigo-400 text-slate-200`;
    } else {
      cls = `${base} border-gray-800/40 text-slate-600`;
    }
    const meta = info
      ? `<div class="text-[8px] font-bold leading-tight">${info.count}×</div><div class="text-[8px] font-mono leading-tight">${info.total.toFixed(0)}</div>`
      : '';
    html += `<div ${click} class="${cls}"><div class="text-[10px] font-semibold">${day}</div>${meta}</div>`;
  }
  grid.innerHTML = html;
}

function renderDayKpi(items) {
  const panel = document.getElementById('receiptDayKpi');
  if (!panel) return;
  if (!selectedDay) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }

  let total = 0, claimed = 0, unclaimed = 0;
  const byCat = {};
  items.forEach(r => {
    const amt = (typeof r.total === 'number') ? r.total : 0;
    total += amt;
    if (r.claimId || r.claimStatus) claimed += amt; else unclaimed += amt;
    const k = r.internalTag || r.category || 'Uncategorized';
    byCat[k] = (byCat[k] || 0) + amt;
  });
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<span class="text-[9px] bg-gray-950/60 border border-gray-800 rounded px-1.5 py-0.5 text-slate-300">${k}: RM ${v.toFixed(2)}</span>`).join(' ');

  panel.classList.remove('hidden');
  panel.innerHTML = `
    <div class="flex items-center justify-between gap-2 mb-2">
      <h4 class="text-xs font-bold text-indigo-300"><i class="fa-solid fa-calendar-day mr-1"></i>${selectedDay}</h4>
      <button onclick="clearReceiptDay()" class="text-[10px] text-slate-400 hover:text-slate-200"><i class="fa-solid fa-xmark mr-0.5"></i>Clear</button>
    </div>
    <div class="grid grid-cols-3 gap-2 mb-2">
      <div class="bg-gray-950/60 border border-gray-800 rounded-lg p-2 text-center"><div class="text-[8px] uppercase text-slate-500">Receipts</div><div class="text-sm font-bold text-slate-100">${items.length}</div></div>
      <div class="bg-gray-950/60 border border-gray-800 rounded-lg p-2 text-center"><div class="text-[8px] uppercase text-slate-500">Total</div><div class="text-sm font-bold text-emerald-400 font-mono">RM ${total.toFixed(2)}</div></div>
      <div class="bg-gray-950/60 border border-gray-800 rounded-lg p-2 text-center"><div class="text-[8px] uppercase text-slate-500">Claimed/Not</div><div class="text-[11px] font-bold text-slate-200 font-mono">${claimed.toFixed(0)}/${unclaimed.toFixed(0)}</div></div>
    </div>
    <div class="flex flex-wrap gap-1">${cats}</div>`;
}

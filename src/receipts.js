import { database } from './state.js';
import { saveToLocalStorage } from './storage.js';
import { refreshLedgerAndCalculations } from './dashboard.js';
import { askConfirm, showToast } from './ui.js';
import { compressImage, runOcr, parseReceiptText } from './ocr.js';
import { gatewayConfig } from './config.js';

let pending = null; // { blob, dataUrl, width, height, ocrText }

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

export async function handleReceiptFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  try {
    const { blob, width, height } = await compressImage(file);
    pending = { blob, dataUrl: await blobToDataUrl(blob), width, height, ocrText: '' };
    document.getElementById('receiptPreview').src = pending.dataUrl;
    document.getElementById('receiptPreviewWrap').hidden = false;
    document.getElementById('receiptSizeInfo').innerText = `${width}×${height}px · ${(blob.size / 1024).toFixed(0)} KB`;
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
    const text = await runOcr(pending.blob);
    pending.ocrText = text;
    const { merchant, date, total, merchantSource } = parseReceiptText(text);
    populateReceiptSelects();
    document.getElementById('recMerchant').value = merchant || '';
    document.getElementById('recDate').value = date || new Date().toISOString().slice(0, 10);
    document.getElementById('recTotal').value = total != null ? total.toFixed(2) : '';
    document.getElementById('recOcrText').value = text;
    document.getElementById('receiptForm').hidden = false;
    if (!text) {
      status.innerText = 'No text detected — enter details manually.';
    } else if (merchantSource === 'known') {
      status.innerText = 'Scanned. Merchant matched a configured retailer ✓ — review the rest.';
    } else {
      status.innerText = 'Scanned. Merchant is a best guess — please verify the fields below.';
    }
  } catch (err) {
    status.innerText = '';
    showToast(err.message, 'error');
  }
}

function populateReceiptSelects() {
  const cardSel = document.getElementById('recCard');
  cardSel.innerHTML = database.cards.map(c => `<option value="${c.id}">${c.name}${c.last4 ? ` (•••• ${c.last4})` : ''}</option>`).join('');
  const tagSel = document.getElementById('recTag');
  tagSel.innerHTML = (database.settings.internalCategories || []).map(t => `<option value="${t}">${t}</option>`).join('');
  recCardChange();
}

export function recCardChange() {
  const cardId = document.getElementById('recCard').value;
  const card = database.cards.find(c => c.id === cardId);
  const catSel = document.getElementById('recCategory');
  catSel.innerHTML = ((card && card.rules) || []).map(r => `<option value="${r.category}">${r.category}</option>`).join('');
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
  const alsoLog = document.getElementById('recAlsoLog').checked;

  let txId = null;
  if (alsoLog && total > 0 && cardId) {
    txId = 'tx-' + Date.now();
    database.transactions.push({ id: txId, date, cardId, category, internalTag, description: merchant || 'Receipt', amount: total, receiptId: id });
  }
  database.receipts.push({
    id, createdAt: new Date().toISOString(), merchant, date, total, currency,
    cardId, category, internalTag, txId, ocrText: pending.ocrText || '', imagePath: `receipt/${id}`, bytes: pending.blob.size,
  });

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

export function renderReceipts() {
  const list = document.getElementById('receiptsList');
  if (!list) return;
  const items = [...(database.receipts || [])].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (items.length === 0) {
    list.innerHTML = '<p class="text-xs text-slate-500 italic text-center py-4">No receipts captured yet.</p>';
    return;
  }
  list.innerHTML = items.map(r => {
    const amt = (typeof r.total === 'number') ? r.total.toFixed(2) : (r.total || '');
    const linked = r.txId ? '<span class="text-[8px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 rounded font-bold">Ledger</span>' : '';
    return `
      <div class="flex items-center justify-between gap-3 p-3 bg-gray-950/40 border border-gray-800/60 rounded-xl">
        <div class="min-w-0">
          <div class="text-xs font-bold text-slate-200 truncate flex items-center gap-1.5">${r.merchant || '(no merchant)'} ${linked}</div>
          <div class="text-[10px] text-slate-500 font-mono">${r.date || ''} · ${r.currency || ''} ${amt} · ${(r.bytes / 1024).toFixed(0)} KB</div>
        </div>
        <div class="flex gap-1.5 shrink-0">
          <button onclick="viewReceipt('${r.id}')" class="text-indigo-400 hover:text-indigo-300 p-1.5 bg-indigo-500/10 rounded transition"><i class="fa-solid fa-eye"></i></button>
          <button onclick="deleteReceipt('${r.id}')" class="text-rose-500 hover:text-rose-400 p-1.5 bg-rose-500/10 rounded transition"><i class="fa-solid fa-trash"></i></button>
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

export function deleteReceipt(id) {
  askConfirm('Delete this receipt record? (The stored image in Koofr is left in place.)', () => {
    database.receipts = (database.receipts || []).filter(r => r.id !== id);
    database.transactions.forEach(t => { if (t.receiptId === id) delete t.receiptId; });
    saveToLocalStorage();
    renderReceipts();
    showToast('Receipt record removed.');
  });
}

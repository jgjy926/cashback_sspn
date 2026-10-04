// Statement import: screenshot of a bank / card app's transaction history -> any AI
// (Claude, ChatGPT, Gemini…) returns JSON -> review -> commit to the CC ledger.
//
// Flow inside one modal:
//  1. Pick the card the rows belong to. The prompt is rebuilt with that card's cashback
//     categories (+ eligible merchants) so the AI can classify each row.
//  2. Copy the prompt, attach the screenshot(s) in the AI chat, paste the JSON reply back.
//  3. Review: every row gets an include tick, editable category / tag. Credits (refunds,
//     incoming transfers) and rows already in the ledger start unticked.
//  4. Commit pushes the ticked rows into database.transactions.
import { refreshLedgerAndCalculations } from './dashboard.js';
import { database } from './state.js';
import { saveToLocalStorage } from './storage.js';
import { showToast } from './ui.js';
import { parseEnrichedJson } from './enrich.js';

const IMPORT_TYPE = 'statement-transactions';
const BTN = 'font-bold py-2 px-3 rounded-xl text-[11px] uppercase tracking-wider transition';
const INPUT = 'bg-gray-900 border border-gray-800 rounded-lg px-2 py-1 text-[11px] text-slate-100 focus:outline-none focus:border-indigo-500';
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');

// ---------- prompt ----------

function buildStatementPrompt(card) {
  const rules = (card.rules || []).map(r => ({ category: r.category, merchants: r.merchants || '' }));
  const tags = database.settings.internalCategories || [];
  const schema = {
    type: IMPORT_TYPE,
    records: [{ date: 'YYYY-MM-DD', time: 'HH:MM:SS', description: '', amount: 0, direction: 'debit', category: '', internalTag: '', note: '' }],
  };
  return [
    `The attached image(s) are screenshots of a banking / credit card app's transaction history for my card "${card.name}"${card.last4 ? ` (ending ${card.last4})` : ''}.`,
    'Extract EVERY transaction row visible, in the order shown.',
    '',
    'For each row:',
    '- "date": the row\'s date as YYYY-MM-DD (rows sit under date headers such as "04 OCT 2026").',
    '- "time": as shown, converted to 24-hour HH:MM:SS, or "" if not visible.',
    '- "description": the merchant / description text exactly as shown, joined onto one line.',
    '- "amount": a positive number without currency or thousands separators (e.g. 1122.00).',
    '- "direction": "debit" for spending (usually shown with a minus sign / red), "credit" for money in, refunds or payments (usually green / no minus).',
    '- "category": the best match from the card\'s cashback categories below. Use the merchant lists as hints; when nothing fits, pick the generic / "other spending" one.',
    `- "internalTag": one of ${JSON.stringify(tags)}.`,
    '- "note": "" normally; describe it briefly if part of the row is cut off, blurred or covered by glare, so I can double-check it.',
    'Skip rows that are cut off so badly that the amount is unreadable, and mention them in a note on the nearest row instead.',
    '',
    `Card cashback categories:\n${JSON.stringify(rules, null, 1)}`,
    '',
    'Rules for your reply:',
    '- Reply with ONLY the JSON object, in a single ```json code block, with no other text.',
    '- It must be strictly valid JSON. Never put a double quote (") inside a string value — use single quotes (\') instead.',
    '',
    `Reply shape:\n\`\`\`json\n${JSON.stringify(schema, null, 1)}\n\`\`\``,
  ].join('\n');
}

// ---------- normalising what the AI returns ----------

// Accepts YYYY-MM-DD, "04 OCT 2026", "4 Oct 26", DD/MM/YYYY (Malaysian order).
function normDate(v) {
  const s = String(v ?? '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = /^(\d{1,2})[\s-]+([A-Za-z]{3})[A-Za-z]*[\s-]+(\d{2,4})$/.exec(s);
  if (m && MONTHS[m[2].toUpperCase()]) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${pad(MONTHS[m[2].toUpperCase()])}-${pad(m[1])}`;
  }
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/.exec(s);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return '';
}

// "- RM 1,122.00" -> { value: 1122, negative: true }
function normAmount(v) {
  if (typeof v === 'number') return { value: Math.abs(v), negative: v < 0 };
  const s = String(v ?? '');
  const n = parseFloat(s.replace(/[^0-9.]/g, ''));
  return { value: isFinite(n) ? n : NaN, negative: /-/.test(s) };
}

// Map whatever category the AI chose onto one of the card's rules: exact (case-insensitive)
// name, then a merchant-list keyword hit, then the card's generic "other" rule.
function resolveCategory(card, aiCat, description) {
  const rules = card.rules || [];
  if (!rules.length) return '';
  const want = String(aiCat || '').trim().toLowerCase();
  const exact = rules.find(r => r.category.toLowerCase() === want);
  if (exact) return exact.category;
  const desc = String(description || '').toLowerCase();
  const byMerchant = rules.find(r => (r.merchants || '').split(',')
    .map(x => x.trim().toLowerCase()).filter(x => x.length >= 3).some(x => desc.includes(x)));
  if (byMerchant) return byMerchant.category;
  const other = rules.find(r => /other/i.test(r.category) || (r.standardCategories || []).some(c => /other/i.test(c)));
  return (other || rules[rules.length - 1]).category;
}

function resolveTag(aiTag, card, category) {
  const tags = database.settings.internalCategories || [];
  const hit = tags.find(t => t.toLowerCase() === String(aiTag || '').trim().toLowerCase());
  if (hit) return hit;
  const rule = (card.rules || []).find(r => r.category === category);
  const std = (rule?.standardCategories || []).find(c => tags.includes(c));
  return std || tags[0] || '';
}

const sameCents = (a, b) => Math.round(a * 100) === Math.round(b * 100);

// Turn the parsed reply into review rows for the chosen card.
function toRows(data, card) {
  const list = Array.isArray(data) ? data : data?.records || data?.transactions;
  if (!Array.isArray(list)) throw new Error('Expected a JSON object with a "records" array.');
  if (data?.type && data.type !== IMPORT_TYPE) throw new Error(`Expected type "${IMPORT_TYPE}", got "${data.type}".`);
  const seen = new Set();
  return list.filter(r => r && typeof r === 'object').map(r => {
    const date = normDate(r.date);
    const amt = normAmount(r.amount);
    const description = String(r.description || r.merchant || '').replace(/\s+/g, ' ').trim();
    // No direction given -> treat as spending; that is what nearly every row is.
    const credit = /credit|refund|incoming|money in/.test(String(r.direction || '').toLowerCase());
    const category = resolveCategory(card, r.category, description);
    const flags = [];
    if (!date) flags.push('bad date');
    if (!(amt.value > 0)) flags.push('bad amount');
    if (credit) flags.push('credit / money in');
    const dup = date && database.transactions.some(t => t.cardId === card.id && t.date === date && sameCents(+t.amount, amt.value));
    if (dup) flags.push('already in ledger');
    const key = `${date}|${amt.value}|${description}|${r.time || ''}`;
    if (seen.has(key)) flags.push('repeated in this reply');
    seen.add(key);
    return {
      include: flags.length === 0,
      date, time: String(r.time || '').trim(), description,
      amount: amt.value, credit, category,
      internalTag: resolveTag(r.internalTag, card, category),
      note: String(r.note || '').trim(), flags,
    };
  });
}

// ---------- modal ----------

export function openStatementImport() {
  if (!database.cards.length) return showToast('Add a card first (Card Manager).', 'error');
  document.getElementById('statementPanel')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'statementPanel';
  wrap.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4';
  wrap.innerHTML = `
    <div class="glass-card bg-gray-950 border border-gray-800 rounded-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto p-5 space-y-4">
      <div class="flex items-center justify-between gap-3">
        <h3 class="text-sm font-bold text-slate-100"><i class="fa-solid fa-camera-retro mr-1 text-indigo-400"></i>Import transactions from a screenshot</h3>
        <button data-act="close" class="text-slate-400 hover:text-white text-lg leading-none" aria-label="Close">&times;</button>
      </div>

      <div class="space-y-1">
        <label class="text-[11px] font-bold uppercase tracking-wider text-slate-400" for="stmtCard">1 · Card these transactions belong to</label>
        <select id="stmtCard" data-el="card" class="w-full bg-gray-900 border border-gray-800 rounded-xl px-3 py-2.5 text-xs text-slate-100 focus:outline-none focus:border-indigo-500">
          ${database.cards.map(c => `<option value="${esc(c.id)}">${esc(c.name)}${c.last4 ? ` (•••• ${esc(c.last4)})` : ''}</option>`).join('')}
        </select>
      </div>

      <div class="space-y-2 border-t border-gray-800 pt-4">
        <p class="text-[11px] font-bold uppercase tracking-wider text-slate-400">2 · Copy the prompt, attach your screenshot(s) in Claude / any AI</p>
        <textarea data-el="prompt" readonly rows="5" class="w-full bg-gray-900 border border-gray-800 rounded-xl p-3 text-[11px] font-mono text-slate-300 focus:outline-none"></textarea>
        <div class="flex justify-end">
          <button data-act="copy" class="${BTN} bg-indigo-600 hover:bg-indigo-500 text-white"><i class="fa-solid fa-copy mr-1"></i>Copy prompt</button>
        </div>
      </div>

      <div class="space-y-2 border-t border-gray-800 pt-4">
        <p class="text-[11px] font-bold uppercase tracking-wider text-slate-400">3 · Paste the AI’s JSON reply</p>
        <textarea data-el="reply" rows="6" placeholder="Paste the whole reply — code fences and extra text are fine." class="w-full bg-gray-900 border border-gray-800 rounded-xl p-3 text-[11px] font-mono text-slate-100 focus:outline-none focus:border-indigo-500"></textarea>
        <p data-el="error" class="hidden text-[11px] text-rose-400 break-words"></p>
        <div class="flex flex-wrap justify-end gap-2">
          <label class="${BTN} bg-gray-900 border border-gray-800 hover:border-indigo-500 text-slate-200 cursor-pointer"><i class="fa-solid fa-file-code mr-1"></i>Load .json<input type="file" accept=".json,application/json,text/plain" data-el="file" class="hidden"></label>
          <button data-act="paste" class="${BTN} bg-gray-900 border border-gray-800 hover:border-indigo-500 text-slate-200"><i class="fa-solid fa-paste mr-1"></i>Paste from clipboard</button>
          <button data-act="parse" class="${BTN} bg-indigo-600 hover:bg-indigo-500 text-white"><i class="fa-solid fa-table-list mr-1"></i>Parse</button>
        </div>
      </div>

      <div data-el="review" class="hidden space-y-2 border-t border-gray-800 pt-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-[11px] font-bold uppercase tracking-wider text-slate-400">4 · Review &amp; commit</p>
          <span data-el="summary" class="text-[11px] text-slate-400"></span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-[11px] text-slate-300 border-collapse">
            <thead class="text-[10px] uppercase tracking-wider text-slate-500 border-b border-gray-800">
              <tr><th class="py-2 px-1"><input type="checkbox" data-el="all" aria-label="Select all"></th><th class="py-2 px-1">Date</th><th class="py-2 px-1">Description</th><th class="py-2 px-1 text-right">Amount</th><th class="py-2 px-1">Category</th><th class="py-2 px-1">Tag</th></tr>
            </thead>
            <tbody data-el="rows" class="divide-y divide-gray-800/60"></tbody>
          </table>
        </div>
        <div class="flex justify-end">
          <button data-act="commit" class="${BTN} bg-emerald-600 hover:bg-emerald-500 text-white"><i class="fa-solid fa-check mr-1"></i>Commit to ledger</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const $ = sel => wrap.querySelector(`[data-el="${sel}"]`);
  const cardEl = $('card'), promptEl = $('prompt'), replyEl = $('reply'), errEl = $('error');
  const showError = msg => { errEl.textContent = msg; errEl.classList.toggle('hidden', !msg); };
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  // Default to the card currently picked in Quick Log, if any.
  const quickCard = document.getElementById('txCard')?.value;
  if (quickCard && database.cards.some(c => c.id === quickCard)) cardEl.value = quickCard;

  let rows = [];
  const card = () => database.cards.find(c => c.id === cardEl.value);

  function renderRows() {
    const c = card();
    const tags = database.settings.internalCategories || [];
    const opts = (list, sel) => list.map(v => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(v)}</option>`).join('');
    $('rows').innerHTML = rows.map((r, i) => `
      <tr class="${r.include ? '' : 'opacity-60'}">
        <td class="py-2 px-1 align-top"><input type="checkbox" data-i="${i}" data-f="include"${r.include ? ' checked' : ''}${r.date && r.amount > 0 ? '' : ' disabled'}></td>
        <td class="py-2 px-1 align-top whitespace-nowrap">${esc(r.date || '—')}<div class="text-[10px] text-slate-500">${esc(r.time)}</div></td>
        <td class="py-2 px-1 align-top min-w-[10rem]">${esc(r.description)}
          ${r.note ? `<div class="text-[10px] text-amber-300"><i class="fa-solid fa-circle-info mr-1"></i>${esc(r.note)}</div>` : ''}
          ${r.flags.length ? `<div class="text-[10px] text-rose-300">${r.flags.map(esc).join(' · ')}</div>` : ''}</td>
        <td class="py-2 px-1 align-top text-right whitespace-nowrap ${r.credit ? 'text-emerald-400' : 'text-slate-100'}">${r.credit ? '+' : ''}${isFinite(r.amount) ? r.amount.toFixed(2) : '?'}</td>
        <td class="py-2 px-1 align-top"><select data-i="${i}" data-f="category" class="${INPUT}">${opts((c.rules || []).map(x => x.category), r.category)}</select></td>
        <td class="py-2 px-1 align-top"><select data-i="${i}" data-f="internalTag" class="${INPUT}">${opts(tags, r.internalTag)}</select></td>
      </tr>`).join('');
    const picked = rows.filter(r => r.include);
    const total = picked.reduce((s, r) => s + r.amount, 0);
    $('summary').textContent = `${picked.length} of ${rows.length} selected · RM ${total.toFixed(2)}`;
    $('all').checked = rows.length > 0 && picked.length === rows.filter(r => r.date && r.amount > 0).length;
    $('review').classList.toggle('hidden', !rows.length);
  }

  function parseReply() {
    showError('');
    try {
      rows = toRows(parseEnrichedJson(replyEl.value), card());
      if (!rows.length) throw new Error('The reply has no transactions in it.');
    } catch (err) { rows = []; showError(err.message); }
    renderRows();
  }

  function setCard() {
    promptEl.value = buildStatementPrompt(card());
    if (rows.length) parseReply();   // re-resolve categories + duplicates for the new card
  }

  cardEl.addEventListener('change', setCard);

  wrap.addEventListener('change', e => {
    if (e.target === $('all')) {
      rows.forEach(r => { if (r.date && r.amount > 0) r.include = e.target.checked; });
      return renderRows();
    }
    if (e.target === $('file')) {
      const f = e.target.files?.[0];
      if (!f) return;
      f.text().then(t => { replyEl.value = t; e.target.value = ''; parseReply(); });
      return;
    }
    const i = e.target.dataset.i, f = e.target.dataset.f;
    if (i == null || !f) return;
    rows[i][f] = f === 'include' ? e.target.checked : e.target.value;
    renderRows();
  });

  wrap.addEventListener('click', async e => {
    if (e.target === wrap) return close();
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') close();
    if (act === 'copy') {
      try { await navigator.clipboard.writeText(promptEl.value); showToast('Prompt copied — paste it into the AI with your screenshot.', 'success'); }
      catch {
        promptEl.focus(); promptEl.select();
        let ok = false; try { ok = document.execCommand('copy'); } catch {}
        showToast(ok ? 'Prompt copied.' : 'Copy failed — select the text and copy it manually.', ok ? 'success' : 'error');
      }
    }
    if (act === 'paste') {
      try { replyEl.value = await navigator.clipboard.readText(); parseReply(); }
      catch { showToast('Clipboard access blocked — long-press / Ctrl+V into the box instead.', 'error'); }
    }
    if (act === 'parse') parseReply();
    if (act === 'commit') commit();
  });

  function commit() {
    const c = card();
    const picked = rows.filter(r => r.include && r.date && r.amount > 0);
    if (!picked.length) return showToast('Nothing selected to commit.', 'error');
    const stamp = Date.now();
    picked.forEach((r, n) => {
      const remark = ['Statement import', r.time, r.note].filter(Boolean).join(' · ');
      database.transactions.push({
        id: `tx-${stamp}${n}${Math.random().toString(36).slice(2, 6)}`,
        date: r.date,
        cardId: c.id,
        category: r.category,
        internalTag: r.internalTag,
        description: r.description || 'General Expense',
        remark,
        // Credits (refunds) are booked negative so they net off the cycle's spend.
        amount: r.credit ? -r.amount : r.amount,
      });
    });
    saveToLocalStorage();
    refreshLedgerAndCalculations();
    showToast(`${picked.length} transaction(s) committed to ${c.name}.`, 'success');
    close();
  }

  setCard();
  replyEl.focus();
}

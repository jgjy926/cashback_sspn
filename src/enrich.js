// Claude enrichment round-trip shared by the Medical and Vehicle tabs.
//
// Two pieces:
//  - parseEnrichedJson(): a forgiving parser for what Claude pastes back. Chat replies
//    often arrive wrapped in ```json fences or prose, and Claude sometimes writes raw
//    double quotes inside a string (e.g. a remark quoting `"(not scanned)"`), which
//    strict JSON.parse rejects with "Unexpected token". We strip the wrapper, try a
//    strict parse, and only then try a conservative repair.
//  - openEnrichPanel(): a copy/paste modal — copy the ready-made prompt (instructions +
//    data) into Claude, paste the reply back, import. No files to download or upload.
import { showToast } from './ui.js';

// ---------- forgiving JSON parse ----------

// After a `"` inside a string, decide whether it really closes the string: it does
// when JSON structure follows (`:` `}` `]`, or `,` followed by the start of another
// value/key). Anything else — `"(not scanned)" are…` — is a stray quote in prose.
function closesString(s, i) {
  let j = i + 1;
  while (j < s.length && /\s/.test(s[j])) j++;
  if (j >= s.length) return true;
  const c = s[j];
  if (c === ':' || c === '}' || c === ']') return true;
  if (c !== ',') return false;
  j++;
  while (j < s.length && /\s/.test(s[j])) j++;
  if (j >= s.length || /["{\[\]}\-0-9]/.test(s[j])) return true;
  return /^(true|false|null)\b/.test(s.slice(j, j + 6));
}

// Escape stray quotes and raw control characters inside strings, and drop trailing
// commas. Valid JSON passes through unchanged.
function repairJson(s) {
  let out = '', inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') { out += c + (s[i + 1] ?? ''); i++; continue; }
      if (c === '"') {
        if (closesString(s, i)) { inStr = false; out += c; } else out += '\\"';
        continue;
      }
      if (c === '\n') { out += '\\n'; continue; }
      if (c === '\r') { out += '\\r'; continue; }
      if (c === '\t') { out += '\\t'; continue; }
      if (c < ' ') { out += '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'); continue; }
      out += c;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === '}' || s[j] === ']') continue;   // trailing comma
    }
    out += c;
  }
  return out;
}

// Point at the spot JSON.parse choked on, so a bad paste is easy to fix by hand.
function describeError(err, s) {
  const m = /position (\d+)/.exec(err.message || '');
  if (!m) return `Not valid JSON (${err.message}).`;
  const p = Number(m[1]);
  const line = s.slice(0, p).split('\n').length;
  const near = s.slice(Math.max(0, p - 40), p + 40).replace(/\s+/g, ' ');
  return `Not valid JSON near line ${line}: …${near}…`;
}

export function parseEnrichedJson(text) {
  let s = String(text || '').replace(/^﻿/, '').trim();
  if (!s) throw new Error('Nothing to import — paste Claude’s reply first.');
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  // Accept a bare records array as well as the full wrapper object.
  const objAt = s.indexOf('{'), arrAt = s.indexOf('[');
  const isArr = arrAt >= 0 && (objAt < 0 || arrAt < objAt);
  const a = isArr ? arrAt : objAt;
  const b = s.lastIndexOf(isArr ? ']' : '}');
  if (a < 0 || b <= a) throw new Error('No JSON found — paste Claude’s whole reply.');
  s = s.slice(a, b + 1);
  try {
    return JSON.parse(s);
  } catch (strictErr) {
    try { return JSON.parse(repairJson(s)); }
    catch { throw new Error(describeError(strictErr, s)); }
  }
}

// Normalise a parsed reply to { type?, records } — Claude occasionally drops the wrapper.
export function normalizeEnriched(data) {
  if (Array.isArray(data)) return { records: data };
  return data;
}

// ---------- prompt ----------

const REPLY_RULES =
  'Rules for your reply:\n' +
  '- Reply with ONLY the JSON object, in a single ```json code block, with no other text.\n' +
  '- It must be strictly valid JSON. Never put a double quote (") inside a string value — use single quotes (\') instead.\n' +
  '- Keep every record\'s "id" exactly as given.';

export function buildPrompt(payload) {
  const { instructions, ...data } = payload;
  return `${instructions}\n\n${REPLY_RULES}\n\nInput:\n\`\`\`json\n${JSON.stringify(data, null, 1)}\n\`\`\``;
}

// ---------- copy/paste panel ----------

async function copyText(text, fallbackEl) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older/insecure contexts: select the textarea and use the legacy copy command.
    fallbackEl.focus(); fallbackEl.select();
    try { return document.execCommand('copy'); } catch { return false; }
  }
}

const BTN = 'font-bold py-2 px-3 rounded-xl text-[11px] uppercase tracking-wider transition';
const SCOPES = [['selected', 'Selected'], ['new', 'Not enriched'], ['all', 'All']];

// opts: { title, defaultScope, build(scope) -> { payload } | { error }, importData(data) -> { ok, message } }
export function openEnrichPanel({ title, defaultScope, build, importData }) {
  document.getElementById('enrichPanel')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'enrichPanel';
  wrap.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4';
  wrap.innerHTML = `
    <div class="glass-card bg-gray-950 border border-gray-800 rounded-2xl w-full max-w-2xl max-h-[92vh] overflow-y-auto p-5 space-y-4">
      <div class="flex items-center justify-between gap-3">
        <h3 class="text-sm font-bold text-slate-100"><i class="fa-solid fa-wand-magic-sparkles mr-1 text-indigo-400"></i><span data-el="title"></span></h3>
        <button data-act="close" class="text-slate-400 hover:text-white text-lg leading-none" aria-label="Close">&times;</button>
      </div>

      <div class="space-y-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-[11px] font-bold uppercase tracking-wider text-slate-400">1 · Copy this prompt into Claude</p>
          <div class="flex gap-1" data-el="scopes">
            ${SCOPES.map(([v, l]) => `<button data-scope="${v}" class="${BTN} !py-1 !px-2 border border-gray-800 text-slate-400">${l}</button>`).join('')}
          </div>
        </div>
        <textarea data-el="prompt" readonly rows="6" class="w-full bg-gray-900 border border-gray-800 rounded-xl p-3 text-[11px] font-mono text-slate-300 focus:outline-none"></textarea>
        <div class="flex items-center justify-between gap-2">
          <span data-el="count" class="text-[11px] text-slate-500"></span>
          <button data-act="copy" class="${BTN} bg-indigo-600 hover:bg-indigo-500 text-white"><i class="fa-solid fa-copy mr-1"></i>Copy prompt</button>
        </div>
      </div>

      <div class="space-y-2 border-t border-gray-800 pt-4">
        <p class="text-[11px] font-bold uppercase tracking-wider text-slate-400">2 · Paste Claude’s reply</p>
        <textarea data-el="reply" rows="8" placeholder="Paste the whole reply here — code fences and extra text are fine." class="w-full bg-gray-900 border border-gray-800 rounded-xl p-3 text-[11px] font-mono text-slate-100 focus:outline-none focus:border-indigo-500"></textarea>
        <p data-el="error" class="hidden text-[11px] text-rose-400 break-words"></p>
        <div class="flex flex-wrap justify-end gap-2">
          <button data-act="paste" class="${BTN} bg-gray-900 border border-gray-800 hover:border-indigo-500 text-slate-200"><i class="fa-solid fa-paste mr-1"></i>Paste from clipboard</button>
          <button data-act="import" class="${BTN} bg-emerald-600 hover:bg-emerald-500 text-white"><i class="fa-solid fa-file-import mr-1"></i>Import</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const $ = sel => wrap.querySelector(`[data-el="${sel}"]`);
  const promptEl = $('prompt'), replyEl = $('reply'), errEl = $('error');
  $('title').textContent = title;
  const showError = msg => { errEl.textContent = msg; errEl.classList.toggle('hidden', !msg); };
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  let prompt = '';
  function setScope(scope) {
    wrap.querySelectorAll('[data-scope]').forEach(b => {
      const on = b.dataset.scope === scope;
      b.classList.toggle('border-indigo-500', on);
      b.classList.toggle('text-slate-100', on);
    });
    const res = build(scope);
    prompt = res.payload ? buildPrompt(res.payload) : '';
    promptEl.value = res.payload ? prompt : res.error;
    $('count').textContent = res.payload ? `${res.payload.records.length} record(s)` : '';
  }

  wrap.addEventListener('click', async e => {
    if (e.target === wrap) return close();
    const scopeBtn = e.target.closest('[data-scope]');
    if (scopeBtn) return setScope(scopeBtn.dataset.scope);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') close();
    if (act === 'copy') {
      if (!prompt) return showToast('Nothing to copy — pick records first.', 'error');
      const copied = await copyText(prompt, promptEl);
      showToast(copied ? 'Prompt copied — paste it into Claude.' : 'Copy failed — select the text and copy it manually.', copied ? 'success' : 'error');
    }
    if (act === 'paste') {
      try { replyEl.value = await navigator.clipboard.readText(); showError(''); }
      catch { showToast('Clipboard access blocked — long-press / Ctrl+V into the box instead.', 'error'); }
    }
    if (act === 'import') {
      let data;
      try { data = normalizeEnriched(parseEnrichedJson(replyEl.value)); }
      catch (err) { return showError(err.message); }
      const res = importData(data);
      if (!res.ok) return showError(res.message);
      showToast(res.message, 'success');
      close();
    }
  });

  setScope(defaultScope);
  replyEl.focus();
}

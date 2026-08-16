// Interest (Saving Acc) tab.
//
// Forecasts a saving account's monthly interest from a tiered rate schedule and
// lets the user lock in the real figure once interest is actually credited.
//
//   Interest Credit  = flat base rate (default 0.05% PA) on the opening balance ÷ 12
//   One Bonus Credit = tiered PA schedule on the opening balance ÷ 12
//   Total Bonus      = Interest Credit + One Bonus Credit
//   Balance (Close)  = Open + Deposit + Total Bonus − (Withdraw + Expense)
//
// Only *actualised* months are persisted (database.savingsMonths). Forecast rows
// are recomputed on every render from settings.savingsConfig, so a mid-year edit
// can never leave a stale downstream balance. Interest is computed on the OPENING
// balance, so a deposit only starts earning the following month.

import { database } from './state.js';
import { saveToLocalStorage } from './storage.js';
import { askConfirm, showToast } from './ui.js';

// Which month's inline tier breakdown is currently expanded (single-open accordion).
let expandedMonth = null;
// Selected start month of the visible 12-month window (null => current calendar month).
let viewStartMonth = null;
// Whether the editor modal is showing day-of-month fields (set when it opens).
let modalDailyMode = false;

// ---- pure helpers --------------------------------------------------------

// Round to cents (half away from zero). The 1e-6 tolerance on the *cent-scaled*
// value absorbs binary-float slop so an exact half-cent like 921.875 rounds up to
// 921.88 instead of landing on 921.87 (it stored as 921.8749999…). The tolerance
// is far below any real half-cent gap yet well above double-precision ULP noise.
function round2(n) {
  const v = Number(n) || 0;
  return Math.round(v * 100 + Math.sign(v) * 1e-6) / 100;
}

function fmtRM(n) {
  return 'RM ' + (Number(n) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function pad2(n) { return String(n).padStart(2, '0'); }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "YYYY-MM" -> { y, m } with m in 1..12.
function parseMonth(key) { const [y, m] = String(key).split('-').map(Number); return { y, m }; }
// Add whole months to a "YYYY-MM" key.
function addMonths(key, delta) {
  const { y, m } = parseMonth(key);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${pad2((idx % 12) + 1)}`;
}
// "2026-06" -> "Jun 26".
function monthLabel(key) { const { y, m } = parseMonth(key); return `${MONTHS[m - 1]} ${String(y).slice(-2)}`; }
function currentMonthKey() { const n = new Date(); return `${n.getFullYear()}-${pad2(n.getMonth() + 1)}`; }

function getConfig() { return (database.settings && database.settings.savingsConfig) || {}; }

// Per-tier split of a balance. Always returns every configured band (amountInBand
// 0 for bands the balance doesn't reach) plus an "above top tier" row when the
// balance exceeds the schedule — this drives the collapsible breakdown panel.
function tierBreakdown(balance, tiers, aboveRatePA) {
  const rows = [];
  let remaining = Math.max(0, Number(balance) || 0);
  let lower = 0;
  for (const t of (tiers || [])) {
    const band = Number(t.band) || 0;
    const ratePA = Number(t.ratePA) || 0;
    const inBand = Math.max(0, Math.min(remaining, band));
    rows.push({ lower, upper: lower + band, ratePA, amountInBand: inBand, monthlyInterest: inBand * ratePA / 12 });
    remaining -= inBand;
    lower += band;
  }
  if (remaining > 0) {
    const ratePA = Number(aboveRatePA) || 0;
    rows.push({ lower, upper: Infinity, ratePA, amountInBand: remaining, monthlyInterest: remaining * ratePA / 12 });
  }
  return rows;
}

// Monthly "One Bonus Credit" — tiered PA schedule on the balance. Sum the raw
// per-band interest first, then round once, so the displayed total reconciles.
function oneBonusMonthly(balance, tiers, aboveRatePA) {
  const sum = tierBreakdown(balance, tiers, aboveRatePA).reduce((a, r) => a + r.monthlyInterest, 0);
  return round2(sum);
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function daysInMonth(key) { const { y, m } = parseMonth(key); return new Date(y, m, 0).getDate(); }

// Monthly "Interest Credit". Two bases (config.interestBasis):
//  - 'monthEnd': baseRate/12 x (opening + deposits - withdrawals). Dates ignored.
//  - 'daily'   : day-weight each balance by its day-of-month, ÷365, inclusive from
//                the flow date. Opening spans the whole month; the fixed deposit
//                lands on config.depositDay; each ad-hoc entry on its own `date`
//                (missing => 1st). A flow on day D earns for (daysInMonth-D+1) days.
// One Bonus is unaffected — it always uses the opening balance.
function interestCreditFor(openBal, fixedDeposit, adhocDeposits, withdrawals, monthKey, cfg) {
  const rate = Number(cfg.baseRatePA) || 0;
  const base = Math.max(0, Number(openBal) || 0);

  if (cfg.interestBasis === 'daily') {
    const N = daysInMonth(monthKey);
    const depDay = clamp(Math.round(Number(cfg.depositDay) || 1), 1, N);
    const daysFrom = d => N - clamp(Math.round(Number(d) || 1), 1, N) + 1; // inclusive
    let weighted = base * N;
    weighted += (Number(fixedDeposit) || 0) * daysFrom(depDay);
    for (const e of (adhocDeposits || [])) weighted += (Number(e.amount) || 0) * daysFrom(e.date);
    for (const e of (withdrawals || [])) weighted -= (Number(e.amount) || 0) * daysFrom(e.date);
    return round2(Math.max(0, weighted) * rate / 365);
  }

  // month-end: whole net balance treated as present for the month
  const dep = (Number(fixedDeposit) || 0) + (adhocDeposits || []).reduce((a, e) => a + (Number(e.amount) || 0), 0);
  const wd = (withdrawals || []).reduce((a, e) => a + (Number(e.amount) || 0), 0);
  return round2(Math.max(0, base + dep - wd) * rate / 12);
}

// Absolute month ordinal for "YYYY-MM" (for range math / comparisons).
function monthIndex(key) { const { y, m } = parseMonth(key); return y * 12 + (m - 1); }

// Timeline bounds. `genesis` = where the balance history starts (config). The full
// schedule always extends from genesis through `windowSize` months past the CURRENT
// calendar month, so the forecast is "12 months onward from this month" while any
// earlier months stay reviewable via the view dropdown.
function scheduleBounds() {
  const cfg = getConfig();
  const genesis = /^\d{4}-\d{2}$/.test(cfg.startMonth || '') ? cfg.startMonth : currentMonthKey();
  const windowSize = Math.max(1, Math.min(120, Number(cfg.horizonMonths) || 12));
  const forwardEndIdx = Math.max(monthIndex(genesis), monthIndex(currentMonthKey())) + windowSize - 1;
  const count = Math.min(360, forwardEndIdx - monthIndex(genesis) + 1);
  return { genesis, windowSize, count };
}

// Build the entire timeline (genesis → current month + windowSize). Pure w.r.t the
// DOM: reads config + stored actuals, returns one row per month with every derived
// figure. The visible slice is chosen later by viewWindow().
function buildFullSchedule() {
  const cfg = getConfig();
  const { genesis, count } = scheduleBounds();
  const defDeposit = round2(cfg.monthlyDeposit || 0);
  const byMonth = new Map((database.savingsMonths || []).map(r => [r.month, r]));

  const rows = [];
  let opening = round2(cfg.startingBalance || 0);
  let prevTotalBonus = null;
  let key = genesis;

  for (let i = 0; i < count; i++) {
    const rec = byMonth.get(key);
    const isActual = !!(rec && rec.status === 'actual');

    // An actual month may pin its own real statement opening; otherwise carry over.
    const openBal = (isActual && typeof rec.openingBalance === 'number') ? round2(rec.openingBalance) : opening;

    // Deposits = one fixed monthly amount + any ad-hoc entries; withdrawals = entries.
    // Back-compat: older records stored single `deposit` / `withdrawExpense` numbers.
    const fixedDeposit = rec && typeof rec.fixedDeposit === 'number' ? round2(rec.fixedDeposit)
      : (rec && typeof rec.deposit === 'number' ? round2(rec.deposit) : defDeposit);
    const mapEntry = e => { const o = { amount: round2(e.amount || 0), remark: e.remark || '' }; if (e.date != null) o.date = e.date; return o; };
    const adhocDeposits = (rec && Array.isArray(rec.deposits) ? rec.deposits : []).map(mapEntry);
    const withdrawals = (rec && Array.isArray(rec.withdrawals) ? rec.withdrawals
      : (rec && typeof rec.withdrawExpense === 'number' && rec.withdrawExpense > 0 ? [{ amount: rec.withdrawExpense, remark: '' }] : []))
      .map(mapEntry);
    const deposit = round2(fixedDeposit + adhocDeposits.reduce((a, e) => a + e.amount, 0));
    const withdraw = round2(withdrawals.reduce((a, e) => a + e.amount, 0));

    let interestCredit, oneBonus;
    if (isActual) {
      interestCredit = round2(rec.interestCredit || 0);
      oneBonus = round2(rec.oneBonusCredit || 0);
    } else {
      interestCredit = interestCreditFor(openBal, fixedDeposit, adhocDeposits, withdrawals, key, cfg);
      oneBonus = oneBonusMonthly(openBal, cfg.tiers, cfg.aboveTopTierRatePA);
    }

    const totalBonus = round2(interestCredit + oneBonus);
    const closing = round2(openBal + deposit + totalBonus - withdraw);
    const effRate = openBal > 0 ? (totalBonus / openBal) * 12 * 100 : 0;
    const momAmt = prevTotalBonus == null ? null : round2(totalBonus - prevTotalBonus);
    const momPct = (prevTotalBonus == null || prevTotalBonus === 0) ? null : (momAmt / prevTotalBonus) * 100;

    rows.push({
      month: key, label: monthLabel(key), status: isActual ? 'actual' : 'forecast',
      openingBalance: openBal, deposit, fixedDeposit, deposits: adhocDeposits,
      interestCredit, oneBonusCredit: oneBonus, totalBonus,
      withdrawExpense: withdraw, withdrawals, closingBalance: closing, effRate, momAmt, momPct,
      customised: !!rec
    });

    opening = closing;
    prevTotalBonus = totalBonus;
    key = addMonths(key, 1);
  }
  return rows;
}

// Legal window-start months = every month from which a full window still fits.
function windowStarts(full, windowSize) {
  const lastStart = Math.max(0, full.length - windowSize);
  return full.slice(0, lastStart + 1).map(r => r.month);
}

// The currently-selected window start, defaulting to the current calendar month
// (or the closest legal start), clamped to the available range.
function resolveViewStart(full, windowSize) {
  const starts = windowStarts(full, windowSize);
  if (viewStartMonth && starts.includes(viewStartMonth)) return viewStartMonth;
  const cur = currentMonthKey();
  if (starts.includes(cur)) return cur;
  // current month sits past the last legal start (short horizon) → clamp to last.
  if (full.some(r => r.month === cur)) return starts[starts.length - 1];
  return starts[0];
}

// ---- rendering -----------------------------------------------------------

function renderSavings() {
  const section = document.getElementById('tabContent-savings');
  if (!section) return;
  const cfg = getConfig();

  syncSetupForm(cfg);
  const full = buildFullSchedule();
  // Drop a stale expansion if that month is no longer on the timeline.
  if (expandedMonth && !full.some(r => r.month === expandedMonth)) expandedMonth = null;
  renderKpis(full);
  renderViewFilter(full);
  renderScheduleWindow(full);

  const chip = document.getElementById('svBasisChip');
  if (chip) chip.textContent = cfg.interestBasis === 'daily'
    ? `Interest: daily by-date ÷365 (deposit day ${clamp(Math.round(cfg.depositDay || 1), 1, 31)})`
    : 'Interest: month-end balance';
}

// Render just the schedule table for the active view window.
function renderScheduleWindow(full) {
  full = full || buildFullSchedule();
  const { windowSize } = scheduleBounds();
  const start = resolveViewStart(full, windowSize);
  const idx = full.findIndex(r => r.month === start);
  renderScheduleTable(full.slice(idx, idx + windowSize));
}

// Populate the month-window dropdown (a filter to review earlier months).
function renderViewFilter(full) {
  const sel = document.getElementById('svViewStart');
  if (!sel) return;
  const { windowSize } = scheduleBounds();
  const starts = windowStarts(full, windowSize);
  const active = resolveViewStart(full, windowSize);
  sel.innerHTML = starts.map(m => {
    const endIdx = Math.min(full.length - 1, full.findIndex(r => r.month === m) + windowSize - 1);
    const end = full[endIdx] ? full[endIdx].month : m;
    return `<option value="${m}"${m === active ? ' selected' : ''}>${monthLabel(m)} – ${monthLabel(end)}</option>`;
  }).join('');

  const atCurrent = active === currentMonthKey();
  const btn = document.getElementById('svViewTodayBtn');
  if (btn) btn.classList.toggle('hidden', atCurrent || !starts.includes(currentMonthKey()));
}

function onSavingsViewChange() {
  const sel = document.getElementById('svViewStart');
  if (!sel) return;
  viewStartMonth = sel.value;
  const full = buildFullSchedule();
  renderViewFilter(full);
  renderScheduleWindow(full);
}

function savingsViewToday() {
  viewStartMonth = currentMonthKey();
  renderSavings();
}

// Push stored config into the setup form inputs (only when not focused, so typing
// isn't clobbered by a re-render triggered elsewhere).
function syncSetupForm(cfg) {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = val;
  };
  set('svStartMonth', /^\d{4}-\d{2}$/.test(cfg.startMonth || '') ? cfg.startMonth : currentMonthKey());
  set('svStartingBalance', cfg.startingBalance ?? 0);
  set('svMonthlyDeposit', cfg.monthlyDeposit ?? 0);
  set('svHorizon', cfg.horizonMonths ?? 12);
  set('svBaseRate', round4((cfg.baseRatePA ?? 0) * 100));
  set('svAboveRate', round4((cfg.aboveTopTierRatePA ?? 0) * 100));
  set('svInterestBasis', cfg.interestBasis === 'daily' ? 'daily' : 'monthEnd');
  set('svDepositDay', cfg.depositDay ?? 1);
  // The deposit-day input only matters in daily mode — dim it otherwise.
  const depDayWrap = document.getElementById('svDepositDayWrap');
  if (depDayWrap) depDayWrap.classList.toggle('opacity-40', cfg.interestBasis !== 'daily');

  const wrap = document.getElementById('svTierInputs');
  if (wrap && document.activeElement && wrap.contains(document.activeElement)) return; // don't clobber mid-edit
  if (wrap) {
    wrap.innerHTML = (cfg.tiers || []).map((t, i) => `
      <div class="grid grid-cols-[1fr_auto_5.5rem] items-center gap-2">
        <div class="relative">
          <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-600 text-[10px] font-semibold">RM</span>
          <input type="number" step="0.01" min="0" id="svTierBand${i}" value="${Number(t.band) || 0}"
            class="w-full bg-gray-950 border border-gray-800 rounded-lg pl-8 pr-2 py-1.5 text-[11px] text-slate-100 focus:outline-none focus:border-indigo-500 font-mono">
        </div>
        <span class="text-slate-600 text-[10px] font-semibold">band @</span>
        <div class="relative">
          <input type="number" step="0.001" min="0" id="svTierRate${i}" value="${round4((Number(t.ratePA) || 0) * 100)}"
            class="w-full bg-gray-950 border border-gray-800 rounded-lg pl-2 pr-5 py-1.5 text-[11px] text-slate-100 focus:outline-none focus:border-indigo-500 font-mono">
          <span class="absolute right-2 top-1/2 -translate-y-1/2 text-slate-600 text-[10px] font-semibold">%</span>
        </div>
      </div>`).join('');
  }
}

function round4(n) { return Math.round((Number(n) + Number.EPSILON) * 10000) / 10000; }

// Distribute rounding so a set of raw values displays as cents that sum EXACTLY
// to round2(total) — largest-remainder method. Without this, summing the per-band
// column in the breakdown panel can disagree with the stated total by a cent.
function allocateCents(rawValues) {
  const totalCents = Math.round(rawValues.reduce((a, v) => a + v, 0) * 100 + 1e-6);
  const floors = rawValues.map(v => Math.floor(v * 100 + 1e-6));
  let remainder = totalCents - floors.reduce((a, v) => a + v, 0);
  const order = rawValues
    .map((v, i) => ({ i, frac: (v * 100 + 1e-6) - Math.floor(v * 100 + 1e-6) }))
    .sort((a, b) => b.frac - a.frac);
  const out = floors.slice();
  for (let k = 0; k < remainder && k < order.length; k++) out[order[k].i] += 1;
  return out.map(c => c / 100);
}

function renderKpis(full) {
  const wrap = document.getElementById('svKpiRow');
  if (!wrap) return;

  const year = new Date().getFullYear();
  const { windowSize } = scheduleBounds();
  const cur = currentMonthKey();

  const inYear = full.filter(r => parseMonth(r.month).y === year);
  const interestThisYear = round2(inYear.reduce((a, r) => a + r.totalBonus, 0));
  const depositsThisYear = round2(inYear.reduce((a, r) => a + r.deposit, 0));

  // Forward window = the next `windowSize` months from this calendar month.
  const fwd = full.filter(r => monthIndex(r.month) >= monthIndex(cur) && monthIndex(r.month) < monthIndex(cur) + windowSize);
  const nextInterest = round2(fwd.reduce((a, r) => a + r.totalBonus, 0));
  const projected = fwd.length ? fwd[fwd.length - 1].closingBalance : (full.length ? full[full.length - 1].closingBalance : 0);

  // MoM for the current month vs the previous month (the most decision-relevant
  // change); fall back to the last row that has a predecessor.
  const curRow = full.find(r => r.month === cur) || [...full].reverse().find(r => r.momAmt != null);
  const momAmt = curRow ? curRow.momAmt : null;
  const momPct = curRow ? curRow.momPct : null;
  const momUp = (momAmt || 0) >= 0;
  const momColor = momAmt == null ? 'text-slate-400' : (momUp ? 'text-emerald-400' : 'text-rose-400');
  const momArrow = momAmt == null ? '' : (momUp ? '<i class="fa-solid fa-arrow-trend-up mr-1"></i>' : '<i class="fa-solid fa-arrow-trend-down mr-1"></i>');
  const momText = momAmt == null ? '—'
    : `${momArrow}${momUp ? '+' : ''}${fmtRM(momAmt)}${momPct == null ? '' : ` (${momUp ? '+' : ''}${momPct.toFixed(1)}%)`}`;

  const card = (label, value, sub, valClass = 'text-slate-100') => `
    <div class="glass-card rounded-2xl p-4">
      <p class="text-[9px] font-bold uppercase tracking-widest text-slate-500">${label}</p>
      <p class="text-lg font-bold ${valClass} mt-1 font-mono leading-tight">${value}</p>
      <p class="text-[10px] text-slate-500 mt-0.5">${sub}</p>
    </div>`;

  wrap.innerHTML = [
    card(`Interest Credited ${year}`, fmtRM(interestThisYear), `Next ${windowSize} mo: ${fmtRM(nextInterest)}`, 'text-emerald-400'),
    card(`Deposits ${year}`, fmtRM(depositsThisYear), 'Total contributions this year'),
    card(`Projected Balance (+${windowSize}mo)`, fmtRM(projected), curRow ? `From ${monthLabel(cur)}` : 'Set a starting balance', 'text-indigo-300'),
    card('MoM Change', momText, curRow && momAmt != null ? `${monthLabel(cur)} vs ${monthLabel(addMonths(cur, -1))}` : 'Needs 2+ months', momColor)
  ].join('');
}

function renderScheduleTable(rows) {
  const body = document.getElementById('svScheduleBody');
  if (!body) return;

  body.innerHTML = rows.map(r => {
    const isActual = r.status === 'actual';
    const badge = isActual
      ? `<button onclick="openSavingsMonthModal('${r.month}')" title="Locked to actual — click to edit" class="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 text-[9px] font-bold inline-flex items-center gap-1"><i class="fa-solid fa-lock"></i>Actual</button>`
      : `<button onclick="openSavingsMonthModal('${r.month}')" title="Forecast — click to enter the actual received / adjust deposit" class="px-2 py-0.5 rounded bg-slate-500/10 text-slate-400 border border-slate-600/30 text-[9px] font-bold inline-flex items-center gap-1 hover:text-slate-200 hover:border-slate-500">${r.customised ? '<i class="fa-solid fa-pen-to-square"></i>' : '<i class="fa-solid fa-wand-magic-sparkles"></i>'}Forecast</button>`;

    let mom = '<span class="text-slate-600 text-[9px]">—</span>';
    if (r.momAmt != null && r.momAmt !== 0) {
      const up = r.momAmt > 0;
      const c = up ? 'text-emerald-500' : 'text-rose-500';
      mom = `<div class="${c} text-[9px] font-medium mt-0.5">${up ? '▲' : '▼'} ${up ? '+' : ''}${r.momAmt.toFixed(2)}${r.momPct == null ? '' : ` · ${up ? '+' : ''}${r.momPct.toFixed(1)}%`}</div>`;
    }

    const depClass = r.deposit > 0 ? 'text-sky-400' : 'text-slate-500';
    const wdClass = r.withdrawExpense > 0 ? 'text-rose-400' : 'text-slate-500';
    const rowTint = isActual ? 'bg-emerald-500/[0.03]' : '';
    const isOpen = expandedMonth === r.month;
    const chev = isOpen ? 'fa-chevron-down' : 'fa-chevron-right';

    const mainRow = `
      <tr class="hover:bg-gray-900/40 transition ${rowTint} ${isOpen ? 'bg-gray-900/30' : ''}">
        <td class="py-2.5 px-3 whitespace-nowrap">
          <button onclick="toggleMonthBreakdown('${r.month}')" title="Click to see this month's tier breakdown" class="flex items-center gap-1.5 font-semibold text-slate-200 text-xs hover:text-emerald-300 transition">
            <i class="fa-solid ${chev} text-[8px] text-slate-500 w-2"></i>${r.label}
          </button>
        </td>
        <td class="py-2.5 px-3 text-right font-mono text-[11px] text-slate-300">${fmtRM(r.openingBalance)}</td>
        <td class="py-2.5 px-3 text-right font-mono text-[11px] ${depClass}">${r.deposit > 0 ? '+' : ''}${r.deposit.toFixed(2)}</td>
        <td class="py-2.5 px-3 text-right font-mono text-[11px] text-slate-300">${r.interestCredit.toFixed(2)}</td>
        <td class="py-2.5 px-3 text-right font-mono text-[11px] text-slate-300">${r.oneBonusCredit.toFixed(2)}</td>
        <td class="py-2.5 px-3 text-right font-mono text-[11px] font-bold text-emerald-400">${r.totalBonus.toFixed(2)}${mom}</td>
        <td class="py-2.5 px-3 text-right font-mono text-[11px] ${wdClass}">${r.withdrawExpense > 0 ? '−' : ''}${r.withdrawExpense.toFixed(2)}</td>
        <td class="py-2.5 px-3 text-right font-mono text-[11px] font-bold text-slate-100">${fmtRM(r.closingBalance)}</td>
        <td class="py-2.5 px-3 text-right font-mono text-[11px] text-indigo-300">${r.effRate.toFixed(2)}%</td>
        <td class="py-2.5 px-3 text-center">${badge}</td>
      </tr>`;

    const detailRow = isOpen ? `
      <tr class="bg-gray-950/50">
        <td colspan="10" class="px-4 pt-1 pb-4 border-b border-gray-800">
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>${tierBreakdownHtml(r)}</div>
            <div>${cashFlowHtml(r)}</div>
          </div>
        </td>
      </tr>` : '';

    return mainRow + detailRow;
  }).join('');
}

// ---- per-month tier breakdown (inline, click a month to expand) ----------

function toggleMonthBreakdown(month) {
  expandedMonth = (expandedMonth === month) ? null : month;
  renderScheduleWindow();
}

// Build the tier-breakdown table HTML for a schedule row. Bands + One Bonus are
// modelled on the row's opening balance; Interest Credit uses the configured basis
// on the row's own cash flows. For an actual month these are the *modelled* figures
// (the credited One Bonus is what the user keyed) — the note flags that.
function tierBreakdownHtml(r) {
  const cfg = getConfig();
  const balance = r.openingBalance;
  const isActual = r.status === 'actual';
  const rows = tierBreakdown(balance, cfg.tiers, cfg.aboveTopTierRatePA);
  const perBand = allocateCents(rows.map(b => b.monthlyInterest)); // sums exactly to total
  const totalOneBonus = oneBonusMonthly(balance, cfg.tiers, cfg.aboveTopTierRatePA);
  const interestCredit = interestCreditFor(balance, r.fixedDeposit, r.deposits, r.withdrawals, r.month, cfg);
  const basisLabel = cfg.interestBasis === 'daily' ? 'daily ÷365' : 'month-end';

  const bandRows = rows.map((r, i) => {
    const range = r.upper === Infinity ? `Above ${fmtRM(r.lower)}` : `${fmtRM(r.lower)} – ${fmtRM(r.upper)}`;
    const active = r.amountInBand > 0;
    return `
      <tr class="${active ? '' : 'opacity-40'}">
        <td class="py-1.5 px-3 text-[10px] text-slate-400">${r.upper === Infinity ? 'Above top tier' : 'Tier ' + (i + 1)}</td>
        <td class="py-1.5 px-3 text-[10px] font-mono text-slate-300">${range}</td>
        <td class="py-1.5 px-3 text-right text-[10px] font-mono text-indigo-300">${(r.ratePA * 100).toFixed(3)}%</td>
        <td class="py-1.5 px-3 text-right text-[10px] font-mono text-slate-300">${fmtRM(r.amountInBand)}</td>
        <td class="py-1.5 px-3 text-right text-[10px] font-mono ${active ? 'text-emerald-400' : 'text-slate-500'}">${perBand[i].toFixed(2)}</td>
      </tr>`;
  }).join('');

  const note = isActual
    ? `<p class="text-[9px] text-amber-400/80 mb-2"><i class="fa-solid fa-circle-info mr-1"></i>This month is <b>actual</b> — the One Bonus above is what you keyed in. The tiers below are the modelled schedule on the opening balance ${fmtRM(balance)}.</p>`
    : `<p class="text-[9px] text-slate-500 mb-2">Tier breakdown of the One Bonus on the opening balance ${fmtRM(balance)}.</p>`;

  return `
    ${note}
    <div class="overflow-x-auto rounded-lg border border-gray-800/70">
      <table class="w-full text-left border-collapse min-w-[480px]">
        <thead class="bg-gray-900/60 uppercase text-[9px] tracking-widest text-slate-500 font-bold border-b border-gray-800">
          <tr>
            <th class="py-2 px-3">Tier</th>
            <th class="py-2 px-3">Band Range</th>
            <th class="py-2 px-3 text-right">Rate PA</th>
            <th class="py-2 px-3 text-right">In Band</th>
            <th class="py-2 px-3 text-right">/ Month</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-800/60">
          ${bandRows}
          <tr class="border-t border-gray-800 bg-gray-900/40">
            <td class="py-2 px-3 text-[10px] font-bold text-slate-400" colspan="4">One Bonus (tiered) / month</td>
            <td class="py-2 px-3 text-right text-[11px] font-mono font-bold text-emerald-400">${totalOneBonus.toFixed(2)}</td>
          </tr>
          <tr class="bg-gray-900/40">
            <td class="py-2 px-3 text-[10px] font-bold text-slate-400" colspan="4">Interest Credit (base ${((cfg.baseRatePA || 0) * 100).toFixed(3)}% PA, ${basisLabel}) / month</td>
            <td class="py-2 px-3 text-right text-[11px] font-mono font-bold text-slate-200">${interestCredit.toFixed(2)}</td>
          </tr>
          <tr class="bg-gray-900/60">
            <td class="py-2 px-3 text-[10px] font-bold text-slate-300" colspan="4">Total Bonus / month</td>
            <td class="py-2 px-3 text-right text-[11px] font-mono font-bold text-emerald-300">${round2(totalOneBonus + interestCredit).toFixed(2)}</td>
          </tr>
        </tbody>
      </table>
    </div>`;
}

// Cash-flow detail for a month: the fixed deposit, each ad-hoc deposit and each
// withdrawal/expense with its remark, and the two totals. Surfaces the remarks the
// user captured in the editor.
function cashFlowHtml(r) {
  const cfg = getConfig();
  const daily = cfg.interestBasis === 'daily';
  const dayTag = d => daily ? ` <span class="text-slate-500">· day ${clamp(Math.round(Number(d) || 1), 1, daysInMonth(r.month))}</span>` : '';

  const depLines = [];
  if ((r.fixedDeposit || 0) > 0) depLines.push({ label: 'Fixed monthly deposit', amount: r.fixedDeposit, muted: true, day: cfg.depositDay });
  (r.deposits || []).forEach(e => depLines.push({ label: e.remark || 'Ad-hoc deposit', amount: e.amount, day: e.date }));
  const wdLines = (r.withdrawals || []).map(e => ({ label: e.remark || 'Withdrawal / expense', amount: e.amount, day: e.date }));

  if (depLines.length === 0 && wdLines.length === 0) {
    return `<p class="text-[10px] text-slate-500 pt-1">No deposits or withdrawals recorded for ${r.label}.</p>`;
  }

  const line = (l, color) => `
    <div class="flex items-center justify-between gap-3 py-1">
      <span class="text-[10px] ${l.muted ? 'text-slate-500' : 'text-slate-300'} truncate">${escapeAttr(l.label)}${dayTag(l.day)}</span>
      <span class="text-[10px] font-mono ${color} shrink-0">${fmtRM(l.amount)}</span>
    </div>`;

  const depBlock = `
    <div class="rounded-lg border border-gray-800/70 p-3">
      <div class="flex items-center justify-between mb-1">
        <span class="text-[10px] font-bold uppercase tracking-wider text-sky-400"><i class="fa-solid fa-arrow-down-to-bracket mr-1"></i>Deposits</span>
        <span class="text-[11px] font-mono font-bold text-sky-300">${fmtRM(r.deposit)}</span>
      </div>
      ${depLines.length ? depLines.map(l => line(l, 'text-sky-300')).join('') : '<p class="text-[10px] text-slate-600">None</p>'}
    </div>`;

  const wdBlock = `
    <div class="rounded-lg border border-gray-800/70 p-3">
      <div class="flex items-center justify-between mb-1">
        <span class="text-[10px] font-bold uppercase tracking-wider text-rose-400"><i class="fa-solid fa-arrow-up-from-bracket mr-1"></i>Withdrawals / Expenses</span>
        <span class="text-[11px] font-mono font-bold text-rose-300">${fmtRM(r.withdrawExpense)}</span>
      </div>
      ${wdLines.length ? wdLines.map(l => line(l, 'text-rose-300')).join('') : '<p class="text-[10px] text-slate-600">None</p>'}
    </div>`;

  return `<div class="space-y-3"><p class="text-[9px] text-slate-500">Cash flows recorded for ${r.label}.</p>${depBlock}${wdBlock}</div>`;
}

// ---- config save ---------------------------------------------------------

function saveSavingsConfig(e) {
  if (e) e.preventDefault();
  const cfg = getConfig();
  const num = (id, fallback = 0) => { const v = parseFloat(document.getElementById(id).value); return Number.isFinite(v) ? v : fallback; };

  const startMonth = document.getElementById('svStartMonth').value;
  cfg.startMonth = /^\d{4}-\d{2}$/.test(startMonth) ? startMonth : currentMonthKey();
  cfg.startingBalance = round2(num('svStartingBalance'));
  cfg.monthlyDeposit = round2(num('svMonthlyDeposit'));
  cfg.horizonMonths = Math.max(1, Math.min(120, Math.round(num('svHorizon', 12))));
  cfg.baseRatePA = num('svBaseRate') / 100;
  cfg.aboveTopTierRatePA = num('svAboveRate') / 100;
  cfg.interestBasis = document.getElementById('svInterestBasis').value === 'daily' ? 'daily' : 'monthEnd';
  cfg.depositDay = Math.max(1, Math.min(31, Math.round(num('svDepositDay', 1))));

  cfg.tiers = (cfg.tiers || []).map((t, i) => ({
    band: round2(num(`svTierBand${i}`, t.band)),
    ratePA: num(`svTierRate${i}`, t.ratePA * 100) / 100
  }));

  database.settings.savingsConfig = cfg;
  saveToLocalStorage();
  renderSavings();
  showToast('Savings forecast settings saved.');
}

function toggleSavingsSetup() {
  const body = document.getElementById('svSetupBody');
  const chev = document.getElementById('svSetupChevron');
  if (!body) return;
  const hidden = body.classList.toggle('hidden');
  if (chev) chev.className = hidden ? 'fa-solid fa-chevron-down transition' : 'fa-solid fa-chevron-up transition';
}

// ---- month editor (forecast <-> actual) ----------------------------------

// Escape a value for safe insertion into an HTML attribute (remarks are free text).
function escapeAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// One editable amount + day + remark line for the deposit / withdrawal lists. The
// day-of-month field is kept in the DOM always (so values survive a basis switch)
// but only shown in daily mode.
function entryRowHtml(amount, remark, kind, date) {
  const border = kind === 'dep' ? 'focus:border-sky-500' : 'focus:border-rose-500';
  const amt = (amount === '' || amount == null) ? '' : Number(amount);
  const dv = (date == null || date === '') ? '' : Number(date);
  const dayHidden = modalDailyMode ? '' : 'hidden';
  return `
    <div class="sv-entry-row flex items-center gap-2">
      <div class="relative w-24 shrink-0">
        <span class="absolute left-2 top-1/2 -translate-y-1/2 text-slate-600 text-[10px] font-semibold">RM</span>
        <input type="number" step="0.01" value="${amt}" oninput="recomputeModalTotals()" class="sv-entry-amt w-full bg-gray-950 border border-gray-800 rounded-lg pl-8 pr-2 py-1.5 text-[11px] text-slate-100 focus:outline-none ${border} font-mono">
      </div>
      <div class="sv-date-cell ${dayHidden} w-14 shrink-0">
        <input type="number" min="1" max="31" step="1" value="${dv}" placeholder="Day" title="Day of month" class="sv-entry-date w-full bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none ${border} font-mono text-center">
      </div>
      <input type="text" value="${escapeAttr(remark)}" placeholder="Remark" class="sv-entry-remark flex-1 bg-gray-950 border border-gray-800 rounded-lg px-2.5 py-1.5 text-[11px] text-slate-200 focus:outline-none ${border}">
      <button type="button" onclick="removeEntryRow(this)" title="Remove" class="text-slate-500 hover:text-rose-400 px-1.5"><i class="fa-solid fa-xmark"></i></button>
    </div>`;
}

function addDepositRow(amount = '', remark = '', date = '') {
  document.getElementById('svmDepositList').insertAdjacentHTML('beforeend', entryRowHtml(amount, remark, 'dep', date));
  recomputeModalTotals();
}
function addWithdrawRow(amount = '', remark = '', date = '') {
  document.getElementById('svmWithdrawList').insertAdjacentHTML('beforeend', entryRowHtml(amount, remark, 'wd', date));
  recomputeModalTotals();
}
function removeEntryRow(btn) {
  const row = btn.closest('.sv-entry-row');
  if (row) row.remove();
  recomputeModalTotals();
}

function sumEntries(listId) {
  return [...document.getElementById(listId).querySelectorAll('.sv-entry-row')]
    .reduce((a, r) => a + (parseFloat(r.querySelector('.sv-entry-amt').value) || 0), 0);
}
// Read entries, dropping fully-empty rows (no amount and no remark). A day-of-month
// is captured when present so daily-basis interest can weight it.
function readEntries(listId) {
  return [...document.getElementById(listId).querySelectorAll('.sv-entry-row')]
    .map(r => {
      const day = parseInt(r.querySelector('.sv-entry-date').value, 10);
      const e = { amount: round2(parseFloat(r.querySelector('.sv-entry-amt').value) || 0), remark: r.querySelector('.sv-entry-remark').value.trim() };
      if (Number.isFinite(day)) e.date = Math.min(31, Math.max(1, day));
      return e;
    })
    .filter(e => e.amount !== 0 || e.remark !== '');
}

function recomputeModalTotals() {
  const fixed = parseFloat(document.getElementById('svmFixedDeposit').value) || 0;
  document.getElementById('svmDepositTotal').textContent = round2(fixed + sumEntries('svmDepositList')).toFixed(2);
  document.getElementById('svmWithdrawTotal').textContent = round2(sumEntries('svmWithdrawList')).toFixed(2);
}

function openSavingsMonthModal(monthKey) {
  const row = buildFullSchedule().find(r => r.month === monthKey);
  if (!row) return;
  const cfg = getConfig();
  modalDailyMode = cfg.interestBasis === 'daily';

  document.getElementById('svmMonth').value = monthKey;
  document.getElementById('svmMonthLabel').textContent = row.label;
  document.getElementById('svmOpening').value = row.openingBalance.toFixed(2);
  document.getElementById('svmInterest').value = row.interestCredit.toFixed(2);
  document.getElementById('svmOneBonus').value = row.oneBonusCredit.toFixed(2);
  document.getElementById('svmFixedDeposit').value = row.fixedDeposit.toFixed(2);
  document.getElementById('svmIsActual').checked = row.status === 'actual';

  // Show the "on day N" hint for the fixed deposit only in daily mode.
  const depHint = document.getElementById('svmFixedDepositHint');
  if (depHint) depHint.textContent = modalDailyMode ? `Fixed monthly deposit · lands day ${clamp(Math.round(cfg.depositDay || 1), 1, daysInMonth(monthKey))}` : 'Fixed monthly deposit';

  // Rebuild the ad-hoc deposit / withdrawal lists from the stored entries.
  document.getElementById('svmDepositList').innerHTML = (row.deposits || []).map(e => entryRowHtml(e.amount, e.remark, 'dep', e.date)).join('');
  document.getElementById('svmWithdrawList').innerHTML = (row.withdrawals || []).map(e => entryRowHtml(e.amount, e.remark, 'wd', e.date)).join('');
  recomputeModalTotals();

  // Show a revert control only when there's a stored record to clear.
  const revert = document.getElementById('svmRevertBtn');
  if (revert) revert.classList.toggle('hidden', !row.customised);

  applySavingsActualMode();
  document.getElementById('savingsMonthModal').classList.remove('hidden');
}

function closeSavingsMonthModal() {
  document.getElementById('savingsMonthModal').classList.add('hidden');
}

// Toggle which fields are editable: in forecast mode the interest figures and the
// opening balance are derived (read-only); in actual mode everything is editable.
function applySavingsActualMode() {
  const isActual = document.getElementById('svmIsActual').checked;
  const hint = document.getElementById('svmModeHint');
  ['svmOpening', 'svmInterest', 'svmOneBonus'].forEach(id => {
    const el = document.getElementById(id);
    el.readOnly = !isActual;
    el.classList.toggle('opacity-50', !isActual);
    el.classList.toggle('cursor-not-allowed', !isActual);
  });
  if (hint) {
    hint.textContent = isActual
      ? 'Actual: all fields editable and locked to what the account actually credited. Feeds next month\'s opening.'
      : 'Forecast: opening & interest are auto-computed. You can still set a planned deposit / withdrawal.';
  }
}

function handleSavingsMonthSubmit(e) {
  e.preventDefault();
  const month = document.getElementById('svmMonth').value;
  const isActual = document.getElementById('svmIsActual').checked;
  const num = id => { const v = parseFloat(document.getElementById(id).value); return Number.isFinite(v) ? round2(v) : 0; };

  const cfg = getConfig();
  const fixedDeposit = num('svmFixedDeposit');
  const deposits = readEntries('svmDepositList');
  const withdrawals = readEntries('svmWithdrawList');
  const defDeposit = round2(cfg.monthlyDeposit || 0);

  // Forecast with no overrides needs no stored record — keep the ledger lean.
  const overridesDefaults = fixedDeposit !== defDeposit || deposits.length > 0 || withdrawals.length > 0;
  if (!isActual && !overridesDefaults) {
    database.savingsMonths = (database.savingsMonths || []).filter(r => r.month !== month);
    saveToLocalStorage();
    renderSavings();
    closeSavingsMonthModal();
    showToast('Month reset to pure forecast.', 'info');
    return;
  }

  let rec = (database.savingsMonths || []).find(r => r.month === month);
  if (!rec) {
    // Deterministic per-month id so two devices editing the same month reconcile
    // by last-writer-wins instead of creating duplicate rows on merge.
    rec = { id: 'sav-' + month, month };
    database.savingsMonths.push(rec);
  }
  rec.status = isActual ? 'actual' : 'forecast';
  rec.fixedDeposit = fixedDeposit;
  rec.deposits = deposits;
  rec.withdrawals = withdrawals;
  delete rec.deposit;         // drop superseded single-number fields
  delete rec.withdrawExpense;
  if (isActual) {
    rec.openingBalance = num('svmOpening');
    rec.interestCredit = num('svmInterest');
    rec.oneBonusCredit = num('svmOneBonus');
  } else {
    // Pure forecast override: don't freeze derived figures, let them recompute.
    delete rec.openingBalance;
    delete rec.interestCredit;
    delete rec.oneBonusCredit;
  }

  saveToLocalStorage();
  renderSavings();
  closeSavingsMonthModal();
  showToast(isActual ? `${monthLabel(month)} locked as actual.` : `${monthLabel(month)} deposit/withdrawal saved (forecast).`);
}

function revertSavingsMonth() {
  const month = document.getElementById('svmMonth').value;
  askConfirm(`Clear saved values for ${monthLabel(month)} and return it to a pure forecast?`, () => {
    database.savingsMonths = (database.savingsMonths || []).filter(r => r.month !== month);
    saveToLocalStorage();
    renderSavings();
    closeSavingsMonthModal();
    showToast('Reverted to forecast.', 'info');
  });
}

export {
  renderSavings, saveSavingsConfig, toggleSavingsSetup, toggleMonthBreakdown,
  onSavingsViewChange, savingsViewToday,
  openSavingsMonthModal, closeSavingsMonthModal, applySavingsActualMode,
  handleSavingsMonthSubmit, revertSavingsMonth,
  addDepositRow, addWithdrawRow, removeEntryRow, recomputeModalTotals
};

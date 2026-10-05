import { evaluateCashbackSimulation, getCashbackCycleDay, getCurrentCycleKey, getCycleBounds, getCycleStatus } from './calc.js';
import { renderCardsVault } from './cards.js';
import { renderCharts, renderSspnCharts } from './charts.js';
import { populateFilterBanksAndYears } from './dropdowns.js';
import { populateOptimizerDropdowns, runCashbackOptimization } from './optimizer.js';
import { renderSspnHistoryLedger } from './sspn.js';
import { currentFilterCard, currentInteractiveCardId, database, filterDeckCollapsed, setCurrentFilterCard, setCurrentInteractiveCardId } from './state.js';
import { deleteTx, openEditTxModal } from './transactions.js';
import { getNetworkIcon, getThemeStyles } from './ui.js';

        // The CC dashboard's Year / Month filter selects BILLING CYCLES, not calendar dates: a
        // transaction belongs to the cycle (t.cycleKey, "YYYY-MM") that ends in that month on its
        // card's own cut-off day. Picking Oct on a 16th -> 15th card covers 16 Sep -> 15 Oct.
        function inSelectedCycle(t, selectedYear, selectedMonth) {
            const key = t.cycleKey || '';
            return (selectedYear === "ALL" || key.slice(0, 4) === selectedYear)
                && (selectedMonth === "ALL" || key.slice(5, 7) === selectedMonth);
        }

        let allStackCollapsed = true;
        function toggleAllStackSummary() {
            allStackCollapsed = !allStackCollapsed;
            renderInteractiveInspectorContent();
        }

        // One line under the filters saying which dates the selected cycle really covers,
        // grouped by cut-off so a 17-card stack stays readable.
        function renderCycleHint() {
            const el = document.getElementById("filterCycleHint");
            if (!el) return;
            const selectedBank = document.getElementById("filterBank").value;
            const key = selectedPeriodKey();
            const cards = database.cards.filter(c => (selectedBank === "ALL" || c.bank === selectedBank) && (currentFilterCard === "ALL" || c.id === currentFilterCard));
            const groups = new Map();
            cards.forEach(c => {
                const b = getCycleBounds(key || getCurrentCycleKey(c), getCashbackCycleDay(c));
                const span = `${fmtDay(b.start)} → ${fmtDay(b.end)}`;
                if (!groups.has(span)) groups.set(span, { end: b.end, names: [] });
                groups.get(span).names.push(c.name);
            });
            const chips = [...groups.entries()].sort((a, b) => a[1].end - b[1].end).map(([span, g]) =>
                `<span title="${g.names.join(', ')}" class="px-2 py-0.5 rounded bg-gray-900 border border-gray-800 font-mono text-slate-300">${span} <span class="text-slate-500">· ${g.names.length === 1 ? g.names[0] : g.names.length + ' cards'}</span></span>`).join('');
            const y = document.getElementById("filterYear").value;
            const m = document.getElementById("filterMonth").value;
            const lead = key ? `<b class="text-indigo-300">${fmtPeriod(key)} cycle</b> covers:`
                : (y === "ALL" && m === "ALL") ? '<b class="text-indigo-300">All cycles</b> · card meters show the live cycle:'
                : `<b class="text-indigo-300">Cycles ending in ${m === "ALL" ? y : 'month ' + m}</b> · card meters show the live cycle:`;
            el.innerHTML = `<span class="text-slate-400">${lead}</span> ${chips}`;
        }

        function refreshLedgerAndCalculations() {
            populateFilterBanksAndYears();

            const selectedBank = document.getElementById("filterBank").value;
            const selectedYear = document.getElementById("filterYear").value;
            const selectedMonth = document.getElementById("filterMonth").value;
            const simulatedTxs = evaluateCashbackSimulation();

            let filteredTxs = simulatedTxs.filter(t => {
                const card = database.cards.find(c => c.id === t.cardId);
                const bankMatch = (selectedBank === "ALL" || (card && card.bank === selectedBank));
                const cardMatch = (currentFilterCard === "ALL" || t.cardId === currentFilterCard);
                return bankMatch && cardMatch && inSelectedCycle(t, selectedYear, selectedMonth);
            });

            filteredTxs.sort((a,b) => new Date(b.date) - new Date(a.date));

            const body = document.getElementById("transactionLedgerBody");
            if(body) {
                body.innerHTML = filteredTxs.map(t => {
                    const card = database.cards.find(c => c.id === t.cardId) || {name: t.cardId, bank: "", last4: "", network: ""};
                    const statusClass = t.isEligible 
                        ? "bg-emerald-950/40 text-emerald-400 border border-emerald-900/50" 
                        : "bg-rose-950/40 text-rose-400 border border-rose-900/50";
                    
                    const networkIcon = card.network ? getNetworkIcon(card.network) : '';
                    const bankPrefix = card.bank && !card.name.toLowerCase().startsWith(card.bank.toLowerCase()) ? `${card.bank} - ` : '';
                    const last4Suffix = card.last4 ? ` (•••• ${card.last4})` : '';
                    const sourceBadge = t.receiptId
                        ? `<span title="From receipt" class="text-[8px] bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 px-1.5 py-0.5 rounded font-bold"><i class="fa-solid fa-receipt"></i> Receipt</span>`
                        : `<span title="Manual entry" class="text-[8px] bg-slate-500/10 text-slate-400 border border-slate-500/20 px-1.5 py-0.5 rounded font-bold"><i class="fa-solid fa-pen"></i> Manual</span>`;
                    const remarkLine = t.remark ? `<div class="text-[9px] text-slate-500 italic">“${t.remark}”</div>` : '';

                    return `<tr class="hover:bg-gray-900/30 transition text-[11px]">
                        <td class="py-3 px-4 font-mono">${t.date}${t.cycleKey && t.cycleKey !== t.date.substring(0, 7) ? `<div class="text-[8px] text-indigo-400 font-sans font-semibold">${fmtPeriod(t.cycleKey)} cycle</div>` : ''}</td>
                        <td class="py-3 px-4 font-semibold text-slate-200">
                            <div class="flex items-center gap-1.5">
                                ${networkIcon}
                                <span>${bankPrefix}${card.name}${last4Suffix}</span>
                            </div>
                        </td>
                        <td class="py-3 px-4 text-indigo-400 font-medium">${t.category}</td>
                        <td class="py-3 px-4 text-slate-400 font-semibold">${t.internalTag}</td>
                        <td class="py-3 px-4 text-slate-400">${t.description}${remarkLine}</td>
                        <td class="py-3 px-4 text-center">${sourceBadge}</td>
                        <td class="py-3 px-4 text-right font-semibold">RM ${t.amount.toFixed(2)}</td>
                        <td class="py-3 px-4 text-right font-bold text-indigo-400 font-mono">RM ${t.calculatedCashback.toFixed(2)}</td>
                        <td class="py-3 px-4 text-center"><span class="text-[9px] font-bold px-2 py-0.5 rounded-md ${statusClass}">${t.statusMessage}</span></td>
                        <td class="py-3 px-4 text-center">
                            <div class="flex gap-1 justify-center">
                                <button onclick="openEditTxModal('${t.id}')" class="text-indigo-400 hover:text-indigo-300 p-1"><i class="fa-solid fa-pen-to-square"></i></button>
                                <button onclick="deleteTx('${t.id}')" class="text-rose-500 hover:text-rose-400 p-1"><i class="fa-solid fa-trash"></i></button>
                            </div>
                        </td>
                    </tr>`;
                }).join('');
            }

            let totalSpend = 0, totalCashback = 0;
            filteredTxs.forEach(t => { 
                totalSpend += t.amount; 
                totalCashback += t.calculatedCashback; 
            });
            const avgRate = totalSpend > 0 ? (totalCashback / totalSpend) * 100 : 0;

            document.getElementById("kpiTotalCashback").innerText = `RM ${totalCashback.toFixed(2)}`;
            document.getElementById("kpiTotalSpend").innerText = `RM ${totalSpend.toFixed(2)}`;
            document.getElementById("kpiAverageRate").innerText = `${avgRate.toFixed(2)}%`;
            
            let activeCardsCount = 0;
            if (currentFilterCard !== "ALL") {
                activeCardsCount = 1;
            } else {
                activeCardsCount = database.cards.filter(c => selectedBank === "ALL" || c.bank === selectedBank).length;
            }
            document.getElementById("kpiActiveCards").innerText = activeCardsCount;

            renderFilterDecks(simulatedTxs);
            renderCycleHint();
            renderCardsVault();
            renderInteractiveSelectorDeck();

            populateOptimizerDropdowns();
            runCashbackOptimization();

            // SSPN Specific Timeline filtering integration
            const selectedSspnYear = document.getElementById("sspnFilterYear").value;
            const selectedSspnMonth = document.getElementById("sspnFilterMonth").value;

            let filteredSspn = database.sspnRecords.filter(r => {
                const txYear = r.date.substring(0, 4);
                const txMonth = r.date.substring(5, 7);
                const yearMatch = (selectedSspnYear === "ALL" || txYear === selectedSspnYear);
                const monthMatch = (selectedSspnMonth === "ALL" || txMonth === selectedSspnMonth);
                return yearMatch && monthMatch;
            });

            renderSspnHistoryLedger(filteredSspn);

            let sspnDep = 0, sspnWith = 0;
            filteredSspn.forEach(r => {
                if(r.amount > 0) sspnDep += r.amount;
                else sspnWith += Math.abs(r.amount);
            });

            const netSavings = sspnDep - sspnWith;
            document.getElementById("sspnDashboardKpiNet").innerText = `RM ${netSavings.toFixed(2)}`;
            document.getElementById("sspnDashboardKpiDeposits").innerText = `RM ${sspnDep.toFixed(2)}`;
            document.getElementById("sspnDashboardKpiWithdrawals").innerText = `RM ${sspnWith.toFixed(2)}`;

            renderCharts(filteredTxs);
            renderSspnCharts(filteredSspn);

            // Maintain collapsible expanded filter deck state on render updates
            const panel = document.getElementById("collapsibleFilterDeck");
            const icon = document.getElementById("filterDeckToggleIcon");
            if (filterDeckCollapsed) {
                panel.classList.add("hidden");
                icon.className = "fa-solid fa-chevron-down text-slate-400 text-xs";
            } else {
                panel.classList.remove("hidden");
                icon.className = "fa-solid fa-chevron-up text-slate-400 text-xs";
            }
        }

        function renderFilterDecks(simulatedTxs) {
            const deck = document.getElementById("dashboardFilterDeck");
            const badgeContainer = document.getElementById("filterPillBadgeContainer");
            if(!deck) return;

            const selectedBank = document.getElementById("filterBank").value;
            const selectedYear = document.getElementById("filterYear").value;
            const selectedMonth = document.getElementById("filterMonth").value;

            // Generate "ALL STACK" default filter button
            let html = `<div onclick="setCardFilter('ALL')" class="glass-card rounded-xl p-3.5 cursor-pointer border transition text-center ${currentFilterCard === 'ALL' ? 'active-filter-card' : 'border-gray-800'}">
                <span class="text-[10px] font-black uppercase text-slate-300">All Stack</span>
                <h4 class="text-[9px] font-mono text-slate-500 mt-1">Multi-Card View</h4>
            </div>`;
            
            const filteredByBank = database.cards.filter(c => selectedBank === "ALL" || c.bank === selectedBank);

            // Premium dynamic active pill design in collapsed state showing the active card's bank color
            let selectedPillHtml = "";

            if (currentFilterCard === "ALL") {
                selectedPillHtml = `
                    <span class="text-[9px] font-bold px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 uppercase tracking-widest font-mono">
                        Consolidated stack (${filteredByBank.length} CC)
                    </span>
                `;
            }

            html += filteredByBank.map(c => {
                const styles = getThemeStyles(c.theme);
                const txs = simulatedTxs.filter(t => t.cardId === c.id && inSelectedCycle(t, selectedYear, selectedMonth));
                const span = getCycleBounds(selectedPeriodKey() || getCurrentCycleKey(c), getCashbackCycleDay(c));
                const totalCB = txs.reduce((sum, t) => sum + t.calculatedCashback, 0);
                const networkIcon = c.network ? getNetworkIcon(c.network) : '';
                const last4Suffix = c.last4 ? ` •• ${c.last4}` : '';
                const bankPrefix = c.bank ? `${c.bank} ` : '';

                if (currentFilterCard === c.id) {
                    selectedPillHtml = `
                        <span class="text-[9px] font-bold px-2 py-0.5 rounded ${styles.badge} uppercase tracking-widest font-mono flex items-center gap-1.5">
                            <span class="h-1.5 w-1.5 rounded-full ${styles.bg.replace('grad-', 'bg-').split(' ')[0]}"></span>
                            ${c.name} (${last4Suffix.trim()})
                        </span>
                    `;
                }

                return `<div onclick="setCardFilter('${c.id}')" class="glass-card rounded-xl p-3.5 cursor-pointer border transition ${styles.bg} ${currentFilterCard === c.id ? 'active-filter-card' : ''}">
                    <div class="flex items-center justify-between gap-1 mb-1">
                        <span class="text-[8px] font-extrabold uppercase px-1.5 py-0.5 rounded ${styles.badge} truncate max-w-[70%]">${c.id}</span>
                        <span class="text-xs">${networkIcon}</span>
                    </div>
                    <h4 class="text-[11px] font-bold text-slate-200 truncate" title="${bankPrefix}${c.name}">${c.name}</h4>
                    <div class="flex justify-between items-center mt-1">
                        <p class="text-[8px] font-mono text-slate-400">${last4Suffix}</p>
                        <p class="text-[10px] text-indigo-400 font-bold font-mono">RM ${totalCB.toFixed(2)}</p>
                    </div>
                    <p class="text-[8px] font-mono text-slate-500 mt-0.5">${fmtDay(span.start)}–${fmtDay(span.end)}</p>
                </div>`;
            }).join('');
            
            deck.innerHTML = html;
            if (badgeContainer) {
                badgeContainer.innerHTML = selectedPillHtml;
            }
        }

        function setCardFilter(cardId) {
            setCurrentFilterCard(cardId);
            setCurrentInteractiveCardId(cardId); // Direct sync linkage
            
            const activeFilterText = document.getElementById("activeFilterBadge");
            if(activeFilterText) {
                activeFilterText.innerText = cardId === "ALL" ? "All Cards Active" : `${cardId} Selected`;
            }

            refreshLedgerAndCalculations();
        }

        function loadCardInteractiveMeter(cardId) {
            setCurrentInteractiveCardId(cardId);
            setCurrentFilterCard(cardId); // Direct bidirectional link
            
            const activeFilterText = document.getElementById("activeFilterBadge");
            if (activeFilterText) {
                if (cardId === "ALL") {
                    activeFilterText.innerText = "All Cards Active";
                } else {
                    activeFilterText.innerText = `${cardId} Selected`;
                }
            }

            refreshLedgerAndCalculations();
        }

        /* Renders Single Card metrics or high-level Unified Multi-Card summary */

        function renderInteractiveSelectorDeck() {
            renderInteractiveInspectorContent();
        }

        /* Cashback period inspector. A card's cap / min-spend run per cashback period, which
           can straddle two calendar months (Muamalat EON: 16th -> 15th). The inspector therefore
           reads the Year + Month filter as "the period that ENDS in that month": picking Oct
           shows 16 Sep -> 15 Oct. With no specific month picked it shows the live period.
           The ledger, KPIs, charts and card tiles use the same cycles (inSelectedCycle). */

        const fmtRM = v => v === Infinity ? 'Unlimited' : `RM ${v.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const fmtDay = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        const fmtPeriod = key => { const [y, m] = key.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }); };

        // The cycle key picked by the filters, or null when Year/Month is "ALL".
        function selectedPeriodKey() {
            const y = document.getElementById("filterYear").value;
            const m = document.getElementById("filterMonth").value;
            return y !== "ALL" && m !== "ALL" ? `${y}-${m}` : null;
        }

        function cardPeriodStatus(card, simulatedTxs) {
            const key = selectedPeriodKey() || getCurrentCycleKey(card);
            return getCycleStatus(card, simulatedTxs, key);
        }

        function jumpToCyclePeriod(key) {
            const [y, m] = key.split('-');
            const yearSel = document.getElementById("filterYear");
            if (![...yearSel.options].some(o => o.value === y)) yearSel.add(new Option(y, y));
            yearSel.value = y;
            document.getElementById("filterMonth").value = m;
            refreshLedgerAndCalculations();
        }

        function periodVerdict(st) {
            const tone = {
                slate: 'bg-slate-500/10 text-slate-400 border border-slate-500/20',
                amber: 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
                rose: 'bg-rose-500/10 text-rose-400 border border-rose-500/20',
                emerald: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
            };
            const unused = fmtRM(st.cbLeft === Infinity ? st.cardCapLeft : st.cbLeft);
            if (st.phase === 'future') return { cls: 'text-slate-400', badge: tone.slate, label: 'Upcoming', text: 'Period has not started yet' };
            if (st.minSpendLeft > 0) return st.phase === 'past'
                ? { cls: 'text-amber-400', badge: tone.amber, label: 'Min Spend Missed', text: `Closed ${fmtRM(st.minSpendLeft)} short of the minimum spend` }
                : { cls: 'text-amber-400', badge: tone.amber, label: 'Locked (Under Minimum)', text: `Spend ${fmtRM(st.minSpendLeft)} more to unlock cashback` };
            if (st.isMaxed) return { cls: 'text-rose-400', badge: tone.rose, label: 'Maxed Out', text: st.phase === 'past' ? 'Cap fully used this period' : 'Maxed out — switch card until next period' };
            return st.phase === 'past'
                ? { cls: 'text-slate-400', badge: tone.slate, label: 'Closed', text: `Period closed with ${unused} of cap unused` }
                : { cls: 'text-emerald-400', badge: tone.emerald, label: 'Sweet Spot', text: 'Under cap — keep using this card' };
        }

        function phaseText(st) {
            if (st.phase === 'current') return `<b class="text-slate-200">${st.daysLeft} day${st.daysLeft === 1 ? '' : 's'} left</b>`;
            return st.phase === 'past' ? '<b class="text-slate-500">Closed</b>' : '<b class="text-slate-400">Upcoming</b>';
        }

        function ruleRestrictions(r) {
            const out = [];
            if (r.weekendOnly) out.push("Weekends");
            if (r.daysOnly) out.push(`Days: ${r.daysOnly}`);
            if (r.monthsOnly) out.push(`Months: ${r.monthsOnly}`);
            if (Array.isArray(r.capOverrides)) {
                r.capOverrides.forEach(ov => { if (ov && ov.months && ov.cap > 0) out.push(`Cap RM${ov.cap} in ${ov.months}`); });
            }
            return out;
        }

        function renderPeriodPanel(card, st) {
            const live = st.phase === 'current';
            const verdict = periodVerdict(st);
            const cbLeft = st.cbLeft === Infinity ? st.cardCapLeft : st.cbLeft;
            const capPct = st.cardCap !== Infinity && st.cardCap > 0 ? Math.min((st.earned / st.cardCap) * 100, 100) : 0;
            const spendPct = st.minSpend > 0 ? Math.min((st.spend / st.minSpend) * 100, 100) : 100;

            const liveKey = getCurrentCycleKey(card);
            const note = !selectedPeriodKey()
                ? `<p class="text-[9px] text-slate-500">No specific month selected — showing the live period.</p>`
                : liveKey !== st.cycleKey
                    ? `<p class="text-[9px] text-slate-500">Live period is ${fmtPeriod(liveKey)}. <button onclick="jumpToCyclePeriod('${liveKey}')" class="text-indigo-400 hover:text-indigo-300 font-semibold underline">View live quota</button></p>`
                    : '';

            const catHTML = st.rules.map(r => {
                const restrictions = ruleRestrictions(r.rule);
                const badge = restrictions.length ? `<span class="bg-indigo-950 text-indigo-400 text-[8px] px-1.5 py-0.2 rounded font-bold">${restrictions.join(" | ")}</span>` : "";
                const pct = r.catCap !== Infinity ? Math.min((r.earned / r.catCap) * 100, 100) : 100;
                const headroom = !r.active
                    ? '<span class="text-slate-600">not active this month</span>'
                    : live ? `${fmtRM(r.spendLeft)} spend · ${fmtRM(r.cbLeft)} CB left` : '';
                return `
                    <div class="space-y-1 bg-gray-950/40 p-3 rounded-lg border border-gray-800/40 font-mono ${r.active ? '' : 'opacity-60'}">
                        <div class="flex justify-between gap-2 text-[10px] text-slate-300 font-semibold font-sans">
                            <span>${r.category} <span class="text-slate-500 font-normal">(${(r.rate * 100).toFixed(1)}%)</span> ${badge}</span>
                            <span class="whitespace-nowrap">RM ${r.earned.toFixed(2)} / ${r.catCap !== Infinity ? 'RM ' + r.catCap.toFixed(0) : 'No Limit'}</span>
                        </div>
                        <div class="w-full bg-gray-950 h-1.5 rounded-full overflow-hidden border border-gray-900">
                            <div class="bg-violet-500 h-full rounded-full transition-all" style="width: ${pct}%"></div>
                        </div>
                        <div class="flex justify-between gap-2 text-[9px] text-slate-500 font-sans">
                            <span>${r.rule.merchants ? `<i class="fa-solid fa-store text-indigo-400"></i> ${r.rule.merchants}` : `Spent RM ${r.spend.toFixed(2)}`}</span>
                            <span class="font-mono text-slate-400 whitespace-nowrap">${headroom}</span>
                        </div>
                    </div>`;
            }).join('');

            const stat = (label, value, cls) => `
                <div>
                    <span class="text-[9px] uppercase tracking-wider text-slate-400 font-semibold">${label}</span>
                    <h2 class="text-lg font-bold font-mono ${cls}">${value}</h2>
                </div>`;

            return `
                <div class="bg-indigo-500/5 p-4 rounded-xl border border-indigo-500/25 space-y-3">
                    <div class="flex flex-wrap justify-between items-center gap-2">
                        <span class="text-[10px] font-bold uppercase tracking-wider text-indigo-300"><i class="fa-solid fa-calendar-day"></i> Cashback Period · ${fmtPeriod(st.cycleKey)}</span>
                        <span class="text-[10px] font-mono text-slate-400">${fmtDay(st.start)} → ${fmtDay(st.end)} · ${phaseText(st)}</span>
                    </div>
                    ${note}
                    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        ${stat('Spend Left to Max', live ? (st.isMaxed ? 'RM 0.00' : fmtRM(st.totalSpendLeft)) : '—', 'text-indigo-300')}
                        ${stat(live ? 'Cashback Left' : 'Cap Unused', fmtRM(cbLeft), 'text-emerald-400')}
                        ${stat('Earned / Cap', `RM ${st.earned.toFixed(2)}<span class="text-[10px] text-slate-500"> / ${st.cardCap === Infinity ? '∞' : 'RM ' + st.cardCap.toFixed(0)}</span>`, 'text-slate-100')}
                        ${stat('Daily Pace', live && !st.isMaxed && st.totalSpendLeft !== Infinity ? fmtRM(st.dailyPace) + '<span class="text-[10px] text-slate-500">/day</span>' : '—', 'text-violet-400')}
                    </div>
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 font-mono">
                        <div class="space-y-1">
                            <div class="flex justify-between text-[10px] text-slate-400 font-semibold">
                                <span>Min Spend</span>
                                <span>RM ${st.spend.toFixed(2)} / ${st.minSpend > 0 ? 'RM ' + st.minSpend.toFixed(0) : 'None'}</span>
                            </div>
                            <div class="w-full bg-gray-900 h-2 rounded-full overflow-hidden">
                                <div class="bg-indigo-500 h-full rounded-full transition-all" style="width: ${spendPct}%"></div>
                            </div>
                        </div>
                        <div class="space-y-1">
                            <div class="flex justify-between text-[10px] text-slate-400 font-semibold">
                                <span>Cashback Cap</span>
                                <span>RM ${st.earned.toFixed(2)} / ${st.cardCap !== Infinity ? 'RM ' + st.cardCap.toFixed(0) : 'Unlimited'}</span>
                            </div>
                            <div class="w-full bg-gray-900 h-2 rounded-full overflow-hidden">
                                <div class="bg-emerald-500 h-full rounded-full transition-all" style="width: ${capPct}%"></div>
                            </div>
                        </div>
                    </div>
                    <p class="text-[10px] font-semibold ${verdict.cls}">${verdict.text} <span class="text-slate-500 font-normal">· spent RM ${st.spend.toFixed(2)} this period</span></p>
                    <div class="space-y-2 pt-2 border-t border-gray-800/60">
                        <span class="text-[8px] uppercase tracking-widest text-slate-500 font-bold block font-sans">Category Breakdown</span>
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[220px] overflow-y-auto pr-1">
                            ${catHTML}
                        </div>
                    </div>
                </div>
            `;
        }

        function renderPeriodQuotaTable(statuses) {
            const key = selectedPeriodKey();
            const rows = statuses.map(({ card: c, st }) => {
                const verdict = periodVerdict(st);
                const cbLeft = st.cbLeft === Infinity ? st.cardCapLeft : st.cbLeft;
                const spendCell = st.phase !== 'current' ? verdict.label : st.minSpendLeft > 0 ? 'Locked' : st.isMaxed ? 'Maxed' : fmtRM(st.totalSpendLeft);
                return `
                    <tr class="border-b border-gray-900 text-[10px]">
                        <td class="py-2 pr-2 font-semibold text-slate-200 cursor-pointer hover:text-indigo-300" onclick="loadCardInteractiveMeter('${c.id}')">${c.name}</td>
                        <td class="py-2 pr-2 font-mono text-slate-400 whitespace-nowrap">${fmtDay(st.start)}–${fmtDay(st.end)} <span class="text-slate-500">(${st.phase === 'current' ? st.daysLeft + 'd' : st.phase})</span></td>
                        <td class="py-2 pr-2 font-mono text-slate-300 text-right whitespace-nowrap">RM ${st.earned.toFixed(2)}</td>
                        <td class="py-2 pr-2 font-mono text-emerald-400 text-right whitespace-nowrap">${fmtRM(cbLeft)}</td>
                        <td class="py-2 font-mono font-bold text-right whitespace-nowrap ${verdict.cls}">${spendCell}</td>
                    </tr>`;
            }).join('');
            return `
                <div class="bg-indigo-500/5 p-4 rounded-xl border border-indigo-500/25 space-y-2">
                    <span class="text-[10px] font-bold uppercase tracking-wider text-indigo-300"><i class="fa-solid fa-calendar-day"></i> Cashback Period — ${key ? `Ending ${fmtPeriod(key)}` : 'Live'}</span>
                    <div class="overflow-x-auto">
                        <table class="w-full text-left">
                            <thead><tr class="text-[8px] uppercase tracking-widest text-slate-500">
                                <th class="pb-1 pr-2">Card</th><th class="pb-1 pr-2">Period</th><th class="pb-1 pr-2 text-right">Earned</th><th class="pb-1 pr-2 text-right">CB Left</th><th class="pb-1 text-right">Spend Left</th>
                            </tr></thead>
                            <tbody>${rows}</tbody>
                        </table>
                    </div>
                </div>
            `;
        }

        function renderInteractiveInspectorContent() {
            const inspector = document.getElementById("interactiveInspectorContent");
            if (!inspector) return;

            const simulatedTxs = evaluateCashbackSimulation();
            const periodKey = selectedPeriodKey();
            const filterLabel = periodKey ? `Period ending ${fmtPeriod(periodKey)}` : 'Live period';

            if (currentInteractiveCardId === "ALL") {
                // RENDER: High-Level Unified Multi-Card Summary ("ALL STACK" Inspector Behavior)
                const selectedBank = document.getElementById("filterBank").value;
                const statuses = database.cards
                    .filter(c => selectedBank === "ALL" || c.bank === selectedBank)
                    .map(c => ({ card: c, st: cardPeriodStatus(c, simulatedTxs) }));

                const cbAvail = statuses.reduce((sum, x) => sum + (x.st.cbLeft === Infinity ? x.st.cardCapLeft : x.st.cbLeft), 0);
                const live = statuses.filter(x => x.st.phase === 'current');
                const maxed = live.filter(x => x.st.minSpendLeft <= 0 && x.st.isMaxed).length;
                const locked = live.filter(x => x.st.minSpendLeft > 0).length;
                const summary = [
                    `${statuses.length} card${statuses.length === 1 ? '' : 's'}`,
                    `<span class="text-emerald-400">${cbAvail === Infinity ? 'Unlimited' : fmtRM(cbAvail)} CB ${live.length ? 'left' : 'unused'}</span>`,
                    maxed ? `<span class="text-rose-400">${maxed} maxed</span>` : '',
                    locked ? `<span class="text-amber-400">${locked} locked</span>` : ''
                ].filter(Boolean).join(' · ');

                inspector.innerHTML = `
                    <div class="space-y-4">
                        <button onclick="toggleAllStackSummary()" class="w-full flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 text-left focus:outline-none ${allStackCollapsed ? '' : 'pb-2 border-b border-gray-800'}">
                            <div>
                                <h4 class="text-sm font-bold text-indigo-400 flex items-center gap-2">
                                    <i class="fa-solid fa-layer-group text-sm"></i>
                                    <span>Consolidated "All Stack" Summary</span>
                                </h4>
                                <span class="text-[9px] font-mono text-slate-500 uppercase tracking-widest">${filterLabel} · each card on its own billing cycle</span>
                            </div>
                            <span class="flex items-center gap-2 text-[10px] font-mono font-semibold text-slate-300">
                                ${summary}
                                <i class="fa-solid ${allStackCollapsed ? 'fa-chevron-down' : 'fa-chevron-up'} text-slate-400 text-xs"></i>
                            </span>
                        </button>

                        ${allStackCollapsed ? '' : renderPeriodQuotaTable(statuses)}
                    </div>
                `;
                return;
            }

            const card = database.cards.find(c => c.id === currentInteractiveCardId);
            if (!card) {
                inspector.innerHTML = `<div class="text-center py-10 text-slate-500 text-xs italic">Select a card to inspect.</div>`;
                return;
            }

            const st = cardPeriodStatus(card, simulatedTxs);
            const verdict = periodVerdict(st);

            inspector.innerHTML = `
                <div class="space-y-4 font-sans">
                    <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 pb-2 border-b border-gray-800">
                        <div>
                            <h4 class="text-sm font-bold text-slate-100 flex items-center gap-2">
                                ${getNetworkIcon(card.network)}
                                <span>${card.name}</span>
                            </h4>
                            <span class="text-[9px] font-mono text-slate-500 uppercase tracking-widest">${card.bank || 'CC'} •••• ${card.last4 || 'XXXX'} | Billing Day ${card.billingDay}${card.cashbackCycleEndDay > 0 && card.cashbackCycleEndDay !== card.billingDay ? ` | CB Period Ends Day ${card.cashbackCycleEndDay}` : ''}</span>
                        </div>
                        <span class="text-[9px] font-black uppercase px-2.5 py-1 rounded-md ${verdict.badge}">${verdict.label}</span>
                    </div>

                    ${renderPeriodPanel(card, st)}
                </div>
            `;
        }

// Default the CC, SSPN and Receipts filters to the current calendar month on first load.
// Older data is still reachable by changing the dropdowns.
function applyCurrentMonthDefaults() {
    const now = new Date();
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, '0');

    ['filterYear', 'sspnFilterYear', 'receiptFilterYear'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        if (![...el.options].some(o => o.value === year)) el.add(new Option(year, year));
        el.value = year;
    });
    ['filterMonth', 'sspnFilterMonth', 'receiptFilterMonth'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = month;
    });
}

export { refreshLedgerAndCalculations, renderFilterDecks, setCardFilter, loadCardInteractiveMeter, renderInteractiveSelectorDeck, renderInteractiveInspectorContent, applyCurrentMonthDefaults, jumpToCyclePeriod, toggleAllStackSummary };

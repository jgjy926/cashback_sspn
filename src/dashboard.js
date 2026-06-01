import { evaluateCashbackSimulation } from './calc.js';
import { renderCardsVault } from './cards.js';
import { renderCharts, renderSspnCharts } from './charts.js';
import { populateFilterBanksAndYears } from './dropdowns.js';
import { populateOptimizerDropdowns, runCashbackOptimization } from './optimizer.js';
import { renderSspnHistoryLedger } from './sspn.js';
import { currentFilterCard, currentInteractiveCardId, database, filterDeckCollapsed, setCurrentFilterCard, setCurrentInteractiveCardId } from './state.js';
import { deleteTx, openEditTxModal } from './transactions.js';
import { getNetworkIcon, getThemeStyles } from './ui.js';

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
                const txYear = t.date.substring(0, 4);
                const txMonth = t.date.substring(5, 7);
                const yearMatch = (selectedYear === "ALL" || txYear === selectedYear);
                const monthMatch = (selectedMonth === "ALL" || txMonth === selectedMonth);
                return bankMatch && cardMatch && yearMatch && monthMatch;
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
                        <td class="py-3 px-4 font-mono">${t.date}</td>
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
                const txs = simulatedTxs.filter(t => {
                    const cardMatch = t.cardId === c.id;
                    const txYear = t.date.substring(0, 4);
                    const txMonth = t.date.substring(5, 7);
                    const yearMatch = (selectedYear === "ALL" || txYear === selectedYear);
                    const monthMatch = (selectedMonth === "ALL" || txMonth === selectedMonth);
                    return cardMatch && yearMatch && monthMatch;
                });
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

        function renderInteractiveInspectorContent() {
            const inspector = document.getElementById("interactiveInspectorContent");
            if (!inspector) return;

            const selectedYear = document.getElementById("filterYear").value;
            const selectedMonth = document.getElementById("filterMonth").value;
            const simulatedTxs = evaluateCashbackSimulation();

            const filterLabel = (selectedMonth !== "ALL" ? selectedMonth : "All Months") + " " + (selectedYear !== "ALL" ? selectedYear : "All Years");

            if (currentInteractiveCardId === "ALL") {
                // RENDER: High-Level Unified Multi-Card Summary ("ALL STACK" Inspector Behavior)
                let totalConsolidatedSpend = 0;
                let totalConsolidatedCashback = 0;
                let totalRemainingCashbackQuota = 0;

                database.cards.forEach(c => {
                    const cardTxs = simulatedTxs.filter(t => {
                        const cardMatch = t.cardId === c.id;
                        const txYear = t.date.substring(0, 4);
                        const txMonth = t.date.substring(5, 7);
                        const yearMatch = (selectedYear === "ALL" || txYear === selectedYear);
                        const monthMatch = (selectedMonth === "ALL" || txMonth === selectedMonth);
                        return cardMatch && yearMatch && monthMatch;
                    });

                    const totalSpendOnCard = cardTxs.reduce((sum, t) => sum + t.amount, 0);
                    const totalCBOnCard = cardTxs.reduce((sum, t) => sum + t.calculatedCashback, 0);
                    totalConsolidatedSpend += totalSpendOnCard;
                    totalConsolidatedCashback += totalCBOnCard;

                    // World-Class QA Audit calculation: Calculate remaining available quota on a PER-RULE breakdown first, then overall card cap
                    let sumOfRemainingCategoryQuota = 0;
                    let hasUnlimitedCategory = false;

                    c.rules.forEach(r => {
                        const catTxs = cardTxs.filter(t => t.category === r.category);
                        const catCB = catTxs.reduce((sum, t) => sum + t.calculatedCashback, 0);
                        
                        if (r.categoryCap && r.categoryCap > 0) {
                            sumOfRemainingCategoryQuota += Math.max(0, r.categoryCap - catCB);
                        } else {
                            hasUnlimitedCategory = true;
                        }
                    });

                    const limitCap = c.cycleCashbackCap || Infinity;
                    const remainingCardOverall = limitCap !== Infinity ? Math.max(0, limitCap - totalCBOnCard) : Infinity;

                    let cardRemainingAllowed = 0;
                    if (hasUnlimitedCategory) {
                        cardRemainingAllowed = remainingCardOverall;
                    } else {
                        cardRemainingAllowed = Math.min(sumOfRemainingCategoryQuota, remainingCardOverall);
                    }

                    if (cardRemainingAllowed !== Infinity) {
                        totalRemainingCashbackQuota += cardRemainingAllowed;
                    } else {
                        totalRemainingCashbackQuota += 99999; 
                    }
                });

                const averageYield = totalConsolidatedSpend > 0 ? (totalConsolidatedCashback / totalConsolidatedSpend) * 100 : 0;
                const remainingQuotaText = totalRemainingCashbackQuota >= 99999 
                    ? "Unlimited / Infinite" 
                    : `RM ${totalRemainingCashbackQuota.toFixed(2)}`;

                inspector.innerHTML = `
                    <div class="space-y-4">
                        <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 pb-2 border-b border-gray-800">
                            <div>
                                <h4 class="text-sm font-bold text-indigo-400 flex items-center gap-2">
                                    <i class="fa-solid fa-layer-group text-sm"></i>
                                    <span>Consolidated "All Stack" Summary</span>
                                </h4>
                                <span class="text-[9px] font-mono text-slate-500 uppercase tracking-widest">Active Filters: ${filterLabel}</span>
                            </div>
                            <span class="text-[9px] font-black uppercase px-2.5 py-1 rounded-md bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 font-mono">Audit Standard: Per-Rule Cap Summed</span>
                        </div>

                        <!-- Consolidated Metrics Grid -->
                        <div class="grid grid-cols-2 gap-4">
                            <div class="bg-gray-950/60 p-4 rounded-xl border border-gray-800/80 space-y-1">
                                <span class="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Total Spend</span>
                                <h2 class="text-xl font-bold text-slate-100 font-mono">RM ${totalConsolidatedSpend.toFixed(2)}</h2>
                                <p class="text-[8px] text-slate-500">Combined ledger volumes</p>
                            </div>
                            <div class="bg-gray-950/60 p-4 rounded-xl border border-gray-800/80 space-y-1">
                                <span class="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Total Cash Back</span>
                                <h2 class="text-xl font-bold text-emerald-400 font-mono">RM ${totalConsolidatedCashback.toFixed(2)}</h2>
                                <p class="text-[8px] text-slate-500">Calculated earnings matches</p>
                            </div>
                            <div class="bg-gray-950/60 p-4 rounded-xl border border-gray-800/80 space-y-1">
                                <span class="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Cash Back Available</span>
                                <h2 class="text-xl font-bold text-indigo-400 font-mono">${remainingQuotaText}</h2>
                                <p class="text-[8px] text-slate-500 font-sans">Summed remaining tier breakdowns</p>
                            </div>
                            <div class="bg-gray-950/60 p-4 rounded-xl border border-gray-800/80 space-y-1">
                                <span class="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Average Wallet Yield</span>
                                <h2 class="text-xl font-bold text-violet-400 font-mono">${averageYield.toFixed(2)}%</h2>
                                <p class="text-[8px] text-slate-500 font-sans">Combined efficiency rating</p>
                            </div>
                        </div>

                        <div class="p-3 bg-gray-950 border border-gray-800 rounded-xl flex items-center gap-1.5 text-[10px] text-slate-400 leading-relaxed font-sans">
                            <i class="fa-solid fa-circle-info text-indigo-400"></i>
                            <span>You are looking at high-level consolidated metrics. Expand the "Filter Workspace View" above and tap any single card to isolate individual parameters.</span>
                        </div>
                    </div>
                `;
                return;
            }

            const card = database.cards.find(c => c.id === currentInteractiveCardId);
            if (!card) {
                inspector.innerHTML = `<div class="text-center py-10 text-slate-500 text-xs italic">Select a card to inspect.</div>`;
                return;
            }

            const cardTxs = simulatedTxs.filter(t => {
                const cardMatch = t.cardId === card.id;
                const txYear = t.date.substring(0, 4);
                const txMonth = t.date.substring(5, 7);
                const yearMatch = (selectedYear === "ALL" || txYear === selectedYear);
                const monthMatch = (selectedMonth === "ALL" || txMonth === selectedMonth);
                return cardMatch && yearMatch && monthMatch;
            });

            const totalSpend = cardTxs.reduce((sum, t) => sum + t.amount, 0);
            const totalCB = cardTxs.reduce((sum, t) => sum + t.calculatedCashback, 0);
            const minReq = card.cycleMinSpend || 0;
            const limitCap = card.cycleCashbackCap || Infinity;

            const spendPercent = minReq > 0 ? Math.min((totalSpend / minReq) * 100, 100) : 100;
            const capPercent = limitCap !== Infinity ? Math.min((totalCB / limitCap) * 100, 100) : 0;
            const hasUnlocked = totalSpend >= minReq;

            // Gauge Status Flag
            let rangeStatusClass = "bg-amber-500/10 text-amber-400 border border-amber-500/20";
            let rangeStatusText = "Locked Range (Under Minimum)";
            let rangeSuggestion = `Spend RM ${(minReq - totalSpend).toFixed(2)} more to unlock premium yields.`;

            if (hasUnlocked) {
                if (limitCap !== Infinity && totalCB >= limitCap) {
                    rangeStatusClass = "bg-rose-500/10 text-rose-400 border border-rose-500/20 animate-pulse";
                    rangeStatusText = "Maxed Out (Capped Yields)";
                    rangeSuggestion = "⚠️ Maximum monthly cashback cap has been reached. Swap to another card immediately.";
                } else {
                    rangeStatusClass = "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20";
                    rangeStatusText = "Optimized Range (Sweet Spot)";
                    rangeSuggestion = limitCap !== Infinity 
                        ? `Yield active. You have RM ${(limitCap - totalCB).toFixed(2)} left in this cycle's cashback quota.`
                        : "Yield active with unlimited cashback yield available!";
                }
            }

            // Category Limit Items
            let catHTML = "";
            card.rules.forEach(r => {
                const catTxs = cardTxs.filter(t => t.category === r.category);
                const catCB = catTxs.reduce((sum, t) => sum + t.calculatedCashback, 0);
                let ruleSpec = r.categoryCap > 0 ? `Limit: RM ${r.categoryCap}` : "No Limit";
                let percent = r.categoryCap > 0 ? Math.min((catCB / r.categoryCap) * 100, 100) : 100;
                
                let restrictions = [];
                if (r.weekendOnly) restrictions.push("Weekends");
                if (r.daysOnly) restrictions.push(`Days: ${r.daysOnly}`);
                if (r.monthsOnly) restrictions.push(`Months: ${r.monthsOnly}`);
                const restrictBadge = restrictions.length > 0 ? `<span class="bg-indigo-950 text-indigo-400 text-[8px] px-1.5 py-0.2 rounded font-bold">${restrictions.join(" | ")}</span>` : "";

                catHTML += `
                    <div class="space-y-1 bg-gray-950/40 p-3 rounded-lg border border-gray-800/40 font-mono">
                        <div class="flex justify-between text-[10px] text-slate-300 font-semibold font-sans">
                            <span>${r.category} ${restrictBadge}</span>
                            <span>RM ${catCB.toFixed(2)} / ${ruleSpec}</span>
                        </div>
                        <div class="w-full bg-gray-950 h-1.5 rounded-full overflow-hidden border border-gray-900">
                            <div class="bg-violet-500 h-full rounded-full transition-all" style="width: ${percent}%"></div>
                        </div>
                        ${r.merchants ? `<div class="text-[9px] text-slate-500 flex items-center gap-1 mt-1 font-sans"><i class="fa-solid fa-store text-indigo-400"></i> ${r.merchants}</div>` : ""}
                    </div>
                `;
            });

            inspector.innerHTML = `
                <div class="space-y-4 font-sans">
                    <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 pb-2 border-b border-gray-800">
                        <div>
                            <h4 class="text-sm font-bold text-slate-100 flex items-center gap-2">
                                ${getNetworkIcon(card.network)}
                                <span>${card.name}</span>
                            </h4>
                            <span class="text-[9px] font-mono text-slate-500 uppercase tracking-widest">${card.bank || 'CC'} •••• ${card.last4 || 'XXXX'} | Billing Day ${card.billingDay}</span>
                        </div>
                        <span class="text-[9px] font-black uppercase px-2.5 py-1 rounded-md ${rangeStatusClass}">${rangeStatusText}</span>
                    </div>

                    <!-- Meters Grid -->
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 font-sans">
                        <div class="bg-gray-950/60 p-3 rounded-xl border border-gray-800/80 space-y-2">
                            <div class="flex justify-between text-[10px] text-slate-400 font-semibold font-mono">
                                <span>Cycle Spending Requirement</span>
                                <span>RM ${totalSpend.toFixed(2)} / ${minReq > 0 ? 'RM ' + minReq.toFixed(0) : 'None'}</span>
                            </div>
                            <div class="w-full bg-gray-900 h-2.5 rounded-full overflow-hidden">
                                <div class="bg-indigo-500 h-full rounded-full transition-all" style="width: ${spendPercent}%"></div>
                            </div>
                        </div>

                        <div class="bg-gray-950/60 p-3 rounded-xl border border-gray-800/80 space-y-2">
                            <div class="flex justify-between text-[10px] text-slate-400 font-semibold font-mono">
                                <span>Overall Cashback Cap Quota</span>
                                <span>RM ${totalCB.toFixed(2)} / ${limitCap !== Infinity ? 'RM ' + limitCap.toFixed(0) : 'Unlimited'}</span>
                            </div>
                            <div class="w-full bg-gray-900 h-2.5 rounded-full overflow-hidden">
                                <div class="bg-emerald-500 h-full rounded-full transition-all" style="width: ${limitCap !== Infinity ? capPercent : 0}%"></div>
                            </div>
                        </div>
                    </div>

                    <div class="p-3 bg-gray-950 border border-gray-800 rounded-xl">
                        <p class="text-[10px] text-slate-300 italic flex items-center gap-1.5 leading-relaxed font-sans">
                            <i class="fa-solid fa-lightbulb text-amber-400"></i>
                            ${rangeSuggestion}
                        </p>
                    </div>

                    <!-- Category cap breaks -->
                    <div class="space-y-2">
                        <span class="text-[8px] uppercase tracking-widest text-slate-500 font-bold block font-sans">Internal Category Limit Breakdown</span>
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[160px] overflow-y-auto pr-1">
                            ${catHTML}
                        </div>
                    </div>
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

export { refreshLedgerAndCalculations, renderFilterDecks, setCardFilter, loadCardInteractiveMeter, renderInteractiveSelectorDeck, renderInteractiveInspectorContent, applyCurrentMonthDefaults };

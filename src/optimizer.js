import { evaluateCashbackSimulation, getTransactionCycle } from './calc.js';
import { database } from './state.js';
import { getNetworkIcon, getThemeStyles, showToast, switchTab } from './ui.js';

        function populateOptimizerDropdowns() {
            const optCat = document.getElementById("optCategory");
            if (optCat) {
                const prevVal = optCat.value;
                const categories = database.settings.optimizerCategories || ["Other Spending"];
                optCat.innerHTML = categories.map(cat => `<option value="${cat}">${cat}</option>`).join('');
                if (prevVal && categories.includes(prevVal)) {
                    optCat.value = prevVal;
                }
            }
        }

        function runCashbackOptimization() {
            const amtInput = document.getElementById("optAmount");
            const catInput = document.getElementById("optCategory");
            const merchantInput = document.getElementById("optMerchant");
            const container = document.getElementById("optimizerRecommendations");
            if (!amtInput || !catInput || !container) return;

            const spendAmount = parseFloat(amtInput.value) || 0;
            const selectedCat = catInput.value;
            const merchantSearch = merchantInput ? merchantInput.value.trim().toLowerCase() : "";

            if (spendAmount <= 0) {
                container.innerHTML = `<div class="text-[11px] text-slate-500 italic text-center py-4 bg-gray-900/10 rounded-xl">Please enter a valid spending amount above RM 0.00</div>`;
                return;
            }

            const simulatedTxs = evaluateCashbackSimulation(); 
            const cardBillingCycleStats = {};
            const todayStr = new Date().toISOString().split('T')[0];
            const dateObj = new Date(todayStr.replace(/-/g, "/"));
            const currentDayOfMonth = dateObj.getDate();
            const currentDayOfWeek = dateObj.getDay(); 
            const isWeekend = (currentDayOfWeek === 0 || currentDayOfWeek === 6);

            database.cards.forEach(c => {
                const cycleKey = getTransactionCycle(todayStr, c.billingDay);
                const cardTxs = simulatedTxs.filter(t => t.cardId === c.id && getTransactionCycle(t.date, c.billingDay) === cycleKey);
                const accumCB = cardTxs.reduce((sum, t) => sum + t.calculatedCashback, 0);
                const accumSpend = cardTxs.reduce((sum, t) => sum + t.amount, 0);

                const categoryAccum = {};
                cardTxs.forEach(t => {
                    categoryAccum[t.category] = (categoryAccum[t.category] || 0) + t.calculatedCashback;
                });

                cardBillingCycleStats[c.id] = {
                    accumCB: accumCB,
                    accumSpend: accumSpend,
                    categoryAccum: categoryAccum
                };
            });

            const results = [];

            database.cards.forEach(c => {
                const stats = cardBillingCycleStats[c.id];
                const totalSpendWithNew = stats.accumSpend + spendAmount;

                // FIXED QA BUG: Filter rules where the selected category is explicitly found inside standardCategories. Avoid irrelevant fallbacks!
                const matchedRules = (c.rules || []).filter(r => {
                    const activeCats = Array.isArray(r.standardCategories) ? r.standardCategories : (r.standardCategory ? [r.standardCategory] : []);
                    return activeCats.includes(selectedCat);
                });

                if (matchedRules.length === 0) {
                    // Omit this card completely if no exact rule configuration matches this selected category!
                    return;
                }

                let bestMatchedRule = matchedRules[0];
                let ruleSource = "exact";

                if (merchantSearch) {
                    const merchantMatch = matchedRules.find(r => r.merchants && r.merchants.toLowerCase().includes(merchantSearch));
                    if (merchantMatch) {
                        bestMatchedRule = merchantMatch;
                        ruleSource = "merchant";
                    }
                }

                let eligible = true;
                let rejectReason = "";
                let potentialRate = bestMatchedRule.rate || 0;

                let hasMinSpendMatch = true;
                let hasCategoryCapMatch = true;
                let hasOverallCapMatch = true;
                let hasDayConstraintMatch = true;

                if (spendAmount < (bestMatchedRule.minTxSpend || 0)) {
                    eligible = false;
                    hasMinSpendMatch = false;
                    rejectReason = `Tx < Min RM ${bestMatchedRule.minTxSpend}`;
                }

                if (eligible && totalSpendWithNew < (c.cycleMinSpend || 0)) {
                    if (bestMatchedRule.tiered && bestMatchedRule.tiers && bestMatchedRule.tiers.length > 0) {
                        const sortedTiers = [...bestMatchedRule.tiers].sort((a,b) => b.minSpend - a.minSpend);
                        const matchedTier = sortedTiers.find(tier => totalSpendWithNew >= tier.minSpend);
                        potentialRate = matchedTier ? matchedTier.rate : (bestMatchedRule.rate || 0);
                    } else {
                        eligible = false;
                        hasMinSpendMatch = false;
                        rejectReason = `Cycle < RM ${c.cycleMinSpend}`;
                    }
                }

                if (eligible && bestMatchedRule.weekendOnly && !isWeekend) {
                    eligible = false;
                    hasDayConstraintMatch = false;
                    rejectReason = "Weekends only";
                }

                if (eligible && bestMatchedRule.daysOnly) {
                    const allowedDays = bestMatchedRule.daysOnly.split(',').map(d => parseInt(d.trim())).filter(d => !isNaN(d));
                    if (allowedDays.length > 0 && !allowedDays.includes(currentDayOfMonth)) {
                        eligible = false;
                        hasDayConstraintMatch = false;
                        rejectReason = `Requires Day ${bestMatchedRule.daysOnly}`;
                    }
                }

                if (eligible && bestMatchedRule.monthsOnly) {
                    const transMonth = String(new Date().getMonth() + 1).padStart(2, '0');
                    const allowedMonths = bestMatchedRule.monthsOnly.split(',').map(m => m.trim().padStart(2, '0'));
                    if (allowedMonths.length > 0 && !allowedMonths.includes(transMonth)) {
                        eligible = false;
                        hasDayConstraintMatch = false;
                        rejectReason = `Requires Month ${bestMatchedRule.monthsOnly}`;
                    }
                }

                let cashbackEarned = 0;
                if (eligible) {
                    if (bestMatchedRule.tiered && bestMatchedRule.tiers && bestMatchedRule.tiers.length > 0) {
                        const sortedTiers = [...bestMatchedRule.tiers].sort((a,b) => b.minSpend - a.minSpend);
                        const matchedTier = sortedTiers.find(tier => totalSpendWithNew >= tier.minSpend);
                        potentialRate = matchedTier ? matchedTier.rate : (bestMatchedRule.rate || 0);
                    }

                    const rawPotentialCB = spendAmount * potentialRate;
                    const catCapMax = (bestMatchedRule.categoryCap !== undefined && bestMatchedRule.categoryCap > 0) ? bestMatchedRule.categoryCap : Infinity;
                    const cardCapMax = (c.cycleCashbackCap !== undefined && c.cycleCashbackCap > 0) ? c.cycleCashbackCap : Infinity;

                    const currentCatCB = stats.categoryAccum[bestMatchedRule.category] || 0;
                    const currentCardCB = stats.accumCB;

                    const allowedByCat = Math.max(0, catCapMax - currentCatCB);
                    const allowedByCard = Math.max(0, cardCapMax - currentCardCB);

                    cashbackEarned = Math.min(rawPotentialCB, allowedByCat, allowedByCard);

                    if (allowedByCat <= 0) hasCategoryCapMatch = false;
                    if (allowedByCard <= 0) hasOverallCapMatch = false;

                    if (cashbackEarned <= 0 && rawPotentialCB > 0) {
                        eligible = false;
                        rejectReason = allowedByCat <= 0 ? "Category Cap reached" : "Overall Cap reached";
                    } else if (cashbackEarned < rawPotentialCB) {
                        rejectReason = allowedByCat < allowedByCard ? "Partially Category Capped" : "Partially Overall Capped";
                    }
                }

                results.push({
                    card: c,
                    rule: bestMatchedRule,
                    rate: potentialRate,
                    cashbackEarned: cashbackEarned,
                    eligible: eligible,
                    rejectReason: rejectReason,
                    ruleSource: ruleSource,
                    diagnostics: {
                        minSpend: hasMinSpendMatch,
                        catCap: hasCategoryCapMatch,
                        overallCap: hasOverallCapMatch,
                        dayRule: hasDayConstraintMatch
                    }
                });
            });

            results.sort((a, b) => {
                if (a.eligible && !b.eligible) return -1;
                if (!a.eligible && b.eligible) return 1;
                if (a.eligible && b.eligible) {
                    return b.cashbackEarned - a.cashbackEarned;
                }
                return 0;
            });

            let html = "";
            
            if (results.length === 0) {
                container.innerHTML = `
                    <div class="text-center py-8 bg-gray-900/25 border border-dashed border-gray-800 rounded-xl space-y-2">
                        <i class="fa-solid fa-face-frown text-slate-500 text-xl"></i>
                        <p class="text-xs text-slate-400 font-semibold">No specialized card config rules found mapping explicitly to "${selectedCat}".</p>
                        <p class="text-[10px] text-slate-500 leading-relaxed max-w-sm mx-auto">Please add a standard category mapping rule under system settings to analyze prospective cashback on this wallet stack.</p>
                    </div>
                `;
                return;
            }

            results.forEach((res, idx) => {
                const styles = getThemeStyles(res.card.theme);
                const netIcon = res.card.network ? getNetworkIcon(res.card.network) : '';
                const last4Text = res.card.last4 ? `•••• ${res.card.last4}` : '';
                const bankPrefix = res.card.bank ? `${res.card.bank} ` : '';
                const recBadge = idx === 0 && res.eligible && res.cashbackEarned > 0
                    ? `<span class="bg-emerald-500 text-slate-950 px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-wider flex items-center gap-1 animate-pulse"><i class="fa-solid fa-star"></i> Recommended Stack</span>`
                    : '';

                const rateText = `${(res.rate * 100).toFixed(1)}%`;
                const yieldVal = res.eligible ? `+RM ${res.cashbackEarned.toFixed(2)}` : 'RM 0.00';
                const capStats = cardBillingCycleStats[res.card.id];
                
                const maxOverall = res.card.cycleCashbackCap || Infinity;
                const remainingOverall = maxOverall !== Infinity ? Math.max(0, maxOverall - capStats.accumCB) : Infinity;
                const overallQuotaText = maxOverall !== Infinity ? `Overall: RM ${remainingOverall.toFixed(2)} left` : 'Overall: Unlimited';

                const maxCat = res.rule.categoryCap || 0;
                const currentCatCB = capStats.categoryAccum[res.rule.category] || 0;
                const remainingCat = maxCat > 0 ? Math.max(0, maxCat - currentCatCB) : Infinity;
                const catQuotaText = maxCat > 0 ? `Category: RM ${remainingCat.toFixed(2)} left` : '';

                const getDiagIcon = (status) => status 
                    ? '<i class="fa-solid fa-circle-check text-emerald-400"></i>' 
                    : '<i class="fa-solid fa-circle-xmark text-rose-400"></i>';

                html += `
                    <div class="flex flex-col p-4 rounded-xl border bg-gray-950/40 hover:bg-gray-950/80 transition duration-150 gap-3 ${idx === 0 && res.eligible && res.cashbackEarned > 0 ? 'border-indigo-500/50 shadow-md shadow-indigo-500/5' : 'border-gray-800/60'}">
                        <div class="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                            <div class="flex items-center gap-3 flex-1 min-w-0">
                                <div class="w-1.5 h-10 rounded-full ${styles.bg}"></div>
                                
                                <div class="space-y-0.5 flex-1 min-w-0">
                                    <div class="flex flex-wrap items-center gap-1.5">
                                        ${netIcon}
                                        <span class="text-xs font-bold text-slate-200 truncate">${bankPrefix}${res.card.name}</span>
                                        <span class="text-[9px] font-mono text-slate-500">${last4Text}</span>
                                        ${recBadge}
                                    </div>
                                    <div class="text-[10px] text-slate-400 flex flex-wrap items-center gap-1.5">
                                        <span class="font-semibold text-indigo-400">Rule: "${res.rule.category}"</span>
                                        <span class="text-slate-500">•</span>
                                        <span class="font-medium text-slate-300">Rate: ${rateText}</span>
                                        ${res.ruleSource === 'merchant' ? '<span class="text-[8px] bg-indigo-500/10 text-indigo-300 px-1.5 rounded">Merchant Promo</span>' : ''}
                                    </div>
                                    <div class="text-[9px] text-slate-500 flex flex-wrap items-center gap-1.5 font-mono">
                                        <span>${overallQuotaText}</span>
                                        ${catQuotaText ? `<span>•</span> <span>${catQuotaText}</span>` : ''}
                                    </div>
                                </div>
                            </div>

                            <div class="flex sm:flex-col items-center sm:items-end justify-between sm:justify-center border-t sm:border-t-0 border-gray-800 pt-2 sm:pt-0 gap-1.5 min-w-[100px]">
                                ${res.eligible 
                                    ? `
                                        <span class="text-xs text-slate-500 sm:block hidden font-medium">Est. Yield</span>
                                        <span class="text-sm font-black text-emerald-400">${yieldVal}</span>
                                      ` 
                                    : `
                                        <span class="text-xs text-slate-500 sm:block hidden font-medium">Ineligible</span>
                                        <span class="text-[10px] font-bold px-2 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20 max-w-full truncate" title="${res.rejectReason}">${res.rejectReason}</span>
                                      `
                                }
                            </div>
                        </div>

                        <!-- Diagnostic Checkmarks -->
                        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-gray-950 text-[9px] text-slate-400 font-mono">
                            <div class="flex items-center gap-1.5">
                                ${getDiagIcon(res.diagnostics.minSpend)}
                                <span>Spend Levels</span>
                            </div>
                            <div class="flex items-center gap-1.5">
                                ${getDiagIcon(res.diagnostics.catCap)}
                                <span>Category Cap</span>
                            </div>
                            <div class="flex items-center gap-1.5">
                                ${getDiagIcon(res.diagnostics.overallCap)}
                                <span>Overall Cap</span>
                            </div>
                            <div class="flex items-center gap-1.5">
                                ${getDiagIcon(res.diagnostics.dayRule)}
                                <span>Constraint Status</span>
                            </div>
                        </div>
                    </div>
                `;
            });

            container.innerHTML = html;
        }

        function renderCashbackCheatSheet() {
            // Matrix Cheat-sheet UI Removed per QA request to declutter mobile workspace!
        }

        function autofillOptimizer(categoryName) {
            switchTab('cashbackOptimizer');
            const catInput = document.getElementById("optCategory");
            if (catInput) {
                catInput.value = categoryName;
                runCashbackOptimization();
                showToast(`Optimizer matched to standard category: "${categoryName}"`);
            }
        }

        /* Direct Bidirectional Interface with Filter Deck */

export { populateOptimizerDropdowns, runCashbackOptimization, renderCashbackCheatSheet, autofillOptimizer };

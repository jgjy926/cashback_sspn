import { database } from './state.js';

        // Resolve the effective category cap for a given calendar month (option a: keyed by
        // the transaction's month). capOverrides is an optional array of { months, cap }, e.g.
        // [{ months: "03,04", cap: 100 }] meaning RM100 in Mar/Apr. The first override whose
        // month list contains monthStr ("MM") wins; otherwise the base categoryCap applies.
        // Returns a raw number where 0 means "unlimited" (callers convert to Infinity).
        function resolveCategoryCap(rule, monthStr) {
            const base = (rule.categoryCap !== undefined && rule.categoryCap > 0) ? rule.categoryCap : 0;
            if (Array.isArray(rule.capOverrides)) {
                for (const ov of rule.capOverrides) {
                    if (!ov || !ov.months) continue;
                    const months = ov.months.split(',').map(m => m.trim().padStart(2, '0')).filter(Boolean);
                    if (months.includes(monthStr)) {
                        return (ov.cap !== undefined && ov.cap > 0) ? ov.cap : base;
                    }
                }
            }
            return base;
        }

        function getTransactionCycle(txDateStr, billingDay) {
            const date = new Date(txDateStr);
            const y = date.getFullYear();
            const m = date.getMonth(); 
            const d = date.getDate();

            let cycleYear = y;
            let cycleMonth = m; 

            if (d > billingDay) {
                cycleMonth += 1;
                if (cycleMonth > 11) {
                    cycleMonth = 0;
                    cycleYear += 1;
                }
            }
            const mm = String(cycleMonth + 1).padStart(2, '0');
            return `${cycleYear}-${mm}`;
        }

        // The day-of-month the CASHBACK period ends on. Some cards cap cashback on a window
        // that differs from the statement date (e.g. Muamalat EON: 16th -> 15th while the
        // statement is cut on the 25th). cashbackCycleEndDay overrides billingDay for all
        // cap / min-spend grouping; when unset, cashback follows the statement cycle.
        function getCashbackCycleDay(card) {
            if (!card) return 15;
            if (card.cashbackCycleEndDay > 0) return card.cashbackCycleEndDay;
            return card.billingDay || 15;
        }

        function localDateStr(d) {
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        }

        // Inclusive start/end dates of a cycle key ("YYYY-MM") for a given end day. Mirrors
        // getTransactionCycle: the cycle ends on endDay of its month (clamped to month length,
        // since a day > endDay never exists then) and starts the day after the previous one ends.
        function getCycleBounds(cycleKey, endDay) {
            const [y, m] = cycleKey.split('-').map(Number);
            const dim = (yy, mm) => new Date(yy, mm, 0).getDate(); // mm is 1-based here
            const end = new Date(y, m - 1, Math.min(endDay, dim(y, m)));
            const py = m === 1 ? y - 1 : y;
            const pm = m === 1 ? 12 : m - 1;
            const start = new Date(py, pm - 1, Math.min(endDay, dim(py, pm)) + 1);
            return { start, end, startStr: localDateStr(start), endStr: localDateStr(end) };
        }

        // Snapshot of one cashback period of a card (cycleKey = the month the period ENDS in,
        // e.g. "2026-10" for 16 Sep -> 15 Oct): what has been earned, what cap is left, and --
        // the part a bare "RM left" can't answer -- how much more qualifying spend it takes to
        // max the period out (cashback left / rate, per rule, bounded by the card cap).
        // phase is 'current' | 'past' | 'future' relative to `now`; headroom on a past period
        // is reported but can no longer be used.
        function getCycleStatus(card, simulatedTxs, cycleKey, now = new Date()) {
            const endDay = getCashbackCycleDay(card);
            const bounds = getCycleBounds(cycleKey, endDay);
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const phase = today > bounds.end ? 'past' : today < bounds.start ? 'future' : 'current';
            const daysTotal = Math.round((bounds.end - bounds.start) / 86400000) + 1;
            const daysLeft = phase === 'past' ? 0
                : phase === 'future' ? daysTotal
                : Math.round((bounds.end - today) / 86400000) + 1; // includes today

            const txs = simulatedTxs.filter(t => t.cardId === card.id && t.cycleKey === cycleKey);
            const spend = txs.reduce((s, t) => s + t.amount, 0);
            const earned = txs.reduce((s, t) => s + t.calculatedCashback, 0);
            const cardCap = card.cycleCashbackCap > 0 ? card.cycleCashbackCap : Infinity;
            const cardCapLeft = Math.max(0, cardCap - earned);
            const minSpend = card.cycleMinSpend || 0;
            const minSpendLeft = Math.max(0, minSpend - spend);
            // Month used for monthsOnly / capOverrides: today's while the period is live (that is
            // the month new spend would land in), otherwise the period's end month.
            const monthStr = phase === 'current' ? String(now.getMonth() + 1).padStart(2, '0') : cycleKey.slice(5, 7);

            const rules = (card.rules || []).map(r => {
                const ruleTxs = txs.filter(t => t.category === r.category);
                const ruleEarned = ruleTxs.reduce((s, t) => s + t.calculatedCashback, 0);
                const ruleSpend = ruleTxs.reduce((s, t) => s + t.amount, 0);
                let rate = r.rate || 0;
                if (r.tiered && Array.isArray(r.tiers) && r.tiers.length > 0) {
                    const tier = [...r.tiers].sort((a, b) => b.minSpend - a.minSpend).find(tr => spend >= tr.minSpend);
                    if (tier) rate = tier.rate;
                }
                let active = true;
                if (r.monthsOnly) {
                    const months = r.monthsOnly.split(',').map(m => m.trim().padStart(2, '0'));
                    active = months.includes(monthStr);
                }
                const catCapRaw = resolveCategoryCap(r, monthStr);
                const catCap = catCapRaw > 0 ? catCapRaw : Infinity;
                const catLeft = Math.max(0, catCap - ruleEarned);
                const cbLeft = active ? Math.min(catLeft, cardCapLeft) : 0;
                const spendLeft = rate > 0 ? cbLeft / rate : 0;
                return { rule: r, category: r.category, rate, active, earned: ruleEarned, spend: ruleSpend, catCap, catLeft, cbLeft, spendLeft };
            });

            // Total qualifying spend left: fill the best-rate rules first, each limited by its
            // own category headroom and by whatever card-level cap remains after the previous.
            let capPool = cardCapLeft;
            let totalSpendLeft = 0;
            [...rules].filter(r => r.active && r.rate > 0).sort((a, b) => b.rate - a.rate).forEach(r => {
                const take = Math.min(r.catLeft, capPool);
                if (take === Infinity) { totalSpendLeft = Infinity; return; }
                totalSpendLeft += take / r.rate;
                capPool -= take;
            });

            const cbLeft = Math.min(cardCapLeft, rules.reduce((s, r) => s + r.cbLeft, 0));
            const isMaxed = (cardCap !== Infinity && cardCapLeft <= 0.005) || (rules.length > 0 && totalSpendLeft <= 0.005);

            return {
                cycleKey, endDay, ...bounds, phase, daysTotal, daysLeft,
                spend, earned, cardCap, cardCapLeft, cbLeft,
                minSpend, minSpendLeft,
                totalSpendLeft,
                dailyPace: totalSpendLeft !== Infinity && daysLeft > 0 ? totalSpendLeft / daysLeft : 0,
                isMaxed, rules
            };
        }

        function getCurrentCycleKey(card, now = new Date()) {
            return getTransactionCycle(localDateStr(now), getCashbackCycleDay(card));
        }

        function getCurrentCycleStatus(card, simulatedTxs, now = new Date()) {
            return getCycleStatus(card, simulatedTxs, getCurrentCycleKey(card, now), now);
        }

        function evaluateCashbackSimulation() {
            const cardCycleSpendTotals = {};

            database.transactions.forEach(t => {
                const card = database.cards.find(c => c.id === t.cardId);
                const bDay = getCashbackCycleDay(card);
                const cycleKey = getTransactionCycle(t.date, bDay);

                if (!cardCycleSpendTotals[cycleKey]) cardCycleSpendTotals[cycleKey] = {};
                if (!cardCycleSpendTotals[cycleKey][t.cardId]) cardCycleSpendTotals[cycleKey][t.cardId] = 0;
                cardCycleSpendTotals[cycleKey][t.cardId] += t.amount;
            });

            const sortedTxs = database.transactions.map(t => ({ ...t }))
                .sort((a, b) => new Date(a.date) - new Date(b.date));

            const cardCycleCashbackAccumulated = {};
            const categoryCycleCashbackAccumulated = {};
            const evaluatedMap = {};

            sortedTxs.forEach(t => {
                const card = database.cards.find(c => c.id === t.cardId);
                const bDay = getCashbackCycleDay(card);
                const cycleKey = getTransactionCycle(t.date, bDay);
                
                const totalCycleSpend = (cardCycleSpendTotals[cycleKey] && cardCycleSpendTotals[cycleKey][t.cardId]) || 0;
                const cycleMinRequired = card ? (card.cycleMinSpend || 0) : 0;
                const cycleCapMax = card ? (card.cycleCashbackCap || Infinity) : Infinity;

                let calculatedCashback = 0;
                let statusMsg = "";
                let actualRate = 0;
                let eligible = true;

                if (!card) {
                    statusMsg = "Unknown Card Config";
                    eligible = false;
                } else {
                    const rule = card.rules ? card.rules.find(r => r.category === t.category) : null;
                    if (!rule) {
                        statusMsg = "No Rule Matched";
                        eligible = false;
                    } else {
                        const ruleMinTx = rule.minTxSpend || 0;
                        if (t.amount < ruleMinTx) {
                            eligible = false;
                            statusMsg = `Blocked: Tx < Min RM ${ruleMinTx}`;
                        }
                        
                        if (eligible && totalCycleSpend < cycleMinRequired) {
                            eligible = false;
                            statusMsg = `Blocked: Cycle < RM ${cycleMinRequired}`;
                        }

                        if (eligible && rule.weekendOnly) {
                            const dateObj = new Date(t.date.replace(/-/g, "/"));
                            const day = dateObj.getDay(); 
                            if (day !== 0 && day !== 6) {
                                eligible = false;
                                statusMsg = "Blocked: Weekday Tx";
                            }
                        }

                        if (eligible && rule.daysOnly) {
                            const dateObj = new Date(t.date.replace(/-/g, "/"));
                            const transDay = dateObj.getDate();
                            const allowedDays = rule.daysOnly.split(',').map(d => parseInt(d.trim())).filter(d => !isNaN(d));
                            if (allowedDays.length > 0 && !allowedDays.includes(transDay)) {
                                eligible = false;
                                statusMsg = `Blocked: Requires Day ${rule.daysOnly}`;
                            }
                        }

                        // Configurable month check to solve Maybank Ikhwan month-of-year tiered profiles
                        if (eligible && rule.monthsOnly) {
                            const dateObj = new Date(t.date.replace(/-/g, "/"));
                            const transMonth = String(dateObj.getMonth() + 1).padStart(2, '0');
                            const allowedMonths = rule.monthsOnly.split(',').map(m => m.trim().padStart(2, '0'));
                            if (allowedMonths.length > 0 && !allowedMonths.includes(transMonth)) {
                                eligible = false;
                                statusMsg = `Blocked: Promo active only in month(s) ${rule.monthsOnly}`;
                            }
                        }

                        if (eligible) {
                            if (rule.tiered && rule.tiers && rule.tiers.length > 0) {
                                const sortedTiers = [...rule.tiers].sort((a,b) => b.minSpend - a.minSpend);
                                const matchedTier = sortedTiers.find(tier => totalCycleSpend >= tier.minSpend);
                                if (matchedTier) {
                                    actualRate = matchedTier.rate;
                                    statusMsg = `Bracket Met (${(actualRate*100).toFixed(1)}%)`;
                                } else {
                                    actualRate = rule.rate || 0; 
                                    statusMsg = `Base Bracket (${(actualRate*100).toFixed(1)}%)`;
                                }
                            } else {
                                actualRate = rule.rate || 0;
                                statusMsg = `Unlocked (${(actualRate*100).toFixed(1)}%)`;
                            }

                            const potentialCashback = t.amount * actualRate;

                            if (!cardCycleCashbackAccumulated[cycleKey]) cardCycleCashbackAccumulated[cycleKey] = {};
                            if (cardCycleCashbackAccumulated[cycleKey][t.cardId] === undefined) cardCycleCashbackAccumulated[cycleKey][t.cardId] = 0;

                            if (!categoryCycleCashbackAccumulated[cycleKey]) categoryCycleCashbackAccumulated[cycleKey] = {};
                            if (!categoryCycleCashbackAccumulated[cycleKey][t.cardId]) categoryCycleCashbackAccumulated[cycleKey][t.cardId] = {};
                            if (categoryCycleCashbackAccumulated[cycleKey][t.cardId][t.category] === undefined) {
                                categoryCycleCashbackAccumulated[cycleKey][t.cardId][t.category] = 0;
                            }

                            const txMonthStr = String(new Date(t.date.replace(/-/g, "/")).getMonth() + 1).padStart(2, '0');
                            const effectiveCap = resolveCategoryCap(rule, txMonthStr);
                            const categoryCapMax = effectiveCap > 0 ? effectiveCap : Infinity;
                            const currentCatAccumulated = categoryCycleCashbackAccumulated[cycleKey][t.cardId][t.category];
                            const currentCardAccumulated = cardCycleCashbackAccumulated[cycleKey][t.cardId];

                            const allowedByCat = Math.max(0, categoryCapMax - currentCatAccumulated);
                            const allowedByCard = Math.max(0, cycleCapMax - currentCardAccumulated);

                            calculatedCashback = Math.min(potentialCashback, allowedByCat, allowedByCard);

                            if (calculatedCashback <= 0 && potentialCashback > 0) {
                                eligible = false;
                                statusMsg = allowedByCat <= 0 ? "Category Cap Reached" : "Overall Cap Reached";
                            } else if (calculatedCashback < potentialCashback) {
                                eligible = true;
                                statusMsg = allowedByCat < allowedByCard 
                                    ? `Partially Capped (Cat: +RM ${calculatedCashback.toFixed(2)})`
                                    : `Partially Capped (Card: +RM ${calculatedCashback.toFixed(2)})`;
                                categoryCycleCashbackAccumulated[cycleKey][t.cardId][t.category] += calculatedCashback;
                                cardCycleCashbackAccumulated[cycleKey][t.cardId] += calculatedCashback;
                            } else {
                                categoryCycleCashbackAccumulated[cycleKey][t.cardId][t.category] += calculatedCashback;
                                cardCycleCashbackAccumulated[cycleKey][t.cardId] += calculatedCashback;
                            }
                        }
                    }
                }

                evaluatedMap[t.id] = {
                    calculatedCashback: calculatedCashback,
                    statusMessage: statusMsg,
                    isEligible: eligible,
                    cycleKey: cycleKey
                };
            });

            return database.transactions.map(t => ({
                ...t,
                ...(evaluatedMap[t.id] || { calculatedCashback: 0, statusMessage: "Unprocessed", isEligible: false, cycleKey: "ALL" })
            }));
        }

export { getTransactionCycle, evaluateCashbackSimulation, resolveCategoryCap, getCashbackCycleDay, getCycleBounds, getCycleStatus, getCurrentCycleKey, getCurrentCycleStatus };

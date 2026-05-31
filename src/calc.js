import { database } from './state.js';

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

        function evaluateCashbackSimulation() {
            const cardCycleSpendTotals = {};

            database.transactions.forEach(t => {
                const card = database.cards.find(c => c.id === t.cardId);
                const bDay = card ? card.billingDay : 15;
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
                const bDay = card ? card.billingDay : 15;
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

                            const categoryCapMax = (rule.categoryCap !== undefined && rule.categoryCap > 0) ? rule.categoryCap : Infinity;
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

export { getTransactionCycle, evaluateCashbackSimulation };

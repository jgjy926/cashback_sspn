import { refreshLedgerAndCalculations } from './dashboard.js';
import { populateDropdownOptions } from './dropdowns.js';
import { database } from './state.js';
import { saveToLocalStorage } from './storage.js';
import { askConfirm, getNetworkIcon, getThemeStyles, showToast } from './ui.js';

        function renderCardsVault() {
            const body = document.getElementById("cardManagerTableBody");
            if(body) {
                body.innerHTML = database.cards.map(c => {
                    const styles = getThemeStyles(c.theme);
                    const minSpendText = c.cycleMinSpend > 0 ? `RM ${c.cycleMinSpend}` : 'None';
                    const textCap = c.cycleCashbackCap > 0 ? `RM ${c.cycleCashbackCap}` : 'Unlimited';
                    const networkIcon = c.network ? getNetworkIcon(c.network) : '';
                    const last4Text = c.last4 ? `•••• ${c.last4}` : '';
                    const bankText = c.bank && !c.name.toLowerCase().startsWith(c.bank.toLowerCase()) ? `[${c.bank}] ` : '';

                    return `
                        <tr class="border-b border-gray-900 hover:bg-gray-900/30 transition text-xs">
                            <td class="py-3 px-4 font-bold text-slate-200">
                                <div class="flex items-center gap-1.5">
                                    ${networkIcon}
                                    <span>${bankText}${c.name}</span>
                                </div>
                                <span class="text-[9px] block font-mono text-slate-500">${c.id} ${last4Text}</span>
                            </td>
                            <td class="py-3 px-4 uppercase text-xs">
                                <span class="px-2 py-0.5 rounded text-[10px] font-bold ${styles.badge}">${c.theme}</span>
                            </td>
                            <td class="py-3 px-4 text-slate-400 font-semibold">Day ${c.billingDay}</td>
                            <td class="py-3 px-4 text-slate-400 font-mono">
                                <span class="text-xs block font-bold text-slate-300">Min: ${minSpendText}</span>
                                <span class="text-[9px] block font-semibold text-indigo-400">Cap: ${textCap}</span>
                            </td>
                            <td class="py-3 px-4 text-center">
                                <div class="flex gap-1.5 justify-center">
                                    <button onclick="editCard('${c.id}')" class="text-indigo-400 hover:text-indigo-300 p-1 bg-indigo-500/10 hover:bg-indigo-500/25 rounded transition"><i class="fa-solid fa-pen-to-square"></i></button>
                                    <button onclick="deleteCard('${c.id}')" class="text-rose-500 hover:text-rose-400 p-1 bg-rose-500/10 hover:bg-rose-500/25 rounded transition"><i class="fa-solid fa-trash"></i></button>
                                </div>
                            </td>
                        </tr>
                    `;
                }).join('');
            }
        }

        function showAddCardForm() {
            document.getElementById("cardEditorPanel").classList.remove("hidden");
            document.getElementById("cardEditorTitle").innerText = "Add Config Instrument";
            document.getElementById("editCardId").value = "";
            document.getElementById("editCardId").disabled = false;
            document.getElementById("editCardName").value = "";
            document.getElementById("editCardBank").value = "";
            document.getElementById("editCardNetwork").value = "Visa";
            document.getElementById("editCardLast4").value = "";
            document.getElementById("editCardTheme").value = "purple";
            document.getElementById("editCardBillingDay").value = "1";
            document.getElementById("editCardMinSpend").value = "0";
            document.getElementById("editCardCashbackCap").value = "100";
            document.getElementById("rulesListContainer").innerHTML = "";
            addRuleRow("Other Spending", 0.002, 0, false, [], 0, false, "", "", ["Other Spending"]);
        }

        function hideCardEditor() {
            document.getElementById("cardEditorPanel").classList.add("hidden");
        }

        // Global rule pill helper

        function toggleRuleStandardPill(btn, cat) {
            if (btn.classList.contains('bg-indigo-600')) {
                btn.classList.remove('bg-indigo-600', 'text-white', 'border-indigo-500');
                btn.classList.add('bg-slate-950', 'text-slate-400', 'border-gray-800');
            } else {
                btn.classList.remove('bg-slate-950', 'text-slate-400', 'border-gray-800');
                btn.classList.add('bg-indigo-600', 'text-white', 'border-indigo-500');
            }
        }

        function addRuleRow(category = "", rate = 0, minTx = 0, tiered = false, tiers = [], categoryCap = 0, weekendOnly = false, merchants = "", daysOnly = "", activeCategories = [], monthsOnly = "") {
            const container = document.getElementById("rulesListContainer");
            const ruleId = "rule-" + Date.now() + Math.random().toString(36).substr(2, 4);
            const row = document.createElement("div");
            row.className = "p-3.5 bg-gray-950/60 border border-gray-800/80 rounded-xl space-y-3 rule-item-row";
            row.dataset.ruleId = ruleId;

            const ratePct = (rate * 100).toFixed(1);

            // Backwards compatibility normalization
            if (!activeCategories || !Array.isArray(activeCategories)) {
                activeCategories = activeCategories ? [activeCategories] : ["Other Spending"];
            }

            // Standard Categories Multi-Select interactive pill elements
            const standardCategoriesList = database.settings.optimizerCategories || ["Other Spending"];
            const pillContainerHtml = standardCategoriesList.map(cat => {
                const isSelected = activeCategories.includes(cat);
                const activeClass = isSelected 
                    ? 'bg-indigo-600 text-white border-indigo-500' 
                    : 'bg-slate-950 text-slate-400 border-gray-800';
                return `
                    <button type="button" onclick="toggleRuleStandardPill(this, '${cat}')" class="rule-standard-pill px-2.5 py-1 rounded-lg text-[9px] font-bold border transition ${activeClass}" data-category="${cat}">
                        ${cat}
                    </button>
                `;
            }).join('');

            row.innerHTML = `
                <div class="flex flex-col gap-3 font-sans">
                    <div class="flex flex-wrap gap-2.5 items-center justify-between">
                        <div class="flex flex-col gap-0.5 flex-1 min-w-[120px]">
                            <label class="text-[9px] uppercase font-bold text-slate-500">Custom Category Name</label>
                            <input type="text" placeholder="Category e.g. Weekend Dining" value="${category}" required class="rule-category bg-gray-950 border border-gray-800 rounded-lg px-2.5 py-1.5 text-[11px] text-slate-100 focus:outline-none focus:border-indigo-500 font-semibold">
                        </div>

                        <div class="flex gap-1.5 items-center mt-3 font-mono">
                            <label class="text-[9px] uppercase font-bold text-slate-400 font-sans">Min Tx</label>
                            <input type="number" value="${minTx}" placeholder="0" class="rule-min-spend-tx w-14 bg-gray-950 border border-gray-800 rounded-lg px-2 py-1 text-[11px] text-slate-100 text-right">
                        </div>

                        <div class="flex gap-1.5 items-center mt-3 font-mono">
                            <label class="text-[9px] uppercase font-bold text-indigo-400 font-sans">Cat Cap</label>
                            <input type="number" value="${categoryCap}" placeholder="0" class="rule-category-cap w-14 bg-gray-950 border border-gray-800 rounded-lg px-2 py-1 text-[11px] text-slate-100 text-right font-mono">
                        </div>

                        <div class="flex gap-1 items-center mt-3">
                            <label class="text-[9px] uppercase font-bold text-amber-400">Weekend?</label>
                            <input type="checkbox" ${weekendOnly ? 'checked' : ''} class="rule-weekend-checkbox rounded border-gray-800 text-amber-500 focus:ring-amber-500 cursor-pointer">
                        </div>

                        <div class="flex gap-1.5 items-center mt-3 font-mono">
                            <label class="text-[9px] uppercase font-bold text-cyan-400 font-sans">Days Only</label>
                            <input type="text" value="${daysOnly}" placeholder="e.g. 20, 28" class="rule-days-only w-16 bg-gray-950 border border-gray-800 rounded-lg px-2 py-0.5 text-[11px] text-slate-100 text-center focus:outline-none focus:border-cyan-500">
                        </div>

                        <!-- Configurable Months Profile supporting Maybank Ikhwan month-dependent rate layers -->
                        <div class="flex gap-1.5 items-center mt-3 font-mono">
                            <label class="text-[9px] uppercase font-bold text-teal-400 font-sans">Months Only</label>
                            <input type="text" value="${monthsOnly}" placeholder="e.g. 05, 06" class="rule-months-only w-16 bg-gray-950 border border-gray-800 rounded-lg px-2 py-0.5 text-[11px] text-slate-100 text-center focus:outline-none focus:border-teal-500" title="Comma separated month numbers, e.g. 05, 06 for May & June">
                        </div>

                        <div class="flex gap-1 items-center mt-3">
                            <label class="text-[9px] uppercase font-bold text-indigo-400 font-sans">Tiered?</label>
                            <input type="checkbox" ${tiered ? 'checked' : ''} onchange="toggleTieredRow(this, '${ruleId}')" class="rule-tiered-checkbox rounded border-gray-800 text-indigo-500 focus:ring-indigo-500 cursor-pointer">
                        </div>
                        
                        <button type="button" onclick="this.parentElement.parentElement.parentElement.remove()" class="text-rose-500 hover:text-rose-400 p-1 text-[11px] mt-3"><i class="fa-solid fa-trash"></i></button>
                    </div>

                    <!-- Multi-Select Categories Container -->
                    <div class="space-y-1">
                        <label class="text-[9px] uppercase font-bold text-indigo-400 block mb-1 font-sans">Standard Mapping Categories (Tap Multiple)</label>
                        <div class="flex flex-wrap gap-1.5 bg-gray-950/40 p-2 rounded-xl border border-gray-800/80">
                            ${pillContainerHtml}
                        </div>
                    </div>
                </div>

                <div class="grid grid-cols-1 gap-1 border-t border-gray-850 pt-2.5">
                    <label class="text-[9px] uppercase font-bold text-indigo-300 flex items-center gap-1 font-sans"><i class="fa-solid fa-store"></i> Eligible Retailers (Comma Separated)</label>
                    <input type="text" placeholder="e.g. AEON, AEON BIG, Lotus's, Giant" value="${merchants}" class="rule-merchants w-full bg-gray-950 border border-gray-850 rounded-lg px-3 py-1.5 text-[11px] text-slate-100 focus:outline-none focus:border-indigo-500 font-sans">
                </div>

                <div class="rate-config-panel" id="ratePanel-${ruleId}">
                    ${tiered ? renderTiersInputs(tiers) : `
                        <div class="flex gap-2 items-center font-sans">
                            <span class="text-[9px] uppercase font-bold text-slate-500">Flat Cashback Rate:</span>
                            <div class="relative w-24">
                                <input type="number" step="0.1" value="${ratePct}" placeholder="5" class="rule-flat-rate w-full bg-gray-950 border border-gray-800 rounded-lg pl-2 pr-5 py-1 text-[11px] text-slate-100 focus:outline-none text-right font-mono">
                                <span class="absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] text-slate-400 font-bold">%</span>
                            </div>
                        </div>
                    `}
                </div>
            `;
            container.appendChild(row);
        }

        function toggleTieredRow(checkbox, ruleId) {
            const panel = document.getElementById(`ratePanel-${ruleId}`);
            if (checkbox.checked) {
                panel.innerHTML = renderTiersInputs([]);
            } else {
                panel.innerHTML = `
                    <div class="flex gap-2 items-center font-sans">
                        <span class="text-[9px] uppercase font-bold text-slate-500">Flat Cashback Rate:</span>
                        <div class="relative w-24">
                            <input type="number" step="0.1" value="1.0" placeholder="5" class="rule-flat-rate w-full bg-gray-950 border border-gray-800 rounded-lg pl-2 pr-5 py-1 text-[11px] text-slate-100 focus:outline-none text-right font-mono">
                            <span class="absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] text-slate-400 font-bold">%</span>
                        </div>
                    </div>
                `;
            }
        }

        function renderTiersInputs(tiers) {
            let html = `
                <div class="space-y-1.5 bg-gray-950/60 p-2 rounded-lg border border-gray-850">
                    <div class="flex justify-between items-center mb-1">
                        <span class="text-[9px] uppercase font-black text-indigo-400 tracking-wider font-sans">Statement Spending Tiers</span>
                        <button type="button" onclick="addTierInputRow(this)" class="text-[8px] bg-slate-900 hover:bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded font-bold border border-gray-800 font-sans">
                            + Add Tier
                        </button>
                    </div>
                    <div class="tier-rows-container space-y-1">
            `;

            if (tiers && tiers.length > 0) {
                tiers.forEach(t => {
                    html += `
                        <div class="flex gap-2 items-center tier-row">
                            <span class="text-[9px] text-slate-400 font-sans">If cycle spend &ge; RM</span>
                            <input type="number" value="${t.minSpend}" class="rule-tier-min-spend w-16 bg-gray-950 border border-gray-800 rounded px-1.5 py-0.5 text-[10px] text-slate-100 font-mono">
                            <span class="text-[9px] text-slate-400 font-sans">rate is</span>
                            <input type="number" step="0.1" value="${(t.rate*100).toFixed(1)}" class="rule-tier-rate w-12 bg-gray-950 border border-gray-800 rounded px-1.5 py-0.5 text-[10px] text-slate-100 text-right font-mono">%
                            <button type="button" onclick="this.parentElement.remove()" class="text-rose-500 hover:text-rose-400 text-[10px] ml-auto"><i class="fa-solid fa-trash"></i></button>
                        </div>
                    `;
                });
            } else {
                html += `
                    <div class="flex gap-2 items-center tier-row">
                        <span class="text-[9px] text-slate-400 font-sans">If cycle spend &ge; RM</span>
                        <input type="number" value="1000" class="rule-tier-min-spend w-16 bg-gray-950 border border-gray-800 rounded px-1.5 py-0.5 text-[10px] text-slate-100 font-mono">
                        <span class="text-[9px] text-slate-400 font-sans">rate is</span>
                        <input type="number" step="0.1" value="5.0" class="rule-tier-rate w-12 bg-gray-950 border border-gray-800 rounded px-1.5 py-0.5 text-[10px] text-slate-100 text-right font-mono">%
                        <button type="button" onclick="this.parentElement.remove()" class="text-rose-500 hover:text-rose-400 text-[10px] ml-auto"><i class="fa-solid fa-trash"></i></button>
                    </div>
                `;
            }

            html += `</div></div>`;
            return html;
        }

        function addTierInputRow(btn) {
            const container = btn.parentElement.parentElement.querySelector(".tier-rows-container");
            const div = document.createElement("div");
            div.className = "flex gap-2 items-center tier-row";
            div.innerHTML = `
                <span class="text-[9px] text-slate-400 font-sans">If cycle spend &ge; RM</span>
                <input type="number" value="1000" class="rule-tier-min-spend w-16 bg-gray-950 border border-gray-800 rounded px-1.5 py-0.5 text-[10px] text-slate-100 font-mono">
                <span class="text-[9px] text-slate-400 font-sans">rate is</span>
                <input type="number" step="0.1" value="5.0" class="rule-tier-rate w-12 bg-gray-950 border border-gray-800 rounded px-1.5 py-0.5 text-[10px] text-slate-100 text-right font-mono">%
                <button type="button" onclick="this.parentElement.remove()" class="text-rose-500 hover:text-rose-400 text-[10px] ml-auto"><i class="fa-solid fa-trash"></i></button>
            `;
            container.appendChild(div);
        }

        function editCard(cardId) {
            const card = database.cards.find(c => c.id === cardId);
            if (!card) return;

            document.getElementById("cardEditorPanel").classList.remove("hidden");
            document.getElementById("cardEditorTitle").innerText = `Configure ${card.name}`;
            
            const idInput = document.getElementById("editCardId");
            idInput.value = card.id;
            idInput.disabled = true;

            document.getElementById("editCardName").value = card.name;
            document.getElementById("editCardBank").value = card.bank || "";
            document.getElementById("editCardNetwork").value = card.network || "Visa";
            document.getElementById("editCardLast4").value = card.last4 || "";
            document.getElementById("editCardTheme").value = card.theme || "purple";
            document.getElementById("editCardBillingDay").value = card.billingDay || 1;
            document.getElementById("editCardMinSpend").value = card.cycleMinSpend || 0;
            document.getElementById("editCardCashbackCap").value = card.cycleCashbackCap || 100;

            const rulesContainer = document.getElementById("rulesListContainer");
            rulesContainer.innerHTML = "";
            
            if (card.rules) {
                card.rules.forEach(r => {
                    // Normalize standardCategories arrays for loaded profiles
                    const targetCats = Array.isArray(r.standardCategories) 
                        ? r.standardCategories 
                        : (r.standardCategory ? [r.standardCategory] : ["Other Spending"]);

                    addRuleRow(r.category, r.rate, r.minTxSpend, r.tiered, r.tiers, r.categoryCap || 0, r.weekendOnly || false, r.merchants || "", r.daysOnly || "", targetCats, r.monthsOnly || "");
                });
            }
        }

        function deleteCard(cardId) {
            const index = database.cards.findIndex(c => c.id === cardId);
            if (index === -1) return;

            const txCount = database.transactions.filter(t => t.cardId === cardId).length;
            const confirmMsg = txCount > 0 
                ? `Warning: Removing this card configuration will impact calculations for ${txCount} historical transactions. Continue?` 
                : "Are you sure you want to remove this credit card from your config database?";

            askConfirm(confirmMsg, () => {
                database.cards.splice(index, 1);
                saveToLocalStorage();
                refreshLedgerAndCalculations();
                populateDropdownOptions();
                showToast("Card configuration wiped.");
            });
        }

        function handleCardFormSubmit(e) {
            e.preventDefault();
            const rawId = document.getElementById("editCardId").value.trim().replace(/\s+/g, '');
            const cardName = document.getElementById("editCardName").value.trim();
            const cardBank = document.getElementById("editCardBank").value.trim();
            const cardNetwork = document.getElementById("editCardNetwork").value;
            const cardLast4 = document.getElementById("editCardLast4").value.trim();
            const cardTheme = document.getElementById("editCardTheme").value;
            const billingDay = parseInt(document.getElementById("editCardBillingDay").value) || 1;
            const minSpend = parseFloat(document.getElementById("editCardMinSpend").value) || 0;
            const cbCap = parseFloat(document.getElementById("editCardCashbackCap").value) || 0;

            const rules = [];
            document.querySelectorAll(".rule-item-row").forEach(row => {
                const categoryInput = row.querySelector(".rule-category");
                const minTxInput = row.querySelector(".rule-min-spend-tx");
                const categoryCapInput = row.querySelector(".rule-category-cap");
                const tieredCheckbox = row.querySelector(".rule-tiered-checkbox");
                const weekendCheckbox = row.querySelector(".rule-weekend-checkbox");
                const merchantsInput = row.querySelector(".rule-merchants");
                const daysOnlyInput = row.querySelector(".rule-days-only");
                const monthsOnlyInput = row.querySelector(".rule-months-only");

                // Dynamic extraction of Standard Mapping Categories array from toggled active pills
                const selectedPills = Array.from(row.querySelectorAll(".rule-standard-pill.bg-indigo-600"))
                                            .map(btn => btn.getAttribute("data-category"));

                if (categoryInput && categoryInput.value.trim()) {
                    const ruleData = {
                        category: categoryInput.value.trim(),
                        standardCategories: selectedPills.length > 0 ? selectedPills : ["Other Spending"],
                        standardCategory: selectedPills[0] || "Other Spending", // Fallback for backwards compatibility
                        minTxSpend: parseFloat(minTxInput.value) || 0,
                        categoryCap: parseFloat(categoryCapInput.value) || 0,
                        tiered: tieredCheckbox.checked,
                        weekendOnly: weekendCheckbox ? weekendCheckbox.checked : false,
                        merchants: merchantsInput ? merchantsInput.value.trim() : "",
                        daysOnly: daysOnlyInput ? daysOnlyInput.value.trim() : "",
                        monthsOnly: monthsOnlyInput ? monthsOnlyInput.value.trim() : "",
                        rate: 0,
                        tiers: []
                    };

                    if (tieredCheckbox.checked) {
                        const tierRows = row.querySelectorAll(".tier-row");
                        tierRows.forEach(tr => {
                            const minSpendInput = tr.querySelector(".rule-tier-min-spend");
                            const rateInput = tr.querySelector(".rule-tier-rate");
                            if (minSpendInput && rateInput) {
                                ruleData.tiers.push({
                                    minSpend: parseFloat(minSpendInput.value) || 0,
                                    rate: (parseFloat(rateInput.value) || 0) / 100
                                });
                            }
                        });
                        if (ruleData.tiers.length > 0) {
                            ruleData.rate = Math.min(...ruleData.tiers.map(t => t.rate));
                        }
                    } else {
                        const rateInput = row.querySelector(".rule-flat-rate");
                        ruleData.rate = rateInput ? (parseFloat(rateInput.value) || 0) / 100 : 0;
                    }
                    rules.push(ruleData);
                }
            });

            const existingCard = database.cards.find(c => c.id === rawId);
            if (existingCard) {
                existingCard.name = cardName;
                existingCard.bank = cardBank;
                existingCard.network = cardNetwork;
                existingCard.last4 = cardLast4;
                existingCard.theme = cardTheme;
                existingCard.billingDay = billingDay;
                existingCard.cycleMinSpend = minSpend;
                existingCard.cycleCashbackCap = cbCap;
                existingCard.rules = rules;
                showToast("Card settings updated.");
            } else {
                database.cards.push({
                    id: rawId,
                    name: cardName,
                    bank: cardBank,
                    network: cardNetwork,
                    last4: cardLast4,
                    theme: cardTheme,
                    billingDay: billingDay,
                    cycleMinSpend: minSpend,
                    cycleCashbackCap: cbCap,
                    rules: rules
                });
                showToast("New credit card configuration stored.");
            }

            saveToLocalStorage();
            refreshLedgerAndCalculations();
            populateDropdownOptions();
            hideCardEditor();
        }

        function handleSystemSettingsSubmit(e) {
            e.preventDefault();
            const parseCsv = (id) => document.getElementById(id).value.split(',')
                .map(item => item.trim())
                .filter(item => item.length > 0);

            database.settings.internalCategories = parseCsv("settingsPersonalTags");
            database.settings.optimizerCategories = parseCsv("settingsOptimizerCategories");
            database.settings.sspnChannels = parseCsv("settingsSspnChannels");
            database.settings.sspnDevices = parseCsv("settingsSspnDevices");
            database.settings.sspnMethods = parseCsv("settingsSspnMethods");

            saveToLocalStorage();
            populateDropdownOptions();
            refreshLedgerAndCalculations();
            showToast("System dropdown configurations saved.");
        }

export { renderCardsVault, showAddCardForm, hideCardEditor, toggleRuleStandardPill, addRuleRow, toggleTieredRow, renderTiersInputs, addTierInputRow, editCard, deleteCard, handleCardFormSubmit, handleSystemSettingsSubmit };

import { refreshLedgerAndCalculations } from './dashboard.js';
import { database } from './state.js';
import { saveToLocalStorage } from './storage.js';
import { askConfirm, initDatePickers, showToast } from './ui.js';

        function handleTxCardChange() {
            const cardId = document.getElementById("txCard").value;
            const card = database.cards.find(c => c.id === cardId);
            const catSel = document.getElementById("txCategory");
            const label = document.getElementById("selectedCardRuleLabel");
            if(card && catSel) {
                const rulesCount = card.rules ? card.rules.length : 0;
                label.innerText = `${rulesCount} Processing Rules Defined`;
                catSel.innerHTML = (card.rules || []).map(r => {
                    const desc = r.tiered ? 'Tiered Scheme' : `${(r.rate*100).toFixed(1)}%`;
                    return `<option value="${r.category}">${r.category} (${desc})</option>`;
                }).join('');
                updateQuickLogMerchantBadge();
            }
        }

        function updateQuickLogMerchantBadge() {
            const cardId = document.getElementById("txCard").value;
            const catKey = document.getElementById("txCategory").value;
            const txDateVal = document.getElementById("txDate").value;
            const card = database.cards.find(c => c.id === cardId);
            
            const mBadge = document.getElementById("txCategoryMerchantsBadge");
            const mValSpan = document.getElementById("txCategoryMerchantsVal");
            const dBadge = document.getElementById("txCategoryDaysBadge");
            const dValSpan = document.getElementById("txCategoryDaysVal");

            if (card) {
                const rule = card.rules ? card.rules.find(r => r.category === catKey) : null;
                
                if (rule && rule.merchants) {
                    mValSpan.innerText = rule.merchants;
                    mBadge.classList.remove("hidden");
                } else {
                    mBadge.classList.add("hidden");
                }

                if (rule && rule.daysOnly) {
                    const allowedDays = rule.daysOnly.split(',').map(d => parseInt(d.trim())).filter(d => !isNaN(d));
                    if (allowedDays.length > 0) {
                        const currentDay = txDateVal ? new Date(txDateVal.replace(/-/g, "/")).getDate() : null;
                        const isMatch = currentDay && allowedDays.includes(currentDay);
                        
                        dValSpan.innerHTML = `${rule.daysOnly} (Selected Day: <strong>${currentDay || '--'}</strong>)`;
                        
                        if (isMatch) {
                            dBadge.className = "text-[10px] text-emerald-300 font-semibold mt-1 select-none flex items-start gap-1 p-2 rounded-lg bg-emerald-950/20 border border-emerald-900/30";
                            dBadge.innerHTML = `<i class="fa-solid fa-circle-check text-emerald-400 mt-0.5"></i> <span>Perfect Match! Active Promo Day (yield applied).</span>`;
                        } else {
                            dBadge.className = "text-[10px] text-amber-300 font-semibold mt-1 select-none flex items-start gap-1 p-2 rounded-lg bg-amber-950/20 border border-amber-900/30";
                            dBadge.innerHTML = `<i class="fa-solid fa-triangle-exclamation text-amber-400 mt-0.5"></i> <span>Blocked: Only eligible on day ${rule.daysOnly} of the month!</span>`;
                        }
                        dBadge.classList.remove("hidden");
                    } else {
                        dBadge.classList.add("hidden");
                    }
                } else {
                    dBadge.classList.add("hidden");
                }
            } else {
                mBadge.classList.add("hidden");
                dBadge.classList.add("hidden");
            }
        }

        function calculateRealtimeCashback() {
            const cardId = document.getElementById("txCard").value;
            const catKey = document.getElementById("txCategory").value;
            const amount = parseFloat(document.getElementById("txAmount").value) || 0;
            const card = database.cards.find(c => c.id === cardId);
            
            if(card) {
                const rule = card.rules ? card.rules.find(r => r.category === catKey) : null;
                if(rule) {
                    let rate = rule.rate || 0;
                    let prefix = "";
                    if (rule.tiered && rule.tiers && rule.tiers.length > 0) {
                        rate = rule.tiers[0].rate; 
                        prefix = "Est. Tier Min ";
                    }
                    const yieldAmt = amount * rate;
                    document.getElementById("cashbackPreviewRate").innerText = `${prefix}${(rate*100).toFixed(2)}% Rule`;
                    document.getElementById("cashbackPreviewVal").innerText = `RM ${yieldAmt.toFixed(2)}`;
                    document.getElementById("cashbackPreviewCycleMsg").innerText = `Billing Cycle Day: ${card.billingDay} | Min Tx: RM ${rule.minTxSpend || 0}`;
                }
            }
            updateQuickLogMerchantBadge();
        }

        function handleTransactionSubmit(e) {
            e.preventDefault();
            const cardId = document.getElementById("txCard").value;
            const catKey = document.getElementById("txCategory").value;
            const amount = parseFloat(document.getElementById("txAmount").value);

            const record = {
                id: 'tx-' + Date.now(),
                date: document.getElementById("txDate").value,
                cardId: cardId,
                category: catKey,
                internalTag: document.getElementById("txInternalCategory").value,
                description: document.getElementById("txDescription").value || "General Expense",
                remark: document.getElementById("txRemark").value.trim(),
                amount: amount
            };

            database.transactions.push(record);
            saveToLocalStorage();
            refreshLedgerAndCalculations();
            document.getElementById("quickLogForm").reset();
            initDatePickers();
            handleTxCardChange();
            showToast("Transaction committed to data workspace!");
        }

        function deleteTx(id) {
            askConfirm("Are you sure you want to permanently delete this credit card transaction from the ledger?", () => {
                database.transactions = database.transactions.filter(t => t.id !== id);
                saveToLocalStorage();
                refreshLedgerAndCalculations();
                showToast("Ledger record purged.", "info");
            });
        }

        function openEditTxModal(txId) {
            const tx = database.transactions.find(t => t.id === txId);
            if (!tx) return;

            document.getElementById("editFormTxId").value = tx.id;
            document.getElementById("editFormTxDate").value = tx.date;
            
            const cardSelect = document.getElementById("editFormTxCard");
            cardSelect.innerHTML = database.cards.map(c => {
                const last4Suffix = c.last4 ? ` (•••• ${c.last4})` : '';
                return `<option value="${c.id}">${c.name}${last4Suffix}</option>`;
            }).join('');
            cardSelect.value = tx.cardId;

            handleModalTxCardChange(tx.category);

            const internalSelect = document.getElementById("editFormTxInternal");
            internalSelect.innerHTML = database.settings.internalCategories.map(cat => `<option value="${cat}">${cat}</option>`).join('');
            internalSelect.value = tx.internalTag;

            document.getElementById("editFormTxAmount").value = tx.amount;
            document.getElementById("editFormTxDesc").value = tx.description;
            document.getElementById("editFormTxRemark").value = tx.remark || "";

            document.getElementById("editTxModal").classList.remove("hidden");
        }

        function handleModalTxCardChange(selectedCategory = null) {
            const cardId = document.getElementById("editFormTxCard").value;
            const card = database.cards.find(c => c.id === cardId);
            const catSelect = document.getElementById("editFormTxCategory");
            
            if (card && catSelect) {
                catSelect.innerHTML = (card.rules || []).map(r => `<option value="${r.category}">${r.category}</option>`).join('');
                if (selectedCategory) {
                    catSelect.value = selectedCategory;
                }
            }
        }

        function closeEditTxModal() {
            document.getElementById("editTxModal").classList.add("hidden");
        }

        function handleEditTxSubmit(e) {
            e.preventDefault();
            const id = document.getElementById("editFormTxId").value;
            const tx = database.transactions.find(t => t.id === id);

            if (tx) {
                tx.date = document.getElementById("editFormTxDate").value;
                tx.cardId = document.getElementById("editFormTxCard").value;
                tx.category = document.getElementById("editFormTxCategory").value;
                tx.internalTag = document.getElementById("editFormTxInternal").value;
                tx.amount = parseFloat(document.getElementById("editFormTxAmount").value);
                tx.description = document.getElementById("editFormTxDesc").value;
                tx.remark = document.getElementById("editFormTxRemark").value.trim();

                saveToLocalStorage();
                refreshLedgerAndCalculations();
                closeEditTxModal();
                showToast("Ledger record updated.");
            }
        }

export { handleTxCardChange, updateQuickLogMerchantBadge, calculateRealtimeCashback, handleTransactionSubmit, deleteTx, openEditTxModal, handleModalTxCardChange, closeEditTxModal, handleEditTxSubmit };

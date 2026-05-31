import { refreshLedgerAndCalculations } from './dashboard.js';
import { database, setSspnSignIsPositive, sspnSignIsPositive } from './state.js';
import { saveToLocalStorage } from './storage.js';
import { askConfirm, initDatePickers, showToast } from './ui.js';

        function toggleSspnSign() {
            setSspnSignIsPositive(!sspnSignIsPositive);
            const btn = document.getElementById("sspnSignBtn");
            if(sspnSignIsPositive) {
                btn.className = "w-14 bg-emerald-500/25 border border-emerald-500/40 text-emerald-400 font-bold rounded-xl text-center text-sm flex items-center justify-center transition duration-150";
                btn.innerText = "+";
            } else {
                btn.className = "w-14 bg-rose-500/25 border border-rose-500/40 text-rose-400 font-bold rounded-xl text-center text-sm flex items-center justify-center transition duration-150";
                btn.innerText = "-";
            }
        }

        function handleSspnSubmit(e) {
            e.preventDefault();
            let baseAmount = parseFloat(document.getElementById("sspnAmount").value);
            if(!sspnSignIsPositive) baseAmount = -baseAmount;
            const reflected = document.getElementById("sspnReflected").checked;

            const rec = {
                id: 'sspn-' + Date.now(),
                date: document.getElementById("sspnDate").value,
                channel: document.getElementById("sspnChannel").value,
                device: document.getElementById("sspnDevice").value,
                method: document.getElementById("sspnMethod").value,
                amount: baseAmount,
                reflected: reflected
            };

            database.sspnRecords.push(rec);
            saveToLocalStorage();
            refreshLedgerAndCalculations();
            document.getElementById("sspnForm").reset();
            initDatePickers();
            showToast("SSPN Balance adjustment saved.");
        }

        function deleteSspn(id) {
            askConfirm("Are you sure you want to delete this SSPN savings entry?", () => {
                database.sspnRecords = database.sspnRecords.filter(r => r.id !== id);
                saveToLocalStorage();
                refreshLedgerAndCalculations();
                showToast("SSPN record purged.", "info");
            });
        }

        function toggleSspnReflected(id) {
            const rec = database.sspnRecords.find(r => r.id === id);
            if (rec) {
                rec.reflected = !rec.reflected;
                saveToLocalStorage();
                refreshLedgerAndCalculations();
                showToast(`SSPN Status toggled to ${rec.reflected ? "Reflected" : "Pending"}.`, "info");
            }
        }

        function renderSspnHistoryLedger(recordsList) {
            const body = document.getElementById("sspnHistoryLedgerBody");
            if (!body) return;

            recordsList.sort((a,b) => new Date(b.date) - new Date(a.date));

            body.innerHTML = recordsList.map(r => {
                const sign = r.amount > 0 ? "+" : "";
                const amtClass = r.amount > 0 ? "text-emerald-400" : "text-rose-400";
                
                const reflectedBadge = r.reflected 
                    ? `<button onclick="toggleSspnReflected('${r.id}')" class="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[9px] font-bold flex items-center gap-1 mx-auto">Reflected <i class="fa-solid fa-check"></i></button>`
                    : `<button onclick="toggleSspnReflected('${r.id}')" class="px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[9px] font-bold flex items-center gap-1 mx-auto">Pending <i class="fa-solid fa-clock"></i></button>`;

                return `
                    <tr class="hover:bg-gray-900/40 transition">
                        <td class="py-2.5 px-4 font-mono text-[11px]">${r.date}</td>
                        <td class="py-2.5 px-4 font-semibold text-slate-300 text-xs font-sans">
                            <div>${r.channel}</div>
                            <div class="text-[9px] text-slate-500 font-normal">${r.method}</div>
                        </td>
                        <td class="py-2.5 px-4 text-right font-bold ${amtClass} text-xs font-mono">RM ${sign}${r.amount.toFixed(2)}</td>
                        <td class="py-2.5 px-4 text-center">${reflectedBadge}</td>
                        <td class="py-2.5 px-4 text-center">
                            <div class="flex gap-1 justify-center">
                                <button onclick="openEditSspnModal('${r.id}')" class="text-indigo-400 hover:text-indigo-300 p-1"><i class="fa-solid fa-pen-to-square"></i></button>
                                <button onclick="deleteSspn('${r.id}')" class="text-rose-500 hover:text-rose-400 p-1"><i class="fa-solid fa-trash"></i></button>
                            </div>
                        </td>
                    </tr>
                `;
            }).join('');
        }

        function openEditSspnModal(recId) {
            const rec = database.sspnRecords.find(r => r.id === recId);
            if (!rec) return;

            document.getElementById("editFormSspnId").value = rec.id;
            document.getElementById("editFormSspnDate").value = rec.date;

            const chSelect = document.getElementById("editFormSspnChannel");
            chSelect.innerHTML = database.settings.sspnChannels.map(c => `<option value="${c}">${c}</option>`).join('');
            chSelect.value = rec.channel;

            const devSelect = document.getElementById("editFormSspnDevice");
            devSelect.innerHTML = database.settings.sspnDevices.map(d => `<option value="${d}">${d}</option>`).join('');
            devSelect.value = rec.device;

            const metSelect = document.getElementById("editFormSspnMethod");
            metSelect.innerHTML = database.settings.sspnMethods.map(m => `<option value="${m}">${m}</option>`).join('');
            metSelect.value = rec.method;

            document.getElementById("editFormSspnAmount").value = rec.amount;
            document.getElementById("editFormSspnReflected").checked = !!rec.reflected;

            document.getElementById("editSspnModal").classList.remove("hidden");
        }

        function closeEditSspnModal() {
            document.getElementById("editSspnModal").classList.add("hidden");
        }

        function handleEditSspnSubmit(e) {
            e.preventDefault();
            const id = document.getElementById("editFormSspnId").value;
            const rec = database.sspnRecords.find(r => r.id === id);

            if (rec) {
                rec.date = document.getElementById("editFormSspnDate").value;
                rec.channel = document.getElementById("editFormSspnChannel").value;
                rec.device = document.getElementById("editFormSspnDevice").value;
                rec.method = document.getElementById("editFormSspnMethod").value;
                rec.amount = parseFloat(document.getElementById("editFormSspnAmount").value);
                rec.reflected = document.getElementById("editFormSspnReflected").checked;

                saveToLocalStorage();
                refreshLedgerAndCalculations();
                closeEditSspnModal();
                showToast("SSPN record modified.");
            }
        }

export { toggleSspnSign, handleSspnSubmit, deleteSspn, toggleSspnReflected, renderSspnHistoryLedger, openEditSspnModal, closeEditSspnModal, handleEditSspnSubmit };

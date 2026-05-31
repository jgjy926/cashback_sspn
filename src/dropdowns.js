import { database } from './state.js';
import { handleTxCardChange } from './transactions.js';

        function populateDropdownOptions() {
            const txCard = document.getElementById("txCard");
            if(txCard) {
                txCard.innerHTML = database.cards.map(c => {
                    const last4Suffix = c.last4 ? ` (•••• ${c.last4})` : '';
                    return `<option value="${c.id}">${c.name}${last4Suffix}</option>`;
                }).join('');
                handleTxCardChange();
            }
            const txIntSel = document.getElementById("txInternalCategory");
            if(txIntSel) txIntSel.innerHTML = database.settings.internalCategories.map(cat => `<option value="${cat}">${cat}</option>`).join('');

            const chSel = document.getElementById("sspnChannel");
            if(chSel) chSel.innerHTML = database.settings.sspnChannels.map(i => `<option value="${i}">${i}</option>`).join('');
            const devSel = document.getElementById("sspnDevice");
            if(devSel) devSel.innerHTML = database.settings.sspnDevices.map(i => `<option value="${i}">${i}</option>`).join('');
            const metSel = document.getElementById("sspnMethod");
            if(metSel) metSel.innerHTML = database.settings.sspnMethods.map(i => `<option value="${i}">${i}</option>`).join('');
        }

        function populateFilterBanksAndYears() {
            const banks = new Set();
            database.cards.forEach(c => {
                if (c.bank) banks.add(c.bank.trim());
            });
            const bankSel = document.getElementById("filterBank");
            if (bankSel) {
                const prevVal = bankSel.value || "ALL";
                const sortedBanks = Array.from(banks).sort();
                bankSel.innerHTML = '<option value="ALL">All Banks</option>' + 
                    sortedBanks.map(b => `<option value="${b}">${b}</option>`).join('');
                bankSel.value = Array.from(bankSel.options).some(o => o.value === prevVal) ? prevVal : "ALL";
            }

            const years = new Set([new Date().getFullYear().toString()]); 
            database.transactions.forEach(t => {
                if (t.date && t.date.length >= 4) years.add(t.date.substring(0, 4));
            });
            database.sspnRecords.forEach(r => {
                if (r.date && r.date.length >= 4) years.add(r.date.substring(0, 4));
            });
            
            const sortedYears = Array.from(years).sort().reverse();
            const yearSel = document.getElementById("filterYear");
            const sspnYearSel = document.getElementById("sspnFilterYear");

            const populateYearDropdown = (el) => {
                if (el) {
                    const prevVal = el.value || "ALL";
                    el.innerHTML = '<option value="ALL">All Years</option>' + 
                        sortedYears.map(y => `<option value="${y}">${y}</option>`).join('');
                    el.value = Array.from(el.options).some(o => o.value === prevVal) ? prevVal : "ALL";
                }
            };

            populateYearDropdown(yearSel);
            populateYearDropdown(sspnYearSel);
        }

export { populateDropdownOptions, populateFilterBanksAndYears };

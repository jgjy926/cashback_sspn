import { database } from './state.js';
import { showToast } from './ui.js';

        function exportToExcel() {
            if(database.transactions.length === 0) {
                showToast("Ledger dashboard empty!", "error");
                return;
            }
            const worksheet = XLSX.utils.json_to_sheet(database.transactions);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, "Ledger Audit");
            XLSX.writeFile(workbook, `Cashback_Ledger_Output.xlsx`);
        }

export { exportToExcel };

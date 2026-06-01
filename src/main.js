// Bootstrap. Inline on* handlers in index.html call these as globals, so every
// module's exports are mirrored onto window after import.
import * as ui from './ui.js';
import * as storage from './storage.js';
import * as calc from './calc.js';
import * as dropdowns from './dropdowns.js';
import * as dashboard from './dashboard.js';
import * as transactions from './transactions.js';
import * as cards from './cards.js';
import * as optimizer from './optimizer.js';
import * as sspn from './sspn.js';
import * as charts from './charts.js';
import * as excel from './excel.js';
import * as sync from './sync.js';
import * as receipts from './receipts.js';
import { loadFromLocalStorage } from './storage.js';
import { initDatePickers } from './ui.js';
import { populateDropdownOptions } from './dropdowns.js';
import { refreshLedgerAndCalculations, applyCurrentMonthDefaults } from './dashboard.js';
import { renderReceipts } from './receipts.js';

Object.assign(window, ui, storage, calc, dropdowns, dashboard, transactions, cards, optimizer, sspn, charts, excel, sync, receipts);

window.addEventListener('load', () => {
  loadFromLocalStorage();
  initDatePickers();
  populateDropdownOptions();
  applyCurrentMonthDefaults();   // default CC/SSPN/Receipts filters to the current month
  refreshLedgerAndCalculations();
  renderReceipts();
});

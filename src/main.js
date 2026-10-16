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
import * as claims from './claims.js';
import * as medical from './medical.js';
import * as vehicle from './vehicle.js';
import * as savings from './savings.js';
import * as autosync from './autosync.js';
import * as statement from './statement.js';
import * as mobile from './mobile.js';
import { loadFromLocalStorage } from './storage.js';
import { initDatePickers } from './ui.js';
import { populateDropdownOptions } from './dropdowns.js';
import { refreshLedgerAndCalculations, applyCurrentMonthDefaults } from './dashboard.js';
import { renderReceipts } from './receipts.js';
import { renderClaims } from './claims.js';
import { renderMedical } from './medical.js';
import { renderVehicle } from './vehicle.js';
import { renderSavings } from './savings.js';
import { initAutoSync } from './autosync.js';
import { initMobile } from './mobile.js';

Object.assign(window, ui, storage, calc, dropdowns, dashboard, transactions, cards, optimizer, sspn, charts, excel, sync, receipts, claims, medical, vehicle, savings, autosync, statement, mobile);

window.addEventListener('load', () => {
  // Show which deploy this device is running (APP_VERSION in index.html), so a stale cache is easy to spot.
  const ver = document.getElementById('appVersionLabel');
  if (ver) ver.textContent = 'v' + (window.APP_VERSION || '?');
  loadFromLocalStorage();
  initDatePickers();
  populateDropdownOptions();
  applyCurrentMonthDefaults();   // default CC/SSPN/Receipts filters to the current month
  refreshLedgerAndCalculations();
  renderReceipts();
  renderClaims();
  renderMedical();
  renderVehicle();
  renderSavings();
  initAutoSync();                // pull on open + auto-push on change + periodic refresh
  initMobile();                  // flush on background, re-sync on resume/online, Android Back button
});

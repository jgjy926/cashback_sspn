// Deterministic splitter: cc.html -> index.html + styles/app.css + src/*.js ES modules.
// Slices functions by line range (brace-safe), auto-derives cross-module imports,
// and routes the 4 shared mutable globals through setters for ES live-binding safety.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = readFileSync(join(ROOT, 'cc.html'), 'utf8');
const lines = raw.split('\n').map(l => l.replace(/\r$/, ''));   // 0-indexed; line N -> lines[N-1]
const L = n => lines[n - 1];

// ---- ordered function table (name -> 1-based start line in cc.html) ----
const fns = [
  ['getThemeStyles', 999], ['getNetworkIcon', 1015], ['toggleMobileMenu', 1024],
  ['toggleFilterDeck', 1038], ['askConfirm', 1052], ['showToast', 1067], ['switchTab', 1082],
  ['getTransactionCycle', 1107], ['initDatePickers', 1127], ['populateDropdownOptions', 1133],
  ['populateFilterBanksAndYears', 1153], ['handleTxCardChange', 1192], ['updateQuickLogMerchantBadge', 1208],
  ['calculateRealtimeCashback', 1257], ['handleTransactionSubmit', 1281], ['toggleSspnSign', 1306],
  ['handleSspnSubmit', 1318], ['deleteTx', 1342], ['deleteSspn', 1351], ['toggleSspnReflected', 1360],
  ['evaluateCashbackSimulation', 1370], ['populateOptimizerDropdowns', 1522], ['runCashbackOptimization', 1534],
  ['renderCashbackCheatSheet', 1818], ['autofillOptimizer', 1822], ['renderInteractiveSelectorDeck', 1833],
  ['loadCardInteractiveMeter', 1837], ['renderInteractiveInspectorContent', 1854], ['refreshLedgerAndCalculations', 2093],
  ['renderSspnHistoryLedger', 2216], ['renderFilterDecks', 2250], ['setCardFilter', 2321],
  ['renderCardsVault', 2333], ['showAddCardForm', 2373], ['hideCardEditor', 2390], ['toggleRuleStandardPill', 2395],
  ['addRuleRow', 2405], ['toggleTieredRow', 2504], ['renderTiersInputs', 2521], ['addTierInputRow', 2561],
  ['editCard', 2575], ['deleteCard', 2610], ['handleCardFormSubmit', 2628], ['handleSystemSettingsSubmit', 2728],
  ['openEditTxModal', 2746], ['handleModalTxCardChange', 2772], ['closeEditTxModal', 2785], ['handleEditTxSubmit', 2789],
  ['openEditSspnModal', 2809], ['closeEditSspnModal', 2834], ['handleEditSspnSubmit', 2838],
  ['renderCharts', 2858], ['renderSspnCharts', 2935], ['exportToExcel', 2988],
  ['saveToLocalStorage', 2999], ['loadFromLocalStorage', 3003], ['saveSyncSettings', 3029], ['handleCloudSync', 3034],
];
const SCRIPT_END = 3083; // last line of handleCloudSync (line before </script>)

// verify each start line really declares that function
for (const [name, ln] of fns) {
  if (!new RegExp(`function\\s+${name}\\b`).test(L(ln))) {
    throw new Error(`line ${ln} does not declare ${name}: ${JSON.stringify(L(ln))}`);
  }
}

const rstrip = arr => { let e = arr.length; while (e > 0 && arr[e - 1].trim() === '') e--; return arr.slice(0, e); };

// transforms: route shared-global reassignments through setters (reads stay as live bindings)
function transform(text) {
  return text
    .replaceAll('database = parsed;', 'setDatabase(parsed);')
    .replaceAll('database = cloudDb;', 'setDatabase(cloudDb);')
    .replaceAll('currentFilterCard = cardId;', 'setCurrentFilterCard(cardId);')
    .replaceAll('currentInteractiveCardId = cardId;', 'setCurrentInteractiveCardId(cardId);')
    .replaceAll('sspnSignIsPositive = !sspnSignIsPositive;', 'setSspnSignIsPositive(!sspnSignIsPositive);')
    .replaceAll('filterDeckCollapsed = false;', 'setFilterDeckCollapsed(false);')
    .replaceAll('filterDeckCollapsed = true;', 'setFilterDeckCollapsed(true);');
}

// slice every function body verbatim
const body = {};
for (let i = 0; i < fns.length; i++) {
  const [name, start] = fns[i];
  const end = i + 1 < fns.length ? fns[i + 1][1] - 1 : SCRIPT_END;
  body[name] = transform(rstrip(lines.slice(start - 1, end)).join('\n'));
}

// ---- module routing ----
const moduleExports = {
  ui: ['getThemeStyles', 'getNetworkIcon', 'toggleMobileMenu', 'toggleFilterDeck', 'askConfirm', 'showToast', 'switchTab', 'initDatePickers'],
  storage: ['saveToLocalStorage', 'loadFromLocalStorage'],
  calc: ['getTransactionCycle', 'evaluateCashbackSimulation'],
  dropdowns: ['populateDropdownOptions', 'populateFilterBanksAndYears'],
  dashboard: ['refreshLedgerAndCalculations', 'renderFilterDecks', 'setCardFilter', 'loadCardInteractiveMeter', 'renderInteractiveSelectorDeck', 'renderInteractiveInspectorContent'],
  transactions: ['handleTxCardChange', 'updateQuickLogMerchantBadge', 'calculateRealtimeCashback', 'handleTransactionSubmit', 'deleteTx', 'openEditTxModal', 'handleModalTxCardChange', 'closeEditTxModal', 'handleEditTxSubmit'],
  cards: ['renderCardsVault', 'showAddCardForm', 'hideCardEditor', 'toggleRuleStandardPill', 'addRuleRow', 'toggleTieredRow', 'renderTiersInputs', 'addTierInputRow', 'editCard', 'deleteCard', 'handleCardFormSubmit', 'handleSystemSettingsSubmit'],
  optimizer: ['populateOptimizerDropdowns', 'runCashbackOptimization', 'renderCashbackCheatSheet', 'autofillOptimizer'],
  sspn: ['toggleSspnSign', 'handleSspnSubmit', 'deleteSspn', 'toggleSspnReflected', 'renderSspnHistoryLedger', 'openEditSspnModal', 'closeEditSspnModal', 'handleEditSspnSubmit'],
  charts: ['renderCharts', 'renderSspnCharts'],
  excel: ['exportToExcel'],
  sync: ['saveSyncSettings', 'handleCloudSync'],
};
const stateExports = ['database', 'setDatabase', 'currentFilterCard', 'setCurrentFilterCard',
  'currentInteractiveCardId', 'setCurrentInteractiveCardId', 'sspnSignIsPositive', 'setSspnSignIsPositive',
  'filterDeckCollapsed', 'setFilterDeckCollapsed', 'SCHEMA_VERSION'];

const ownerOf = {};
for (const [mod, names] of Object.entries(moduleExports)) for (const n of names) ownerOf[n] = mod;
for (const n of stateExports) ownerOf[n] = 'state';

mkdirSync(join(ROOT, 'src'), { recursive: true });
mkdirSync(join(ROOT, 'styles'), { recursive: true });

// charts.js needs its module-local chart object declarations (were top-level globals)
const modulePreamble = {
  charts: 'let catPieChartObj = null;\nlet sspnTrendChartObj = null, sspnChannelPieChartObj = null;\n',
};

for (const [mod, names] of Object.entries(moduleExports)) {
  const text = (modulePreamble[mod] || '') + names.map(n => body[n]).join('\n\n');
  // derive imports
  const needed = {};
  for (const name of Object.keys(ownerOf)) {
    const home = ownerOf[name];
    if (home === mod) continue;
    if (new RegExp(`\\b${name}\\b`).test(text)) (needed[home] ||= new Set()).add(name);
  }
  const importLines = Object.keys(needed).sort().map(home =>
    `import { ${[...needed[home]].sort().join(', ')} } from './${home}.js';`).join('\n');
  const out = `${importLines}${importLines ? '\n\n' : ''}${text}\n\nexport { ${names.join(', ')} };\n`;
  writeFileSync(join(ROOT, 'src', `${mod}.js`), out);
}

// ---- state.js (seed + setters) ----
const seed = rstrip(lines.slice(882, 983)).join('\n') // 'let database = { ... };'
  .replace(/^\s*let database =/, 'export let database =');
const stateJs = `// Shared application state. The database object is a live ES export reassigned
// only through setDatabase(); the four UI flags are reassigned through their setters.
export const SCHEMA_VERSION = 1;

${seed}

export function setDatabase(next) { database = next; }

export let currentFilterCard = "ALL";
export let currentInteractiveCardId = "ALL";
export let sspnSignIsPositive = true;
export let filterDeckCollapsed = true;

export function setCurrentFilterCard(v) { currentFilterCard = v; }
export function setCurrentInteractiveCardId(v) { currentInteractiveCardId = v; }
export function setSspnSignIsPositive(v) { sspnSignIsPositive = v; }
export function setFilterDeckCollapsed(v) { filterDeckCollapsed = v; }
`;
writeFileSync(join(ROOT, 'src', 'state.js'), stateJs);

// ---- main.js (bootstrap + window exposure for inline handlers) ----
const modList = Object.keys(moduleExports);
const mainJs = `// Bootstrap. Inline on* handlers in index.html call these as globals, so every
// module's exports are mirrored onto window after import.
${modList.map(m => `import * as ${m} from './${m}.js';`).join('\n')}
import { loadFromLocalStorage } from './storage.js';
import { initDatePickers } from './ui.js';
import { populateDropdownOptions } from './dropdowns.js';
import { refreshLedgerAndCalculations } from './dashboard.js';

Object.assign(window, ${modList.join(', ')});

window.addEventListener('load', () => {
  loadFromLocalStorage();
  initDatePickers();
  populateDropdownOptions();
  refreshLedgerAndCalculations();
});
`;
writeFileSync(join(ROOT, 'src', 'main.js'), mainJs);

// ---- styles/app.css ----
writeFileSync(join(ROOT, 'styles', 'app.css'), rstrip(lines.slice(13, 91)).join('\n') + '\n');

// ---- index.html: replace <style> block and <script> block ----
const head = lines.slice(0, 12).join('\n');           // lines 1..12 (up to before <style>)
const between = lines.slice(93, 880).join('\n');      // lines 94..880 (<body> .. before <script>)
const tail = lines.slice(3084).join('\n');            // lines 3085..end (after </script>)
const indexHtml = `${head}
    <link rel="stylesheet" href="./styles/app.css">
</head>
${between}
    <script type="module" src="./src/main.js"></script>
${tail}`;
writeFileSync(join(ROOT, 'index.html'), indexHtml);

console.log('Wrote src/{' + [...modList, 'state', 'main'].join(',') + '}.js, styles/app.css, index.html');

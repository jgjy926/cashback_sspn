import { readFileSync, writeFileSync } from 'node:fs';

const YEAR = '2026'; // dashboard_backup dates are dd/mm with no year; lastSync was 2026-05
const ledger = JSON.parse(readFileSync('data/cashback_ledger_sync.json', 'utf8'));
const dash = JSON.parse(readFileSync('data/dashboard_backup.json', 'utf8'));

// last4 -> cardId
const byLast4 = {};
for (const c of ledger.cards) if (c.last4) byLast4[c.last4] = c.id;
const rulesOf = id => (ledger.cards.find(c => c.id === id)?.rules || []).map(r => r.category);

// dashboard category -> { category (bank rule), tag (internal) }
function mapCategory(cardId, cat) {
  const has = c => rulesOf(cardId).includes(c);
  const pick = (...prefs) => prefs.find(has) || prefs[prefs.length - 1];
  switch (cat) {
    case 'Automotive Fuel':            return { category: pick('Petrol', 'Other'), tag: 'Petrol' };
    case 'Ride Hailing / Food Delivery': return { category: pick('Grab', 'Dining', 'Other'), tag: 'RHL' };
    case 'Food & Beverage':            return { category: pick('Dining', 'Other'), tag: 'Dining' };
    case 'Groceries':                  return { category: pick('Groceries', 'Other'), tag: 'Groceries' };
    case 'Shopping & Retail':          return { category: pick('Other', 'Online'), tag: 'Shopping' };
    case 'E-wallet Top-up':            return { category: pick('Ewallet', 'Other'), tag: 'Shopee Pay' };
    case 'Parking':                    return { category: pick('Online', 'Other'), tag: 'Parking' };
    default:                           return { category: pick('Other'), tag: 'Shopping' };
  }
}

const existingIds = new Set(ledger.transactions.map(t => t.id));
const mapped = [];
const report = [];

dash.transactions.forEach((t, i) => {
  const last4 = (t.cardInfo.match(/(\d{4})/) || [])[1] || '';
  const cardId = byLast4[last4] || '';
  const [dd, mm] = t.transDate.split('/');
  const date = `${YEAR}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  const { category, tag } = cardId ? mapCategory(cardId, t.category) : { category: '', tag: '' };

  let id = `tx-imp-${t.id}`;
  while (existingIds.has(id)) id += '-' + i;
  existingIds.add(id);

  const rec = {
    id, date, cardId,
    category,
    internalTag: tag,
    description: t.mappedMerchant || t.merchant || '',
    amount: t.amount,
  };
  mapped.push(rec);

  const matched = cardId && rulesOf(cardId).includes(category);
  report.push({
    src: `${t.cardInfo} | ${t.transDate} | ${t.category} | RM${t.amount}`,
    out: `${cardId} | ${date} | ${category} | tag=${tag}`,
    flag: !cardId ? 'NO CARD MATCH' : (matched ? 'ok' : 'CATEGORY NOT ON CARD (will show "No Rule Matched")'),
  });
});

// standalone mapped set (for review)
writeFileSync('data/dashboard_mapped.json', JSON.stringify(mapped, null, 2));

// full merged ledger ready to upload (original untouched)
const merged = { ...ledger, transactions: [...ledger.transactions, ...mapped] };
merged.meta = { ...ledger.meta, updatedAt: new Date().toISOString() };
writeFileSync('data/cashback_ledger_sync.merged.json', JSON.stringify(merged, null, 2));

console.log('Mapped', mapped.length, 'transactions. Merged total:', merged.transactions.length, '\n');
console.log('REVIEW (flagged rows need your attention):');
for (const r of report) {
  const mark = r.flag === 'ok' ? '   ' : ' ! ';
  console.log(`${mark}${r.src}\n      -> ${r.out}   [${r.flag}]`);
}

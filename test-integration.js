/**
 * Integration test for the Google Sheets path — the riskiest code in the app,
 * and the part unit tests can't reach: real URLs, real A1 ranges, real request
 * bodies.
 *
 * `fetch` is replaced with a recorder that returns canned spreadsheet
 * responses, so this asserts what would actually go over the wire: that sync
 * writes to the right tab, lands on the first empty row, never touches the
 * sheet's formula columns, and refuses to write at all when no tab is mapped.
 *
 * No network, no credentials, no spreadsheet required.
 */
const { boot } = require('./harness.js');
const vm = require('vm');
const app = boot('index.html');
const C = app.ctx;
const val = (e) => vm.runInContext(e, C);

const calls = [];
C.fetch = (url, opts) => {
  calls.push({ url, method: (opts && opts.method) || 'GET', auth: opts && opts.headers && opts.headers.Authorization,
               body: opts && opts.body ? JSON.parse(opts.body) : null });
  let payload = {};
  if (/\?fields=sheets\.properties\.title/.test(url)) {
    payload = { sheets: [
      { properties: { title: 'Money - Read Me' } }, { properties: { title: 'Money - Transactions' } },
      { properties: { title: 'Money - Budget Plan' } }, { properties: { title: 'Money - Dashboard' } },
      { properties: { title: 'NetWorth - Net Worth' } },
      { properties: { title: 'Invest - Transactions' } }, { properties: { title: 'Invest - Holdings' } },
      { properties: { title: 'Invest - Config' } } ] };
  } else if (/values%3AbatchUpdate|values:batchUpdate/.test(url)) {
    payload = { totalUpdatedCells: 4 };
  } else if (/Invest%20-%20Transactions/.test(url)) {
    payload = { values: [
      ['Date','Side','Ticker','Qty','Price (RM)','Amount (RM)','Source','Type','Fee (RM)','Currency',
       'Strategy Version','Signal Score','Setup','Emotion','Thesis','Invalidation','Rule Followed'],
      ['2026-01-10','Buy','1155.KL','100','9.00','900','app','Buy','7','MYR','1.0','7','','','',''],
      ['2026-02-10','Sell','1155.KL','100','12.00','1200','app','Sell','7','MYR','1.0','','','','',''] ] };
  } else if (/Invest%20-%20Config/.test(url)) {
    payload = { values: [['Key','Value'],['Cash available to invest (RM)','1500'],['Max risk per trade (%)','2']] };
  } else if (/Money%20-%20Transactions/.test(url)) {
    payload = { values: [['Date'],['06 Aug 2026'],['08 Aug 2026']] };
  }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload), text: () => Promise.resolve('') });
};

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.log('  ✗ FAIL: ' + l); } };

(async () => {
  console.log('\n[integration — tab discovery]');
  val("state.accessToken = 'FAKE_TOKEN'; state.sheetId = 'SHEET123';");
  await val('doDiscoverTabs()');
  const meta = calls.find(c => /fields=/.test(c.url));
  ok(!!meta, 'issues a metadata request');
  ok(meta.url.includes('/spreadsheets/SHEET123?'), 'targets the configured spreadsheet: ' + meta.url);
  ok(meta.auth === 'Bearer FAKE_TOKEN', 'sends the bearer token');
  ok(val('state.tabs.moneyTransactions') === 'Money - Transactions', 'maps Money transactions');
  ok(val('state.tabs.investTransactions') === 'Invest - Transactions', 'maps Invest transactions');
  ok(val('state.tabsMissing.length') === 0, 'reports nothing missing');

  console.log('\n[integration — money sync]');
  calls.length = 0;
  val(`state.transactions = [
    { id:'t1', date:'2026-08-20', category:'Petrol', type:'Expense', amount:30, note:'petrol', createdAt:1 },
    { id:'t2', date:'2026-08-21', category:'Food (daily)', type:'Expense', amount:12.5, note:'lunch', createdAt:2 } ];
    state.syncedIds = new Set();`);
  await val('doSyncNow()');
  const read = calls.find(c => c.method === 'GET' && /values\//.test(c.url));
  ok(!!read, 'reads column A first to find where to write');
  ok(/%27Money%20-%20Transactions%27|'Money%20-%20Transactions'/.test(read.url), 'the range is the quoted prefixed tab: ' + decodeURIComponent(read.url.split('/values/')[1]));
  const write = calls.find(c => c.method === 'POST');
  ok(!!write, 'then issues a batchUpdate');
  ok(write.body.valueInputOption === 'USER_ENTERED', 'writes as USER_ENTERED so the sheet parses dates/numbers');
  ok(write.body.data.length === 4, 'two transactions -> four ranges (A:B and D:E each): got ' + write.body.data.length);
  const ranges = write.body.data.map(d => d.range);
  ok(ranges.every(r => r.startsWith("'Money - Transactions'!")), 'every range is scoped to the Money tab');
  ok(ranges.includes("'Money - Transactions'!A4:B4"), 'first write lands on row 4, after the 3 existing rows: ' + JSON.stringify(ranges));
  ok(!ranges.some(r => /!C\d|!F\d/.test(r)), 'no range touches column C (Type) or F (Month)');
  ok(write.body.data[0].values[0][0] === '20 Aug 2026', 'date is written in the sheet\'s own text format');
  ok(val('state.syncedIds.size') === 2, 'both transactions are marked synced afterwards');
  ok(/Synced 2 transaction/.test(val('state.lastSyncMsg')), 'reports what it did: ' + val('state.lastSyncMsg'));

  console.log('\n[integration — sync is not repeated]');
  calls.length = 0;
  await val('doSyncNow()');
  ok(calls.filter(c => c.method === 'POST').length === 0, 'a second sync with nothing new writes nothing');

  console.log('\n[integration — invest load]');
  calls.length = 0;
  C.fetchHistory = () => Promise.reject(new Error('no network for prices in this test'));
  vm.runInContext('fetchHistory = () => Promise.reject(new Error("offline"));', C);
  await val('loadInvestFromSheet()');
  ok(val('state.holdings.length') === 0, 'the fully-sold position is not left open');
  ok(val('state.realizedTrades.length') === 1, 'the sell became one realized trade');
  ok(Math.abs(val('state.realizedTrades[0].pl') - ((12 - 9) * 100 - 7)) < 1e-9, 'realized P/L is right: ' + val('state.realizedTrades[0].pl'));
  ok(val('state.cash') === 286, 'cash is computed (0 funded so far - (-286) net deployed from the closed round trip): got ' + val('state.cash'));
  ok(val('state.riskLimits.maxRiskPct') === 2, 'max risk % was read from Config: got ' + val('state.riskLimits.maxRiskPct'));
  ok(val('state.investLoaded') === true, 'the section is marked loaded');

  console.log('\n[integration — investment fund ceiling]');
  val(`state.transactions.push({id:'fund1', date:'2026-08-01', category:'Investment fund', type:'Expense', amount:900, note:'moomoo top-up', createdAt:0});
    recomputeInvestCash();`);
  ok(val('state.investmentFundTotal') === 900, 'funded total reflects the Investment fund category: got ' + val('state.investmentFundTotal'));
  ok(Math.abs(val('state.cash') - 1186) < 1e-9, 'cash available = funded total minus net deployed (900 - -286): got ' + val('state.cash'));

  console.log('\n[integration — a buy beyond the ceiling is blocked]');
  calls.length = 0;
  vm.runInContext(`
    document.getElementById('t-date').value = '2026-08-28';
    document.getElementById('t-side').value = 'Buy';
    document.getElementById('t-ticker').value = '5225.kl';
    document.getElementById('t-qty').value = '100000';
    document.getElementById('t-price').value = '2.50';
    document.getElementById('t-fee').value = '7';
  `, C);
  await val('doLogTrade()');
  ok(calls.length === 0, 'no request is made when the buy would exceed the investment fund ceiling');

  console.log('\n[integration — logging a trade]');
  calls.length = 0;
  vm.runInContext(`
    document.getElementById('t-date').value = '2026-08-28';
    document.getElementById('t-side').value = 'Buy';
    document.getElementById('t-ticker').value = '5225.kl';
    document.getElementById('t-qty').value = '200';
    document.getElementById('t-price').value = '2.50';
    document.getElementById('t-fee').value = '7';
    document.getElementById('t-thesis').value = 'uptrend + volume';
    document.getElementById('t-invalidation').value = 'close below 2.20';
  `, C);
  await val('doLogTrade()');
  const trade = calls.find(c => c.method === 'POST');
  ok(!!trade, 'issues a write');
  ok(trade.body.data[0].range.startsWith("'Invest - Transactions'!"), 'writes to the Invest tab, not the Money one: ' + trade.body.data[0].range);
  ok(/!A\d+:Q\d+$/.test(trade.body.data[0].range), 'writes the full 17-column row A:Q');
  const row = trade.body.data[0].values[0];
  ok(row.length === 17, 'the row has 17 cells');
  ok(row[2] === '5225.KL', 'ticker is upper-cased on the way in');
  ok(row[5] === 500, 'amount is computed (200 x 2.50): got ' + row[5]);
  ok(row[14] === 'uptrend + volume' && row[15] === 'close below 2.20', 'thesis and invalidation are recorded');

  console.log('\n[integration — refuses to write without a mapped tab]');
  calls.length = 0;
  val("state.tabs = {}; state.transactions.push({id:'t9',date:'2026-08-22',category:'Petrol',type:'Expense',amount:5,note:'x',createdAt:9});");
  await val('doSyncNow()');
  ok(calls.length === 0, 'no request is made when no Money tab is mapped');

  console.log('\n' + '='.repeat(46));
  console.log(pass + ' passed, ' + fail + ' failed');
  console.log('='.repeat(46));
  process.exit(fail ? 1 : 0);
})();

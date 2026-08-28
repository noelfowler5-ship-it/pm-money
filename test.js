const fs = require('fs');
const { boot } = require('./harness.js');
const app = boot('index.html');

/* Static wiring audit, computed in Node against the raw file: every element ID
   the script reaches for must actually exist in the markup. A typo here fails
   silently in a browser (null.innerHTML throws only on the code path that runs),
   so it's worth checking the whole file up front rather than per render. */
const rawHtml = fs.readFileSync('index.html', 'utf8');
const scriptBody = rawHtml.split('<script>').slice(1).join('<script>');
const definedIds = new Set([...rawHtml.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const referencedIds = [...new Set([...scriptBody.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]))];
app.ctx.__audit = {
  definedIds: [...definedIds],
  referencedIds,
  danglingIds: referencedIds.filter(id => !definedIds.has(id)),
  missingViews: ['capture', 'log', 'budget', 'dashboard', 'screener', 'portfolio', 'risk', 'setup']
    .filter(v => !definedIds.has('view-' + v)),
  usesClientSecret: /client_secret|GOCSPX/i.test(rawHtml),
  usesModules: /<script[^>]+type=["']module["']/.test(rawHtml),
  externalScripts: [...rawHtml.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]),
};

app.run(`
section('static wiring');
ok(__audit.danglingIds.length === 0,
  'every element ID the script reaches for exists in the markup: dangling = ' + JSON.stringify(__audit.danglingIds));
ok(__audit.missingViews.length === 0,
  'every section the tab router can show has a matching <section>: missing = ' + JSON.stringify(__audit.missingViews));
ok(__audit.referencedIds.length > 25, 'the audit actually found the script (sanity): ' + __audit.referencedIds.length + ' ids');
ok(__audit.usesClientSecret === false,
  'no OAuth client secret is embedded — a browser-only app must never carry one');
ok(__audit.usesModules === false,
  'no ES modules, so the app still works opened straight from the filesystem');
ok(__audit.externalScripts.length === 1 && /accounts\\.google\\.com/.test(__audit.externalScripts[0]),
  'the only external script is Google sign-in: ' + JSON.stringify(__audit.externalScripts));

/* ============================ MONEY ============================ */

section('money — parsing single transactions');
let p = parseSegment('dinner rm10');
ok(p.amount === 10, 'dinner rm10 -> amount 10');
ok(p.category === 'Food (daily)', 'dinner -> Food (daily): got ' + p.category);
ok(p.type === 'Expense', 'dinner is an Expense');

p = parseSegment('Netflix 17.90');
ok(p.amount === 17.9, 'Netflix 17.90 -> amount 17.9');

p = parseSegment('rent 500');
ok(p.amount === 500, 'rent 500 -> amount 500');
ok(p.category === "Sewa rumah (own rent)", 'rent -> Sewa rumah: got ' + p.category);

p = parseSegment('girlfriend rent help 200');
ok(p.category === "Girlfriend's rent help", "gf rent is matched before the generic rent rule: got " + p.category);

p = parseSegment('received salary 1900');
ok(p.amount === 1900, 'received salary 1900 -> amount 1900');
ok(p.category === 'Full-time salary (net)', 'salary -> Full-time salary: got ' + p.category);
ok(p.type === 'Income', 'salary is Income');

p = parseSegment('reload boost RM150');
ok(p.amount === 150 && p.category === 'Reload (Boost eWallet)', 'reload boost RM150 parses amount and category');

p = parseSegment('RM30 church offering');
ok(p.amount === 30, 'RM-prefixed number is picked up ahead of any bare number');

p = parseSegment('mom gave me RM100');
ok(p.amount === 100, 'mom gave me RM100 -> amount 100');
ok(p.confidence < 0.5, 'a gift with no matching category is flagged low-confidence for review');

p = parseSegment('just a note with no number');
ok(p.amount === null && p.error, 'a segment with no amount is returned with an error, not a silent zero');

section('money — currency formatting');
ok(fmtRM(1830) === 'RM1,830.00', 'thousands separator and 2dp: got ' + fmtRM(1830));
ok(fmtRM(-74.2) === '-RM74.20', 'a negative reads as -RM74.20, not RM-74.20: got ' + fmtRM(-74.2));
ok(fmtRM(0) === 'RM0.00', 'zero is RM0.00');
ok(fmtRM(-0.004) === 'RM0.00', 'a value that rounds to zero does not render as -RM0.00: got ' + fmtRM(-0.004));
ok(fmtRM(null) === 'RM0.00' && fmtRM(undefined) === 'RM0.00', 'null/undefined render as RM0.00, never NaN');
ok(fmtRM(0.1 + 0.2) === 'RM0.30', 'float noise is rounded away: got ' + fmtRM(0.1 + 0.2));

section('money — multi-transaction split');
let list = parseInput('dinner rm10, telur rm12, apple rm12.50');
ok(list.length === 3, 'three comma-separated items become three transactions, not one 34.50 total');
ok(list[0].amount === 10 && list[1].amount === 12 && list[2].amount === 12.5, 'each amount parsed independently');
list = parseInput('beli telur 12\\napple 12.50');
ok(list.length === 2, 'newline-separated input splits too');

section('money — domain math');
const txs = [
  { date: '2026-08-06', type: 'Income',  category: 'Full-time salary (net)', amount: 1942.95 },
  { date: '2026-08-06', type: 'Expense', category: 'Sewa rumah (own rent)',  amount: 250 },
  { date: '2026-08-08', type: 'Expense', category: 'Food (daily)',           amount: 24.6 },
  { date: '2026-07-01', type: 'Expense', category: 'Food (daily)',           amount: 999 },
];
const totals = monthlyTotals(txs, '2026-08');
ok(totals.income === 1942.95, 'monthlyTotals sums income for the given month only');
ok(Math.abs(totals.expense - 274.6) < 0.001, 'monthlyTotals excludes July: got ' + totals.expense);
ok(totals.byCategory['Food (daily)'] === 24.6, 'per-category total excludes other months');
ok(Math.abs(lifetimeCash(txs) - (1942.95 - 250 - 24.6 - 999)) < 0.001, 'lifetimeCash nets all-time income minus expense');

section('money — learning loop');
let learned = {};
learnFromCorrection('KFC dinner', 'Sunday treat', learned);
ok(learned['kfc'] === 'Sunday treat', 'correction teaches a distinctive word');
ok(learned['dinner'] === 'Sunday treat', 'every non-stopword in the correction is learned');
ok(guessCategory('kfc again today', learned).category === 'Sunday treat', 'learned word beats the static keyword table');
ok(guessCategory('kfc again today', {}).category !== 'Sunday treat', 'without the learned map the same text does NOT match');
let stop = {};
learnFromCorrection('paid the rm for that', 'Petrol', stop);
ok(!('the' in stop) && !('rm' in stop), 'stopwords are never learned');

section('money — duplicate detection');
const existingToday = [{ date: todayISO(), type: 'Expense', category: 'Petrol', amount: 30, note: 'petrol', createdAt: 1 }];
let candidates = [
  { amount: 30, category: 'Petrol' },
  { amount: 30, category: 'Food (daily)' },
  { amount: null, category: 'Petrol' },
];
flagDuplicates(candidates, existingToday, todayISO());
ok(candidates[0].duplicate === true, 'same category+amount today is flagged as a possible duplicate');
ok(candidates[1].duplicate === false, 'different category with the same amount is not flagged');
ok(candidates[2].duplicate === false, 'a candidate with no amount yet is never flagged');

/* ============================ SHEET WIRING ============================ */

section('sheets — A1 quoting for prefixed tab names');
ok(a1('Money - Transactions', 'A:A') === "'Money - Transactions'!A:A",
  'a tab name with spaces/dashes is single-quoted: got ' + a1('Money - Transactions', 'A:A'));
ok(a1("Bob's tab", 'A1') === "'Bob''s tab'!A1", "an apostrophe inside the name is doubled: got " + a1("Bob's tab", 'A1'));

section('sheets — date formatting and parsing');
ok(fmtSheetDate('2026-08-06') === '06 Aug 2026', 'ISO -> the sheet\\'s "06 Aug 2026" style: got ' + fmtSheetDate('2026-08-06'));
ok(fmtSheetDate('2026-01-01') === '01 Jan 2026', 'single-digit day is zero-padded');
ok(parseSheetDate('2026-08-06').getMonth() === 7, 'parses ISO');
ok(parseSheetDate('06/08/2026').getMonth() === 7, 'parses Malaysian DD/MM/YYYY as August, not June');
ok(parseSheetDate('06/08/2026').getDate() === 6, 'DD/MM/YYYY day is 6, not 8');
ok(parseSheetDate('06 Aug 2026').getMonth() === 7, 'parses the sheet\\'s "06 Aug 2026" text');
ok(parseSheetDate('') === null && parseSheetDate(null) === null, 'blank/null dates return null instead of Invalid Date');
ok(parseSheetDate('not a date') === null, 'unparseable text returns null');

section('sheets — finding the first empty row');
ok(findFirstEmptyRow([['Date'], ['06 Aug 2026'], ['08 Aug 2026'], ['']]) === 4, 'finds the first blank cell after the header');
ok(findFirstEmptyRow([['Date'], ['06 Aug 2026']]) === 3, 'falls off the end of a full range to the next row');
ok(findFirstEmptyRow([['Date']]) === 2, 'a header-only sheet starts writing at row 2');

section('sheets — money writes never touch the formula columns');
const syncCandidates = [
  { id: 'a', date: '2026-08-20', category: 'Petrol', amount: 30, note: 'petrol' },
  { id: 'b', date: '2026-08-20', category: 'Food (daily)', amount: 12.5, note: 'lunch' },
];
const writes = buildSyncWrites(syncCandidates, 32, 'Money - Transactions');
ok(writes.length === 2, 'one write pair per transaction');
ok(writes[0].row === 32 && writes[1].row === 33, 'rows increment sequentially from the start row');
ok(writes[0].ab.range === "'Money - Transactions'!A32:B32", 'A:B write is scoped to the prefixed tab: got ' + writes[0].ab.range);
ok(writes[0].de.range === "'Money - Transactions'!D32:E32", 'D:E write skips column C (the Type formula): got ' + writes[0].de.range);
ok(writes[0].ab.values[0][0] === '20 Aug 2026' && writes[0].ab.values[0][1] === 'Petrol', 'A:B values are [date, category]');
ok(writes[0].de.values[0][0] === 30 && writes[0].de.values[0][1] === 'petrol', 'D:E values are [amount, note]');
ok(!/!C\\d|!F\\d/.test(JSON.stringify(writes)), 'no write addresses column C or F anywhere');

section('sheets — tab discovery');
let r = resolveTabs([
  'Money - Read Me', 'Money - Budget Plan', 'Money - Transactions', 'Money - Dashboard',
  'NetWorth - Net Worth', 'NetWorth - Debts',
  'Invest - Transactions', 'Invest - Holdings', 'Invest - Config', 'Invest - Signals'
]);
ok(r.tabs.moneyTransactions === 'Money - Transactions', 'maps the prefixed Money transactions tab');
ok(r.tabs.investTransactions === 'Invest - Transactions', 'maps the prefixed Invest transactions tab');
ok(r.tabs.moneyBudget === 'Money - Budget Plan', 'maps the Money budget tab');
ok(r.tabs.investConfig === 'Invest - Config', 'maps the Invest config tab');
ok(r.tabs.netWorth === 'NetWorth - Net Worth', 'maps the net worth tab');
ok(r.missing.length === 0, 'nothing required is missing in the combined sheet');

r = resolveTabs(['Transactions', 'Budget Plan', 'Dashboard', 'Reference Lists']);
ok(r.tabs.moneyTransactions === 'Transactions', 'still works against the un-merged Personal CFO sheet');
ok(r.missing.length === 1 && /Invest/.test(r.missing[0]), 'reports the missing Invest tab rather than silently mapping Money\\'s: got ' + JSON.stringify(r.missing));

r = resolveTabs(['Money - Transactions']);
ok(r.tabs.investTransactions === undefined, 'a Money tab is never mis-mapped as the Invest one');

r = resolveTabs([]);
ok(r.missing.length === 2, 'an empty spreadsheet reports both required tabs missing');

section('sheets — invest transaction rows');
const investRows = [
  ['Date','Side','Ticker','Qty','Price (RM)','Amount (RM)','Source','Type','Fee (RM)','Currency',
   'Strategy Version','Signal Score','Setup','Emotion','Thesis','Invalidation','Rule Followed'],
  ['2026-01-10','Buy','1155.KL','100','9.50','950','app','Buy','7.00','MYR','1.0','8','trend','calm','uptrend','close below 9','TRUE'],
  ['','','','','','','','','','','','','','','','',''],
  ['2026-02-10','Sell','1155.KL','100','10.50','1050','app','Sell','7.00','MYR','1.0','','','','','',''],
];
let objs = investTxRowsToObjects(investRows);
ok(objs.length === 2, 'blank rows are dropped: got ' + objs.length);
ok(objs[0].ticker === '1155.KL' && objs[0].qty === '100', 'columns map by header name');
ok(objs[0].thesis === 'uptrend', 'later text columns line up too');

const reordered = [
  ['Ticker','Date','Side','Qty','Price (RM)'],
  ['5225.KL','2026-03-01','Buy','200','2.50'],
];
objs = investTxRowsToObjects(reordered);
ok(objs[0].ticker === '5225.KL' && objs[0].date === '2026-03-01' && objs[0].qty === '200',
  'a reordered header is followed rather than assumed positional');

ok(investTxRowsToObjects([]).length === 0, 'an empty range yields no transactions');
ok(investTxRowsToObjects([['Date','Side']]).length === 0, 'a header-only tab yields no transactions');

section('sheets — building an invest trade row');
let row = buildInvestTradeRow({ date: '2026-08-28', side: 'Buy', ticker: '1155.kl', qty: '200', price: '9.5', fee: '7', thesis: 'x' });
ok(row.length === 17, 'a trade row has all 17 columns: got ' + row.length);
ok(row[2] === '1155.KL', 'ticker is upper-cased');
ok(row[5] === 1900, 'amount is computed as qty x price when not supplied: got ' + row[5]);
ok(row[7] === 'Buy', 'Type defaults to the side');
ok(row[9] === 'MYR', 'currency defaults to MYR');
ok(row[16] === '', 'an unset Rule Followed writes blank, not "undefined"');
ok(buildInvestTradeRow({ ruleFollowed: true, qty: 1, price: 1 })[16] === 'TRUE', 'ruleFollowed true -> TRUE');
ok(buildInvestTradeRow({ ruleFollowed: false, qty: 1, price: 1 })[16] === 'FALSE', 'ruleFollowed false -> FALSE');

section('sheets — invest config');
const cfg = parseConfigRows([
  ['Key', 'Value'],
  ['Cash available to invest (RM)', '900'],
  ['Moomoo portfolio value (RM)', '0'],
  ['Max risk per trade (%)', '1.5'],
  ['Something we do not know about', 'ignored'],
]);
ok(cfg.cash === 900, 'reads cash from the Config tab: got ' + cfg.cash);
ok(cfg.maxRiskPct === 1.5, 'reads max risk per trade');
ok(cfg.moomooValue === 0, 'a legitimate zero is read, not treated as missing');
ok(cfg.daily === undefined, 'a key that is not in the sheet stays undefined rather than becoming 0');
ok(parseConfigRows([]).cash === undefined, 'an empty Config tab yields no values');

/* ============================ INVEST ============================ */

section('invest — indicators');
const flat = Array.from({length: 60}, () => 10);
ok(sma(flat, 20) === 10, 'SMA of a flat series is the value itself');
ok(sma([1,2], 20) === null, 'SMA returns null without enough history');
const rising = Array.from({length: 60}, (_, i) => 10 + i * 0.1);
ok(rsi14(rising) === 100, 'a series that only rises has RSI 100');
ok(sma(rising, 20) > sma(rising, 50), 'SMA20 leads SMA50 in an uptrend');
const cls = classify(rising);
ok(cls.trend === 'up', 'a rising series classifies as an uptrend');
ok(cls.signal === 'HOLD', 'but RSI 100 is overbought, so it is HOLD, not BUY: got ' + cls.signal);
const falling = Array.from({length: 60}, (_, i) => 20 - i * 0.1);
ok(classify(falling).trend === 'down', 'a falling series classifies as a downtrend');
ok(rsi14(falling) === 0, 'a series that only falls has RSI 0');
ok(classify(falling).signal === 'HOLD',
  'a downtrend that is already deeply oversold (RSI < 30) is HOLD, not AVOID — "it already crashed" is not "sell now": got ' + classify(falling).signal);
// A downtrend that is NOT oversold — a long decline followed by a modest bounce —
// is the one the screener should push away from: still broken, no longer cheap.
const sagging = [];
for (let i = 0; i < 45; i++) sagging.push(20 - i * 0.15);
for (let i = 0; i < 15; i++) sagging.push(sagging[sagging.length - 1] + 0.12);
ok(classify(sagging).trend === 'down' && rsi14(sagging) >= 30, 'sanity: bounced-but-broken series is a downtrend with RSI >= 30');
ok(classify(sagging).signal === 'AVOID', 'a downtrend with RSI at or above 30 is AVOID: got ' + classify(sagging).signal);
ok(classify([1,2,3]) === null, 'classify returns null without enough history');
ok(atr14([1,2],[1,2],[1,2]) === null, 'ATR returns null without enough history');

const highs = Array.from({length: 40}, (_, i) => 11 + (i % 3));
const lows  = Array.from({length: 40}, (_, i) => 9 + (i % 3));
const closes= Array.from({length: 40}, (_, i) => 10 + (i % 3));
ok(atr14(highs, lows, closes) > 0, 'ATR of a range-bound series is positive');

section('invest — entry / stop / target');
const ets = computeEntryStopTarget({ currentPrice: 10, highs, lows, closes });
ok(ets.stop < 10, 'the stop sits below the current price');
ok(ets.target > 10, 'the target sits above the current price');
ok(Math.abs((ets.target - 10) / (10 - ets.stop) - 2) < 0.01, 'target is a 2:1 reward:risk by default');
ok(ets.entry === undefined && ets.entryLow === 10, 'entryLow is the real fetched price, not a made-up level');
ok(buildInvalidation(9.5) === 'Daily close below RM9.500', 'invalidation reads as a price rule');

section('invest — position sizing');
let size = computePositionSize({ portfolioValue: 1000, maxRiskPct: 1, entry: 2, stop: 1.8, cash: 900 });
ok(size.valid, 'a well-formed sizing request is valid');
ok(Math.abs(size.riskPerShare - 0.2) < 1e-9, 'risk per share is entry minus stop');
ok(size.maxShares % 100 === 0, 'position size is rounded to whole board lots: got ' + size.maxShares);
ok(size.maxShares === 0, 'RM10 of allowed risk at RM0.20/share is under one lot, so it rounds to 0');
size = computePositionSize({ portfolioValue: 100000, maxRiskPct: 1, entry: 2, stop: 1.8, cash: 900 });
ok(size.maxShares === 400, 'when risk allows more than cash, cash is the binding limit: got ' + size.maxShares);
ok(size.limitedBy === 'cash', 'and that limit is reported as "cash"');
ok(computePositionSize({ portfolioValue: 1000, maxRiskPct: 1, entry: 2, stop: 2.5, cash: 900 }).valid === false,
  'a stop above entry is rejected for a long position');
ok(computePositionSize({ portfolioValue: 0, maxRiskPct: 1, entry: 2, stop: 1, cash: 900 }).valid === false,
  'a zero portfolio value is rejected rather than dividing by zero');

section('invest — scoring and buckets');
const strategy = DEFAULT_STRATEGY;
const maxS = maxPossibleScore(strategy.weights);
ok(maxS === 10, 'the strategy tops out at 10 points: got ' + maxS);
const hist = Array.from({length: 60}, (_, i) => ({ close: 10 + i * 0.05, high: 10.2 + i * 0.05, low: 9.8 + i * 0.05, volume: 100000 }));
const upCls = { trend: 'up', rsi: 50, sma20: 11, sma50: 10 };
let base = scoreCandidate({ hist, cls: upCls, avgVol20: 50000, regime: 'RISK_ON', fundamentals: null, strategy });
ok(base.score === 5, 'trend + momentum + volume + regime scores 5 of 10 without verified fundamentals: got ' + base.score);
ok(base.risks.some(x => /Fundamentals not verified/.test(x)), 'unverified fundamentals is surfaced as a risk, never assumed good');
let withFund = scoreCandidate({ hist, cls: upCls, avgVol20: 50000, regime: 'RISK_ON', fundamentals: { profitable: true }, strategy });
ok(withFund.score === 7, 'a user-verified profitable company adds its 2 points: got ' + withFund.score);
let down = scoreCandidate({ hist, cls: { trend: 'down', rsi: 20, sma20: 9, sma50: 10 }, avgVol20: 999999, regime: 'RISK_OFF', fundamentals: null, strategy });
ok(down.score === 0, 'a downtrend in a risk-off market on weak volume scores zero');
ok(down.risks.length >= 4, 'and every one of those is spelled out as a risk');

const card = buildDecisionCard({ ticker: '1155.KL', name: 'Maybank', currentPrice: 10, base, entryStopTarget: ets,
  positionSizing: { valid: true, maxShares: 200, portfolioRiskPct: 0.9 }, strategy });
ok(card.score === base.score + strategy.weights.riskReward + strategy.weights.positionSizing,
  'a 2:1 R:R and a workable position size each add their weight');
ok(card.maxScore === 10 && card.invalidation, 'the card carries its max score and an invalidation line');
ok(card.strategyVersion === '1.0', 'the card records which strategy version produced it');

ok(classifyBucket({ score: 8, maxScore: 10, signal: 'BUY', fitsBudget: true, liquid: true }) === 'READY', '80% BUY that fits budget is READY');
ok(classifyBucket({ score: 6, maxScore: 10, signal: 'BUY', fitsBudget: true, liquid: true }) === 'APPROACHING', '60% BUY is APPROACHING');
ok(classifyBucket({ score: 9, maxScore: 10, signal: 'BUY', fitsBudget: false, liquid: true }) === 'APPROACHING', 'a great signal you cannot afford is not READY');
ok(classifyBucket({ score: 9, maxScore: 10, signal: 'BUY', fitsBudget: true, liquid: false }) === 'AVOID', 'an illiquid name is AVOID whatever it scores');
ok(classifyBucket({ score: 9, maxScore: 10, signal: 'AVOID', fitsBudget: true, liquid: true }) === 'AVOID', 'an AVOID signal stays AVOID');

section('invest — market regime');
const upKlci = Array.from({length: 250}, (_, i) => 1000 + i);
let reg = classifyRegime({ klciCloses: upKlci, breadthPct: 70 });
ok(reg.regime === 'RISK_ON', 'a rising KLCI with broad participation is risk-on: got ' + reg.regime);
const downKlci = Array.from({length: 250}, (_, i) => 2000 - i);
ok(classifyRegime({ klciCloses: downKlci, breadthPct: 20 }).regime === 'RISK_OFF', 'a falling KLCI with narrow breadth is risk-off');
ok(classifyRegime({ klciCloses: [1, 2, 3] }).regime === 'NEUTRAL', 'too little history is NEUTRAL, not a guess');
ok(/not a prediction/i.test(reg.disclaimer), 'the regime always carries its "not a prediction" disclaimer');

section('invest — ledger');
const ledgerRows = [
  { date: '2026-01-10', side: 'Buy',  ticker: '1155.KL', qty: 100, price: 9.00, fee: 7 },
  { date: '2026-02-10', side: 'Buy',  ticker: '1155.KL', qty: 100, price: 11.00, fee: 7 },
  { date: '2026-03-10', side: 'Sell', ticker: '1155.KL', qty: 100, price: 12.00, fee: 7 },
  { date: '2026-01-15', side: 'Buy',  ticker: '5225.KL', qty: 200, price: 2.00, fee: 7 },
];
let led = reduceLedger(ledgerRows);
ok(led.holdings.length === 2, 'two tickers still hold an open position');
const may = led.holdings.find(h => h.ticker === '1155.KL');
ok(may.qty === 100, 'Maybank is down to 100 shares after the sell');
ok(Math.abs(may.avgCost - 10) < 0.001, 'avg cost stays the average of ALL buys (RM10), unrebased by the sell: got ' + may.avgCost);
ok(led.realizedTrades.length === 1, 'one realized trade was booked');
ok(Math.abs(led.realizedTrades[0].pl - ((12 - 10) * 100 - 7)) < 0.001, 'realized P/L is (exit - avg cost) x qty, minus the fee: got ' + led.realizedTrades[0].pl);

const oversell = reduceLedger([
  { date: '2026-01-10', side: 'Buy',  ticker: 'X.KL', qty: 100, price: 1, fee: 0 },
  { date: '2026-02-10', side: 'Sell', ticker: 'X.KL', qty: 500, price: 2, fee: 0 },
]);
ok(oversell.warnings.length === 1, 'selling more than you hold produces a warning rather than a silent negative position');
ok(oversell.holdings.length === 0, 'and the position closes at zero, not minus 400');

const outOfOrder = reduceLedger([
  { date: '2026-03-10', side: 'Sell', ticker: 'Y.KL', qty: 100, price: 12, fee: 0 },
  { date: '2026-01-10', side: 'Buy',  ticker: 'Y.KL', qty: 100, price: 10, fee: 0 },
]);
ok(outOfOrder.warnings.length === 0, 'rows given out of date order are sorted before reducing, so no false warning');
ok(Math.abs(outOfOrder.realizedTrades[0].pl - 200) < 0.001, 'and the P/L is still right: got ' + outOfOrder.realizedTrades[0].pl);

const malaysianDates = reduceLedger([
  { date: '10/01/2026', side: 'Buy',  ticker: 'Z.KL', qty: 100, price: 10, fee: 0 },
  { date: '10/03/2026', side: 'Sell', ticker: 'Z.KL', qty: 100, price: 12, fee: 0 },
]);
ok(malaysianDates.warnings.length === 0, 'DD/MM/YYYY rows sort correctly (a MM/DD misread would flip these)');

const mixed = reduceLedger([
  { date: '2026-01-10', type: 'Deposit', amount: 1000 },
  { date: '2026-01-11', type: 'Dividend', ticker: 'A.KL', amount: 50 },
  { date: '2026-01-12', side: 'Buy', ticker: 'A.KL', qty: 100, price: 1, fee: 0 },
]);
ok(mixed.cashFlows.length === 1 && mixed.dividends.length === 1, 'deposits and dividends are separated from trades');
ok(mixed.holdings.length === 1, 'and the actual trade still becomes a holding');
ok(reduceLedger([]).holdings.length === 0, 'an empty ledger is empty, not an error');

section('invest — portfolio heat');
let heat = computePortfolioHeat({
  holdings: [
    { ticker: 'A.KL', qty: 100, avgCost: 10, currentPrice: 11, stopPrice: 9, sector: 'Financial' },
    { ticker: 'B.KL', qty: 200, avgCost: 2,  currentPrice: 2,  stopPrice: null, sector: 'Tech' },
  ], cash: 500
});
ok(heat.totalValue === 500 + 1100 + 400, 'total value is cash plus positions at current price');
ok(heat.totalRiskAmount === 100, 'only the position with a stop contributes quantified risk: got ' + heat.totalRiskAmount);
ok(heat.unquantifiedRiskPositions.length === 1 && heat.unquantifiedRiskPositions[0] === 'B.KL',
  'the stopless position is named rather than counted as zero risk');
ok(heat.largestPosition.ticker === 'A.KL', 'largest position is identified');
ok(heat.largestSector.sector === 'Financial', 'sector concentration is computed');
ok(computePortfolioHeat({ holdings: [], cash: 0 }).portfolioHeatPct === 0, 'an empty portfolio has zero heat, not NaN');

section('invest — loss limits');
const now = new Date('2026-08-15T12:00:00');
let lim = evaluateLossLimits({
  realizedTrades: [{ date: '2026-08-15', pl: -200 }],
  limits: { daily: 150, weekly: 300, monthly: 600 }, now
});
ok(lim.daily.breached === true, 'a RM200 loss today breaches a RM150 daily limit');
ok(lim.paused === true, 'and that pauses trading');
lim = evaluateLossLimits({
  realizedTrades: [{ date: '2026-08-15', pl: 500 }],
  limits: { daily: 150, weekly: 300, monthly: 600 }, now
});
ok(lim.daily.loss === 0 && lim.paused === false, 'a winning day registers zero loss, not a negative one');
lim = evaluateLossLimits({
  realizedTrades: [{ date: '2026-07-01', pl: -1000 }],
  limits: { daily: 150, weekly: 300, monthly: 600 }, now
});
ok(lim.monthly.loss === 0, 'last month\\'s loss does not count against this month');

section('invest — streaks');
let st = consecutiveStreak([{ pl: 1 }, { pl: 1 }, { pl: -1 }, { pl: -1 }, { pl: -1 }]);
ok(st.maxWinStreak === 2 && st.maxLossStreak === 3, 'longest win and loss streaks are found');
ok(st.trailingStreak === -3, 'the streak currently running is reported as negative when losing');
ok(consecutiveStreak([]).maxWinStreak === 0, 'no trades means no streak, not an error');

section('invest — stop levels');
const rising2 = Array.from({length: 60}, (_, i) => ({ close: 10 + i * 0.1, high: 10.1 + i * 0.1, low: 9.9 + i * 0.1, volume: 1 }));
let si = computeStopInfo(rising2, 10);
ok(si.operative >= si.hardStop, 'the operative stop never sits below the hard stop');
ok(si.state === 'trailing', 'a position well in profit is on its trailing stop: got ' + si.state);
const falling2 = Array.from({length: 60}, (_, i) => ({ close: 20 - i * 0.1, high: 20.1 - i * 0.1, low: 19.9 - i * 0.1, volume: 1 }));
ok(computeStopInfo(falling2, 20).state === 'breached', 'a position below its stop reports breached');
ok(computeStopInfo(rising2.slice(0, 3), 10) === null, 'too little history returns null rather than a fake stop');

section('invest — screener ranking');
function fakeStock(code, price, trend, signal, vol) {
  return { code, name: code, sector: 'Test', price, signal, trend, rsi: 50,
    sma20: trend === 'up' ? 11 : 9, sma50: 10, avgVol20: vol,
    hist: Array.from({length: 60}, (_, i) => ({ close: price, high: price * 1.02, low: price * 0.98, volume: vol })) };
}
let screened = buildScreenRows({
  scanned: [
    fakeStock('A.KL', 1, 'up', 'BUY', 999999),
    fakeStock('B.KL', 1, 'up', 'BUY', 999999),
    fakeStock('C.KL', 1, 'up', 'BUY', 999999),
    fakeStock('D.KL', 1, 'up', 'BUY', 999999),
    fakeStock('E.KL', 1, 'up', 'BUY', 999999),
  ],
  held: [], cash: 900, regime: 'RISK_ON', strategy: DEFAULT_STRATEGY,
  riskLimits: { maxRiskPct: 1 }, investedCapital: 0
});
ok(screened.length === 3, 'only the top 3 new candidates are shown, not all 5: got ' + screened.length);
ok(screened.every(r => r.card), 'each shown BUY candidate gets a decision card');

screened = buildScreenRows({
  scanned: [fakeStock('ILLIQ.KL', 1, 'up', 'BUY', 100)],
  held: [], cash: 900, regime: 'RISK_ON', strategy: DEFAULT_STRATEGY,
  riskLimits: { maxRiskPct: 1 }, investedCapital: 0
});
ok(screened.length === 0, 'an illiquid name is filtered out of the screen entirely');

screened = buildScreenRows({
  scanned: [fakeStock('PRICEY.KL', 50, 'up', 'BUY', 999999)],
  held: [], cash: 900, regime: 'RISK_ON', strategy: DEFAULT_STRATEGY,
  riskLimits: { maxRiskPct: 1 }, investedCapital: 0
});
ok(screened.length === 0, 'a name whose lot costs more than your cash is not surfaced as a new idea');

screened = buildScreenRows({
  scanned: [fakeStock('HELD.KL', 50, 'down', 'AVOID', 100)],
  held: ['HELD.KL'], cash: 900, regime: 'RISK_OFF', strategy: DEFAULT_STRATEGY,
  riskLimits: { maxRiskPct: 1 }, investedCapital: 5000
});
ok(screened.length === 1 && screened[0].isHeld, 'but something you already hold is ALWAYS shown, however it screens');
ok(screened[0].bucket === 'AVOID', 'and its bucket tells you the truth about it');
ok(screened[0].card === null, 'a held position gets no buy card — it is a monitoring row, not a new idea');

/* ============================ RENDER ============================ */

section('render — money capture (empty state)');
state.section = 'money'; state.tab.money = 'capture'; state.transactions = []; render();
ok(html('#today-log').includes('Nothing logged today yet'), 'empty today-log shows an empty state, not a blank table');
ok(!/undefined|NaN/.test(html('#dash-stats')), 'no undefined/NaN in the stat row with zero transactions');
ok(html('#tabbar').includes('Capture') && html('#tabbar').includes('Dashboard'), 'the Money tab bar renders Money tabs');
ok(!html('#tabbar').includes('Screener'), 'and does not leak Invest tabs into the Money section');

section('render — money capture flow end to end');
state.pending = parseInput('dinner rm10, telur rm12');
render();
ok(html('#pending-list').includes('RM10.00'), 'pending list renders the parsed amount');
doSavePending();
ok(state.transactions.length === 2, 'saving commits both parsed transactions');
ok(state.pending.length === 0, 'pending clears after save');
render();
ok(html('#today-log').includes('Food (daily)'), 'today log shows the newly saved transaction');
ok(!/undefined|NaN/.test(html('#today-log')), 'no undefined/NaN in the log after a save');
ok(html('#today-log').includes('not synced'), 'a transaction not yet pushed to the Sheet says so');

section('render — money budget + dashboard');
state.tab.money = 'budget'; render();
ok(html('#budget-editor').includes('Sewa rumah (own rent)'), 'budget editor lists real categories from the sheet');
ok(html('#budget-editor').includes('250'), 'budget editor shows the real seeded target (RM250 rent)');
state.tab.money = 'dashboard'; render();
ok(!/undefined|NaN/.test(html('#dashboard-summary')), 'no undefined/NaN in dashboard summary');
ok(html('#dashboard-breakdown').includes('Food (daily)'), 'dashboard breakdown lists the Food row');

section('render — invest tabs');
state.section = 'invest'; state.tab.invest = 'screener'; render();
ok(html('#tabbar').includes('Screener') && html('#tabbar').includes('Risk'), 'the Invest tab bar renders Invest tabs');
ok(!html('#tabbar').includes('Capture'), 'and does not leak Money tabs into the Invest section');
ok(html('#results-empty').includes('Run the screener'), 'the screener starts with a prompt, not a broken table');

state.screenRows = screened; render();
ok(html('#results-body').includes('HELD.KL'), 'screener results render the ticker');
ok(!/undefined|NaN/.test(html('#results-body')), 'no undefined/NaN in screener results');

state.tab.invest = 'portfolio';
state.holdings = []; state.realizedTrades = []; state.investLoaded = false; render();
ok(html('#holdings-list').includes('Connect in Setup'), 'an unloaded portfolio tells you what to do next');
state.holdings = led.holdings.map(h => ({ ...h, currentPrice: 12, sector: 'Financial' }));
state.realizedTrades = led.realizedTrades;
state.investLoaded = true; render();
ok(html('#holdings-list').includes('1155.KL'), 'holdings table renders the ticker');
ok(!/undefined|NaN/.test(html('#holdings-list')), 'no undefined/NaN in the holdings table');
ok(!/undefined|NaN/.test(html('#portfolio-stats')), 'no undefined/NaN in the portfolio stats');
ok(html('#realized-list').includes('1155.KL'), 'realized trades render');

state.tab.invest = 'risk'; render();
ok(!/undefined|NaN/.test(html('#risk-heat')), 'no undefined/NaN in the risk heat panel');
ok(!/undefined|NaN/.test(html('#risk-limits')), 'no undefined/NaN in the loss-limit panel');
ok(html('#risk-record').includes('Win rate'), 'the track record shows a win rate once there are closed trades');
state.realizedTrades = []; render();
ok(html('#risk-record').includes('nothing to judge'), 'with no closed trades it says so instead of showing 0%/NaN');

section('render — setup');
state.section = 'setup'; render();
ok(html('#conn-status').includes('Signed in'), 'setup shows the connection state');
ok(html('#tab-map').includes('Check tabs'), 'setup prompts you to map tabs before anything else');
state.tabs = { moneyTransactions: 'Money - Transactions' }; state.tabsMissing = ['Invest transactions']; render();
ok(html('#tab-map').includes('Missing required tab'), 'a missing required tab is called out, not silently ignored');
ok(!/undefined|NaN/.test(html('#sync-status')), 'no undefined/NaN in the sync status');

section('render — section switch does not lose the sub-tab');
state.section = 'money'; state.tab.money = 'budget';
state.section = 'invest'; state.tab.invest = 'risk';
state.section = 'money'; render();
ok(activeView() === 'budget', 'coming back to Money returns to the tab you left it on');
state.section = 'invest'; render();
ok(activeView() === 'risk', 'and Invest remembers its own tab independently');

section('CSV export round trip');
state.transactions.push({ id: 'x', date: '2026-08-09', type: 'Expense', category: 'Sunday treat',
  amount: 26, note: 'a "quoted" note, with comma', createdAt: 999999999999 });
let threw = false;
try { exportCSV(); } catch (e) { threw = true; }
ok(!threw, 'exportCSV runs without throwing on a note containing a comma and quotes');

section('universe');
ok(UNIVERSE.length >= 60, 'the Bursa universe is inlined so the app works offline and from file://: got ' + UNIVERSE.length);
ok(UNIVERSE.every(u => u.code && u.name && u.sector), 'every universe entry has a code, name and sector');
ok(UNIVERSE.every(u => /\\.KL$/.test(u.code)), 'every ticker is a Bursa (.KL) symbol');
ok(sectorFor('1155.KL') === 'Financial', 'sector lookup works: got ' + sectorFor('1155.KL'));
ok(sectorFor('NOPE.KL') === 'Unclassified', 'an unknown ticker is Unclassified rather than undefined');
`);

app.done();

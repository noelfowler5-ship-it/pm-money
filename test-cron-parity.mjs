/**
 * Checks that cron/screen-and-report.mjs's ported pure functions produce
 * identical output to index.html's originals, for the same inputs. The cron
 * script duplicates this logic (index.html can't be an ES module — see the
 * comment at the top of screen-and-report.mjs), so nothing else catches drift
 * between the two if one gets edited and the other doesn't.
 */
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { boot } from './harness.js';
import * as cron from './cron/screen-and-report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const A = boot(path.join(here, 'index.html')).ctx;
const val = (expr) => vm.runInContext(expr, A);

let pass = 0, fail = 0;
const eq = (a, b, label) => {
  const X = JSON.stringify(a), Y = JSON.stringify(b);
  if (X === Y) { pass++; return; }
  fail++;
  console.log(`  x MISMATCH ${label}\n      cron: ${X}\n      app:  ${Y}`);
};

// deterministic pseudo-random series, same generator test-parity.mjs uses
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const series = [];
let px = 10;
for (let i = 0; i < 300; i++) { px += (rnd() - 0.48) * 0.3; series.push(Math.max(0.5, px)); }
const highs = series.map(c => c * 1.02), lows = series.map(c => c * 0.98);

console.log('\n[cron parity] vs index.html');

for (const p of [5, 20, 50, 200]) eq(cron.sma(series, p), val(`sma(${JSON.stringify(series)}, ${p})`), 'sma' + p);
eq(cron.rsi14(series), val(`rsi14(${JSON.stringify(series)})`), 'rsi14');
eq(cron.atr14(highs, lows, series), val(`atr14(${JSON.stringify(highs)}, ${JSON.stringify(lows)}, ${JSON.stringify(series)})`), 'atr14');
eq(cron.classify(series), val(`classify(${JSON.stringify(series)})`), 'classify');
eq(cron.maxPossibleScore({ a: 2, b: -1, c: 3 }), val('maxPossibleScore({a:2,b:-1,c:3})'), 'maxPossibleScore');

const regimeArgs = { klciCloses: series, breadthPct: 62 };
const cronRegime = cron.classifyRegime(regimeArgs);
const appRegime = val(`classifyRegime(${JSON.stringify(regimeArgs)})`);
eq({ regime: cronRegime.regime, confidence: cronRegime.confidence }, { regime: appRegime.regime, confidence: appRegime.confidence }, 'classifyRegime');

const ets = { currentPrice: 12.5, highs, lows, closes: series };
eq(cron.computeEntryStopTarget(ets), val(`computeEntryStopTarget(${JSON.stringify(ets)})`), 'computeEntryStopTarget');

const sizeArgs = { portfolioValue: 5000, maxRiskPct: 1, entry: 12.5, stop: 11.8, cash: 1200, target: 14.0 };
const cronSize = cron.computePositionSize(sizeArgs);
const appSize = val(`computePositionSize(${JSON.stringify(sizeArgs)})`);
eq({ maxShares: cronSize.maxShares, maxLoss: cronSize.maxLoss, valid: cronSize.valid },
   { maxShares: appSize.maxShares, maxLoss: appSize.maxLoss, valid: appSize.valid }, 'computePositionSize');

const bucketArgs = { score: 8, maxScore: 10, signal: 'BUY', fitsBudget: true, liquid: true };
eq(cron.classifyBucket(bucketArgs), val(`classifyBucket(${JSON.stringify(bucketArgs)})`), 'classifyBucket');

const hist = series.map((c, i) => ({ close: c, high: highs[i], low: lows[i] }));
eq(cron.computeStopInfo(hist, 9.5).state, val(`computeStopInfo(${JSON.stringify(hist)}, 9.5)`).state, 'computeStopInfo.state');

// reduceLedger: cron's version reads raw Sheet rows (arrays); index.html's
// reads normalized transaction objects. Compare on the same trade sequence.
const rawRows = [
  ['2026-01-10', 'Buy', '1155.KL', '100', '9.00', '900', 'app', 'Buy', '7'],
  ['2026-02-10', 'Sell', '1155.KL', '100', '12.00', '1200', 'app', 'Sell', '7'],
];
const cronLedger = cron.reduceLedger(rawRows);
const appLedger = val(`reduceLedger(investTxRowsToObjects(${JSON.stringify([
  ['Date','Side','Ticker','Qty','Price (RM)','Amount (RM)','Source','Type','Fee (RM)','Currency','Strategy Version','Signal Score','Setup','Emotion','Thesis','Invalidation','Rule Followed'],
  ...rawRows.map(r => [...r, 'MYR', '1.0', '', '', '', '', '']),
])}))`);
eq(cronLedger.holdings, appLedger.holdings, 'reduceLedger.holdings');
eq(cronLedger.cashDeployed, appLedger.cashDeployed, 'reduceLedger.cashDeployed');

console.log(`\n${'='.repeat(46)}\ncron parity: ${pass} identical, ${fail} unexplained\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);

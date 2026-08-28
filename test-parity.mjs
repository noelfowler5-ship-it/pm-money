/**
 * Parity check against the two apps this one replaces.
 *
 * ± money re-implements Personal CFO's Money logic and Signalvest's Invest
 * logic inline in index.html (one file, no modules, works from file://). That
 * rewrite is only trustworthy if it still behaves identically, so this runs
 * the same inputs through both and diffs the results.
 *
 * It needs the two original checkouts. Point at them with:
 *   PERSONAL_CFO=../personal-cfo SIGNALVEST=../signalvest node test-parity.mjs
 * Absent either one, that half skips rather than fails, so `npm test` still
 * works on a machine that only has this repo.
 *
 * Divergences are allowed only when listed in INTENTIONAL below, with a
 * reason. Anything else is a porting bug and fails the run.
 */
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const vm = require('vm');
const { boot } = require('./harness.js');

const here = path.dirname(new URL(import.meta.url).pathname);
const resolveRepo = (envVar, ...guesses) => {
  const candidates = [process.env[envVar], ...guesses].filter(Boolean);
  for (const c of candidates) {
    const p = path.resolve(here, c);
    if (fs.existsSync(path.join(p, 'index.html'))) return p;
  }
  return null;
};
const PERSONAL_CFO = resolveRepo('PERSONAL_CFO', '../personal-cfo');
const SIGNALVEST = resolveRepo('SIGNALVEST', '../signalvest', '../noelfowler5-ship-it/signalvest');

/* Deliberate divergences: bugs found in the originals while porting. Each is
   listed here with its reason, so an UNEXPLAINED difference still fails. */
const INTENTIONAL = new Map([
  ['parseSegment "gf rent 100"',
   "Personal CFO ordered /rent|sewa/ before /(girlfriend|gf).*rent/, and the map is first-match-wins, so \"Girlfriend's rent help\" was unreachable dead code. Reordered here so the more specific rule wins."],
  ['guessCategory "gf rent 100"', 'same rule-ordering fix as above'],
]);

let pass = 0, fail = 0, intentional = 0;
const eq = (a, b, label) => {
  const X = JSON.stringify(a), Y = JSON.stringify(b);
  if (X === Y) { pass++; return; }
  if (INTENTIONAL.has(label)) {
    intentional++;
    console.log('  ~ intentional fix: ' + label);
    console.log('      now:    ' + X);
    console.log('      was:    ' + Y);
    console.log('      reason: ' + INTENTIONAL.get(label));
    return;
  }
  fail++;
  console.log('  x MISMATCH ' + label + '\n      ours:   ' + X + '\n      theirs: ' + Y);
};

const A = boot(path.join(here, 'index.html')).ctx;
const val = (expr) => vm.runInContext(expr, A);
const valA = val;

/* ===================== vs Signalvest (Invest) ===================== */
if (!SIGNALVEST) {
  console.log('\n[Invest parity] SKIPPED - Signalvest checkout not found (set SIGNALVEST=...)');
} else {
  console.log('\n[Invest parity] vs ' + SIGNALVEST);
  const V = A;
  const SV = SIGNALVEST + '/lib/';
  const ind = await import(SV + 'indicators.js');
  const dec = await import(SV + 'decision.js');
  const reg = await import(SV + 'regime.js');
  const risk = await import(SV + 'risk.js');
  const led = await import(SV + 'ledger.js');
  const strat = await import(SV + 'strategy.js');

  // deterministic pseudo-random series
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const series = [];
  let px = 10;
  for (let i = 0; i < 300; i++) { px += (rnd() - 0.48) * 0.3; series.push(Math.max(0.5, px)); }
  const highs = series.map(c => c * 1.02), lows = series.map(c => c * 0.98);

  for (const p of [5, 20, 50, 200]) eq(V.sma(series, p), ind.sma(series, p), 'sma' + p);
  eq(V.rsi14(series), ind.rsi14(series), 'rsi14');
  eq(V.atr14(highs, lows, series), ind.atr14(highs, lows, series), 'atr14');

  // classify over many windows — this is the one I restructured, so check every slice
  for (let n = 40; n <= 300; n += 7) {
    const s = series.slice(0, n);
    eq(V.classify(s), ind.classify(s), 'classify@' + n);
  }

  eq(val('DEFAULT_STRATEGY').weights, strat.DEFAULT_STRATEGY.weights, 'strategy weights');
  eq(V.maxPossibleScore(val('DEFAULT_STRATEGY').weights), strat.maxPossibleScore(strat.DEFAULT_STRATEGY.weights), 'maxPossibleScore');

  const hist = series.map((c, i) => ({ close: c, high: highs[i], low: lows[i], volume: 100000 + i * 10 }));
  for (const regime of ['RISK_ON', 'NEUTRAL', 'RISK_OFF']) {
    for (const f of [null, { profitable: true }, { profitable: false }]) {
      const cls = ind.classify(series);
      const args = { hist, cls, avgVol20: 90000, regime, fundamentals: f, strategy: strat.DEFAULT_STRATEGY };
      eq(V.scoreCandidate({ ...args, strategy: val('DEFAULT_STRATEGY') }), dec.scoreCandidate(args), `scoreCandidate ${regime}/${JSON.stringify(f)}`);
    }
  }

  const etsArgs = { currentPrice: series[series.length - 1], highs, lows, closes: series };
  eq(V.computeEntryStopTarget(etsArgs), dec.computeEntryStopTarget(etsArgs), 'computeEntryStopTarget');
  eq(V.buildInvalidation(9.123), dec.buildInvalidation(9.123), 'buildInvalidation');

  const base = dec.scoreCandidate({ hist, cls: ind.classify(series), avgVol20: 90000, regime: 'RISK_ON', fundamentals: null, strategy: strat.DEFAULT_STRATEGY });
  const ets = dec.computeEntryStopTarget(etsArgs);
  for (const sizing of [null, { valid: true, maxShares: 0 }, { valid: true, maxShares: 300, portfolioRiskPct: 0.8 }]) {
    const a = { ticker: 'T.KL', name: 'T', currentPrice: 10, base, entryStopTarget: ets, positionSizing: sizing };
    eq(V.buildDecisionCard({ ...a, strategy: val('DEFAULT_STRATEGY') }), dec.buildDecisionCard({ ...a, strategy: strat.DEFAULT_STRATEGY }), 'buildDecisionCard ' + JSON.stringify(sizing));
  }

  for (const sig of ['BUY', 'HOLD', 'AVOID'])
    for (const fb of [true, false])
      for (const lq of [true, false])
        for (const sc of [0, 3, 5, 7, 9, 10])
          eq(V.classifyBucket({ score: sc, maxScore: 10, signal: sig, fitsBudget: fb, liquid: lq }),
             dec.classifyBucket({ score: sc, maxScore: 10, signal: sig, fitsBudget: fb, liquid: lq }),
             `classifyBucket ${sig}/${fb}/${lq}/${sc}`);

  for (const b of [null, 10, 50, 55, 90]) {
    const a = { klciCloses: series, breadthPct: b };
    const mine = V.classifyRegime(a), theirs = reg.classifyRegime(a);
    eq(mine.regime, theirs.regime, 'regime ' + b);
    eq(mine.confidence, theirs.confidence, 'regime confidence ' + b);
  }
  eq(V.classifyRegime({ klciCloses: [1,2,3] }).regime, reg.classifyRegime({ klciCloses: [1,2,3] }).regime, 'regime short history');

  for (const pv of [0, 1000, 100000]) for (const e of [2, 9.5]) for (const st of [1.8, 9.0, 12]) for (const c of [0, 900, 50000]) {
    const a = { portfolioValue: pv, maxRiskPct: 1, entry: e, stop: st, cash: c, target: e * 1.2 };
    eq(V.computePositionSize(a), risk.computePositionSize(a), `positionSize ${pv}/${e}/${st}/${c}`);
  }

  const holds = [
    { ticker: 'A.KL', qty: 100, avgCost: 10, currentPrice: 11, stopPrice: 9, sector: 'Fin' },
    { ticker: 'B.KL', qty: 200, avgCost: 2, currentPrice: 2, stopPrice: null, sector: 'Tech' },
    { ticker: 'C.KL', qty: 50, avgCost: 5, stopPrice: 4, sector: 'Fin' },
  ];
  eq(V.computePortfolioHeat({ holdings: holds, cash: 500 }), risk.computePortfolioHeat({ holdings: holds, cash: 500 }), 'portfolioHeat');
  eq(V.computePortfolioHeat({ holdings: [], cash: 0 }), risk.computePortfolioHeat({ holdings: [], cash: 0 }), 'portfolioHeat empty');

  const rt = [
    { date: '2026-08-15', pl: -80 }, { date: '2026-08-14', pl: -50 },
    { date: '2026-08-01', pl: 200 }, { date: '2026-07-20', pl: -400 },
  ];
  const now = new Date('2026-08-15T12:00:00');
  eq(V.evaluateLossLimits({ realizedTrades: rt, limits: { daily: 150, weekly: 300, monthly: 600 }, now }),
     risk.evaluateLossLimits({ realizedTrades: rt, limits: { daily: 150, weekly: 300, monthly: 600 }, now }), 'lossLimits');

  for (const arr of [[], [{pl:1}], [{pl:1},{pl:1},{pl:-1},{pl:-1},{pl:-1},{pl:0},{pl:1}]])
    eq(V.consecutiveStreak(arr), risk.consecutiveStreak(arr), 'streak ' + JSON.stringify(arr));

  const txRows = [
    { date: '2026-01-10', side: 'Buy', ticker: '1155.KL', qty: 100, price: 9, fee: 7 },
    { date: '2026-02-10', side: 'Buy', ticker: '1155.KL', qty: 100, price: 11, fee: 7 },
    { date: '2026-03-10', side: 'Sell', ticker: '1155.KL', qty: 100, price: 12, fee: 7 },
    { date: '2026-01-15', side: 'Buy', ticker: '5225.KL', qty: 200, price: 2, fee: 7 },
    { date: '2026-04-01', type: 'Dividend', ticker: '1155.KL', amount: 50 },
    { date: '2026-04-02', type: 'Deposit', amount: 1000 },
    { date: '2026-05-01', side: 'Sell', ticker: '5225.KL', qty: 500, price: 3, fee: 7 },
  ];
  const mine = V.reduceLedger(txRows), theirs = led.reduceLedger(txRows);
  eq(mine.holdings, theirs.holdings, 'ledger holdings');
  eq(mine.realizedTrades, theirs.realizedTrades, 'ledger realizedTrades');
  eq(mine.dividends, theirs.dividends, 'ledger dividends');
  eq(mine.cashFlows, theirs.cashFlows, 'ledger cashFlows');
  eq(mine.realizedPLTotal, theirs.realizedPLTotal, 'ledger realizedPLTotal');
  eq(mine.warnings, theirs.warnings, 'ledger warnings');
  eq(V.reduceLedger([]), led.reduceLedger([]), 'ledger empty');
}

/* ===================== vs Personal CFO (Money) ===================== */
if (!PERSONAL_CFO) {
  console.log('\n[Money parity] SKIPPED - Personal CFO checkout not found (set PERSONAL_CFO=...)');
} else {
  console.log('\n[Money parity] vs ' + PERSONAL_CFO);
  const B = boot(path.join(PERSONAL_CFO, 'index.html')).ctx;
  const valB = (e) => vm.runInContext(e, B);
  eq(valA('CATEGORIES'), valB('CATEGORIES'), 'category taxonomy + budget targets');
  eq(valA('CATEGORY_NAMES'), valB('CATEGORY_NAMES'), 'category names');
  eq(valA('[...LEARN_STOPWORDS]'), valB('[...LEARN_STOPWORDS]'), 'learn stopwords');

  const inputs = [
    'dinner rm10', 'Netflix 17.90', 'rent 500', 'sewa 250', 'received salary 1900',
    'reload boost RM150', 'RM30 church offering', 'mom gave me RM100', 'bought RM300 Maybank',
    'beli telur 12', 'apple 12.50', 'petrol 60', 'minyak rm45', 'tnb bill 88',
    'asb 350', 'ef1 150', 'gold 200', 'sunday treat 26', 'dobi 12', 'post jog drinks 8',
    'ptptn 100', 'car sinking fund 120', 'freelance 400', 'refund 25', 'no amount here',
    'americano 12.90', 'nasi lemak 6', 'kangkung 3.50', 'utility 20', 'gf rent 100',
  ];
  for (const s of inputs) {
    eq(A.parseSegment(s), B.parseSegment(s), 'parseSegment ' + JSON.stringify(s));
    eq(A.guessCategory(s, null), B.guessCategory(s, null), 'guessCategory ' + JSON.stringify(s));
    eq(A.extractAmount(s), B.extractAmount(s), 'extractAmount ' + JSON.stringify(s));
  }

  const multi = ['dinner rm10, telur rm12, apple rm12.50', 'beli telur 12\napple 12.50', 'a, b, c'];
  for (const s of multi) {
    eq(A.parseInput(s, null), B.parseInput(s, null), 'parseInput ' + JSON.stringify(s));
    eq(A.splitSegments(s), B.splitSegments(s), 'splitSegments ' + JSON.stringify(s));
  }

  // learning loop must teach identically
  for (const [text, cat] of [['KFC dinner', 'Sunday treat'], ['grab ride home', 'Petrol'], ['the rm paid', 'Utility']]) {
    const la = {}, lb = {};
    A.learnFromCorrection(text, cat, la);
    B.learnFromCorrection(text, cat, lb);
    eq(la, lb, 'learnFromCorrection ' + JSON.stringify(text));
    eq(A.guessCategory(text, la), B.guessCategory(text, lb), 'guessCategory after learning ' + JSON.stringify(text));
  }

  const txs = [
    { date: '2026-08-06', type: 'Income',  category: 'Full-time salary (net)', amount: 1942.95 },
    { date: '2026-08-06', type: 'Expense', category: 'Sewa rumah (own rent)',  amount: 250 },
    { date: '2026-08-08', type: 'Expense', category: 'Food (daily)',           amount: 24.6 },
    { date: '2026-07-01', type: 'Expense', category: 'Food (daily)',           amount: 999 },
  ];
  for (const m of ['2026-08', '2026-07', '2026-06'])
    eq(A.monthlyTotals(txs, m), B.monthlyTotals(txs, m), 'monthlyTotals ' + m);
  eq(A.lifetimeCash(txs), B.lifetimeCash(txs), 'lifetimeCash');

  for (const d of ['2026-08-06', '2026-01-01', '2026-12-31', '2026-02-28'])
    eq(A.fmtSheetDate(d), B.fmtSheetDate(d), 'fmtSheetDate ' + d);

  for (const col of [[['Date'],['06 Aug 2026'],['']], [['Date']], [['Date'],['x'],['y']], [['Date'],[''],['y']]])
    eq(A.findFirstEmptyRow(col), B.findFirstEmptyRow(col), 'findFirstEmptyRow ' + JSON.stringify(col));

  // duplicate flagging
  const today = valA('todayISO()');
  const existing = [{ date: today, type: 'Expense', category: 'Petrol', amount: 30 }];
  const ca = [{ amount: 30, category: 'Petrol' }, { amount: 30, category: 'Food (daily)' }, { amount: null, category: 'Petrol' }];
  const cb = JSON.parse(JSON.stringify(ca));
  A.flagDuplicates(ca, existing, today);
  B.flagDuplicates(cb, existing, today);
  eq(ca, cb, 'flagDuplicates');

  // sync writes: same rows/values, only the tab name differs (pm-money targets the merged tab)
  const cands = [
    { id: 'a', date: '2026-08-20', category: 'Petrol', amount: 30, note: 'petrol' },
    { id: 'b', date: '2026-08-20', category: 'Food (daily)', amount: 12.5, note: 'lunch' },
  ];
  const wa = A.buildSyncWrites(cands, 32, 'Transactions');
  const wb = B.buildSyncWrites(cands, 32);
  // pm-money always single-quotes the tab name (required once tabs are named
  // "Money - Transactions"; harmless on a bare name). Everything that actually
  // lands in a cell -- row, column span, values -- must still be identical.
  const strip = (w) => JSON.parse(JSON.stringify(w).replace(/'([A-Za-z0-9 _-]+)'!/g, '$1!'));
  eq(strip(wa), wb, 'buildSyncWrites (identical rows/columns/values once quoting is normalized)');
  eq(wa.map(w => w.ab.range), ["'Transactions'!A32:B32", "'Transactions'!A33:B33"], 'pm-money quotes the tab name');
}

console.log('\n' + '='.repeat(60));
console.log(`parity: ${pass} identical, ${intentional} intentional fix(es), ${fail} unexplained`);
console.log('='.repeat(60));
if (!PERSONAL_CFO && !SIGNALVEST) {
  console.log('Both sources were missing - nothing was actually compared.');
}
process.exit(fail ? 1 : 0);

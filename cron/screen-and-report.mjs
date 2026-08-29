#!/usr/bin/env node
/**
 * Morning screener — the fresh cron behind ± money's Invest section.
 *
 * pm-money itself is a static, client-only page (no server, no build step),
 * so it can only screen while you have it open. This script is the piece
 * that runs unattended: a GitHub Actions job wakes it up every weekday
 * morning, it reads your combined spreadsheet, screens the same Bursa
 * universe with the same rules as the app, and pushes a Telegram digest.
 * It also writes the day's live Invest total into the NetWorth tab's
 * Moomoo cell, so Net Worth stays current without hand-typing it.
 *
 * It duplicates (rather than imports) index.html's pure scoring/sizing
 * logic — index.html is deliberately not an ES module (it has to keep
 * working opened straight from disk with no build step), so there is no
 * shared module to import from. Keep the two in sync by hand if the
 * strategy changes; test-parity.mjs only compares index.html against the
 * old apps, not against this file.
 *
 * Required environment (set as GitHub Actions secrets):
 *   GOOGLE_SERVICE_ACCOUNT_JSON  service account key JSON, as one line
 *   TELEGRAM_BOT_TOKEN           from @BotFather
 *   TELEGRAM_CHAT_ID             your chat id (see cron/README.md)
 * Optional:
 *   SHEET_ID                     defaults to the same combined sheet the app uses
 */

import crypto from 'node:crypto';

/* ============================ CONFIG ============================ */

const SHEET_ID = process.env.SHEET_ID || '18gPV_WMHzWHH4zppVu8jGl8Y36rAxknjBv3pD3OivXY';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TOP_CANDIDATES = 3;
const LIQUIDITY_FLOOR = 50000;
const LOT_SIZE = 100;
const DEFAULT_RISK_LIMITS = { daily: 150, weekly: 300, monthly: 600, maxRiskPct: 1 };
const DEFAULT_STRATEGY = {
  id: "sma-rsi-v1", version: "1.0",
  weights: { trend: 2, momentum: 1, volume: 1, fundamentals: 2, marketRegime: 1, riskReward: 2, positionSizing: 1 },
};

// Same 67-name Bursa universe as index.html. Keep these two lists identical.
const UNIVERSE = [
  { code: "1155.KL", name: "Malayan Banking (Maybank)", sector: "Financial" },
  { code: "1295.KL", name: "Public Bank", sector: "Financial" },
  { code: "1023.KL", name: "CIMB Group", sector: "Financial" },
  { code: "1066.KL", name: "RHB Bank", sector: "Financial" },
  { code: "5819.KL", name: "Hong Leong Bank", sector: "Financial" },
  { code: "1082.KL", name: "Hong Leong Financial Group", sector: "Financial" },
  { code: "1015.KL", name: "AMMB (AmBank)", sector: "Financial" },
  { code: "2488.KL", name: "Alliance Bank", sector: "Financial" },
  { code: "5185.KL", name: "Affin Bank", sector: "Financial" },
  { code: "5258.KL", name: "BIMB Holdings", sector: "Financial" },
  { code: "1818.KL", name: "Bursa Malaysia", sector: "Financial" },
  { code: "6888.KL", name: "Axiata Group", sector: "Telecommunications" },
  { code: "6012.KL", name: "Maxis", sector: "Telecommunications" },
  { code: "6947.KL", name: "CelcomDigi", sector: "Telecommunications" },
  { code: "4863.KL", name: "Telekom Malaysia", sector: "Telecommunications" },
  { code: "5347.KL", name: "Tenaga Nasional", sector: "Utilities" },
  { code: "4677.KL", name: "YTL Corporation", sector: "Utilities" },
  { code: "6742.KL", name: "YTL Power International", sector: "Utilities" },
  { code: "5183.KL", name: "Petronas Chemicals", sector: "Energy" },
  { code: "6033.KL", name: "Petronas Gas", sector: "Energy" },
  { code: "5681.KL", name: "Petronas Dagangan", sector: "Energy" },
  { code: "3816.KL", name: "MISC", sector: "Energy" },
  { code: "7293.KL", name: "Yinson Holdings", sector: "Energy" },
  { code: "5141.KL", name: "Dayang Enterprise", sector: "Energy" },
  { code: "5210.KL", name: "Bumi Armada", sector: "Energy" },
  { code: "5243.KL", name: "Velesto Energy", sector: "Energy" },
  { code: "5218.KL", name: "Sapura Energy", sector: "Energy" },
  { code: "5199.KL", name: "Hibiscus Petroleum", sector: "Energy" },
  { code: "7277.KL", name: "Dialog Group", sector: "Energy" },
  { code: "5285.KL", name: "Sime Darby Plantation", sector: "Plantation" },
  { code: "1961.KL", name: "IOI Corporation", sector: "Plantation" },
  { code: "2445.KL", name: "Kuala Lumpur Kepong (KLK)", sector: "Plantation" },
  { code: "5222.KL", name: "FGV Holdings", sector: "Plantation" },
  { code: "2291.KL", name: "Genting Plantations", sector: "Plantation" },
  { code: "4197.KL", name: "Sime Darby", sector: "Industrial" },
  { code: "3182.KL", name: "Genting Berhad", sector: "Consumer" },
  { code: "4715.KL", name: "Genting Malaysia", sector: "Consumer" },
  { code: "4707.KL", name: "Nestle (Malaysia)", sector: "Consumer" },
  { code: "3689.KL", name: "Fraser & Neave (F&N)", sector: "Consumer" },
  { code: "4065.KL", name: "PPB Group", sector: "Consumer" },
  { code: "7084.KL", name: "QL Resources", sector: "Consumer" },
  { code: "3026.KL", name: "Dutch Lady Milk Industries", sector: "Consumer" },
  { code: "5296.KL", name: "MR DIY Group", sector: "Consumer" },
  { code: "7052.KL", name: "Padini Holdings", sector: "Consumer" },
  { code: "5398.KL", name: "Gamuda", sector: "Property & Construction" },
  { code: "3336.KL", name: "IJM Corporation", sector: "Property & Construction" },
  { code: "5211.KL", name: "Sunway Berhad", sector: "Property & Construction" },
  { code: "8664.KL", name: "S P Setia", sector: "Property & Construction" },
  { code: "5148.KL", name: "UEM Sunrise", sector: "Property & Construction" },
  { code: "8206.KL", name: "Eco World Development", sector: "Property & Construction" },
  { code: "8583.KL", name: "Mah Sing Group", sector: "Property & Construction" },
  { code: "7113.KL", name: "Top Glove Corporation", sector: "Healthcare" },
  { code: "5168.KL", name: "Hartalega Holdings", sector: "Healthcare" },
  { code: "7106.KL", name: "Supermax Corporation", sector: "Healthcare" },
  { code: "7153.KL", name: "Kossan Rubber Industries", sector: "Healthcare" },
  { code: "5225.KL", name: "IHH Healthcare", sector: "Healthcare" },
  { code: "0166.KL", name: "Inari Amertron", sector: "Technology" },
  { code: "0128.KL", name: "Frontken Corporation", sector: "Technology" },
  { code: "0097.KL", name: "ViTrox Corporation", sector: "Technology" },
  { code: "3867.KL", name: "Malaysian Pacific Industries (MPI)", sector: "Technology" },
  { code: "5005.KL", name: "Unisem (M)", sector: "Technology" },
  { code: "7160.KL", name: "Pentamaster Corporation", sector: "Technology" },
  { code: "0208.KL", name: "Greatech Technology", sector: "Technology" },
  { code: "7204.KL", name: "D&O Green Technologies", sector: "Technology" },
  { code: "0138.KL", name: "MyEG Services", sector: "Technology" },
  { code: "5099.KL", name: "AirAsia Group (Capital A)", sector: "Transportation" },
  { code: "0036.KL", name: "KGROUP", sector: "Unclassified" },
];

/* ============================ PURE LOGIC (ported from index.html) ============================ */

const num = (v) => { const n = Number(String(v ?? '').replace(/[, ]/g, '')); return isNaN(n) ? 0 : n; };
const fmtRM = (n) => {
  const v = Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
  return (v < 0 ? '-' : '') + 'RM' + Math.abs(v).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const MONTHS_SHORT = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
function parseSheetDate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/);
  if (m) { const mo = MONTHS_SHORT.indexOf(m[2].slice(0, 3).toLowerCase()); if (mo >= 0) return new Date(+m[3], mo, +m[1]); }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function sma(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function rsi14(closes) {
  const period = 14;
  if (closes.length < period + 1) return null;
  const changes = [];
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) { const c = changes[i]; if (c > 0) avgGain += c; else avgLoss += -c; }
  avgGain /= period; avgLoss /= period;
  for (let i = period; i < changes.length; i++) {
    const c = changes[i];
    avgGain = (avgGain * (period - 1) + (c > 0 ? c : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (c < 0 ? -c : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function atr14(highs, lows, closes) {
  const period = 14;
  if (highs.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  let a = trs.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}

function classify(closes) {
  const s20 = sma(closes, 20), s50 = sma(closes, 50), r = rsi14(closes);
  if (s20 == null || s50 == null || r == null) return null;
  let trend = "flat";
  if (s20 > s50) trend = "up"; else if (s20 < s50) trend = "down";
  let signal = "HOLD";
  if (trend === "up" && r >= 35 && r <= 68) signal = "BUY";
  else if (trend === "down" && r >= 30) signal = "AVOID";
  return { trend, rsi: r, signal, sma20: s20, sma50: s50 };
}

function classifyRegime({ klciCloses, breadthPct = null }) {
  const s20 = sma(klciCloses, 20), s50 = sma(klciCloses, 50), s200 = sma(klciCloses, 200);
  const reasons = [];
  let votes = 0, total = 0;
  if (s20 != null && s50 != null) { total++; if (s20 > s50) { votes++; reasons.push("KLCI SMA20 above SMA50 (short-term uptrend)"); } else reasons.push("KLCI SMA20 at/below SMA50 (short-term flat or down)"); }
  if (s50 != null && s200 != null) { total++; if (s50 > s200) { votes++; reasons.push("KLCI SMA50 above SMA200 (long-term uptrend)"); } else reasons.push("KLCI SMA50 at/below SMA200 (long-term flat or down)"); }
  if (breadthPct != null) { total++; if (breadthPct >= 55) { votes++; reasons.push(`${breadthPct.toFixed(0)}% of the universe is in an uptrend (broad)`); } else reasons.push(`${breadthPct.toFixed(0)}% of the universe is in an uptrend (narrow)`); }
  if (total === 0) return { regime: "NEUTRAL", reasons: ["Not enough KLCI history to classify"], confidence: 0 };
  const confidence = votes / total;
  let regime = "NEUTRAL";
  if (confidence >= 0.66) regime = "RISK_ON";
  else if (confidence <= 0.33) regime = "RISK_OFF";
  return { regime, reasons, confidence, votes, total };
}

function maxPossibleScore(weights) { return Object.values(weights).reduce((s, w) => s + Math.abs(Number(w) || 0), 0); }

function scoreCandidate({ hist, cls, avgVol20, regime, strategy }) {
  const w = strategy.weights;
  const positives = [], risks = [];
  let score = 0;
  if (cls.trend === "up") { score += w.trend; positives.push(`Uptrend — SMA20 (RM${cls.sma20.toFixed(3)}) above SMA50 (RM${cls.sma50.toFixed(3)})`); }
  else if (cls.trend === "down") risks.push("Downtrend — SMA20 below SMA50");
  else risks.push("No clear trend — SMA20 ≈ SMA50");
  if (cls.rsi >= 35 && cls.rsi <= 68) { score += w.momentum; positives.push(`RSI ${cls.rsi.toFixed(1)} — healthy momentum, not overbought`); }
  else if (cls.rsi > 68) risks.push(`RSI ${cls.rsi.toFixed(1)} — overbought, chasing risk`);
  else risks.push(`RSI ${cls.rsi.toFixed(1)} — weak or oversold momentum`);
  const lastVol = hist.length ? hist[hist.length - 1].volume : 0;
  const volRatio = avgVol20 > 0 ? lastVol / avgVol20 : null;
  if (volRatio != null) {
    if (volRatio >= 1.2) { score += w.volume; positives.push(`Volume +${Math.round((volRatio - 1) * 100)}% vs 20d average — confirmation`); }
    else risks.push(`Volume ${Math.round(volRatio * 100)}% of 20d average — weak confirmation`);
  }
  risks.push("Fundamentals not verified — check manually before acting");
  if (regime === "RISK_ON") { score += w.marketRegime; positives.push("Market regime: risk-on"); }
  else if (regime === "RISK_OFF") risks.push("Market regime: risk-off — lower-conviction environment");
  else risks.push("Market regime: neutral");
  return { score, positives, risks };
}

function computeEntryStopTarget({ currentPrice, highs, lows, closes, targetRR = 2 }) {
  const atr = atr14(highs, lows, closes);
  if (atr == null) return null;
  const entryLow = +currentPrice.toFixed(3);
  const entryHigh = +(currentPrice * 1.03).toFixed(3);
  const stop = +(currentPrice - 2 * atr).toFixed(3);
  const riskPerShare = currentPrice - stop;
  const target = +(currentPrice + targetRR * riskPerShare).toFixed(3);
  return { entryLow, entryHigh, stop, target, riskPerShare, rr: targetRR, atr };
}

function buildDecisionCard({ ticker, name, currentPrice, base, ets, sizing, strategy }) {
  const w = strategy.weights;
  let score = base.score;
  const positives = [...base.positives], risks = [...base.risks];
  if (ets && ets.rr >= 2) { score += w.riskReward; positives.push(`Risk:reward ${ets.rr.toFixed(1)} — favorable`); }
  else if (ets) risks.push(`Risk:reward ${ets.rr.toFixed(1)} — below 2:1`);
  if (sizing && sizing.valid && sizing.maxShares > 0) { score += w.positionSizing; positives.push(`Position sizing fits your risk limit and cash (max ${sizing.maxShares} shares)`); }
  else if (sizing && sizing.valid) risks.push("Position sizing rounds to 0 shares at your current risk limit / cash — too small to act on");
  return {
    ticker, name, price: currentPrice, score, maxScore: maxPossibleScore(w),
    entry: ets ? [ets.entryLow, ets.entryHigh] : null, stop: ets ? ets.stop : null, target: ets ? ets.target : null,
    rr: ets ? ets.rr : null, positionSizing: sizing || null, positives, risks,
  };
}

function classifyBucket({ score, maxScore, signal, fitsBudget, liquid }) {
  if (!liquid || signal === "AVOID") return "AVOID";
  const pct = maxScore > 0 ? score / maxScore : 0;
  if (signal === "BUY" && pct >= 0.7 && fitsBudget) return "READY";
  if (signal === "BUY" && pct >= 0.5) return "APPROACHING";
  return "WATCH";
}

function computePositionSize({ portfolioValue, maxRiskPct, entry, stop, cash, target, lotSize = LOT_SIZE }) {
  if (!(portfolioValue > 0) || !(entry > 0) || stop == null || !(stop >= 0) || stop >= entry) return { valid: false };
  const riskPerShare = entry - stop;
  const maxRiskAmount = portfolioValue * (maxRiskPct / 100);
  const maxSharesByRisk = Math.floor(maxRiskAmount / riskPerShare / lotSize) * lotSize;
  const maxSharesByCash = cash > 0 ? Math.floor(cash / entry / lotSize) * lotSize : 0;
  const maxShares = Math.max(0, Math.min(maxSharesByRisk, maxSharesByCash));
  return { valid: true, riskPerShare, maxShares, maxCapital: maxShares * entry, maxLoss: maxShares * riskPerShare,
           rr: target != null && target > entry ? (target - entry) / riskPerShare : null };
}

function computeStopInfo(hist, avgCost) {
  const closes = hist.map(h => h.close), highs = hist.map(h => h.high), lows = hist.map(h => h.low);
  const atr = atr14(highs, lows, closes);
  if (atr == null) return null;
  const currentPrice = closes[closes.length - 1];
  const highestHigh = Math.max(...highs.slice(-Math.min(22, highs.length)));
  const hardStop = avgCost - 2 * atr;
  const chandelier = highestHigh - 3 * atr;
  const operative = Math.max(hardStop, chandelier);
  let state;
  if (currentPrice <= operative) state = "breached";
  else if (currentPrice <= operative * 1.03) state = "near";
  else if (chandelier > hardStop) state = "trailing";
  else state = "initial";
  return { operative, state, currentPrice };
}

const CASH_TYPES = new Set(["Deposit", "Withdrawal"]);
function reduceLedger(rawTransactions) {
  const txs = rawTransactions
    .map((r, i) => ({
      date: r[0], side: r[1], ticker: String(r[2] || '').toUpperCase().trim(),
      qty: num(r[3]), price: num(r[4]), fee: num(r[8]), index: i,
    }))
    .filter(t => t.ticker && t.qty > 0)
    .sort((a, b) => {
      const da = parseSheetDate(a.date), db = parseSheetDate(b.date);
      if (da && db && da.getTime() !== db.getTime()) return da - db;
      return a.index - b.index;
    });

  const positions = new Map();
  let cashDeployed = 0;
  for (const t of txs) {
    const pos = positions.get(t.ticker) || { qty: 0, buyQty: 0, buyAmount: 0 };
    if (t.side === "Buy") {
      pos.qty += t.qty; pos.buyQty += t.qty; pos.buyAmount += t.qty * t.price;
      cashDeployed += t.qty * t.price + t.fee;
      positions.set(t.ticker, pos);
    } else if (t.side === "Sell") {
      const sellQty = Math.min(t.qty, pos.qty);
      cashDeployed -= sellQty * t.price - t.fee;
      pos.qty -= sellQty;
      positions.set(t.ticker, pos);
    }
  }
  const holdings = [];
  for (const [ticker, pos] of positions.entries()) {
    if (pos.qty > 0) holdings.push({ ticker, qty: pos.qty, avgCost: pos.buyQty > 0 ? pos.buyAmount / pos.buyQty : 0 });
  }
  return { holdings, cashDeployed };
}

/* ============================ GOOGLE SHEETS (service account) ============================ */

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getServiceAccountToken() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');
  const key = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  };
  const signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claims));
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(key.private_key);
  const jwt = signingInput + '.' + signature.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  const json = await res.json();
  if (!json.access_token) throw new Error('service account auth failed: ' + JSON.stringify(json));
  return json.access_token;
}

function a1(tab, range) { return "'" + String(tab).replace(/'/g, "''") + "'!" + range; }
const sheetUrl = (path) => `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SHEET_ID)}${path}`;

async function sheetsGet(token, path) {
  const res = await fetch(sheetUrl(path), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
async function sheetsPut(token, range, values) {
  const res = await fetch(sheetUrl(`/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`), {
    method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ range, values }),
  });
  if (!res.ok) throw new Error(`Sheets write ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

function resolveTab(titles, exactNames, sectionKw, roleKw) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  let hit = exactNames.find(n => titles.includes(n));
  if (hit) return hit;
  return titles.find(t => { const n = norm(t); return n.includes(norm(sectionKw)) && n.includes(norm(roleKw)); }) || null;
}

/* ============================ MARKET DATA ============================ */

async function fetchHistory(ticker) {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=6mo&interval=1d`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const data = await res.json();
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  if (!result) throw new Error('no data for ' + ticker);
  const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const closes = q.close || [], volumes = q.volume || [], highs = q.high || [], lows = q.low || [];
  const clean = [];
  for (let i = 0; i < closes.length; i++) {
    if (closes[i] != null) clean.push({ close: closes[i], volume: volumes[i] || 0, high: highs[i] ?? closes[i], low: lows[i] ?? closes[i] });
  }
  return clean;
}

/* ============================ TELEGRAM ============================ */

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('--- Telegram not configured, printing digest instead ---\n' + text);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
  });
  if (!res.ok) console.error('Telegram send failed: ' + (await res.text()).slice(0, 300));
}

/* ============================ MAIN ============================ */

async function main() {
  const token = await getServiceAccountToken();

  const meta = await sheetsGet(token, '?fields=sheets.properties.title');
  const titles = (meta.sheets || []).map(s => s.properties && s.properties.title).filter(Boolean);
  const moneyTab = resolveTab(titles, ['Money - Transactions', 'Transactions'], 'money', 'transactions');
  const investTab = resolveTab(titles, ['Invest - Transactions'], 'invest', 'transactions');
  const configTab = resolveTab(titles, ['Invest - Config', 'Config'], 'invest', 'config');
  const netWorthTab = resolveTab(titles, ['NetWorth - Net Worth', 'Net Worth'], 'networth', 'networth');
  if (!moneyTab || !investTab) throw new Error(`Could not find required tabs. Found: ${titles.join(', ')}`);

  // Funded ceiling — lifetime "Investment fund" total from Money.
  const moneyRows = ((await sheetsGet(token, `/values/${encodeURIComponent(a1(moneyTab, 'A2:E'))}`)).values || []);
  const fundedTotal = moneyRows.reduce((s, r) => (String(r[1] || '').trim() === 'Investment fund' ? s + num(r[3]) : s), 0);

  // Ledger — open holdings and net cash deployed.
  const investRows = ((await sheetsGet(token, `/values/${encodeURIComponent(a1(investTab, 'A2:Q'))}`)).values || []);
  const ledger = reduceLedger(investRows);
  const cash = Math.max(0, fundedTotal - ledger.cashDeployed);

  // Risk limits from Invest - Config, defaults otherwise.
  const riskLimits = { ...DEFAULT_RISK_LIMITS };
  if (configTab) {
    const cfgRows = ((await sheetsGet(token, `/values/${encodeURIComponent(a1(configTab, 'A:B'))}`)).values || []);
    const byKey = new Map(cfgRows.map(r => [String(r[0] || '').trim().toLowerCase(), r[1]]));
    const pick = (...labels) => { for (const l of labels) { const v = byKey.get(l.toLowerCase()); if (v != null && String(v).trim() !== '') return num(v); } return null; };
    riskLimits.maxRiskPct = pick('Max risk per trade (%)', 'Max risk per trade') ?? riskLimits.maxRiskPct;
    riskLimits.daily = pick('Daily loss limit (RM)', 'Daily loss limit') ?? riskLimits.daily;
    riskLimits.weekly = pick('Weekly loss limit (RM)', 'Weekly loss limit') ?? riskLimits.weekly;
    riskLimits.monthly = pick('Monthly loss limit (RM)', 'Monthly loss limit') ?? riskLimits.monthly;
  }

  // Price + stop status for open holdings.
  const heldSectorless = ledger.holdings.map(h => ({ ...h }));
  for (const h of heldSectorless) {
    try {
      const hist = await fetchHistory(h.ticker);
      if (hist.length) { h.currentPrice = hist[hist.length - 1].close; h.stopInfo = computeStopInfo(hist, h.avgCost); }
    } catch (e) { /* one bad ticker shouldn't sink the run */ }
  }
  const investedCapital = heldSectorless.reduce((s, h) => s + h.qty * (h.currentPrice ?? h.avgCost), 0);

  // Scan the universe.
  const universe = UNIVERSE.slice();
  const heldTickers = new Set(heldSectorless.map(h => h.ticker));
  heldTickers.forEach(t => { if (!universe.find(u => u.code === t)) universe.push({ code: t, name: t, sector: 'Unclassified' }); });

  const scanned = [];
  let upCount = 0, classifiedCount = 0;
  for (const stock of universe) {
    try {
      const hist = await fetchHistory(stock.code);
      const closes = hist.map(h => h.close);
      const cls = classify(closes);
      if (!cls) continue;
      classifiedCount++;
      if (cls.trend === 'up') upCount++;
      scanned.push({ ...stock, ...cls, hist, price: closes[closes.length - 1],
        avgVol20: hist.slice(-20).reduce((a, h) => a + h.volume, 0) / Math.min(20, hist.length) });
    } catch (e) { /* skip unreachable ticker */ }
  }

  let regimeInfo = { regime: 'NEUTRAL', reasons: ['Not enough KLCI history'], confidence: 0 };
  try {
    const klci = await fetchHistory('^KLSE');
    regimeInfo = classifyRegime({ klciCloses: klci.map(h => h.close), breadthPct: classifiedCount > 0 ? (upCount / classifiedCount) * 100 : null });
  } catch (e) { /* regime stays NEUTRAL */ }

  const portfolioValue = cash + investedCapital;
  const rows = scanned.map(s => {
    const lotCost = s.price * LOT_SIZE;
    return { ...s, lotCost, liquid: s.avgVol20 >= LIQUIDITY_FLOOR, fitsBudget: lotCost <= cash, trendStrength: (s.sma20 - s.sma50) / s.sma50 };
  }).filter(r => !heldTickers.has(r.code) && r.liquid && r.fitsBudget);

  const buyCandidates = rows.filter(r => r.signal === 'BUY').sort((a, b) => b.trendStrength - a.trendStrength).slice(0, TOP_CANDIDATES);
  const cards = buyCandidates.map(r => {
    const base = scoreCandidate({ hist: r.hist, cls: r, avgVol20: r.avgVol20, regime: regimeInfo.regime, strategy: DEFAULT_STRATEGY });
    const ets = computeEntryStopTarget({ currentPrice: r.price, highs: r.hist.map(h => h.high), lows: r.hist.map(h => h.low), closes: r.hist.map(h => h.close) });
    const sizing = ets ? computePositionSize({ portfolioValue, maxRiskPct: riskLimits.maxRiskPct, entry: r.price, stop: ets.stop, cash, target: ets.target }) : null;
    const card = ets ? buildDecisionCard({ ticker: r.code, name: r.name, currentPrice: r.price, base, ets, sizing, strategy: DEFAULT_STRATEGY }) : null;
    const bucket = classifyBucket({ score: card ? card.score : 0, maxScore: maxPossibleScore(DEFAULT_STRATEGY.weights), signal: r.signal, fitsBudget: r.fitsBudget, liquid: r.liquid });
    return { r, card, bucket };
  }).filter(c => c.card && (c.bucket === 'READY' || c.bucket === 'APPROACHING'));

  // ---- write today's Invest total into NetWorth's Moomoo cell ----
  if (netWorthTab) {
    try {
      const grid = ((await sheetsGet(token, `/values/${encodeURIComponent(a1(netWorthTab, 'A1:J60'))}`)).values || []);
      let target = null;
      for (let r = 0; r < grid.length && !target; r++) {
        const row = grid[r] || [];
        for (let c = 0; c < row.length; c++) if (String(row[c] || '').trim().toLowerCase() === 'moomoo') { target = { r, c: c + 1 }; break; }
      }
      if (target) {
        const colLetter = (i0) => { let n = i0 + 1, s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
        const cellRange = a1(netWorthTab, `${colLetter(target.c)}${target.r + 1}`);
        const total = Math.round(((cash + investedCapital) + Number.EPSILON) * 100) / 100;
        await sheetsPut(token, cellRange, [[total]]);
      }
    } catch (e) { console.error('NetWorth push failed (non-fatal): ' + e.message); }
  }

  // ---- compose and send the digest ----
  const today = new Date().toLocaleDateString('en-MY', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const lines = [];
  lines.push(`*± money — morning screen*`);
  lines.push(today);
  lines.push('');
  lines.push(`Market regime: *${regimeInfo.regime.replace('_', '-')}* (${Math.round((regimeInfo.confidence || 0) * 100)}% confidence)`);
  lines.push(`Investment fund: ${fmtRM(fundedTotal)} funded, ${fmtRM(cash)} available, ${fmtRM(investedCapital)} deployed in ${heldSectorless.length} position(s).`);
  lines.push('');

  const breached = heldSectorless.filter(h => h.stopInfo && h.stopInfo.state === 'breached');
  const near = heldSectorless.filter(h => h.stopInfo && h.stopInfo.state === 'near');
  if (breached.length) lines.push(`⚠️ *Stop breached:* ${breached.map(h => h.ticker).join(', ')}`);
  if (near.length) lines.push(`⚠️ *Near stop:* ${near.map(h => h.ticker).join(', ')}`);
  if (breached.length || near.length) lines.push('');

  if (!cards.length) {
    lines.push('No actionable setups today. Not financial advice.');
  } else {
    lines.push(`*Top ${cards.length} candidate(s)* (${cards[0].bucket === 'READY' ? 'ready to size' : 'approaching'}):`);
    cards.forEach(({ r, card, bucket }, i) => {
      lines.push('');
      lines.push(`${i + 1}. *${r.code}* — ${r.name} [${bucket}]`);
      lines.push(`   Price RM${r.price.toFixed(3)} · Entry ${card.entry[0].toFixed(3)}–${card.entry[1].toFixed(3)} · Stop ${card.stop.toFixed(3)} · Target ${card.target.toFixed(3)} (${card.rr.toFixed(1)}R)`);
      if (card.positionSizing && card.positionSizing.valid) {
        lines.push(`   Size: ${card.positionSizing.maxShares} shares · Max loss ${fmtRM(card.positionSizing.maxLoss)}`);
      }
      lines.push(`   ${card.positives[0] || ''}`);
    });
    lines.push('');
    lines.push('Not financial advice. You execute with your broker, then log the trade in the app.');
  }

  await sendTelegram(lines.join('\n'));
  console.log(`Done. Scanned ${classifiedCount} tickers, ${cards.length} candidate(s) sent.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('Morning screen failed: ' + e.stack); process.exit(1); });
}

export { sma, rsi14, atr14, classify, classifyRegime, scoreCandidate, computeEntryStopTarget,
         buildDecisionCard, classifyBucket, computePositionSize, computeStopInfo, reduceLedger,
         parseSheetDate, maxPossibleScore };

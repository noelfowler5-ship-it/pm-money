# ± money

Money in, money out — and what you own. One app over one spreadsheet.

This replaces two apps ([Personal CFO](https://github.com/noelfowler5-ship-it/personal-cfo)
and [Signalvest](https://github.com/noelfowler5-ship-it/signalvest)) and the
three spreadsheets behind them, without losing anything either one did.

## Two sections, on purpose

The app opens on a **Money / Invest / Setup** switcher, and Money and Invest
never blend into each other:

| | Money 💰 | Invest 📈 |
|---|---|---|
| Tabs | Capture · Log · Budget · Dashboard | Screener · Portfolio · Risk |
| Question it answers | Where did this month go? | What do I own, what does it risk, what next? |
| Rhythm | Every day, seconds at a time | Weekly, deliberately |
| Sheet tabs | `Money - *` | `Invest - *` |

They share exactly one thing: the Google Sheet connection in **Setup**. Deciding
whether to buy a stock and deciding whether you overspent on food are different
decisions on different clocks — a single blended dashboard makes you worse at
both, so this doesn't build one.

## What's in each section

**Money** — type what happened (`dinner rm10, telur rm12`), the app splits it,
guesses the amount and category, and shows an editable confirmation card before
saving anything. Correcting a category teaches it that word for next time.
A same-category, same-amount entry already logged today is flagged as a possible
duplicate rather than silently double-counted. Sync pushes new rows into
`Money - Transactions` columns A/B and D/E only — never C (Type) or F (Month),
which are the sheet's own formulas.

**Invest** — screens the Bursa universe on live prices, and for each candidate
that passes shows a scored card: what's good, what's risky, and the
entry/stop/target with a position size fitted to your cash and risk limit. It
never emits a bare "BUY", never fabricates a resistance level (stops and targets
come from real ATR), and never places an order — you execute with your broker,
then log the trade back. Portfolio reads your trade history into current
holdings, average cost and realized P/L. Risk shows portfolio heat (what you'd
actually lose if every stop hit), loss limits, and your track record.

**Setup** — sign in to Google, point at the spreadsheet, map the tabs, and set
your cash and risk limits.

## The spreadsheet

One combined spreadsheet holds everything, with tabs prefixed by section:

- `Money - Transactions`, `Money - Budget Plan`, `Money - Dashboard`
- `NetWorth - *`
- `Invest - Transactions`, `Invest - Holdings`, `Invest - Config`, …

Tab names are **discovered at runtime**, not hardcoded — the app reads the
spreadsheet's tab list and maps it. Exact names win; a section+keyword fallback
means a rename doesn't silently break sync, and the app still works pointed at
the un-merged original sheets. **Setup → Check tabs** shows exactly what it
mapped and what it couldn't find.

## Running it

No install, no build step:

1. Clone or download this repo.
2. Open `index.html` in a browser.

Everything works from a double-click except installing to your home screen and
Google sign-in — those need it served over HTTPS. On GitHub Pages it lives at
https://noelfowler5-ship-it.github.io/pm-money/

### Google sign-in setup

Sign-in needs the page's origin registered in Google Cloud Console:

1. **APIs & Services → Credentials →** your OAuth client → **Authorized
   JavaScript origins** → add `https://noelfowler5-ship-it.github.io`
   (origin only — no path, no trailing slash).
2. **OAuth consent screen → Test users** → add your own email. While the app
   is in Testing mode you cannot sign into your own app without this.

The OAuth **Client ID** is embedded in `index.html`, which is correct and safe —
that's what client IDs are for. There is no client **secret** anywhere in this
repo, and there must never be one: a browser app cannot keep it secret, and the
test suite fails the build if one appears.

## Development

`index.html` is the whole app — HTML, CSS and JS inline, no modules, no
bundler. `manifest.json` and `service-worker.js` make it installable and
offline-capable.

```sh
npm test
```

runs four suites, all of which must stay green:

- **`node test.js`** — 213 assertions covering parsing, budget math, the
  learning loop, duplicate detection, tab discovery, A1 quoting, sheet-date
  parsing, indicators, scoring, position sizing, the ledger, risk math, screener
  ranking, and every render path (asserting no `undefined`/`NaN` reaches the
  screen). It also runs a static audit of the file itself: every element ID the
  script reaches for must exist in the markup, and no client secret or ES module
  may appear.

- **`node test-integration.js`** — 32 assertions against the Google Sheets path
  with `fetch` replaced by a recorder, checking what would actually go over the
  wire: the right tab, the first empty row, correctly quoted A1 ranges, the full
  17-column trade row, never a write to the formula columns, and no request at
  all when no tab is mapped. No network or credentials needed.

- **`node test-parity.mjs`** — 328 checks running identical inputs through this
  app and through the two originals, asserting the rewrite didn't change
  behaviour. It needs the old checkouts nearby (`../personal-cfo`,
  `../signalvest`, or set `PERSONAL_CFO=` / `SIGNALVEST=`); if they're missing
  it skips rather than fails.

- **`node test-cron-parity.mjs`** — checks that `cron/screen-and-report.mjs`
  (the standalone morning-screen script — see below) produces identical
  output to index.html's own scoring/sizing functions for the same inputs,
  since the cron script duplicates rather than imports that logic.

`test.js` runs the app's own JavaScript inside Node against a stubbed DOM
(`harness.js`) — no browser required.

### One behaviour that deliberately changed

Personal CFO's keyword table listed `/rent|sewa/` **before**
`/(girlfriend|gf).*rent/`. The table is first-match-wins, so the second rule was
unreachable: `Girlfriend's rent help` could never be auto-assigned. ± money
reorders them so the more specific rule wins. This is the only intentional
behavioural difference, and `test-parity.mjs` records it explicitly — any
*other* divergence fails the run.

Sheet dates are also parsed more carefully than before. Rows can arrive as ISO,
Malaysian `DD/MM/YYYY`, or the `06 Aug 2026` text the Money tab uses;
`new Date()` reads `10/03/2026` as October and silently mis-sorts the ledger, so
the format is detected explicitly instead.

### Morning screen (cron)

`cron/screen-and-report.mjs` is a fresh, standalone script — the app itself
can't run in the background (it's a static page, no server), so this is what
actually screens every weekday morning unattended: it reads the combined
sheet directly (via a Google service account, not your personal sign-in),
scans the same universe with the same rules as the in-app Screener, pushes a
Telegram digest, and writes the day's live Invest total into the NetWorth
tab's Moomoo cell. See `cron/README.md` for one-time setup (service account,
Telegram bot, GitHub Actions secrets). It replaces Signalvest's old GitHub
Actions + Telegram cron, which pointed at the standalone (pre-merge) sheet.

### Notes for later

- Personal CFO and Signalvest stay live as backups until this has run for a
  while. Nothing here writes to their spreadsheets.

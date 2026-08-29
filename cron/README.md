# Morning screen — setup

`screen-and-report.mjs` runs unattended on a GitHub Actions schedule
(`.github/workflows/morning-screen.yml`, weekdays 08:00 Malaysia time). Each
run:

1. Reads your combined spreadsheet directly — no browser, no sign-in.
2. Computes "cash available to invest" the same way the app does: your
   lifetime `Investment fund` total (Money) minus what's currently deployed
   in open positions (Invest).
3. Scans the same 67-stock Bursa universe with the same rules as the app's
   Screener, and picks out the top few actionable candidates.
4. Writes today's live Invest total (cash + market value of holdings) into
   the NetWorth tab's Moomoo cell.
5. Sends a Telegram digest.

It needs three things set up once, outside the app.

## 1. A Google service account (so it can read/write the sheet unattended)

The app itself uses your personal Google sign-in — that only works with a
person clicking "Connect Google" in a browser. A cron job has no one to click
anything, so it needs its own identity: a **service account**.

1. Go to [console.cloud.google.com](https://console.cloud.google.com), same
   project as the app's OAuth client (or a new one — either works).
2. **APIs & Services → Credentials → Create Credentials → Service account.**
   Any name, e.g. `pm-money-cron`. No roles needed — skip that step.
3. Open the new service account → **Keys → Add key → Create new key → JSON.**
   This downloads a `.json` file — treat it like a password.
4. Open your combined Google Sheet → **Share** → paste the service account's
   email (looks like `pm-money-cron@your-project.iam.gserviceaccount.com`,
   also inside the downloaded JSON as `client_email`) → give it **Editor**
   access. Without this step the cron can read but never write (NetWorth
   push will silently fail).
5. Copy the **entire contents** of the downloaded JSON file — you'll paste it
   as one GitHub secret below.

## 2. A Telegram bot (for the morning digest)

You already know Telegram, so this reuses it rather than introducing
something new — it's free either way.

1. In Telegram, message **[@BotFather](https://t.me/BotFather)** →
   `/newbot` → follow the prompts (name + username). It replies with a
   **bot token** (`123456789:AAExample-Token`).
2. Message your new bot anything (e.g. "hi") so it has a conversation to
   send into.
3. Find your **chat ID**: message
   **[@userinfobot](https://t.me/userinfobot)** — it replies with your
   numeric ID. (Or open `https://api.telegram.org/bot<TOKEN>/getUpdates`
   after step 2 and read `"chat":{"id": ...}` from the JSON.)

## 3. GitHub Actions secrets

In the `pm-money` repo → **Settings → Secrets and variables → Actions →
New repository secret.** Add:

| Secret | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the whole JSON file from step 1, pasted as-is |
| `TELEGRAM_BOT_TOKEN` | the bot token from step 2 |
| `TELEGRAM_CHAT_ID` | the numeric chat ID from step 2 |
| `SHEET_ID` | optional — only if you ever point this at a different sheet than the app |

## Testing it

**Actions** tab → **Morning screen** → **Run workflow** (the
`workflow_dispatch` trigger) runs it on demand, without waiting for 8am. Check
the run's log, and check Telegram for the digest.

## Keeping it in sync with the app

`screen-and-report.mjs` duplicates index.html's scoring/sizing logic rather
than importing it — index.html deliberately isn't an ES module (it has to
keep working opened straight from disk, no build step), so there's no shared
file to import from. `npm test` runs `test-cron-parity.mjs`, which checks the
two copies produce identical output for the same inputs — if you change the
strategy in one, that test will fail until you change it in the other too.

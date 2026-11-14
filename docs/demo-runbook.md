# Demo runbook

Demo is 25% of the score. This is the checklist, the click path, and the fallback for every step.
Wording on stage: "candidates" and "matches", never "recommendations". Keep "Educational research, not investment advice." visible.

## 0. How this system fails (read once)

- **Render free tier sleeps** after ~15 min idle and takes up to a minute to wake.
- **Render's disk is ephemeral.** Every restart, redeploy or env-var change wipes `data/db.json`: the seeded feed, the saved thesis, the paper ledger, the sentiment cache and the "email sent today" flag. After a wipe `/api/stocks` quietly serves fixture data until n8n seeds again.
- **Never change an env var or deploy after you have seeded.** Do all of that first.
- **The challenge email fires at most once per UTC day**, on the first "challenges" match after a thesis exists. Rehearsals that save a thesis can burn today's slot. Use the Reset procedure (section 5) before the real run.
- **Fallbacks are silent.** If Alpaca is down, buys are simulated and the portfolio falls back to fixture trades, and the UI cannot tell. `npm run preflight` is how you find out.

## 1. Env flags on Render (set well before the demo)

| Var | Value | Why |
|---|---|---|
| `GEMINI_API_KEY`, `GEMINI_BASE_URL`, `GEMINI_MODEL` | your key, `https://generativelanguage.googleapis.com/v1beta/openai/`, flash-lite model | sentiment now, council text when wired |
| `COUNCIL_MODE` | `lite` (use `mini` if Gemini limits bite) | fewer LLM calls |
| `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` | paper keys | live prices, paper buys |
| `INBOUND_WEBHOOK_SECRET` | same value as the n8n "LOOP Webhook Secret" credential | seed webhook auth (503/401 without it) |
| `N8N_NOTIFY_WEBHOOK_URL` | n8n Notify Webhook **production** URL | Contract E email |
| `NOTIFY_TO_EMAIL` | the demo inbox | email recipient |
| `PUBLIC_URL` | `https://tfsa-gold-site.onrender.com` | link in the email button |
| `DEMO_SEED` | `true` | seeds the 4 backdated paper trades on boot |

`FINNHUB_KEY` is not needed on Render, only in the n8n credential. `PORT` is set by Render.
Boot log should show: `LOOP server on :...` and `[demo-seed] DEMO SCAFFOLDING: seeded 4 backdated paper trades`. A `[WARNING] server/thesis.js is the STUB` line means Vamsi's file is not in.

## 2. Warm-up sequence

Times are relative to the start of the demo (T).

1. **T-90 min** Deploy final `main`, set env, confirm the boot log above.
2. **T-60** Warm and keep warm. Start this in a terminal and leave it running until the demo:
   `while true; do curl -s -o /dev/null https://tfsa-gold-site.onrender.com/api/health; sleep 600; done`
3. **T-45 Warm Render BEFORE any live n8n run.** Cold start plus the sentiment call (up to ~65 s) can exceed the POST node's 120 s timeout on the first attempt. The node retries (3 tries, 20 s apart) will cover it, but the first attempt shows red in the execution log and looks like a failure if anyone is watching. Run `npm run preflight -- https://tfsa-gold-site.onrender.com` first; it waits out the cold start.
4. **T-40** Run the n8n workflow with the Manual Trigger. Expect the final POST to answer `{"ok":true,"accepted":~55-60,...,"sentiment":{"scored":N,"failed":false}}`. If n8n fails, use the curl fallback in section 4, step B.
5. **T-35** `npm run preflight -- <url>` must end `PASSED: 0 fail`. Read every WARN:
   - `llmConfigured` false: FAIL, fix the key.
   - `feedRunDate` not today / `X-Data-Source: fixture`: the feed is not live, reseed.
   - `sentimentMissing` true: the news score is a constant, reseed (see fallbacks).
   - `thesisIsStub` true: every typed goal returns the same fixture thesis; acceptable only if you say so.
   - rank 1 without bull/bear text: the council has not run; the detail drawer will show no analysis.
   - portfolio IDENTICAL to fixture: running on fallback, not live Alpaca.
6. **T-30** Write down the top 3 per tier from the preflight output (cheat sheet for narration). Spot-check the expense ratios (MER) of any ETF in a top 10 against the issuer's page; they were entered from memory. MER is never shown as a number in the UI.
7. **T-20 Test the email branch without using the backend's daily slot:** POST a sample Contract E body straight to the n8n production webhook URL:
   `curl -X POST "$N8N_URL" -H 'content-type: application/json' -d '{"to":"<inbox>","ticker":"VOO","headline":"Fed signals rate hikes","stance":"challenges","whyItMatters":"Test","thesisGoal":"Long-term growth","link":"https://tfsa-gold-site.onrender.com/#thesis"}'`
   Check the inbox on a laptop and a phone.
8. **T-15** Do not save a thesis from the app (see section 0). If you did, run the Reset procedure.
9. **T-10** Open the app on the laptop and on a phone. Clear the site's localStorage (`tier`, `thesis`) so onboarding shows. Have ready: app tab, portfolio tab, Gmail tab, the backup screen recording. Close the n8n execution list.

## 3. The 3-minute click path

UI screens are from Anne's and Dianne's briefs; confirm the exact paths after the join.

| Time | Do | Show / say | Expected |
|---|---|---|---|
| 0:00 | Open the URL | The problem: beginners get hype or spreadsheets, neither says if a pick fits their situation. | Onboarding with three profile cards |
| 0:25 | Click **Starting out** | Today's feed: ranked candidates with a match score and a one-line why. | Top 10, low tier, funds and steady names |
| 0:55 | Click the rank 1 row | Five-part score breakdown, bull case, bear case, council verdict, news tags. | Drawer opens |
| 1:20 | Switch the tier chip: **Some knowledge**, then **Experienced** | The list reorders instantly. Same engine, different risk fit. | Orderings differ (preflight checks this) |
| 1:50 | Back to onboarding or the goals box; type: "I want to invest $20 every two weeks and grow my money long-term." | Goals in plain English become a thesis with assumptions to monitor. | Thesis card with 2-3 assumptions |
| 2:15 | **Paper buy** $500 on a row, then open the portfolio | Virtual money, real prices. The green "what if you had used real money" banner and the dated trades list. | Confirmation, then stat cards, banner, positions |
| 2:45 | Show the email in the inbox | When news challenges an assumption, you hear about it. | "A development affects your thesis" (arrives when the thesis is saved and a challenge exists) |
| 2:55 | Close | We are not another stock picker: we connect your goals to real-world events, with evidence. Educational research, not advice. | |

## 4. Fallback at each step

| Step | If this goes wrong | Do this |
|---|---|---|
| A. Page will not load | Render still asleep | Wait up to 60 s. If it does not come up, switch to the backup screen recording. |
| B. Feed is fixture/stale or empty | No seed since the last restart, or n8n failed | Reseed from the repo, bypassing n8n: `curl -X POST "$URL/api/webhook/seed" -H 'content-type: application/json' -H "x-webhook-secret: $SECRET" --data @fixtures/seed.sample.json`. The sample has sentiment filled in, so it works even with no Gemini key. It is 21 hand-written tickers, so say it is sample data if asked. |
| C. Tier switch looks identical | Only one tier seeded or a UI bug | Check `curl "$URL/api/stocks?tier=high"` differs from low. The backend orderings always differ (preflight). |
| D. Drawer has no bull/bear/verdict | Council not wired or Gemini failed | Narrate from the score breakdown and news tags. Last resort: with no seed at all, `/api/stocks` serves the fixture feed, which has full hand-written text; say it is sample data. |
| E. Sentiment missing (`sentimentMissing` true) | Gemini down or rate limited | Reseed with the fixture (step B). Or wait a minute and reseed; scores are cached for 7 days so a retry costs little. |
| F. Thesis returns the same text for any goal | `thesisIsStub` is true | Use the example goal above, which matches the fixture, and do not claim it is personalized. |
| G. Paper buy errors | Alpaca down or bad ticker | The backend simulates a fill at the last known price and the demo continues. Do not mash the button: each click adds a trade. |
| H. Stock buy on a weekend | The market is closed (Sunday demo) | Alpaca queues the order; the app estimates quantity and entry price from the latest (Friday) price. Believed to work; verify in rehearsal. Crypto trades 24/7. |
| I. Portfolio looks like the sample | Alpaca keys missing or unreachable | It is still a valid view. Say the numbers are seeded demo trades, which they are. |
| J. Email does not arrive | Slot already used today, webhook URL wrong, Gmail credential | Check the n8n Notify Webhook execution. Show the template from the earlier test email (step 7). Reset procedure if you need a clean slot. |
| K. n8n run shows red on the first attempt | Cold start plus sentiment exceeded the 120 s timeout | The retries cover it. Better: warm Render first and do not show the n8n log live; show a recorded green execution instead. |

## 5. Reset procedure (clean slate after rehearsals)

Do the last rehearsal, then reset, then do not touch anything but the click path:

1. Restart the service in the Render dashboard (this wipes feed, thesis, ledger, notify flag, sentiment cache).
2. Wait for the boot log; confirm the `[demo-seed]` line.
3. Run the n8n workflow (or the curl in step B of section 4).
4. `npm run preflight -- <url>`: PASSED, and the thesis check reports "no thesis saved yet".
5. Clear the browser's localStorage (section 2, step 9).

## 6. Known gaps at the time of writing

- `council.js` is not wired yet, so bull/bear/verdict are null in the live feed.
- `server/thesis.js` is a stub until Vamsi's file is dropped in.
- Anne's and Dianne's pages are not joined to the endpoints yet.
- ETF expense ratios are unverified (they only affect the cost score).
- The n8n workflow has not been imported into a real n8n instance; expect small first-import fixes (credential selection, the POST node's URL).

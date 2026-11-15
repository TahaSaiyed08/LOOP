# THESIS: Taha, backbone and integration

Deadline Sunday 5:00 pm. Code freeze Sunday 3:00 pm. You join every piece.

## What we are building

A personalized daily feed of stocks and ETFs. The user picks a risk profile (Starting out, Some knowledge, Experienced) or describes their goals in plain English, which becomes an investment thesis with assumptions to monitor. Every day n8n pulls market data, insider filings and news from free APIs. The backend scores about 60 tickers per tier with a deterministic 0 to 100 match score, an AI council writes bull and bear cases for the top 10, and news is tagged as supporting or challenging the user's thesis. A challenge triggers an email. Users can paper buy any pick through Alpaca's paper API and see what it would have returned with real money. Educational research, not advice.

Flow: n8n daily -> POST /api/webhook/seed -> scoring + council + thesis match -> GET /api/stocks -> paper buy -> portfolio. Email branch: backend -> n8n webhook -> Gmail.

## Rules for the team (you enforce these)

1. Contracts below are frozen. Changes go through you, you update this doc, then code changes on both sides.
2. Each person edits only their own files. Only you touch `server/index.js`, `.env`, and the n8n workflow.
3. UI handoffs are plain HTML, CSS and JS files that fetch the contract endpoints. No screenshots or Figma links as deliverables.

## Your files

Everything in `server/`, the n8n workflow, `.env`, `fixtures/`, the Render deploy.

## Stack

- LLM: Gemini free tier via OpenAI-compatible endpoint. Flash-Lite class model. Check real daily limits in the AI Studio console first. Space calls 5 seconds apart. Create 2 backup keys under different Google accounts
- Market data and paper trading: Alpaca (free, no card). US-listed universe only. Canadian TFSA tax scoring still applies
- News: Finnhub free (300 calls/day). Insider filings: SEC EDGAR (free, needs User-Agent header)
- Voice briefing: ElevenLabs, stretch goal
- n8n Cloud: 85 executions on the plan. Develop on manual trigger, enable daily cron at the end only

Env vars: `GEMINI_API_KEY`, `GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/`, `GEMINI_MODEL`, `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY`, `FINNHUB_KEY`, `INBOUND_WEBHOOK_SECRET`, `N8N_NOTIFY_WEBHOOK_URL`, `COUNCIL_MODE` (lite, or mini as the fallback).

## Contracts

### A: n8n to backend

`POST /api/webhook/seed`, header `x-webhook-secret`. n8n sends raw metrics only, the backend does all scoring.

```json
{
  "runDate": "2026-11-15",
  "stocks": [
    {
      "ticker": "VOO",
      "companyName": "Vanguard S&P 500 ETF",
      "category": "index_etf",
      "price": 512.4,
      "beta": 1.0,
      "dividendYieldPct": 1.3,
      "priceChange5dPct": 3.2,
      "avgVolume": 48200000,
      "usListed": true,
      "merPct": 0.03,
      "peRatio": null,
      "marketCapB": null,
      "insider": { "count": 0, "execBuyer": false, "totalUsd": 0 },
      "news": [
        { "headline": "Fed holds rates steady", "source": "Reuters", "url": "https://example.com", "sentiment": 0.2, "datetime": "2026-11-15T13:00:00Z" }
      ]
    }
  ]
}
```

`category`: `index_etf`, `bond_etf`, `dividend_etf`, `sector_etf`, `reit`, `large_cap`, `mid_cap`, `small_cap`, `thematic_etf`, `crypto`. Tier eligibility comes from category in the backend. `insider` is zeros for ETFs. `peRatio` and `marketCapB` are null for ETFs, `merPct` is null for stocks.

`priceChange5dPct` is the 5-trading-day price change in percent and `avgVolume` is average daily volume in shares (units for crypto), both derived from Alpaca bars. *Extension (Taha, Nov 14): these two fields added to Contract A. Either may be `null` if bars are unavailable; the scorer then treats momentum as neutral and skips the liquidity check.*

### B: the feed

`GET /api/stocks?tier=low|medium|high`, sorted by rank.

```json
[
  {
    "id": "a1b2c3",
    "rank": 1,
    "ticker": "VOO",
    "companyName": "Vanguard S&P 500 ETF",
    "category": "index_etf",
    "tier": "low",
    "matchScore": 87,
    "scoreBreakdown": { "signal": 12, "riskFit": 19, "cost": 18, "quality": 20, "news": 18 },
    "why": "Low fee broad market fit for a long horizon",
    "price": 512.4,
    "bullCase": "two to four sentences",
    "bearCase": "two to four sentences",
    "verdict": "the council chairman's short verdict",
    "newsTags": [ { "headline": "Fed holds rates steady", "stance": "supports", "url": "https://example.com" } ],
    "updatedAt": "2026-11-15T14:05:00Z"
  }
]
```

The five breakdown parts are each 0 to 20 and sum to `matchScore`. The feed is the top 10 or fewer, never padded. `bullCase`, `bearCase`, `verdict` can be null as graceful degradation when the council failed or has not run on a row; null is not a statement about rank. *(Reinterpreted by Taha, Nov 14; no shape change.)* `stance`: `supports`, `challenges`, `neutral`.

### C: thesis (Vamsi's functions, your endpoints)

`POST /api/thesis` body `{ "goalsText": "..." }` returns:

```json
{
  "id": "t1",
  "goal": "Long-term growth with small recurring deposits",
  "budget": { "amount": 20, "cadence": "biweekly" },
  "horizonYears": 10,
  "tier": "low",
  "assumptions": ["Broad index funds beat stock picking at this budget", "Low fees compound more than hot picks over 10 years"],
  "createdAt": "2026-11-15T14:00:00Z"
}
```

`GET /api/thesis` returns the saved one or 404. Daily news matching produces objects like:

```json
{ "ticker": "VOO", "headline": "Fed holds rates steady", "url": "https://example.com", "assumptionIndex": 0, "stance": "supports", "whyItMatters": "One sentence" }
```

### D: paper trading

`POST /api/paper/buy` body `{ "ticker": "VOO", "amountUsd": 500 }` returns `{ "orderId", "ticker", "qty", "entryPrice", "filledAt", "fillNote" }`. `fillNote` is `null` for a genuine Alpaca fill; otherwise a plain-words reason the fill was estimated or simulated, e.g. `"market closed, simulated at Friday's close ($512.40); order queued at Alpaca"`.

`GET /api/paper/portfolio`:

```json
{
  "startValue": 10000,
  "value": 10340,
  "returnPct": 3.4,
  "whatIfLine": "With real money since Oct 28 you would be up $340",
  "positions": [ { "ticker": "VOO", "qty": 2, "entryPrice": 498.1, "currentPrice": 512.4, "plUsd": 28.6, "plPct": 2.9, "fillNote": null } ],
  "trades": [ { "ticker": "VOO", "side": "buy", "qty": 2, "price": 498.1, "at": "2026-10-28T14:30:00Z", "fillNote": null } ]
}
```

`positions` are aggregate per ticker with no date (`entryPrice` is the quantity-weighted average of that ticker's buys). `trades` is the order history (maps to Alpaca's orders endpoint), one row per filled order, newest first, `side` is `buy` or `sell`. *Amendment (Taha, Nov 14): `trades` added to Contract D.* *Amendment (Taha, Nov 14): `fillNote` (string or null) added to the buy response, to every position and to every trade. It is non-null for anything that was not a genuine Alpaca execution: sample-fixture data, backdated demo trades (priced at the real close, no order placed), simulated fills (no Alpaca keys or Alpaca down), and equity buys while the market is closed (position estimated from the last trade, order queued at Alpaca). A position's `fillNote` joins its trades' distinct notes with "; ". The UI may show it as small text; no badge is required.*

`GET /api/paper/portfolio` also sets the response header `X-Data-Source: live | fixture`. `live` means Alpaca priced every position and the ledger contains no sample-fixture trades; any fallback is `fixture`. Same convention as `/api/stocks`.

Alpaca paper API backs it. Seed 3 to 4 trades backdated 2 to 3 weeks so the demo shows real movement.

### E: notification email

Backend posts to `N8N_NOTIFY_WEBHOOK_URL`, n8n Gmail node sends using Dianne's template:

```json
{
  "to": "user@email.com",
  "ticker": "VOO",
  "headline": "Fed signals rate hikes",
  "stance": "challenges",
  "whyItMatters": "One sentence from the news match",
  "thesisGoal": "Long-term growth with small recurring deposits",
  "link": "https://tfsa-gold-site.onrender.com/#thesis"
}
```

## Build order

1. **First, today:** save the samples above as `fixtures/feed.sample.json` (10 rows), `fixtures/portfolio.sample.json`, `fixtures/thesis.sample.json`. Push and tell the team. All three other lanes are blocked until this exists
2. Gemini swap: two env values, add the 5 second delay between calls
3. Rework `scoring.js`: five components 0 to 20, weights per tier, category to tier eligibility map
4. `alpaca.js`: quotes, bars, paper buy, positions, backdated seed trades
5. n8n workflow sending Contract A: Alpaca, Finnhub per ticker, EDGAR Form 4 for stocks, hardcoded universe of about 60 tickers in a Code node
6. Wire Vamsi's `thesis.js` into `/api/thesis` and the daily match step, add the Contract E call
7. Join Anne's and Dianne's pages, flip fixture URLs to real endpoints

## Integration checklist

- Sat evening: scoring and Gemini live, manual n8n run fills the feed
- Sat night: join Anne's feed (swap fixture URL to `/api/stocks`)
- Sun morning: wire thesis.js, join Dianne's portfolio, seed paper trades
- Sun midday: email branch, voice briefing if time, polish with Anne and Dianne
- Sun 3:00 pm: freeze, enable daily cron, warm the Render URL, rehearse 3 times, record a backup screen capture
- Sun 5:00 pm: submit

If a join needs more than the one-line fixture URL swap, a contract was broken. Fix the shape, not the page. Commit after every join so you can roll back.

## Risks

- Render free tier sleeps and takes up to a minute to wake. Open the URL before judging
- Gemini free limits vary by project and have been cut before. Keep `COUNCIL_MODE=mini` ready, backup keys ready
- Finnhub is 300 calls/day. One news call per ticker per day, never poll in a loop
- Disclaimer line stays visible: educational research, not advice. Call results candidates or matches, never recommendations

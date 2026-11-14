# LOOP / TFSA Gold: project memory

Hackathon build. Deadline Sunday 5:00 pm, code freeze Sunday 3:00 pm. Full task file: `docs/plan.md`.
Owner/integrator: Taha. Stack: Node 18+, CommonJS, Express, global `fetch`. No React, no build step, no TypeScript.
Approved dependencies: `express`, `cors`, `dotenv`. Anything else: ask first.

If code cannot satisfy a contract below, STOP and tell Taha. Never change a contract shape.

## File ownership (hard rules)

- Taha (and Claude acting for Taha): everything in `server/`, `.env`, `fixtures/`, n8n workflow, Render deploy. Only Taha touches `server/index.js`.
- Anne: `public/index.html`, `public/feed.js`, `public/styles.css`. NEVER create or edit.
- Dianne: `public/portfolio.*`, `email-template.html`, deck. NEVER create or edit.
- Vamsi: real `server/thesis.js` and `prompts/thesis.md`. Only a clearly marked STUB of `server/thesis.js` (exports `createThesis(goalsText)`, `matchNews(thesis, newsItems)`) is allowed, to be replaced by his file.
- Surgical changes only. No refactors/reformatting of code not asked to touch.
- Everything must run with missing API keys without crashing: degraded, not dead.
- After each step, run the server and curl the endpoints touched. Do not report success unverified.
- Wording: "candidates"/"matches", never "recommendations". Never tell a user to buy or sell. Line "Educational research, not investment advice." stays visible in UIs.

## Architecture decisions

- Deterministic `server/scoring.js` ranks (no LLM calls in it). The AI council (`server/council.js`) only explains: it supplies `bullCase`, `bearCase`, `verdict`. The council must not decide ranking.
- LLM via `server/llm.js` exporting `callLLM(systemPrompt, userPrompt, opts)`; Gemini OpenAI-compatible endpoint; 5 second delay between sequential calls.

## Env vars

`GEMINI_API_KEY`, `GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/`, `GEMINI_MODEL`, `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY`, `FINNHUB_KEY`, `INBOUND_WEBHOOK_SECRET`, `N8N_NOTIFY_WEBHOOK_URL`, `COUNCIL_MODE` (`lite`, or `mini` as the fallback).

## Frozen contracts

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

The five breakdown parts are each 0 to 20 and sum to `matchScore`. `bullCase`, `bearCase`, `verdict` can be null below rank 10. `stance`: `supports`, `challenges`, `neutral`.

### C: thesis (Vamsi's functions, Taha's endpoints)

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

`POST /api/paper/buy` body `{ "ticker": "VOO", "amountUsd": 500 }` returns `{ "orderId", "ticker", "qty", "entryPrice", "filledAt" }`.

`GET /api/paper/portfolio`:

```json
{
  "startValue": 10000,
  "value": 10340,
  "returnPct": 3.4,
  "whatIfLine": "With real money since Oct 28 you would be up $340",
  "positions": [ { "ticker": "VOO", "qty": 2, "entryPrice": 498.1, "currentPrice": 512.4, "plUsd": 28.6, "plPct": 2.9 } ],
  "trades": [ { "ticker": "VOO", "side": "buy", "qty": 2, "price": 498.1, "at": "2026-10-28T14:30:00Z" } ]
}
```

`positions` are aggregate per ticker with no date (`entryPrice` is the quantity-weighted average of that ticker's buys). `trades` is the order history (maps to Alpaca's orders endpoint), one row per filled order, newest first, `side` is `buy` or `sell`. *Amendment (Taha, Nov 14): `trades` added to Contract D.*

Alpaca paper API backs it. Seed 3 to 4 trades backdated 2 to 3 weeks so the demo shows real movement.

### E: notification email

Backend posts to `N8N_NOTIFY_WEBHOOK_URL` on any "challenges" stance (max one per day), n8n Gmail node sends using Dianne's template:

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

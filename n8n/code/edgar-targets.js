// n8n Code node "EDGAR targets": single stocks/REITs that have a CIK. ETFs and crypto have no Form 4s.
const STOCK_CATEGORIES = ['large_cap', 'mid_cap', 'small_cap', 'reit'];
const raw = $('SEC tickers').first().json || {};
const cikByTicker = {};
for (const row of Object.values(raw)) if (row && row.ticker) cikByTicker[row.ticker] = row.cik_str;

const out = [];
for (const i of $('Universe').all()) {
  if (!STOCK_CATEGORIES.includes(i.json.category)) continue;
  const cik = cikByTicker[i.json.ticker];
  if (cik === undefined) continue;
  out.push({ json: { ticker: i.json.ticker, cik: String(cik), cikPadded: String(cik).padStart(10, '0') } });
}
return out;

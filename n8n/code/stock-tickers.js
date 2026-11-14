// n8n Code node "Stock tickers": non-crypto tickers only, for the per-ticker Finnhub calls.
return $('Universe').all()
  .filter((i) => i.json.category !== 'crypto')
  .map((i) => ({ json: { ticker: i.json.ticker } }));

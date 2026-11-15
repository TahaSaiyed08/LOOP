// n8n Code node "Build Contract A" (Run Once for All Items). Output: one item = the POST /api/webhook/seed body.
// Raw metrics only, the backend does all scoring. News sentiment is left null: the backend fills it in.
// Missing data stays null (never invented). Insider = open-market PURCHASES (Form 4 code "P") in the last 30 days.
const STOCK_CATEGORIES = ['large_cap', 'mid_cap', 'small_cap', 'reit'];
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

const universe = $('Universe').all().map((i) => i.json);
const stockBars = ($('Alpaca stock bars').first().json || {}).bars || {};
const cryptoBars = ($('Alpaca crypto bars').first().json || {}).bars || {};

// Finnhub metric: 1:1 with "Stock tickers" (same order)
const stockTickers = $('Stock tickers').all().map((i) => i.json.ticker);
const metrics = {};
$('Finnhub metric').all().forEach((it, idx) => {
  const m = it.json && it.json.metric;
  if (m && stockTickers[idx]) metrics[stockTickers[idx]] = m;
});

// Finnhub company-news is loosely related market noise. For single stocks keep a headline only if it
// names the ticker (whole word, 3+ letters, case-sensitive) or the company (legal suffixes stripped).
function isRelevantNews(headline, ticker, companyName) {
  const h = String(headline || '');
  if (ticker.length >= 3 && new RegExp('\\b' + ticker.replace(/[^A-Z0-9]/g, '') + '\\b').test(h)) return true;
  const name = String(companyName || '').replace(/\b(Inc|Corp|Corporation|Co|Company|Ltd|Limited|plc|Holdings|Group|Class [A-C]|Common Stock)\b\.?/gi, '').replace(/[.,&]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const first = name.split(' ')[0];
  const lower = h.toLowerCase();
  return (name.length >= 4 && lower.includes(name)) || (name.includes(' ') && first.length >= 5 && lower.includes(first));
}
// Finnhub news: arrays are flattened into items; each item names its ticker in `related`
const newsByTicker = {};
for (const it of $('Finnhub news').all()) {
  const n = it.json;
  if (!n || !n.headline || !n.related) continue;
  const list = (newsByTicker[n.related] = newsByTicker[n.related] || []);
  if (list.length < 10 && !list.some((x) => x.headline === n.headline)) {
    list.push({ headline: n.headline, summary: typeof n.summary === 'string' && n.summary.trim() ? n.summary.trim().slice(0, 1000) : null, source: n.source || null, url: n.url || null, sentiment: null, datetime: new Date((n.datetime || 0) * 1000).toISOString() });
  }
}

// EDGAR Form 4 XML: 1:1 with "Pick Form 4"
const insiderByTicker = {};
const picks = $('Pick Form 4').all();
$('SEC Form 4 XML').all().forEach((it, idx) => {
  const ticker = picks[idx] && picks[idx].json && picks[idx].json.ticker;
  const xml = it.json && typeof it.json.data === 'string' ? it.json.data : '';
  if (!ticker || !xml) return;
  const isOfficer = /<isOfficer>\s*(1|true)\s*<\/isOfficer>/i.test(xml);
  const title = (xml.match(/<officerTitle>([^<]*)<\/officerTitle>/i) || [])[1] || '';
  const execTitle = /\b(CEO|CFO|COO|Chief|President)\b/i.test(title);
  let usd = 0, buys = 0;
  for (const block of xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/gi) || []) {
    if (!/<transactionCode>\s*P\s*<\/transactionCode>/i.test(block)) continue; // open-market purchase
    const shares = Number((block.match(/<transactionShares>\s*<value>([\d.]+)</i) || [])[1]);
    const price = Number((block.match(/<transactionPricePerShare>\s*<value>([\d.]+)</i) || [])[1]);
    if (Number.isFinite(shares) && Number.isFinite(price)) usd += shares * price;
    buys++;
  }
  if (!buys) return;
  const cur = (insiderByTicker[ticker] = insiderByTicker[ticker] || { count: 0, execBuyer: false, totalUsd: 0 });
  cur.count += 1; // filings with at least one purchase
  cur.totalUsd += Math.round(usd);
  if (isOfficer && execTitle) cur.execBuyer = true;
});

const summarize = (bars) => {
  if (!Array.isArray(bars) || !bars.length) return null;
  const last = bars[bars.length - 1];
  const prior = bars.length >= 6 ? bars[bars.length - 6] : null;
  const recent = bars.slice(-20);
  return {
    price: last.c,
    priceChange5dPct: prior && prior.c > 0 ? round((last.c / prior.c - 1) * 100, 2) : null,
    avgVolume: Math.round(recent.reduce((a, b) => a + (b.v || 0), 0) / recent.length),
  };
};

const stocks = [];
for (const u of universe) {
  const b = summarize(u.category === 'crypto' ? cryptoBars[u.ticker] : stockBars[u.ticker]);
  if (!b) continue; // no bars -> skip, never invent a price
  const m = metrics[u.ticker] || {};
  const isStock = STOCK_CATEGORIES.includes(u.category);
  const cap = num(m.marketCapitalization);
  stocks.push({
    ticker: u.ticker,
    companyName: u.companyName,
    category: u.category,
    price: b.price,
    beta: num(m.beta),
    dividendYieldPct: num(m.currentDividendYieldTTM) ?? num(m.dividendYieldIndicatedAnnual),
    priceChange5dPct: b.priceChange5dPct,
    avgVolume: b.avgVolume,
    usListed: true,
    merPct: u.merPct ?? null,
    peRatio: isStock ? (num(m.peTTM) ?? num(m.peBasicExclExtraTTM)) : null,
    marketCapB: isStock && cap !== null ? round(cap / 1000, 2) : null,
    insider: isStock ? (insiderByTicker[u.ticker] || { count: 0, execBuyer: false, totalUsd: 0 }) : { count: 0, execBuyer: false, totalUsd: 0 },
    news: (newsByTicker[u.ticker] || []).filter((n) => !isStock || isRelevantNews(n.headline, u.ticker, u.companyName)).slice(0, 3),
  });
}

return [{ json: { runDate: new Date().toISOString().slice(0, 10), stocks } }];

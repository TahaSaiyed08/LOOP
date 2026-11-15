// One-off: build a Contract A payload for the full universe from LIVE data and write it
// to fixtures/seed.sample.json (or --out <file>). Same data the n8n Code node sends in step 6.
//
//   Alpaca bars  -> price, priceChange5dPct, avgVolume           (ALPACA_KEY_ID / ALPACA_SECRET_KEY)
//   Finnhub      -> beta, peRatio, marketCapB, dividendYieldPct, news headlines   (FINNHUB_KEY, optional)
//   universe.js  -> companyName, category, merPct (published expense ratios)
//   NOT live here: insider (zeros; EDGAR Form 4 is added in n8n) and news sentiment (null;
//   Finnhub's sentiment endpoint is premium, so n8n/LLM must supply it).
// Anything unavailable is null (never invented); scoring.js degrades gracefully on nulls.
//
// Run: node scripts/build-seed-from-live.js [--out file] [--no-finnhub]
// After writing the default file, rerun: node scripts/gen-feed-fixtures.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const alpaca = require('../server/alpaca');
const universe = require('./universe');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? args[outIdx + 1] : path.join(__dirname, '..', 'fixtures', 'seed.sample.json');
const USE_FINNHUB = !args.includes('--no-finnhub') && Boolean(process.env.FINNHUB_KEY);
const FINNHUB = process.env.FINNHUB_BASE_URL || 'https://finnhub.io/api/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

async function finnhub(pathname, params) {
  const url = new URL(FINNHUB + pathname);
  for (const [k, v] of Object.entries({ ...params, token: process.env.FINNHUB_KEY })) url.searchParams.set(k, v);
  await sleep(1100); // free tier: 60 calls/minute
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub ${pathname} -> ${res.status}`);
  return res.json();
}

async function fundamentals(sym) {
  const m = ((await finnhub('/stock/metric', { symbol: sym, metric: 'all' })).metric) || {};
  const cap = num(m.marketCapitalization);
  return {
    beta: num(m.beta),
    peRatio: num(m.peTTM) ?? num(m.peBasicExclExtraTTM),
    marketCapB: cap === null ? null : Math.round(cap / 10) / 100, // millions -> billions
    dividendYieldPct: num(m.currentDividendYieldTTM) ?? num(m.dividendYieldIndicatedAnnual),
  };
}

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

async function news(sym, name, stockLike) {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const items = await finnhub('/company-news', { symbol: sym, from, to });
  return (Array.isArray(items) ? items : []).filter((n) => !stockLike || isRelevantNews(n.headline, sym, name)).slice(0, 3).map((n) => ({
    headline: n.headline, source: n.source, url: n.url, sentiment: null,
    datetime: new Date((n.datetime || 0) * 1000).toISOString(),
  }));
}

(async () => {
  if (!alpaca.hasCredentials()) {
    console.error('ALPACA_KEY_ID / ALPACA_SECRET_KEY are not set; cannot pull live bars. Nothing written.');
    process.exit(1);
  }
  if (!USE_FINNHUB) console.warn('No FINNHUB_KEY (or --no-finnhub): beta, P/E, market cap, yield and news will be null/empty.');

  const bars = await alpaca.getBars(universe.map((u) => u.ticker), { days: 40 });
  const stocks = [];
  for (const u of universe) {
    const b = alpaca.summarizeBars(bars[u.ticker]);
    if (b.price === null) { console.warn(`  skip ${u.ticker}: no bars`); continue; }
    let f = { beta: null, peRatio: null, marketCapB: null, dividendYieldPct: null };
    let n = [];
    if (USE_FINNHUB && u.category !== 'crypto') {
      try { f = await fundamentals(u.ticker); } catch (e) { console.warn(`  ${u.ticker} fundamentals: ${e.message}`); }
      try { n = await news(u.ticker, u.companyName, /cap$|reit/.test(u.category)); } catch (e) { console.warn(`  ${u.ticker} news: ${e.message}`); }
    }
    const isStock = !u.merPct && u.category !== 'crypto' && /cap$|reit/.test(u.category);
    stocks.push({
      ticker: u.ticker, companyName: u.companyName, category: u.category,
      price: b.price, beta: f.beta, dividendYieldPct: f.dividendYieldPct,
      priceChange5dPct: b.priceChange5dPct, avgVolume: b.avgVolume, usListed: true,
      merPct: u.merPct, peRatio: isStock ? f.peRatio : null, marketCapB: isStock ? f.marketCapB : null,
      insider: { count: 0, execBuyer: false, totalUsd: 0 }, news: n,
    });
  }
  const payload = { runDate: new Date().toISOString().slice(0, 10), stocks };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
  console.log(`Wrote ${stocks.length}/${universe.length} tickers to ${OUT}`);
})().catch((e) => { console.error(e.message); process.exit(1); });

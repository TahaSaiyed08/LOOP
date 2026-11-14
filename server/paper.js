// Paper-trading ledger + Contract D portfolio math.
//
// Alpaca's paper API cannot backdate orders, so the portfolio is computed from a trade LEDGER:
//   - backdated demo trades (scripts/seed-paper-trades.js): entry prices come from real Alpaca
//     historical bars on the backdated day, no orders are placed;
//   - live buys via POST /api/paper/buy: a real Alpaca paper order, recorded here with its fill.
// Current prices come from Alpaca. Without credentials (or if Alpaca errors) everything falls
// back to fixtures/portfolio.sample.json so the UI never renders empty.

const path = require('path');
const store = require('./store');
const alpaca = require('./alpaca');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const START_VALUE = 10000;
const r2 = (x) => Math.round(x * 100) / 100;
const r1 = (x) => Math.round(x * 10) / 10;

const loadFixture = (name) => JSON.parse(JSON.stringify(require(path.join(FIXTURES, name))));
const fixturePortfolio = () => loadFixture('portfolio.sample.json');

// The honest label for a ledger entry that was NOT a real Alpaca execution (null when it was).
const SAMPLE_NOTE = 'sample data, not a real order';
function noteOf(t) {
  if (t.fillNote) return t.fillNote;
  if (t.seeded) return `demo trade, backdated: priced at the real close on ${String(t.at).slice(0, 10)}, no order was placed`;
  return null;
}

// computePortfolio(trades, prices) -> Contract D. Pure. Only buys are supported.
// fillNote (string|null) on each trade and position says when a fill was simulated or estimated.
function computePortfolio(trades, prices, startValue = START_VALUE) {
  const byTicker = new Map();
  const chrono = [...trades].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const t of chrono) {
    const p = byTicker.get(t.ticker) || { ticker: t.ticker, qty: 0, cost: 0, notes: new Set() };
    p.qty += t.qty;
    p.cost += t.qty * t.price;
    if (noteOf(t)) p.notes.add(noteOf(t));
    byTicker.set(t.ticker, p);
  }
  const positions = [];
  let totalPl = 0;
  for (const p of byTicker.values()) {
    const entryPrice = r2(p.cost / p.qty);
    const currentPrice = prices[p.ticker] ?? entryPrice;
    const plUsd = r2((currentPrice - entryPrice) * p.qty);
    totalPl += plUsd;
    positions.push({
      ticker: p.ticker, qty: Math.round(p.qty * 1e4) / 1e4, entryPrice, currentPrice, plUsd,
      plPct: r1(((currentPrice - entryPrice) / entryPrice) * 100), fillNote: p.notes.size ? [...p.notes].join('; ') : null,
    });
  }
  totalPl = r2(totalPl);
  const first = chrono[0];
  const since = first ? new Date(first.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : null;
  const rounded = Math.round(Math.abs(totalPl));
  const whatIfLine = since
    ? `With real money since ${since} you would be ${totalPl >= 0 ? 'up' : 'down'} $${rounded}`
    : 'Make a paper buy to see what it would have returned';
  return {
    startValue,
    value: r2(startValue + totalPl),
    returnPct: r1((totalPl / startValue) * 100),
    whatIfLine,
    positions,
    trades: [...chrono].reverse().map((t) => ({ ticker: t.ticker, side: t.side, qty: t.qty, price: t.price, at: t.at, fillNote: noteOf(t) })), // newest first
  };
}

function ledger() { return store.get('paperLedger', null); }
function saveLedger(trades) { return store.set('paperLedger', trades); }

// Static prices for fixture mode: fixture positions, the seed sample, then any fed prices.
function staticPrices() {
  const prices = {};
  for (const s of loadFixture('seed.sample.json').stocks) prices[s.ticker] = s.price;
  for (const p of fixturePortfolio().positions) prices[p.ticker] = p.currentPrice;
  const feed = store.get('feed', null);
  if (feed && feed.stocks) for (const s of feed.stocks) if (s.price) prices[s.ticker] = s.price;
  return prices;
}

// -> { prices, live }. live is true only if Alpaca answered with a price for EVERY requested ticker.
async function livePrices(tickers) {
  if (!alpaca.hasCredentials()) return { prices: staticPrices(), live: false };
  try {
    const got = await alpaca.getLatestPrices(tickers);
    return { prices: { ...staticPrices(), ...got }, live: tickers.every((t) => got[t] > 0) };
  } catch (err) {
    console.warn('[paper] price lookup failed, using static prices:', err.message);
    return { prices: staticPrices(), live: false };
  }
}
const currentPrices = async (tickers) => (await livePrices(tickers)).prices;

// Ledger starts as the fixture trades (flagged `sample`) or, with Alpaca keys, whatever the seed/buys wrote.
function currentTrades() {
  const saved = ledger();
  if (saved && saved.length) return saved;
  return fixturePortfolio().trades.map((t) => ({ ticker: t.ticker, side: t.side, qty: t.qty, price: t.price, at: t.at, fillNote: SAMPLE_NOTE, sample: true }));
}

// -> { portfolio, source }. source is 'live' only with Alpaca prices for every ticker AND no sample-data
// trades in the ledger; otherwise 'fixture' (the X-Data-Source header on /api/paper/portfolio).
async function getPortfolio() {
  const trades = currentTrades();
  const { prices, live } = await livePrices([...new Set(trades.map((t) => t.ticker))]);
  const source = live && !trades.some((t) => t.sample) ? 'live' : 'fixture';
  return { portfolio: computePortfolio(trades, prices), source };
}

const money = (x) => `$${r2(x).toFixed(2)}`;
const dayOf = (iso, tz) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleDateString('en-US', { weekday: 'long', timeZone: tz }) : null);

// Why a buy was estimated instead of executed, in words a judge can read on screen.
function unfilledNote(r) {
  const price = money(r.entryPrice);
  if (r.marketOpen === false) {
    const day = dayOf(r.priceAt, 'America/New_York');
    return `market closed, simulated at ${day ? `${day}'s` : 'the last'} close (${price}); order queued at Alpaca`;
  }
  if (r.marketOpen === null) return `market status unknown, position estimated at the latest price (${price})`;
  return `order not filled yet, position estimated at the latest price (${price})`;
}

// buy(ticker, amountUsd) -> Contract D buy response. Real Alpaca paper order when keys work,
// otherwise a simulated fill at the best known price. Either way it lands in the ledger.
// The response carries fillNote: null for a real Alpaca fill, otherwise the plain-words reason it was estimated.
async function buy(ticker, amountUsd) {
  let result;
  let fillNote = null;
  const keys = alpaca.hasCredentials();
  if (keys) {
    try {
      result = await alpaca.placePaperBuy(ticker, amountUsd);
      if (!result.filled) fillNote = unfilledNote(result);
    } catch (err) { console.warn('[paper] Alpaca buy failed, simulating:', err.message); }
  }
  if (!result) {
    const price = (await currentPrices([ticker]))[ticker];
    if (!price) { const e = new Error(`No price available for ${ticker}`); e.code = 'NO_PRICE'; throw e; }
    result = { orderId: `sim-${Date.now().toString(36)}`, ticker, qty: Math.round((amountUsd / price) * 1e4) / 1e4, entryPrice: price, filledAt: new Date().toISOString() };
    fillNote = `${keys ? 'Alpaca unavailable' : 'paper trading offline (no Alpaca keys)'}, simulated fill at the last known price (${money(price)})`;
  }
  const trades = currentTrades();
  trades.push({ ticker, side: 'buy', qty: result.qty, price: result.entryPrice, at: result.filledAt, orderId: result.orderId, fillNote });
  saveLedger(trades);
  return { orderId: result.orderId, ticker, qty: result.qty, entryPrice: result.entryPrice, filledAt: result.filledAt, fillNote };
}

// ---- Demo scaffolding -------------------------------------------------------------------------
// [ticker, days back, dollar amount]. 2-3 weeks back, mixed risk so the demo has winners and losers.
const DEMO_PLAN = [['VOO', 19, 3000], ['AAPL', 17, 1800], ['XLE', 14, 1100], ['ARKK', 12, 600]];

const ledgerIsEmpty = () => !(ledger() || []).length;

// Writes backdated trades priced from real Alpaca daily closes. Places NO orders. Needs Alpaca keys.
async function seedDemoTrades() {
  const bars = await alpaca.getBars(DEMO_PLAN.map((p) => p[0]), { days: 40 });
  const trades = [];
  for (const [ticker, daysBack, usd] of DEMO_PLAN) {
    const target = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);
    const bar = (bars[ticker] || []).find((b) => b.t.slice(0, 10) >= target); // first trading day on/after
    if (!bar) { console.warn(`[demo-seed] no bars for ${ticker}, skipping`); continue; }
    trades.push({ ticker, side: 'buy', qty: Math.round((usd / bar.c) * 1e4) / 1e4, price: bar.c, at: `${bar.t.slice(0, 10)}T14:35:00Z`, seeded: true });
  }
  if (!trades.length) throw new Error('no demo trades could be seeded');
  saveLedger(trades);
  return trades;
}

// Boot hook: only when DEMO_SEED=true, the ledger is empty and Alpaca keys exist. Logs exactly one line.
async function bootDemoSeed() {
  if (process.env.DEMO_SEED !== 'true') return;
  if (!ledgerIsEmpty()) return console.log('[demo-seed] DEMO_SEED=true but ledger already has trades; leaving it alone');
  if (!alpaca.hasCredentials()) return console.log('[demo-seed] DEMO_SEED=true but no Alpaca keys; portfolio uses fixture trades instead');
  try {
    const t = await seedDemoTrades();
    console.log(`[demo-seed] DEMO SCAFFOLDING: seeded ${t.length} backdated paper trades (${t.map((x) => x.ticker).join(', ')}). These are not user actions.`);
  } catch (err) {
    console.warn('[demo-seed] failed, portfolio falls back to fixture:', err.message);
  }
}

module.exports = { START_VALUE, computePortfolio, getPortfolio, buy, saveLedger, currentTrades, ledgerIsEmpty, seedDemoTrades, bootDemoSeed };

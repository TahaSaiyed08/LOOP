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

// computePortfolio(trades, prices) -> Contract D. Pure. Only buys are supported.
function computePortfolio(trades, prices, startValue = START_VALUE) {
  const byTicker = new Map();
  const chrono = [...trades].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const t of chrono) {
    const p = byTicker.get(t.ticker) || { ticker: t.ticker, qty: 0, cost: 0 };
    p.qty += t.qty;
    p.cost += t.qty * t.price;
    byTicker.set(t.ticker, p);
  }
  const positions = [];
  let totalPl = 0;
  for (const p of byTicker.values()) {
    const entryPrice = r2(p.cost / p.qty);
    const currentPrice = prices[p.ticker] ?? entryPrice;
    const plUsd = r2((currentPrice - entryPrice) * p.qty);
    totalPl += plUsd;
    positions.push({ ticker: p.ticker, qty: Math.round(p.qty * 1e4) / 1e4, entryPrice, currentPrice, plUsd, plPct: r1(((currentPrice - entryPrice) / entryPrice) * 100) });
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
    trades: [...chrono].reverse().map(({ ticker, side, qty, price, at }) => ({ ticker, side, qty, price, at })), // newest first
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

async function currentPrices(tickers) {
  if (!alpaca.hasCredentials()) return staticPrices();
  try {
    return { ...staticPrices(), ...(await alpaca.getLatestPrices(tickers)) };
  } catch (err) {
    console.warn('[paper] price lookup failed, using static prices:', err.message);
    return staticPrices();
  }
}

// Ledger starts as the fixture trades (fixture mode) or, with Alpaca keys, whatever the seed script wrote.
function currentTrades() {
  const saved = ledger();
  if (saved && saved.length) return saved;
  return fixturePortfolio().trades.map((t) => ({ ...t }));
}

async function getPortfolio() {
  const trades = currentTrades();
  const prices = await currentPrices(trades.map((t) => t.ticker));
  return computePortfolio(trades, prices);
}

// buy(ticker, amountUsd) -> Contract D buy response. Real Alpaca paper order when keys work,
// otherwise a simulated fill at the best known price. Either way it lands in the ledger.
async function buy(ticker, amountUsd) {
  let result;
  if (alpaca.hasCredentials()) {
    try { result = await alpaca.placePaperBuy(ticker, amountUsd); }
    catch (err) { console.warn('[paper] Alpaca buy failed, simulating:', err.message); }
  }
  if (!result) {
    const price = (await currentPrices([ticker]))[ticker];
    if (!price) { const e = new Error(`No price available for ${ticker}`); e.code = 'NO_PRICE'; throw e; }
    result = { orderId: `sim-${Date.now().toString(36)}`, ticker, qty: Math.round((amountUsd / price) * 1e4) / 1e4, entryPrice: price, filledAt: new Date().toISOString() };
  }
  const trades = currentTrades();
  trades.push({ ticker, side: 'buy', qty: result.qty, price: result.entryPrice, at: result.filledAt, orderId: result.orderId });
  saveLedger(trades);
  return { orderId: result.orderId, ticker, qty: result.qty, entryPrice: result.entryPrice, filledAt: result.filledAt };
}

module.exports = { START_VALUE, computePortfolio, getPortfolio, buy, saveLedger, currentTrades };

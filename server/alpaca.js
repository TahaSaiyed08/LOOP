// Alpaca client: quotes, historical bars, paper orders, positions. Free paper-trading API, no card.
// Credentials: ALPACA_KEY_ID / ALPACA_SECRET_KEY. Without them hasCredentials() is false and every
// network call rejects with err.code === 'NO_ALPACA_KEYS' (callers fall back to fixtures).
// Optional overrides (used by tests): ALPACA_PAPER_URL, ALPACA_DATA_URL.
// Stocks use the free IEX feed. Crypto symbols contain a slash (e.g. BTC/USD) and use the crypto endpoints.

const paperUrl = () => (process.env.ALPACA_PAPER_URL || 'https://paper-api.alpaca.markets').replace(/\/$/, '');
const dataUrl = () => (process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets').replace(/\/$/, '');

const isCrypto = (sym) => String(sym).includes('/');
const hasCredentials = () => Boolean(process.env.ALPACA_KEY_ID && process.env.ALPACA_SECRET_KEY);

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function request(base, method, pathname, { query, body, timeoutMs = 10000 } = {}) {
  if (!hasCredentials()) throw fail('NO_ALPACA_KEYS', 'ALPACA_KEY_ID / ALPACA_SECRET_KEY not set');
  const url = new URL(base + pathname);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID,
        'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    throw fail('ALPACA_NETWORK', `Alpaca request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw fail(`ALPACA_HTTP_${res.status}`, `Alpaca ${method} ${pathname} -> ${res.status}: ${detail}`);
  }
  return res.status === 204 ? null : res.json();
}

const trading = (method, p, opts) => request(paperUrl(), method, p, opts);
const market = (method, p, opts) => request(dataUrl(), method, p, opts);

const split = (symbols) => {
  const list = [...new Set(symbols)];
  return { stocks: list.filter((s) => !isCrypto(s)), crypto: list.filter(isCrypto) };
};

// getLatestPrices(['VOO','BTC/USD']) -> { VOO: 512.4, 'BTC/USD': 98500 } (symbols with no data are omitted)
async function getLatestPrices(symbols) {
  const { stocks, crypto } = split(symbols);
  const out = {};
  if (stocks.length) {
    const d = await market('GET', '/v2/stocks/trades/latest', { query: { symbols: stocks.join(','), feed: 'iex' } });
    for (const [sym, t] of Object.entries(d.trades || {})) if (t && t.p > 0) out[sym] = t.p;
  }
  if (crypto.length) {
    const d = await market('GET', '/v1beta3/crypto/us/latest/trades', { query: { symbols: crypto.join(',') } });
    for (const [sym, t] of Object.entries(d.trades || {})) if (t && t.p > 0) out[sym] = t.p;
  }
  return out;
}

// getBars(symbols, { days = 30 }) -> { VOO: [{t,o,h,l,c,v}, ...] } daily bars, oldest first. Follows pagination.
async function getBars(symbols, { days = 30, start, end } = {}) {
  const { stocks, crypto } = split(symbols);
  const from = start || new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const out = {};
  const pull = async (list, pathname, extra) => {
    if (!list.length) return;
    let token;
    do {
      const d = await market('GET', pathname, {
        query: { symbols: list.join(','), timeframe: '1Day', start: from, end, limit: 10000, page_token: token, ...extra },
      });
      for (const [sym, bars] of Object.entries(d.bars || {})) (out[sym] = out[sym] || []).push(...bars);
      token = d.next_page_token;
    } while (token);
  };
  await pull(stocks, '/v2/stocks/bars', { feed: 'iex', adjustment: 'split' });
  await pull(crypto, '/v1beta3/crypto/us/bars', {});
  return out;
}

// Pure helper: bars (oldest first) -> { price, priceChange5dPct, avgVolume } or nulls when too little history.
function summarizeBars(bars) {
  if (!Array.isArray(bars) || !bars.length) return { price: null, priceChange5dPct: null, avgVolume: null };
  const last = bars[bars.length - 1];
  const prior = bars.length >= 6 ? bars[bars.length - 6] : null;
  const recent = bars.slice(-20);
  const avgVolume = Math.round(recent.reduce((a, b) => a + (b.v || 0), 0) / recent.length);
  return {
    price: last.c,
    priceChange5dPct: prior && prior.c > 0 ? Math.round(((last.c / prior.c - 1) * 100) * 100) / 100 : null,
    avgVolume,
  };
}

// placePaperBuy('VOO', 500) -> order result. Real paper order, dollar-notional market buy.
// If the market is closed the order stays queued; qty/price are then estimated from the latest price.
async function placePaperBuy(ticker, amountUsd) {
  const crypto = isCrypto(ticker);
  let order = await trading('POST', '/v2/orders', {
    body: { symbol: ticker, notional: String(amountUsd), side: 'buy', type: 'market', time_in_force: crypto ? 'gtc' : 'day' },
  });
  for (let i = 0; i < 6 && order.status !== 'filled'; i++) {
    await new Promise((r) => setTimeout(r, 500));
    order = await trading('GET', `/v2/orders/${order.id}`);
  }
  if (order.status === 'filled' && Number(order.filled_avg_price) > 0) {
    return { orderId: order.id, ticker, qty: Number(order.filled_qty), entryPrice: Number(order.filled_avg_price), filledAt: order.filled_at, filled: true };
  }
  const price = (await getLatestPrices([ticker]))[ticker];
  if (!price) throw fail('NO_PRICE', `No price available for ${ticker}`);
  return { orderId: order.id, ticker, qty: Math.round((amountUsd / price) * 1e6) / 1e6, entryPrice: price, filledAt: order.submitted_at || new Date().toISOString(), filled: false };
}

const getPositions = () => trading('GET', '/v2/positions');
const getAccount = () => trading('GET', '/v2/account');
const getOrders = (limit = 100) => trading('GET', '/v2/orders', { query: { status: 'all', direction: 'desc', limit } });

module.exports = { hasCredentials, isCrypto, getLatestPrices, getBars, summarizeBars, placePaperBuy, getPositions, getAccount, getOrders };

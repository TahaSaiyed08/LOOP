// Seeds 4 BACKDATED demo paper trades into the ledger (data/db.json).
// Alpaca cannot backdate orders, so no orders are placed: each entry price is the REAL daily
// close from Alpaca bars on the backdated day. Current prices then come from Alpaca live.
// Requires ALPACA_KEY_ID / ALPACA_SECRET_KEY. Run: node scripts/seed-paper-trades.js [--force]
require('dotenv').config();
const alpaca = require('../server/alpaca');
const paper = require('../server/paper');

// [ticker, days back, dollar amount]. 2-3 weeks back, mixed risk so the demo has winners and losers.
const PLAN = [
  ['VOO', 19, 3000],
  ['AAPL', 17, 1800],
  ['XLE', 14, 1100],
  ['ARKK', 12, 600],
];

(async () => {
  if (!alpaca.hasCredentials()) {
    console.error('No ALPACA_KEY_ID / ALPACA_SECRET_KEY set. The server will use fixtures/portfolio.sample.json instead.');
    process.exit(1);
  }
  if (paper.currentTrades().some((t) => t.orderId || t.seeded) && !process.argv.includes('--force')) {
    console.log('Ledger already has trades. Re-run with --force to replace them.');
    return;
  }
  const bars = await alpaca.getBars(PLAN.map((p) => p[0]), { days: 40 });
  const trades = [];
  for (const [ticker, daysBack, usd] of PLAN) {
    const target = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);
    const bar = (bars[ticker] || []).find((b) => b.t.slice(0, 10) >= target); // first trading day on/after
    if (!bar) { console.warn(`No bars for ${ticker}, skipping`); continue; }
    trades.push({
      ticker, side: 'buy', qty: Math.round((usd / bar.c) * 1e4) / 1e4, price: bar.c,
      at: `${bar.t.slice(0, 10)}T14:35:00Z`, seeded: true,
    });
  }
  if (!trades.length) throw new Error('No trades could be seeded');
  paper.saveLedger(trades);
  console.log(`Seeded ${trades.length} backdated trades:`);
  for (const t of trades) console.log(`  ${t.at.slice(0, 10)} ${t.ticker} ${t.qty} @ ${t.price}`);
})().catch((e) => { console.error(e.message); process.exit(1); });

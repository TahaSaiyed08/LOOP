// Seeds 4 BACKDATED demo paper trades into the ledger (data/db.json). Demo scaffolding, not user actions.
// Alpaca cannot backdate orders, so no orders are placed: each entry price is the REAL daily
// close from Alpaca bars on the backdated day. Current prices then come from Alpaca live.
// The server does the same on boot when DEMO_SEED=true and the ledger is empty.
// Requires ALPACA_KEY_ID / ALPACA_SECRET_KEY. Run: node scripts/seed-paper-trades.js [--force]
require('dotenv').config();
const alpaca = require('../server/alpaca');
const paper = require('../server/paper');

(async () => {
  if (!alpaca.hasCredentials()) {
    console.error('No ALPACA_KEY_ID / ALPACA_SECRET_KEY set. The server will use fixtures/portfolio.sample.json instead.');
    process.exit(1);
  }
  if (!paper.ledgerIsEmpty() && !process.argv.includes('--force')) {
    console.log('Ledger already has trades. Re-run with --force to replace them.');
    return;
  }
  const trades = await paper.seedDemoTrades();
  console.log(`Seeded ${trades.length} backdated trades:`);
  for (const t of trades) console.log(`  ${t.at.slice(0, 10)} ${t.ticker} ${t.qty} @ ${t.price}`);
})().catch((e) => { console.error(e.message); process.exit(1); });

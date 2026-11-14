// Paper-trading honesty tests: fillNote on buys/positions/trades and the X-Data-Source header on
// /api/paper/portfolio. Spawns the real server against a controllable mock of Alpaca.
// Run: npm run test:paper   (takes ~10 s: unfilled equity orders are polled for 3 s each)
const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const state = { clock: 'closed', orders: 'ok', latest: 'ok', fill: 'normal' };
const placed = [];
const FRIDAY_CLOSE = '2026-11-13T20:59:58Z';
const PRICE = { VOO: 512.4, AAPL: 238.1, XLE: 91.35, ARKK: 57.8, 'BTC/USD': 98500 };
const mkBars = (base) => Array.from({ length: 30 }, (_, i) => {
  const d = new Date(Date.now() - (30 - i) * 86400000).toISOString().slice(0, 10);
  return { t: `${d}T04:00:00Z`, o: base, h: base, l: base, c: +(base * (0.96 + i * 0.0013)).toFixed(2), v: 1e6 };
});

const alpaca = http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x');
  const send = (o, c = 200) => { r.statusCode = c; r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(o)); };
  if (u.pathname === '/__set') { for (const [k, v] of u.searchParams) state[k] = v; return send(state); }
  const syms = (u.searchParams.get('symbols') || '').split(',').filter(Boolean);
  if (u.pathname === '/v2/clock') return send({ is_open: state.clock === 'open' });
  if (u.pathname === '/v2/stocks/bars') return send({ bars: Object.fromEntries(syms.map((s) => [s, mkBars(PRICE[s])])), next_page_token: null });
  if (u.pathname.includes('/trades/latest') || u.pathname.includes('/latest/trades')) {
    if (state.latest === 'down') return send({ message: 'down' }, 500);
    return send({ trades: Object.fromEntries(syms.filter((s) => PRICE[s]).map((s) => [s, { p: PRICE[s], t: s.includes('/') ? new Date().toISOString() : FRIDAY_CLOSE }])) });
  }
  if (u.pathname === '/v2/orders' && q.method === 'POST') {
    if (state.orders === 'down') return send({ message: 'down' }, 500);
    let b = ''; q.on('data', (d) => (b += d));
    q.on('end', () => { const o = JSON.parse(b); placed.push(o); send({ id: `ord-${placed.length}`, status: 'accepted', submitted_at: new Date().toISOString() }); });
    return;
  }
  const m = u.pathname.match(/^\/v2\/orders\/ord-(\d+)$/);
  if (m) {
    const o = placed[Number(m[1]) - 1];
    const fills = o.symbol.includes('/') || (state.clock === 'open' && state.fill === 'normal');
    return send(fills
      ? { id: `ord-${m[1]}`, status: 'filled', filled_qty: String(+(Number(o.notional) / PRICE[o.symbol]).toFixed(6)), filled_avg_price: String(PRICE[o.symbol]), filled_at: new Date().toISOString() }
      : { id: `ord-${m[1]}`, status: 'accepted', submitted_at: new Date().toISOString() });
  }
  send({ message: 'not found' }, 404);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbs = [];

async function startServer(extraEnv) {
  const port = 3700 + Math.floor(Math.random() * 250);
  const db = path.join(os.tmpdir(), `loop-paper-${process.pid}-${port}.json`);
  dbs.push(db);
  const env = { ...process.env, PORT: String(port), LOOP_DB_FILE: db, DEMO_SEED: 'false', ...extraEnv };
  const srv = spawn('node', [path.join(__dirname, '..', 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 40; i++) { try { await fetch(base + '/api/health'); break; } catch { await sleep(150); } }
  const buy = async (ticker, amountUsd) => (await fetch(base + '/api/paper/buy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticker, amountUsd }) })).json();
  const portfolio = async () => { const r = await fetch(base + '/api/paper/portfolio'); return { src: r.headers.get('x-data-source'), p: await r.json() }; };
  return { buy, portfolio, stop: () => srv.kill(), log: () => log };
}

async function main() {
  await new Promise((r) => alpaca.listen(0, r));
  const url = `http://localhost:${alpaca.address().port}`;
  const set = (o) => fetch(`${url}/__set?${new URLSearchParams(o)}`);
  const keys = { ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's', ALPACA_PAPER_URL: url, ALPACA_DATA_URL: url };
  const servers = [];
  try {
    // ---- A: keys present, empty ledger (no DEMO_SEED)
    const A = await startServer(keys); servers.push(A);
    let { src, p } = await A.portfolio();
    assert.strictEqual(src, 'fixture', 'empty ledger shows sample trades -> fixture');
    assert(p.positions.every((x) => x.fillNote === 'sample data, not a real order') && p.trades.every((t) => t.fillNote));

    await set({ clock: 'closed' });
    const btc = await A.buy('BTC/USD', 200);
    assert.strictEqual(btc.fillNote, null, 'crypto fills for real, even with the equity market closed');
    assert(btc.qty > 0 && btc.entryPrice === 98500);

    const voo = await A.buy('VOO', 500);
    assert(/^market closed, simulated at Friday's close \(\$512\.40\); order queued at Alpaca$/.test(voo.fillNote), voo.fillNote);
    ({ src, p } = await A.portfolio());
    const vooPos = p.positions.find((x) => x.ticker === 'VOO');
    assert(vooPos.fillNote.includes('market closed') && vooPos.fillNote.includes('sample data'), 'position carries both notes: ' + vooPos.fillNote);
    assert(/market closed/.test(p.trades[0].fillNote) || /market closed/.test(p.trades[1].fillNote), 'trade carries its own note');
    assert.strictEqual(p.positions.find((x) => x.ticker === 'BTC/USD').fillNote, null, 'genuine fill has null note');

    await set({ clock: 'open', fill: 'never' });
    const xle = await A.buy('XLE', 300);
    assert(/^order not filled yet, position estimated at the latest price \(\$91\.35\)$/.test(xle.fillNote), xle.fillNote);

    await set({ orders: 'down' });
    const aapl = await A.buy('AAPL', 400);
    assert(/^Alpaca unavailable, simulated fill at the last known price \(\$238\.10\)$/.test(aapl.fillNote), aapl.fillNote);
    await set({ orders: 'ok', fill: 'normal' });
    console.log('  A ok: crypto genuine (null), equity-closed / unfilled / Alpaca-down notes, sample notes preserved');

    // ---- B: DEMO_SEED boot with keys -> live, seeded trades labelled
    await set({ clock: 'closed', latest: 'ok' });
    const B = await startServer({ ...keys, DEMO_SEED: 'true' }); servers.push(B);
    await sleep(800);
    ({ src, p } = await B.portfolio());
    assert.strictEqual(src, 'live', 'seeded ledger + live prices -> live; log: ' + B.log());
    assert.strictEqual(p.positions.length, 4);
    assert(p.positions.every((x) => /^demo trade, backdated: priced at the real close on \d{4}-\d{2}-\d{2}, no order was placed$/.test(x.fillNote)), JSON.stringify(p.positions.map((x) => x.fillNote)));
    const btcB = await B.buy('BTC/USD', 250);
    assert.strictEqual(btcB.fillNote, null);
    ({ src, p } = await B.portfolio());
    assert.strictEqual(src, 'live'); assert.strictEqual(p.positions.length, 5);
    await set({ latest: 'down' });
    ({ src } = await B.portfolio());
    assert.strictEqual(src, 'fixture', 'Alpaca price lookup failing -> fixture');
    await set({ latest: 'ok' });
    console.log('  B ok: seeded trades labelled, header live -> fixture when prices fail');

    // ---- C: no keys at all
    const C = await startServer({ ALPACA_KEY_ID: '', ALPACA_SECRET_KEY: '' }); servers.push(C);
    ({ src } = await C.portfolio());
    assert.strictEqual(src, 'fixture');
    const sim = await C.buy('VOO', 100);
    assert(/^paper trading offline \(no Alpaca keys\), simulated fill at the last known price \(\$512\.40\)$/.test(sim.fillNote), sim.fillNote);
    console.log('  C ok: no keys -> fixture header, simulated note');
    console.log('\nOK: fillNote semantics and X-Data-Source on /api/paper/portfolio');
  } catch (e) {
    console.error('\nFAILED:', e.message);
    for (const s of servers) console.error('--- server log ---\n' + s.log());
    process.exitCode = 1;
  } finally {
    for (const s of servers) s.stop();
    alpaca.close();
    for (const d of dbs) try { fs.unlinkSync(d); } catch {}
  }
}
main();

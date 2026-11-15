// End-to-end check of the Contract A/B/C/E endpoints. Spawns the real server on a free port with a
// temp database and no Alpaca/Gemini keys, plus an in-process mock of the n8n notify webhook.
// Run: npm run test:endpoints
const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { rankForTier } = require('../server/scoring');

const seed = require('../fixtures/seed.sample.json');
const SECRET = 's3cret';
const db = path.join(os.tmpdir(), `loop-e2e-${process.pid}.json`);
const hooks = [];
let hookStatus = 200;

const hook = http.createServer((q, r) => {
  let b = ''; q.on('data', (d) => (b += d));
  q.on('end', () => { hooks.push(JSON.parse(b)); r.statusCode = hookStatus; r.end('{}'); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mock Gemini: answers thesis creation and news matching; everything else (sentiment, council) gets non-JSON
// so those paths degrade exactly as with no key. It only returns a "challenges" match once mockChallenge is on.
let mockChallenge = false;
const negHeadline = (seed.stocks.flatMap((s) => s.news || []).find((n) => typeof n.sentiment === 'number' && n.sentiment <= -0.15) || {}).headline;
const gemini = http.createServer((q, r) => {
  let b = ''; q.on('data', (d) => (b += d));
  q.on('end', () => {
    const msgs = JSON.parse(b).messages;
    let content = 'not json';
    if (/retail investor's own words/.test(msgs[0].content)) {
      content = JSON.stringify({ goal: 'Invest $20 every two weeks', assumptions: ['Broad markets grow over ten years', 'Low fees compound over time'] });
    } else if (/compare news headlines/.test(msgs[0].content)) {
      const lines = msgs[1].content.split('HEADLINES:\n')[1].split('\n');
      const i = lines.findIndex((l) => negHeadline && l.includes(negHeadline));
      content = JSON.stringify({ matches: mockChallenge && i >= 0 ? [{ n: i + 1, assumptionIndex: 0, stance: 'challenges', whyItMatters: 'Test reason.' }] : [] });
    }
    r.setHeader('content-type', 'application/json');
    r.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

async function main() {
  await new Promise((r) => hook.listen(0, r));
  await new Promise((r) => gemini.listen(0, r));
  const port = 3300 + Math.floor(Math.random() * 500);
  const base = `http://localhost:${port}`;
  const env = { ...process.env, PORT: String(port), LOOP_DB_FILE: db, INBOUND_WEBHOOK_SECRET: SECRET, NOTIFY_TO_EMAIL: 'test@example.com',
    N8N_NOTIFY_WEBHOOK_URL: `http://localhost:${hook.address().port}/hook`, DEMO_SEED: 'false',
    GEMINI_API_KEY: 'test-key', GEMINI_BASE_URL: `http://localhost:${gemini.address().port}/v1/`, GEMINI_MODEL: 'm', LLM_MIN_GAP_MS: '0' };
  for (const k of ['ALPACA_KEY_ID', 'ALPACA_SECRET_KEY', 'FINNHUB_KEY']) env[k] = ''; // '' (not delete): dotenv would refill from a real .env
  const srv = spawn('node', [path.join(__dirname, '..', 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
  const get = (p) => fetch(base + p);
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const seedIt = (body) => post('/api/webhook/seed', body, { 'x-webhook-secret': SECRET });
  const tierRows = async (t) => (await get(`/api/stocks?tier=${t}`)).json();

  try {
    for (let i = 0; i < 40; i++) { try { await get('/api/health'); break; } catch { await sleep(150); } }

    // Before any seed: fixtures, flagged
    let r = await get('/api/stocks?tier=low');
    assert.strictEqual(r.headers.get('x-data-source'), 'fixture');
    assert.strictEqual((await r.json()).length, 10);
    assert.strictEqual((await get('/api/stocks?tier=ultra')).status, 400);
    assert.strictEqual((await get('/api/stocks')).status, 400);

    // Auth
    assert.strictEqual((await post('/api/webhook/seed', seed)).status, 401, 'missing secret');
    assert.strictEqual((await post('/api/webhook/seed', seed, { 'x-webhook-secret': 'nope' })).status, 401, 'wrong secret');
    assert.strictEqual((await seedIt({ stocks: 'x' })).status, 400, 'bad body');

    // Seed with 2 bad rows
    const withBad = { ...seed, stocks: [...seed.stocks, { ticker: 'BAD1', category: 'nope', price: 5 }, { ticker: 'BAD2', category: 'large_cap' }] };
    r = await seedIt(withBad);
    const ack = await r.json();
    assert.strictEqual(ack.accepted, 21); assert.strictEqual(ack.rejected.length, 2);

    // Live feed == scorer output, riskFit floor, <= 10 rows
    for (const t of ['low', 'medium', 'high']) {
      const res = await get(`/api/stocks?tier=${t}`);
      assert.strictEqual(res.headers.get('x-data-source'), 'live');
      const rows = await res.json();
      assert(rows.length <= 10);
      rows.forEach((x, i) => {
        assert.strictEqual(x.rank, i + 1);
        assert.strictEqual(Object.values(x.scoreBreakdown).reduce((a, b) => a + b, 0), x.matchScore);
        assert(x.scoreBreakdown.riskFit > 0, `${t} ${x.ticker} riskFit must be > 0`);
      });
      assert.deepStrictEqual(rows.map((x) => x.ticker), rankForTier(seed.stocks, t).slice(0, 10).map((x) => x.stock.ticker), `${t} order matches scorer`);
    }
    const high = (await tierRows('high')).map((x) => x.ticker);
    assert(!high.includes('JNJ') && !high.includes('PG'), 'riskFit-0 names absent from high');
    assert(!(await tierRows('low')).map((x) => x.ticker).includes('NVDA'), 'NVDA absent from low');

    // Short lists are never padded
    const keep = ['NVDA', 'BTC/USD', 'JNJ', 'VOO', 'BND'];
    await seedIt({ ...seed, stocks: seed.stocks.filter((s) => keep.includes(s.ticker)) });
    const counts = {};
    for (const t of ['low', 'medium', 'high']) counts[t] = (await tierRows(t)).map((x) => x.ticker);
    assert(counts.high.length < 10 && counts.low.length < 10, 'short lists not padded');
    assert.deepStrictEqual(counts.high, rankForTier(seed.stocks.filter((s) => keep.includes(s.ticker)), 'high').map((x) => x.stock.ticker));
    console.log('  short-universe row counts:', Object.entries(counts).map(([t, v]) => `${t}=${v.length} (${v.join(',')})`).join('  '));

    // Sentiment-null warning
    const noSent = { ...seed, stocks: seed.stocks.map((s) => ({ ...s, news: s.news.map((n) => ({ ...n, sentiment: null })) })) };
    await seedIt(noSent);
    assert((await (await get('/api/health')).json()).sentimentMissing === true);
    assert(/sentiment is null for EVERY ticker/.test(log), 'warning logged');

    // Thesis (real engine, mocked Gemini)
    assert.strictEqual((await get('/api/thesis')).status, 404);
    assert.strictEqual((await post('/api/thesis', { goalsText: '  ' })).status, 400);
    const th = await (await post('/api/thesis', { goalsText: 'I want to invest $20 every two weeks' })).json();
    assert(['low', 'medium', 'high'].includes(th.tier) && Array.isArray(th.assumptions));
    assert.deepStrictEqual(await (await get('/api/thesis')).json(), th);
    assert(th.id && typeof th.goal === 'string' && th.assumptions.length >= 2 && th.assumptions.length <= 3 && th.assumptions.every((a) => a.length < 100), 'Contract C assumptions');
    assert(['weekly', 'biweekly', 'monthly', 'one_time'].includes(th.budget.cadence) && th.budget.amount === 20 && Number.isFinite(th.horizonYears) && !Number.isNaN(Date.parse(th.createdAt)), 'Contract C budget/horizon/createdAt');
    assert.strictEqual((await (await get('/api/health')).json()).thesisIsStub, false, 'thesis engine is real');

    // Contract E: first challenge, max one per day, failure does not burn the day
    mockChallenge = true;
    hookStatus = 500;
    await seedIt(withBad); await sleep(500);
    assert.strictEqual(hooks.length, 1, 'attempted once');
    hookStatus = 200;
    await seedIt(withBad); await sleep(500);
    assert.strictEqual(hooks.length, 2, 'retried after failure');
    await seedIt(withBad); await sleep(500);
    assert.strictEqual(hooks.length, 2, 'no second email the same day');
    const mail = hooks[1];
    assert.deepStrictEqual(Object.keys(mail).sort(), ['headline', 'link', 'stance', 'thesisGoal', 'ticker', 'to', 'whyItMatters']);
    assert.strictEqual(mail.stance, 'challenges'); assert.strictEqual(mail.thesisGoal, th.goal);
    assert(mail.link.endsWith('/#thesis'));

    // Admin reset: same secret guard as the seed webhook; clears today's "already sent" flag
    assert.strictEqual((await post('/api/admin/reset-notify', {})).status, 401, 'reset-notify needs the secret');
    assert.strictEqual((await post('/api/admin/reset-notify', {}, { 'x-webhook-secret': 'nope' })).status, 401);
    const reset = await (await post('/api/admin/reset-notify', {}, { 'x-webhook-secret': SECRET })).json();
    assert.strictEqual(reset.ok, true); assert.strictEqual(reset.previous, new Date().toISOString().slice(0, 10));
    await seedIt(withBad); await sleep(500);
    assert.strictEqual(hooks.length, 3, 'a new email can fire after the reset');
    await seedIt(withBad); await sleep(500);
    assert.strictEqual(hooks.length, 3, 'and the one-per-day limit applies again');

    // Portfolio source header (no Alpaca keys here, so always fixture)
    assert.strictEqual((await get('/api/paper/portfolio')).headers.get('x-data-source'), 'fixture');
    console.log('\nOK: auth, fixture fallback, scorer==endpoint, riskFit floor, 10-or-fewer, sentiment warning, thesis Contract C, Contract E, reset-notify');
  } catch (e) {
    console.error('\nFAILED:', e.message, '\n--- server log ---\n' + log);
    process.exitCode = 1;
  } finally {
    srv.kill(); hook.close(); gemini.close(); try { fs.unlinkSync(db); } catch {}
  }
}
main();

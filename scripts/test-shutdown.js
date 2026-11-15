// Graceful shutdown (server/shutdown.js + server/index.js). Offline: local HTTP stand-ins only, a throwaway
// PGlite database, no real Gemini, email, trades or TigerData. Run: npm run test:shutdown   (~10 s)
require('./test-env'); // never a real database, whatever the shell or .env holds
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const { requestTracker, createShutdown } = require('../server/shutdown');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-shutdown-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { log: () => {}, warn: () => {} };
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// A real HTTP server with the tracker installed first, like server/index.js.
async function harness(opts = {}) {
  const tracker = requestTracker();
  const app = express();
  app.use(tracker.middleware);
  app.get('/slow', async (req, res) => { await sleep(Number(req.query.ms) || 800); res.json({ ok: true, answer: 'complete answer' }); });
  app.get('/fast', (req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const order = [];
  const shutdown = createShutdown({
    server, tracker, log: quiet, timeoutMs: opts.timeoutMs || 5000, flushTimeoutMs: opts.flushTimeoutMs || 1000,
    pipelineIdle: opts.pipelineIdle || (() => true),
    flush: async () => { order.push(`flush(active=${tracker.active()})`); if (opts.flushFails) throw new Error('db down'); if (opts.flushHangs) await sleep(60000); },
    close: async () => { order.push('close'); },
  });
  return { base: `http://localhost:${server.address().port}`, server, tracker, shutdown, order };
}

test('an in-flight request (e.g. a chat answer waiting on Gemini) completes before storage is flushed and closed', async () => {
  const h = await harness();
  const pending = fetch(`${h.base}/slow?ms=800`).then(async (r) => ({ status: r.status, body: await r.json(), at: Date.now() }));
  await sleep(100);
  assert.strictEqual(h.tracker.active(), 1);
  const t0 = Date.now();
  const done = h.shutdown('SIGTERM');
  assert.strictEqual(h.shutdown('SIGTERM'), done, 'a second signal reuses the same shutdown');
  await sleep(50);
  await assert.rejects(fetch(`${h.base}/fast`), 'no new connections once shutdown has started');
  const res = await pending;
  const out = await done;
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { ok: true, answer: 'complete answer' }, 'the full response was delivered');
  assert(out.timedOut === false && out.flushed === true, JSON.stringify(out));
  assert.deepStrictEqual(h.order, ['flush(active=0)', 'close'], 'flush only after the request finished, then close');
  assert(out.waitedMs >= 600 && Date.now() - t0 < 3000, `waited for the request (${out.waitedMs} ms)`);
});

test('a running news pipeline (matching + email) is waited for before flushing', async () => {
  let busyUntil = Date.now() + 600;
  const h = await harness({ pipelineIdle: () => Date.now() >= busyUntil });
  const out = await h.shutdown('SIGTERM');
  assert(out.timedOut === false && out.waitedMs >= 550, JSON.stringify(out));
  assert.deepStrictEqual(h.order, ['flush(active=0)', 'close']);
  busyUntil = 0;
});

test('bounded: a request that outlives the timeout is cut off, then storage is still flushed and closed', async () => {
  const h = await harness({ timeoutMs: 300 });
  const pending = fetch(`${h.base}/slow?ms=5000`).then(() => 'answered', () => 'connection closed');
  await sleep(50);
  const out = await h.shutdown('SIGTERM');
  assert(out.timedOut === true && out.waitedMs < 1500, JSON.stringify(out));
  assert.strictEqual(await pending, 'connection closed');
  assert.deepStrictEqual(h.order, ['flush(active=1)', 'close']);
});

test('a failing or hanging flush never blocks the exit and is reported', async () => {
  const a = await harness({ flushFails: true });
  const outA = await a.shutdown('SIGTERM');
  assert(outA.flushed === false && a.order.includes('close'), JSON.stringify(outA));
  const b = await harness({ flushHangs: true, flushTimeoutMs: 200 });
  const t0 = Date.now();
  const outB = await b.shutdown('SIGTERM');
  assert(outB.flushed === false && b.order.includes('close') && Date.now() - t0 < 1500, JSON.stringify(outB));
});

test('real server (PGlite): SIGTERM during a Gemini-backed request finishes it, saves it, exits 0; it survives a restart', async () => {
  let release;
  const geminiCalled = new Promise((r) => { release = r; });
  const gemini = http.createServer((q, r) => {
    let b = ''; q.on('data', (d) => (b += d));
    q.on('end', () => { release(); setTimeout(() => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ choices: [{ message: { content: 'not json' } }] })); }, 1500); });
  });
  await new Promise((r) => gemini.listen(0, r));
  const port = 5200 + Math.floor(Math.random() * 300);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), LOOP_TEST: '1', LOOP_DB: 'pglite', LOOP_PGLITE_DIR: path.join(TMP, 'pglite'),
    LOOP_DB_FILE: path.join(TMP, 'never.json'), DATABASE_URL: '', GEMINI_API_KEY: 'test-key', GEMINI_BASE_URL: `http://localhost:${gemini.address().port}/v1/`,
    GEMINI_MODEL: 'm', LLM_MIN_GAP_MS: '0', DEMO_SEED: 'false', ALPACA_KEY_ID: '', ALPACA_SECRET_KEY: '', FINNHUB_KEY: '', N8N_NOTIFY_WEBHOOK_URL: '', NOTIFY_TO_EMAIL: '', N8N_RUN_WEBHOOK_URL: '' };
  const start = async () => {
    const c = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env, cwd: TMP, stdio: ['ignore', 'pipe', 'pipe'] });
    c.log = ''; c.stdout.on('data', (d) => (c.log += d)); c.stderr.on('data', (d) => (c.log += d));
    c.exited = new Promise((r) => c.on('exit', (code) => r(code)));
    for (let i = 0; i < 200; i++) { try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) return c; } catch { /* booting */ } await sleep(100); }
    c.kill('SIGKILL'); throw new Error(`server did not start:\n${c.log}`);
  };
  let c = await start();
  try {
    const req = fetch(`http://localhost:${port}/api/thesis`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goalsText: 'I want to invest $20 every two weeks for 10 years' }) })
      .then(async (r) => ({ status: r.status, body: await r.json() }), (e) => ({ status: 0, error: e.message }));
    await geminiCalled; // the request is now waiting on the (slow) model
    c.kill('SIGTERM');
    const res = await req;
    const code = await c.exited;
    assert.strictEqual(res.status, 200, `request completed during shutdown: ${JSON.stringify(res)}\n${c.log}`);
    assert(res.body.id && res.body.goal, JSON.stringify(res.body));
    assert.strictEqual(code, 0, c.log);
    assert(/\[shutdown\] SIGTERM: finishing 1 active request/.test(c.log) && /\[shutdown\] done in/.test(c.log), c.log);
    c = await start();
    const again = await (await fetch(`http://localhost:${port}/api/thesis`)).json();
    assert.deepStrictEqual(again, res.body, 'the thesis saved during shutdown survived the restart');
    assert(!fs.existsSync(path.join(TMP, 'never.json')), 'database mode never fell back to the JSON file');
  } finally {
    if (c.exitCode === null) { c.kill('SIGTERM'); await c.exited; }
    gemini.close();
  }
});

(async () => {
  let failed = 0;
  try {
    for (const [name, fn] of tests) {
      try { await fn(); console.log(`PASS  ${name}`); } catch (err) { failed++; console.log(`FAIL  ${name}\n      ${String(err.stack).split('\n').slice(0, 4).join('\n      ')}`); }
    }
  } finally { fs.rmSync(TMP, { recursive: true, force: true }); }
  console.log(failed ? `${failed}/${tests.length} shutdown tests FAILED` : `${tests.length}/${tests.length} shutdown tests passed`);
  process.exit(failed ? 1 : 0);
})();

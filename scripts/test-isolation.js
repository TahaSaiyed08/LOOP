// Proves the automated tests can never reach a real database (TigerData), even when BOTH the shell and a
// .env file say LOOP_DB=postgres with a remote DATABASE_URL. Fully offline: the "remote" host is a reserved
// .invalid name, and a local decoy TCP listener records any connection attempt. Run: npm run test:isolation
//
// Simulates a developer shell that exported the real-database settings BEFORE the test helper runs.
process.env.LOOP_DB = 'postgres';
process.env.DATABASE_URL = 'postgres://tsdbadmin:NeverPrintThisPw@tigerdata-must-never-be-contacted.invalid:5432/tsdb?sslmode=require';
require('./test-env'); // never a real database, whatever the shell or .env holds
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REMOTE = 'postgres://tsdbadmin:NeverPrintThisPw@tigerdata-must-never-be-contacted.invalid:5432/tsdb?sslmode=require';
const SECRETS = /NeverPrintThisPw|tsdbadmin|tigerdata-must-never-be-contacted/;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-isolation-'));
const SERVER = path.join(__dirname, '..', 'server', 'index.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// A local "database" that only counts connections: any attempt to reach it is a failure.
let decoyHits = 0;
const decoy = net.createServer((sock) => { decoyHits++; sock.destroy(); });

function run(env, { cwd = TMP, until } = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SERVER], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    const onData = (d) => { text += d; if (until && until.test(text)) c.kill('SIGTERM'); };
    c.stdout.on('data', onData); c.stderr.on('data', onData);
    const timer = setTimeout(() => c.kill('SIGKILL'), 20000);
    c.on('exit', (code) => { clearTimeout(timer); resolve({ code, text }); });
  });
}

test('every scripts/test-*.js loads ./test-env before anything else', () => {
  const files = fs.readdirSync(__dirname).filter((f) => /^test-.+\.js$/.test(f) && f !== 'test-env.js');
  assert(files.length >= 14, `found ${files.length} test scripts`);
  for (const f of files) {
    const code = fs.readFileSync(path.join(__dirname, f), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    const first = code.match(/require\(\s*['"]([^'"]+)['"]\s*\)/);
    assert(first && first[1] === './test-env', `${f}: first require must be './test-env' (got ${first && first[1]})`);
  }
  const pkg = require('../package.json');
  assert(/^npm run test:isolation\b/.test(pkg.scripts.test), 'npm test runs this check first');
});

test('the helper blanks the shell settings: in-process storage stays on JSON, no connection', async () => {
  assert.strictEqual(process.env.LOOP_DB, '');
  assert.strictEqual(process.env.DATABASE_URL, '');
  assert.strictEqual(process.env.LOOP_TEST, '1');
  const persistence = require('../server/persistence');
  assert.strictEqual(persistence.chosenBackend(), 'json');
  const st = await persistence.init();
  assert(st.backend === 'json' && !persistence.isEnabled());
});

test('a spawned server inheriting the test env stays on JSON even when .env says LOOP_DB=postgres', async () => {
  fs.writeFileSync(path.join(TMP, '.env'), `LOOP_DB=postgres\nDATABASE_URL=postgres://tsdbadmin:NeverPrintThisPw@127.0.0.1:${decoy.address().port}/tsdb\n`);
  const port = 4800 + Math.floor(Math.random() * 300);
  const env = { ...process.env, PORT: String(port), LOOP_DB_FILE: path.join(TMP, 'db.json'), DEMO_SEED: 'false', GEMINI_API_KEY: '', ALPACA_KEY_ID: '', ALPACA_SECRET_KEY: '', FINNHUB_KEY: '' };
  const c = spawn(process.execPath, [SERVER], { env, cwd: TMP, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; c.stdout.on('data', (d) => (log += d)); c.stderr.on('data', (d) => (log += d));
  try {
    let health = null;
    for (let i = 0; i < 100 && !health; i++) { try { const r = await fetch(`http://localhost:${port}/api/health`); if (r.ok) health = await r.json(); } catch { await sleep(100); } }
    assert(health, `server did not start:\n${log}`);
    assert.strictEqual(health.storage.backend, 'json', JSON.stringify(health.storage));
    assert.strictEqual(decoyHits, 0, 'the database in .env was never contacted');
    assert(!SECRETS.test(log), log);
  } finally {
    await new Promise((r) => { c.on('exit', r); c.kill('SIGTERM'); });
  }
});

test('second line of defence: a test that sets LOOP_DB=postgres + a remote URL itself is refused before any network', async () => {
  const persistence = require('../server/persistence');
  Object.assign(process.env, { LOOP_DB: 'postgres', DATABASE_URL: REMOTE });
  const t0 = Date.now();
  let err;
  try { await persistence.init(); } catch (e) { err = e; } finally { Object.assign(process.env, { LOOP_DB: '', DATABASE_URL: '' }); }
  assert(err && /refused: a test run \(LOOP_TEST=1\) may not connect to a non-local PostgreSQL database/.test(err.message), err && err.message);
  assert(Date.now() - t0 < 1000, 'refused immediately (no DNS, no connect timeout)');
  assert(!SECRETS.test(err.message), err.message);
  assert(!persistence.isEnabled());
  // the same through a real server process: exit 1, nothing contacted, nothing leaked
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, PORT: '0', LOOP_TEST: '1', LOOP_DB: 'postgres', DATABASE_URL: REMOTE, LOOP_DB_FILE: path.join(TMP, 'never.json') };
  const out = await run(env, { cwd: TMP });
  assert.strictEqual(out.code, 1, out.text);
  assert(/\[storage\] FATAL: postgres storage unavailable: refused: a test run/.test(out.text), out.text);
  assert(!SECRETS.test(out.text), out.text);
  assert(!fs.existsSync(path.join(TMP, 'never.json')), 'and no JSON file was used instead');
});

test('the guard allows only this machine in tests, and does not change production behaviour', async () => {
  const { connectPostgres } = require('../server/persistence/db');
  process.env.PG_CONNECT_TIMEOUT_MS = '2000';
  process.env.PGSCHEMA = 'thesis_test'; // required with postgres (no default search path)
  // loopback is allowed in tests (it fails to connect for a normal reason: nothing listens on port 1)
  await assert.rejects(connectPostgres('postgres://u:p@127.0.0.1:1/x?sslmode=disable'), (e) => /could not connect/.test(e.message) && !/refused: a test run/.test(e.message));
  // without LOOP_TEST (production) the guard is off: the error is an ordinary connection failure
  process.env.LOOP_TEST = '';
  try {
    await assert.rejects(connectPostgres(REMOTE), (e) => /could not connect/.test(e.message) && !/refused: a test run/.test(e.message) && !SECRETS.test(e.message));
  } finally { process.env.LOOP_TEST = '1'; process.env.PGSCHEMA = ''; }
});

(async () => {
  let failed = 0;
  await new Promise((r) => decoy.listen(0, '127.0.0.1', r));
  try {
    for (const [name, fn] of tests) {
      try { await fn(); console.log(`PASS  ${name}`); } catch (err) { failed++; console.log(`FAIL  ${name}\n      ${String(err.stack).split('\n').slice(0, 4).join('\n      ')}`); }
    }
  } finally {
    decoy.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  assert.strictEqual(decoyHits, 0);
  console.log(failed ? `${failed}/${tests.length} isolation tests FAILED` : `${tests.length}/${tests.length} isolation tests passed`);
  process.exit(failed ? 1 : 0);
})();

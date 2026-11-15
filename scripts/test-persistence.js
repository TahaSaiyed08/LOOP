// Persistence tests (TigerData schema on PGlite = PostgreSQL in this process). Fully offline: no TigerData,
// no real Gemini (a local mock answers), no email (a local stand-in webhook), no trades. Hypothetical data only.
// Run: npm run test:persistence
require('./test-env'); // never a real database, whatever the shell or .env holds
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

// ---------- isolate from any real .env BEFORE loading server code (dotenv never overrides set keys) ----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-persist-'));
const ENV_KEYS = ['ALPACA_DATA_URL', 'ALPACA_KEY_ID', 'ALPACA_PAPER_URL', 'ALPACA_SECRET_KEY', 'COUNCIL_MODE', 'DATABASE_URL', 'DEMO_SEED', 'FALLBACK_GEMINI_MODEL',
  'FINNHUB_KEY', 'GEMINI_API_KEY', 'GEMINI_BASE_URL', 'GEMINI_MODEL', 'INBOUND_WEBHOOK_SECRET', 'NOTIFY_TO_EMAIL', 'PUBLIC_URL', 'N8N_NOTIFY_WEBHOOK_URL',
  'N8N_RUN_WEBHOOK_URL', 'LOOP_DB', 'LOOP_PGLITE_DIR', 'STORE_IMPORT_JSON'];
for (const k of ENV_KEYS) process.env[k] = '';
const SECRET = 'test-secret';
Object.assign(process.env, { LOOP_DB_FILE: path.join(TMP, 'db.json'), LLM_MIN_GAP_MS: '0', INBOUND_WEBHOOK_SECRET: SECRET, DEMO_SEED: 'false', NOTIFY_TO_EMAIL: 'test@example.com' });

// ---------- local stand-ins ----------
const geminiPrompts = { chat: [], news: 0 };
const gemini = http.createServer((q, r) => {
  let b = ''; q.on('data', (d) => (b += d));
  q.on('end', () => {
    const [sys, user] = JSON.parse(b).messages.map((m) => m.content);
    let content = 'not json'; // onboarding, drafts, council, thesis creation: degrade to the offline paths
    if (/research assistant inside THESIS/.test(sys)) {
      geminiPrompts.chat.push(user);
      content = JSON.stringify(/MODE: investigation/.test(user)
        ? { answer: [{ text: 'Cloud customers are delaying orders, which matches a warning sign you listed.', basis: 'evidence', sources: ['E1'] }], followUps: ['What would show demand recovering?'], insufficientEvidence: false }
        : { answer: [{ text: 'Your thesis is that demand for NVIDIA chips keeps growing over your timeline.', basis: 'thesis', sources: [] }], followUps: [], insufficientEvidence: false });
    } else if (/You compare financial news/.test(sys)) {
      geminiPrompts.news++;
      const arts = JSON.parse(user.slice(user.lastIndexOf('<<<') + 3, user.lastIndexOf('>>>')));
      const withVoo = /SELECTED INVESTMENTS:[^\n]*VOO/.test(user); // thesis B holds VOO: it reads the same article differently
      content = JSON.stringify({ matches: arts.map((a) => ({ article: a.n, assumptionIndex: 0, relevance: 'direct',
        stance: /Filler/.test(a.headline) ? 'neutral' : withVoo ? 'supports' : 'challenges', whyItMatters: 'This article relates directly to the first assumption about chip demand.' })) });
    }
    r.setHeader('content-type', 'application/json');
    r.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
const emails = [];
let hookStatus = 200;
let hookDelayMs = 0; // > 8000 makes notify.js time out AFTER the stand-in received the email (delivery uncertain)
const hook = http.createServer((q, r) => { let b = ''; q.on('data', (d) => (b += d)); q.on('end', () => { emails.push({ status: hookStatus, body: JSON.parse(b) }); setTimeout(() => { r.statusCode = hookStatus; r.end('{}'); }, hookDelayMs); }); });
const listen = (srv) => new Promise((res) => srv.listen(0, () => res(srv.address().port)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
let server; let base; let dbDir; let db; let store; let persistence; let pipeline; let connectPglite; let repo;
const call = async (method, p, { user, body, headers = {} } = {}) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-user-id': user } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
};
// Simulated restart: flush, drop every connection and cache, reopen the same database folder.
async function restart() {
  await store.flush();
  await persistence.close();
  store._resetForTests();
  db = await connectPglite(dbDir);
  await store.init({ db });
}
// Faulty adapter: same database, but statements matching `failOn` throw (inside transactions too).
function faulty(inner, failOn) {
  const guard = (q) => ({ query: (t, p) => (failOn.test(t) ? Promise.reject(new Error('simulated database write failure')) : q.query(t, p)), exec: (s) => q.exec(s) });
  return { kind: 'pglite', ...guard(inner), transaction: (fn) => inner.transaction((tx) => fn(guard(tx))), close: () => inner.close() };
}
// Wait for the background pipeline run that a seed started (no extra pass). pass(): one more full run.
const settle = () => pipeline.whenIdle();
const pass = async () => { await settle(); return pipeline.refreshPersisted(); };

// ---------- hypothetical seed (Contract A) ----------
const FIXTURE = require('../fixtures/seed.sample.json');
function seed(runDate, newsByTicker) {
  return { runDate, stocks: FIXTURE.stocks.filter((s) => newsByTicker[s.ticker]).map((s) => ({ ...s, news: newsByTicker[s.ticker] })) };
}
const PUBLISHED = '2020-01-06T15:00:00Z';
const NVDA_ART = { headline: 'HYPOTHETICAL: Nvidia says cloud customers are delaying chip orders', source: 'Sample Wire',
  url: 'https://example.com/hypothetical/nvidia-delays', sentiment: -0.5, datetime: PUBLISHED,
  summary: 'HYPOTHETICAL SAMPLE: several large cloud customers are delaying data-center GPU orders, the company said, citing slower AI spending.' };
const VOO_ART = { headline: 'HYPOTHETICAL: S&P 500 earnings hold up', source: 'Sample Wire', url: 'javascript:alert(1)', sentiment: 0.3, datetime: PUBLISHED };
const FIRST = seed('2026-11-15', { NVDA: [NVDA_ART], VOO: [VOO_ART] });
const postSeed = (payload) => call('POST', '/api/webhook/seed', { body: payload, headers: { 'x-webhook-secret': SECRET } });

const ctx = {};
async function onboard(user, symbols) {
  let r = await call('POST', '/api/v2/thesis/session', { user, body: { action: 'onboard', payload: { message: 'I want to invest $50 a month for 5 years, beginner, medium risk.' } } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const sessionId = r.body.sessionId;
  const step = async (action, payload = {}) => {
    const x = await call('POST', '/api/v2/thesis/session', { user, body: { sessionId, action, payload } });
    assert(x.status === 200 && x.body.ok, `${action}: ${JSON.stringify(x.body).slice(0, 300)}`);
    return x.body;
  };
  r = await step('onboard', { message: 'It is for buying a home.' });
  return { sessionId, step, stage: r.stage };
}

// ======================= 1. database, schema, storage =======================
test('1.1 JSON fallback when LOOP_DB is unset (DATABASE_URL alone never switches storage on); v2 answers 503', async () => {
  const p = require('../server/persistence');
  process.env.DATABASE_URL = 'postgres://nobody:pw@127.0.0.1:1/x';
  const st = await p.init();
  process.env.DATABASE_URL = '';
  assert.strictEqual(st.backend, 'json');
  assert(!p.isEnabled());
  const r = await call('GET', '/api/v2/theses', { user: 'usr_demo' });
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.body.error.code, 'persistence_not_configured');
  assert.strictEqual((await call('GET', '/api/health')).body.storage.backend, 'json');
  assert.throws(() => { process.env.LOOP_DB = 'mysql'; try { p.chosenBackend(); } finally { process.env.LOOP_DB = ''; } }, /LOOP_DB must be/);
});

test('1.2 configured database unavailable: clear, redacted error and no silent JSON fallback', async () => {
  const p = require('../server/persistence');
  Object.assign(process.env, { LOOP_DB: 'postgres', DATABASE_URL: '' });
  await assert.rejects(p.init(), /DATABASE_URL is not set/);
  Object.assign(process.env, { DATABASE_URL: 'postgres://alice:Sup3rSecretPw@127.0.0.1:1/thesis?sslmode=disable', PG_CONNECT_TIMEOUT_MS: '2000' });
  // No PGSCHEMA: refused before any connection (never the default search path / public).
  await assert.rejects(p.init(), (e) => /PGSCHEMA is not set/.test(e.message) && !/Sup3rSecretPw|alice/.test(e.message));
  process.env.PGSCHEMA = 'thesis_test';
  let err;
  try { await p.init(); } catch (e) { err = e; } finally { Object.assign(process.env, { LOOP_DB: '', DATABASE_URL: '', PGSCHEMA: '' }); }
  assert(err && err.code === 'STORAGE_UNAVAILABLE' && /could not connect/.test(err.message), err && err.message);
  assert(!/Sup3rSecretPw|alice|127\.0\.0\.1/.test(err.message), `credentials redacted: ${err.message}`);
  assert(!p.isEnabled() && p.health().error, 'reported, not silently replaced');
  // A real server process refuses to start (exit 1) instead of serving temporary data.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, PORT: '0', LOOP_DB_FILE: path.join(TMP, 'never.json'), PG_CONNECT_TIMEOUT_MS: '2000' };
  for (const k of ENV_KEYS) env[k] = '';
  env.LOOP_TEST = '1';
  Object.assign(env, { LOOP_DB: 'postgres', PGSCHEMA: 'thesis_test', DATABASE_URL: 'postgres://alice:Sup3rSecretPw@127.0.0.1:1/thesis?sslmode=disable' });
  const out = await new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; c.stdout.on('data', (d) => (text += d)); c.stderr.on('data', (d) => (text += d));
    c.on('exit', (code) => resolve({ code, text }));
  });
  assert.strictEqual(out.code, 1, out.text);
  assert(/\[storage\] FATAL: postgres storage unavailable/.test(out.text) && !/Sup3rSecretPw|alice/.test(out.text), out.text);
  assert(!fs.existsSync(path.join(TMP, 'never.json')), 'no JSON file was used instead');
});

test('1.3 schema initialization: all tables, idempotent migrations, demo user', async () => {
  const { rows } = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`);
  const names = rows.map((r) => r.table_name);
  for (const t of ['schema_migrations', 'kv_store', 'users', 'onboarding_sessions', 'session_events', 'theses', 'news_articles', 'thesis_article_checks', 'thesis_matches', 'notifications', 'chat_conversations', 'chat_messages']) assert(names.includes(t), `table ${t}`);
  const { migrate } = require('../server/persistence/migrate');
  assert.deepStrictEqual(await migrate(db), [], 'second run applies nothing');
  assert.strictEqual((await db.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 1);
  assert((await repo.getUser(db, 'usr_demo')), 'demo user exists');
  const fk = await db.query(`SELECT count(*)::int AS n FROM information_schema.table_constraints WHERE constraint_type = 'FOREIGN KEY'`);
  assert(fk.rows[0].n >= 15, 'foreign keys in place');
});

test('1.4 store write-through: insert, update, survive a restart; failed writes are loud, kept and retried', async () => {
  store.set('probe', { n: 1 });
  store.set('probe', { n: 2, list: [1, 2] }); // arrays stored as JSON, latest value wins
  await store.flush();
  await restart();
  assert.deepStrictEqual(store.get('probe'), { n: 2, list: [1, 2] });
  // write failure: data stays in memory, pending, reported; heals on the next flush
  const inner = db;
  await store.init({ db: faulty(inner, /INSERT INTO kv_store/) });
  store.set('probe', { n: 3 });
  await assert.rejects(store.flush(), /simulated database write failure/);
  const h = store.health();
  assert(h.pendingWrites === 1 && /simulated/.test(h.lastError), JSON.stringify(h));
  assert.deepStrictEqual(store.get('probe'), { n: 3 }, 'still served from memory');
  store._resetForTests();
  await store.init({ db: inner });
  assert.deepStrictEqual(store.get('probe'), { n: 2, list: [1, 2] }, 'the failed write never reached the database');
  store.set('probe', { n: 3 }); await store.flush();
  await restart();
  assert.deepStrictEqual(store.get('probe'), { n: 3 });
});

test('1.5 TLS CA pinning and strict schema isolation (no fallback to public)', async () => {
  const dbm = require('../server/persistence/db');
  const url = 'postgres://u:pw@db.example.test:5432/tsdb?sslmode=require&sslrootcert=/x.pem';
  const pem = path.join(TMP, 'ca.pem');
  fs.writeFileSync(pem, '-----BEGIN CERTIFICATE-----\nMIIBhypothetical\n-----END CERTIFICATE-----\n');
  try {
    process.env.PGSSLROOTCERT = pem;
    const ssl = dbm.sslOption(url);
    assert(ssl && ssl.rejectUnauthorized === true && /BEGIN CERTIFICATE/.test(ssl.ca), 'CA pinned, verification on');
    const cs = new URL(dbm.connectionString(url));
    assert(!cs.searchParams.has('sslmode') && !cs.searchParams.has('sslrootcert') && cs.hostname === 'db.example.test', 'URL ssl params stripped so they cannot override the CA');
    process.env.PGSSLROOTCERT = path.join(TMP, 'missing.pem');
    assert.throws(() => dbm.sslOption(url), (e) => /cannot read the CA file missing\.pem/.test(e.message) && !e.message.includes(TMP));
    fs.writeFileSync(path.join(TMP, 'bad.pem'), 'not a cert');
    process.env.PGSSLROOTCERT = path.join(TMP, 'bad.pem');
    assert.throws(() => dbm.sslOption(url), /not a PEM certificate/);
    process.env.PGSSLROOTCERT = '';
    assert.strictEqual(dbm.sslOption(url), undefined, 'without a CA file the URL sslmode decides (unchanged)');
    assert.strictEqual(dbm.connectionString(url), url);
    // schema: required, validated, never injected
    process.env.PGSCHEMA = '';
    assert.throws(() => dbm.schemaName(), (e) => e.code === 'SCHEMA_MISMATCH' && /PGSCHEMA is not set/.test(e.message));
    for (const bad of ['thesis_dev; DROP TABLE users', 'Thesis', 'a-b', 'pg_catalog', '1abc', '"x"']) {
      process.env.PGSCHEMA = bad;
      assert.throws(() => dbm.schemaName(), (e) => e.code === 'SCHEMA_MISMATCH', bad);
    }
    process.env.PGSCHEMA = 'thesis_dev';
    assert.strictEqual(dbm.schemaName(), 'thesis_dev');
    // and connectPostgres refuses before any network without it
    process.env.PGSCHEMA = '';
    await assert.rejects(dbm.connectPostgres('postgres://u:p@127.0.0.1:1/x?sslmode=disable'), /PGSCHEMA is not set/);
  } finally { process.env.PGSSLROOTCERT = ''; process.env.PGSCHEMA = ''; }
});

// ======================= 2. users, onboarding, theses =======================
test('2.1 users and identity: X-User-Id required and checked', async () => {
  assert.strictEqual((await call('GET', '/api/v2/theses')).status, 401);
  assert.strictEqual((await call('GET', '/api/v2/theses', { user: 'usr_doesnotexist' })).status, 401);
  ctx.u1 = (await call('POST', '/api/v2/users', { body: { displayName: 'Hypothetical Ava', preferences: { tier: 'low' } } })).body.userId;
  ctx.u2 = (await call('POST', '/api/v2/users', { body: { displayName: 'Hypothetical Ben' } })).body.userId;
  assert(/^usr_/.test(ctx.u1) && ctx.u1 !== ctx.u2);
  assert.deepStrictEqual((await call('GET', '/api/v2/users/me', { user: ctx.u1 })).body.preferences, { tier: 'low' });
});

test('2.2 onboarding is saved by the server and resumes after a restart; client session objects are ignored', async () => {
  const o = await onboard(ctx.u1, 'NVDA');
  ctx.sessA = o.sessionId;
  assert.strictEqual(o.stage, 'selecting');
  const before = (await call('GET', `/api/v2/thesis/session/${ctx.sessA}`, { user: ctx.u1 })).body;
  await restart();
  const after = (await call('GET', `/api/v2/thesis/session/${ctx.sessA}`, { user: ctx.u1 })).body;
  assert.deepStrictEqual(after, before, 'identical after restart');
  assert(after.history.length === 4 && after.profile.amount === 50 && after.version === 2, JSON.stringify(after).slice(0, 300));
  const forged = await call('POST', '/api/v2/thesis/session', { user: ctx.u1, body: { sessionId: ctx.sessA, action: 'getConfirmedThesis', session: { thesisDraft: { status: 'confirmed' } } } });
  assert(!forged.body.ok && forged.body.error.code === 'not_confirmed', 'a session sent by the client is never used');
  assert(!('session' in forged.body), 'raw session never returned');
});

test('2.3 concurrent session updates: stale expectedVersion and lost races get 409, nothing overwritten', async () => {
  const stale = await call('POST', '/api/v2/thesis/session', { user: ctx.u1, body: { sessionId: ctx.sessA, expectedVersion: 1, action: 'selectAssets', payload: { symbols: 'NVDA' } } });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.body.error.code, 'version_conflict');
  // A race at the database level: two writers that both loaded version 2.
  const row = await repo.getSession(db, ctx.u1, ctx.sessA);
  const next = { state: { ...row.state, version: 3 }, version: 3, stage: row.stage, nextActions: [], displayText: 'x' };
  await repo.updateSession(db, ctx.u1, ctx.sessA, 2, next, { action: 'test', ok: true });
  await assert.rejects(repo.updateSession(db, ctx.u1, ctx.sessA, 2, next, { action: 'test', ok: true }), (e) => e.code === 'version_conflict');
  await db.query( // put the real session back for the next tests
'UPDATE onboarding_sessions SET version = 2, state = $1::jsonb WHERE session_id = $2', [JSON.stringify(row.state), ctx.sessA]);
});

test('2.4 confirmed theses: saved once, assumptions + challenge criteria survive reload; two theses stay separate', async () => {
  const finish = async (sessionId, user, symbols) => {
    const step = async (action, payload = {}) => (await call('POST', '/api/v2/thesis/session', { user, body: { sessionId, action, payload } })).body;
    assert.strictEqual((await step('selectAssets', { symbols })).stage, 'selection_pending');
    assert.strictEqual((await step('confirmSelection')).stage, 'drafting');
    assert.strictEqual((await step('createDraft')).stage, 'reviewing');
    assert.strictEqual((await call('POST', '/api/v2/theses', { user, body: { sessionId } })).status, 409, 'not saved before confirmation');
    assert.strictEqual((await step('confirmAssumptions')).stage, 'confirmed');
    const saved = await call('POST', '/api/v2/theses', { user, body: { sessionId } });
    assert.strictEqual(saved.status, 201);
    const again = await call('POST', '/api/v2/theses', { user, body: { sessionId } });
    assert(again.status === 200 && again.body.created === false && again.body.thesisId === saved.body.thesisId, 'saving twice does not duplicate');
    return saved.body;
  };
  const A = await finish(ctx.sessA, ctx.u1, 'NVDA');
  const b = await onboard(ctx.u1, 'NVDA, VOO');
  const B = await finish(b.sessionId, ctx.u1, 'NVDA, VOO');
  ctx.A = A.thesisId; ctx.B = B.thesisId;
  assert(A.thesis.id === A.thesisId && A.assumptionsConfirmedAt && A.confirmedAt);
  assert(A.assumptions.length >= 2 && A.assumptions.every((a) => a.text && a.whatWouldChallengeIt), 'challenge criteria saved');
  await restart();
  const reA = (await call('GET', `/api/v2/theses/${ctx.A}`, { user: ctx.u1 })).body;
  assert.deepStrictEqual(reA.assumptions, A.assumptions);
  assert.deepStrictEqual(reA.thesis.assumptionDetails, A.thesis.assumptionDetails);
  assert.strictEqual(reA.thesis.assumptionStatus, 'confirmed');
  const list = (await call('GET', '/api/v2/theses', { user: ctx.u1 })).body;
  assert.deepStrictEqual(list.map((t) => t.thesisId).sort(), [ctx.A, ctx.B].sort());
  assert.deepStrictEqual(reA.selectedAssets.map((a) => a.symbol), ['NVDA']);
  assert.deepStrictEqual((await call('GET', `/api/v2/theses/${ctx.B}`, { user: ctx.u1 })).body.selectedAssets.map((a) => a.symbol).sort(), ['NVDA', 'VOO']);
});

test('2.5 two users cannot reach each other\'s records', async () => {
  const u2 = { user: ctx.u2 };
  assert.deepStrictEqual((await call('GET', '/api/v2/theses', u2)).body, []);
  for (const p of [`/api/v2/theses/${ctx.A}`, `/api/v2/theses/${ctx.A}/matches`, `/api/v2/theses/${ctx.A}/timeline`, `/api/v2/thesis/session/${ctx.sessA}`]) {
    assert.strictEqual((await call('GET', p, u2)).status, 404, p);
  }
  assert.strictEqual((await call('POST', `/api/v2/theses/${ctx.A}/chat`, { ...u2, body: { message: 'hi' } })).status, 404);
  assert.strictEqual((await call('POST', '/api/v2/thesis/session', { ...u2, body: { sessionId: ctx.sessA, action: 'confirmAssumptions' } })).status, 404);
  assert.strictEqual((await call('POST', '/api/v2/theses', { ...u2, body: { sessionId: ctx.sessA } })).status, 404);
  assert.strictEqual((await call('PATCH', `/api/v2/theses/${ctx.A}`, { ...u2, body: { monitoringStatus: 'paused' } })).status, 404);
});

// ======================= 3. news, evidence history, notifications =======================
test('3.1 seed: articles keep original summary/URL; failed delivery is recorded as failed, never sent', async () => {
  hookStatus = 500; // the email webhook is down for the first run
  assert.strictEqual((await postSeed(FIRST)).status, 200);
  await settle();
  const { rows } = await db.query('SELECT * FROM news_articles ORDER BY ticker');
  assert.strictEqual(rows.length, 2);
  const nv = rows.find((r) => r.ticker === 'NVDA');
  assert(nv.summary === NVDA_ART.summary && nv.url === NVDA_ART.url && nv.publisher === 'Sample Wire');
  assert.strictEqual(rows.find((r) => r.ticker === 'VOO').url, null, 'invalid URL not stored as a link');
  const n = (await call('GET', `/api/v2/theses/${ctx.A}/notifications`, { user: ctx.u1 })).body;
  assert(n.length === 1 && n[0].status === 'failed' && !n[0].sentAt && n[0].failedAt && /500/.test(n[0].reason), JSON.stringify(n));
  assert.strictEqual(emails.length, 1, 'one attempt reached the webhook');
});

test('3.2 the same article is matched differently for two theses; publication, ingestion and assessment times differ', async () => {
  const mA = (await call('GET', `/api/v2/theses/${ctx.A}/matches`, { user: ctx.u1 })).body.find((m) => m.article.ticker === 'NVDA');
  const mB = (await call('GET', `/api/v2/theses/${ctx.B}/matches`, { user: ctx.u1 })).body.find((m) => m.article.ticker === 'NVDA');
  assert(mA && mB && mA.articleId === mB.articleId, 'one article row');
  assert.strictEqual(mA.stance, 'challenges');
  assert.strictEqual(mB.stance, 'supports');
  assert.strictEqual(mA.article.summary, NVDA_ART.summary);
  assert(mA.assumptionText && mA.assumptionVersion === 1, 'assumption snapshot kept with the assessment');
  const pub = Date.parse(mA.article.publishedAt); const ing = Date.parse(mA.article.ingestedAt); const ass = Date.parse(mA.assessedAt);
  assert(pub < ing && ing <= ass, `published ${mA.article.publishedAt} < ingested ${mA.article.ingestedAt} <= assessed ${mA.assessedAt}`);
  ctx.matchA = mA.matchId;
});

test('3.3 re-sent batch: no duplicate articles or matches, no new Gemini calls, the failed email is retried once and confirmed', async () => {
  const callsBefore = geminiPrompts.news;
  hookStatus = 200;
  assert.strictEqual((await postSeed(FIRST)).status, 200);
  await settle();
  assert.strictEqual((await db.query('SELECT count(*)::int AS n FROM news_articles')).rows[0].n, 2, 'deduplicated');
  assert.strictEqual((await db.query('SELECT seen_count FROM news_articles WHERE ticker = $1', ['NVDA'])).rows[0].seen_count, 2);
  assert.strictEqual((await db.query('SELECT count(*)::int AS n FROM thesis_matches')).rows[0].n, 3, 'A: NVDA article only (VOO is outside its scope); B: both');
  assert.strictEqual(geminiPrompts.news, callsBefore, 'already evaluated articles are not sent to Gemini again');
  const n = (await call('GET', `/api/v2/theses/${ctx.A}/notifications`, { user: ctx.u1 })).body;
  assert(n.length === 1 && n[0].status === 'sent' && n[0].sentAt && n[0].attempts === 2 && n[0].matchId === ctx.matchA, JSON.stringify(n));
  assert.strictEqual(emails.filter((e) => e.status === 200).length, 1);
  const mail = emails[emails.length - 1].body;
  assert.deepStrictEqual(Object.keys(mail).sort(), ['headline', 'link', 'stance', 'thesisGoal', 'ticker', 'to', 'whyItMatters'], 'Contract E unchanged');
  assert(Date.parse(n[0].sentAt) > Date.parse((await call('GET', `/api/v2/theses/${ctx.A}/matches`, { user: ctx.u1 })).body[0].assessedAt));
});

test('3.4 reprocessing an already-notified match never emails again (even with the daily limit reset)', async () => {
  const sent = emails.length;
  assert.strictEqual((await call('POST', '/api/admin/reset-notify', { headers: { 'x-webhook-secret': SECRET } })).status, 200);
  await postSeed(FIRST); await settle(); await pass();
  assert.strictEqual(emails.length, sent, 'no duplicate email');
  assert.strictEqual((await db.query('SELECT count(*)::int AS n FROM notifications')).rows[0].n, 1);
});

// A synthetic "challenges" assessment for thesis B (hypothetical article), to drive notification states directly.
async function challengeRow(label) {
  const t = await repo.getThesisRow(db, ctx.u1, ctx.B);
  const art = { ticker: 'NVDA', headline: `HYPOTHETICAL: notification probe ${label}`, source: 'Sample Wire', url: `https://example.com/hypothetical/${label}`, datetime: PUBLISHED };
  const ids = await repo.upsertArticles(db, [art], { runDate: '2026-11-15' });
  const articleId = ids.get(repo.articleKey(art.ticker, art.headline)).articleId;
  const [m] = await repo.recordAssessment(db, t, { checkedIds: [], analyzedBy: 'gemini', matches: [{ articleId, match: { ticker: 'NVDA', headline: art.headline, url: art.url,
    assumptionIndex: 0, stance: 'challenges', relevance: 'direct', whyItMatters: 'This probe challenges the first assumption.', analyzedBy: 'gemini' } }] });
  return { t, m, articleId };
}
const claimFor = ({ t, m, articleId }) => repo.claimNotification(db, { userId: t.user_id, thesisId: t.thesis_id, matchId: m.match_id, articleId,
  payload: { ticker: 'NVDA', headline: m.match.headline, stance: 'challenges', whyItMatters: m.match.whyItMatters, thesisGoal: t.data.goal } });
const backdate = (id, minutes) => db.query(`UPDATE notifications SET last_attempt_at = now() - make_interval(mins => $2) WHERE notification_id = $1`, [id, minutes]);
const ntf = async (id) => (await db.query('SELECT * FROM notifications WHERE notification_id = $1', [id])).rows[0];

test('3.7 an email send interrupted by a server stop ("sending") is recovered, bounded, without duplicates', async () => {
  await call('POST', '/api/admin/reset-notify', { headers: { 'x-webhook-secret': SECRET } });
  // (a) a send in progress (fresh "sending") is never touched or re-claimed
  const x = await challengeRow('in-progress');
  const cx = await claimFor(x);
  assert(cx && cx.status === 'sending' && cx.attempts === 1);
  assert.deepStrictEqual(await repo.recoverStaleSending(db, { lastSentDate: null }), [], 'fresh sends are left alone');
  assert.strictEqual(await claimFor(x), null, 'and cannot be claimed twice');
  // (b) stale, and an email WAS recorded as sent that day: it may have been this one, so it is never re-sent
  await backdate(cx.notification_id, 11);
  const day = (await db.query(`SELECT to_char(last_attempt_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d FROM notifications WHERE notification_id = $1`, [cx.notification_id])).rows[0].d;
  const rec = await repo.recoverStaleSending(db, { lastSentDate: day });
  assert(rec.length === 1 && rec[0].status === 'failed' && rec[0].attempts === repo.NOTIFY_MAX_ATTEMPTS && /delivery uncertain.*not retried/.test(rec[0].reason), JSON.stringify(rec));
  assert(!(await repo.retryableNotifications(db)).some((r) => r.notification_id === cx.notification_id), 'not retryable');
  // (c) stale, and no email was sent that day: exactly ONE more attempt, through the normal pipeline retry
  const y = await challengeRow('crashed');
  const cy = await claimFor(y);
  await backdate(cy.notification_id, 11);
  const sent = emails.length;
  hookStatus = 200;
  await pass();
  let row = await ntf(cy.notification_id);
  assert(row.status === 'sent' && row.attempts === repo.NOTIFY_MAX_ATTEMPTS && row.sent_at, `1 interrupted + 1 recovery attempt, ending at the cap: ${JSON.stringify(row)}`);
  assert.strictEqual(emails.length, sent + 1, 'one email, not one per thesis or per run');
  assert.deepStrictEqual(Object.keys(emails[emails.length - 1].body).sort(), ['headline', 'link', 'stance', 'thesisGoal', 'ticker', 'to', 'whyItMatters'], 'Contract E unchanged');
  assert.strictEqual(emails[emails.length - 1].body.headline, y.m.match.headline);
  assert.strictEqual((await ntf(cx.notification_id)).status, 'failed', '(b) stayed final');
  // (d) the one extra attempt is the limit: a row that crashes again on its last attempt is not retried
  const z = await challengeRow('crashed-twice');
  const cz = await claimFor(z);
  await db.query('UPDATE notifications SET attempts = $2 WHERE notification_id = $1', [cz.notification_id, repo.NOTIFY_MAX_ATTEMPTS]);
  await backdate(cz.notification_id, 11);
  const before = emails.length;
  await call('POST', '/api/admin/reset-notify', { headers: { 'x-webhook-secret': SECRET } });
  await pass();
  row = await ntf(cz.notification_id);
  assert(row.status === 'failed' && /no attempts left/.test(row.reason), JSON.stringify(row));
  assert.strictEqual(emails.length, before, 'never beyond the attempt cap');
  assert.strictEqual(store.get('notifyLastSentDate'), null);
});

test('3.8 a webhook timeout is recorded as "delivery uncertain" and not re-sent automatically', async () => {
  const { notificationOutcome } = pipeline;
  assert.strictEqual(notificationOutcome({ sent: true }), 'sent');
  assert.strictEqual(notificationOutcome({ sent: false, reason: 'This operation was aborted' }), 'uncertain');
  assert.strictEqual(notificationOutcome({ sent: false, reason: 'webhook responded 500' }), 'failed');
  assert.strictEqual(notificationOutcome({ sent: false, reason: 'fetch failed' }), 'failed');
  assert.strictEqual(notificationOutcome({ sent: false, reason: 'already sent today' }), 'skipped');
  assert.strictEqual(notificationOutcome({ sent: false, reason: 'send in progress' }), 'pending');
  // end to end: the stand-in receives the email but answers after notify.js's 8 s timeout
  await call('POST', '/api/admin/reset-notify', { headers: { 'x-webhook-secret': SECRET } });
  const w = await challengeRow('slow-webhook');
  const cw = await claimFor(w);
  await repo.finishNotification(db, cw.notification_id, 'pending', 'queued for the next run');
  const before = emails.length;
  hookDelayMs = 9000;
  try { await pass(); } finally { hookDelayMs = 0; }
  const row = await ntf(cw.notification_id);
  assert(row.status === 'failed' && row.attempts === repo.NOTIFY_MAX_ATTEMPTS && /delivery uncertain: the email webhook did not answer in time/.test(row.reason), JSON.stringify(row));
  assert.strictEqual(emails.length, before + 1, 'the stand-in did receive it');
  await call('POST', '/api/admin/reset-notify', { headers: { 'x-webhook-secret': SECRET } });
  await pass();
  assert.strictEqual(emails.length, before + 1, 'no duplicate on later runs');
  const n = (await call('GET', `/api/v2/theses/${ctx.B}/notifications`, { user: ctx.u1 })).body.find((x) => x.notificationId === cw.notification_id);
  assert(n && n.status === 'failed' && /uncertain/.test(n.reason), 'visible to the user as uncertain');
});

test('3.5 historical evidence survives later news runs and a restart', async () => {
  const filler = Array.from({ length: 30 }, (_, i) => ({ headline: `HYPOTHETICAL Filler story ${i} about Nvidia`, source: 'Sample Wire', url: `https://example.com/hypothetical/filler-${i}`,
    sentiment: 0, datetime: new Date(Date.UTC(2020, 1, 1, 0, i)).toISOString(), summary: 'HYPOTHETICAL SAMPLE: a filler summary that is long enough to count as an article summary.' }));
  for (let i = 0; i < 3; i++) { await postSeed(seed(`2026-11-1${6 + i}`, { NVDA: filler.slice(i * 10, i * 10 + 10) })); await settle(); } // Contract A keeps 10 news per stock
  await restart();
  const all = (await call('GET', `/api/v2/theses/${ctx.A}/matches`, { user: ctx.u1 })).body;
  assert(all.length >= 31 && all.some((m) => m.matchId === ctx.matchA), `the original assessment is still there (n=${all.length})`);
  assert.strictEqual(all.find((m) => m.matchId === ctx.matchA).stance, 'challenges', 'and unchanged');
  const latest30 = all.slice(0, 30).map((m) => m.matchId);
  assert(!latest30.includes(ctx.matchA), 'the original is now older than the 30 newest matches');
});

test('3.6 timeline: every stage in time order, with distinct article times', async () => {
  const ev = (await call('GET', `/api/v2/theses/${ctx.A}/timeline`, { user: ctx.u1 })).body.events;
  const types = ev.map((e) => e.type);
  for (const t of ['onboarding_started', 'session_action', 'assumptions_confirmed', 'thesis_saved', 'article_published', 'article_ingested', 'article_evaluated', 'evidence_assessed', 'notification_triggered', 'notification_failed', 'notification_sent']) assert(types.includes(t), `timeline has ${t}`);
  assert.deepStrictEqual(ev.map((e) => e.at), [...ev.map((e) => e.at)].sort(), 'sorted by time');
  const said = ev.filter((e) => e.type === 'session_action' && e.action === 'onboard').map((e) => e.payload.message);
  assert(said.includes('It is for buying a home.'), 'what the user said is kept');
  assert(ev.some((e) => e.type === 'session_action' && e.action === 'selectAssets' && e.payload.symbols === 'NVDA'), 'when they selected investments');
});

// ======================= 4. chat =======================
test('4.1 general chat: saved with ordering, timestamps, thesis + conversation ids; survives a restart and continues', async () => {
  const c1 = await call('POST', `/api/v2/theses/${ctx.A}/chat`, { user: ctx.u1, body: { message: 'Can you explain my thesis simply?' } });
  assert(c1.status === 201 && c1.body.ok && c1.body.mode === 'general' && /^conv_/.test(c1.body.conversationId), JSON.stringify(c1.body).slice(0, 300));
  assert(!('history' in c1.body), 'history stays on the server');
  ctx.convA = c1.body.conversationId;
  const c2 = await call('POST', `/api/v2/theses/${ctx.A}/chat`, { user: ctx.u1, body: { message: 'What could go wrong?', conversationId: ctx.convA } });
  assert.strictEqual(c2.status, 200);
  assert(geminiPrompts.chat[geminiPrompts.chat.length - 1].includes('Can you explain my thesis simply?'), 'earlier turn sent back to the engine');
  await restart();
  const m = (await call('GET', `/api/v2/conversations/${ctx.convA}/messages`, { user: ctx.u1 })).body;
  assert.deepStrictEqual(m.messages.map((x) => [x.seq, x.role]), [[1, 'user'], [2, 'assistant'], [3, 'user'], [4, 'assistant']]);
  assert(m.messages.every((x) => x.thesisId === ctx.A && x.conversationId === ctx.convA));
  const times = m.messages.map((x) => Date.parse(x.createdAt));
  assert(times.every((t, i) => i === 0 || t > times[i - 1]), 'strictly increasing timestamps');
  assert(m.messages[1].meta.source === 'gemini' && m.messages[1].meta.mode === 'general');
  const c3 = await call('POST', `/api/v2/theses/${ctx.A}/chat`, { user: ctx.u1, body: { message: 'And over five years?', conversationId: ctx.convA } });
  assert.strictEqual(c3.status, 200);
  assert.deepStrictEqual((await call('GET', `/api/v2/conversations/${ctx.convA}/messages`, { user: ctx.u1 })).body.messages.map((x) => x.seq), [1, 2, 3, 4, 5, 6]);
});

test('4.2 investigation chat: citations stay on their answer and reopen with the ORIGINAL saved article, even after newer news', async () => {
  const c = await call('POST', `/api/v2/theses/${ctx.A}/chat`, { user: ctx.u1, body: { message: 'Does this article really challenge my thesis?', matchId: ctx.matchA } });
  assert(c.status === 201 && c.body.mode === 'investigation' && c.body.matchId === ctx.matchA);
  assert.strictEqual(c.body.citations[0].url, NVDA_ART.url);
  ctx.convInv = c.body.conversationId;
  await restart();
  const again = await call('POST', `/api/v2/theses/${ctx.A}/chat`, { user: ctx.u1, body: { message: 'How significant is it?', conversationId: ctx.convInv } });
  assert.strictEqual(again.status, 200);
  const prompt = geminiPrompts.chat[geminiPrompts.chat.length - 1];
  const e1 = prompt.indexOf('"id": "E1"');
  assert(e1 > 0 && prompt.indexOf(NVDA_ART.headline) > e1 && prompt.indexOf(NVDA_ART.headline) < prompt.indexOf('"id": "E2"'), 'E1 is the original article');
  assert(prompt.includes(NVDA_ART.summary), 'with its original summary');
  assert.strictEqual(again.body.citations[0].url, NVDA_ART.url);
  const m = (await call('GET', `/api/v2/conversations/${ctx.convInv}/messages`, { user: ctx.u1 })).body;
  assert(m.mode === 'investigation' && m.match.matchId === ctx.matchA && m.match.article.url === NVDA_ART.url, 'reopens with its match');
  assert.strictEqual(m.messages[1].citations[0].url, NVDA_ART.url, 'citations saved with the assistant message');
  assert.deepStrictEqual(m.messages[0].citations, [], 'not with the user message');
  // Citations are linked by id to the stored evidence (matchId) and article (articleId), and survive a restart.
  const { rows: [mr] } = await db.query('SELECT m.article_id, a.url FROM thesis_matches m JOIN news_articles a USING (article_id) WHERE m.match_id = $1', [ctx.matchA]);
  for (const cit of [c.body.citations[0], again.body.citations[0], m.messages[1].citations[0], m.messages[3].citations[0]]) {
    assert(cit.matchId === ctx.matchA && cit.articleId === mr.article_id && mr.url === cit.url, `citation linked: ${JSON.stringify(cit)}`);
  }
  assert.strictEqual((await call('POST', `/api/v2/theses/${ctx.A}/chat`, { user: ctx.u1, body: { message: 'x', conversationId: ctx.convInv, matchId: 'mat_other' } })).status, 400);
});

test('4.3 separate theses keep separate conversations and histories', async () => {
  const b = await call('POST', `/api/v2/theses/${ctx.B}/chat`, { user: ctx.u1, body: { message: 'Explain my thesis' } });
  assert(b.status === 201);
  assert(!geminiPrompts.chat[geminiPrompts.chat.length - 1].includes('Can you explain my thesis simply?'), 'thesis A history not used');
  assert.strictEqual((await call('POST', `/api/v2/theses/${ctx.B}/chat`, { user: ctx.u1, body: { message: 'x', conversationId: ctx.convA } })).status, 404);
  const convsA = (await call('GET', `/api/v2/theses/${ctx.A}/conversations`, { user: ctx.u1 })).body.map((x) => x.conversationId);
  const convsB = (await call('GET', `/api/v2/theses/${ctx.B}/conversations`, { user: ctx.u1 })).body.map((x) => x.conversationId);
  assert(convsA.includes(ctx.convA) && !convsB.includes(ctx.convA) && convsB.length === 1);
  const ev = (await call('GET', `/api/v2/theses/${ctx.A}/timeline`, { user: ctx.u1 })).body.events.filter((e) => e.type === 'chat_message');
  assert(ev.length === 10 && ev.every((e) => [ctx.convA, ctx.convInv].includes(e.conversationId)), 'thesis A timeline holds only its own chat');
});

test('4.4 relationship checks (db:verify): all pass on real data, and catch a mislinked citation or message', async () => {
  const { runChecks } = require('../server/persistence/checks');
  const failing = (res) => res.filter((r) => r.bad.length).map((r) => r.name);
  { const r = await runChecks(db); assert.deepStrictEqual(failing(r), [], 'clean data passes every check: ' + JSON.stringify(r.filter((x) => x.bad.length))); }
  const ROLLBACK = new Error('rollback');
  const seen = await db.transaction(async (tx) => {
    // a citation pointing at another article, and a message moved to a different thesis than its conversation
    await tx.query(`UPDATE chat_messages SET citations = jsonb_set(citations, '{0,articleId}', '"art_wrong"')
      WHERE message_id = (SELECT message_id FROM chat_messages WHERE jsonb_array_length(citations) > 0 ORDER BY created_at LIMIT 1)`);
    await tx.query(`UPDATE chat_messages SET thesis_id = $1 WHERE message_id = (SELECT message_id FROM chat_messages WHERE thesis_id = $2 ORDER BY created_at LIMIT 1)`, [ctx.B, ctx.A]);
    const names = failing(await runChecks(tx));
    throw Object.assign(ROLLBACK, { names });
  }).catch((e) => { if (e !== ROLLBACK) throw e; return e.names; });
  assert(seen.includes('cited article = the match article, with the same URL and ticker'), seen.join(' | '));
  assert(seen.includes('chat message thesis/user = its conversation'), seen.join(' | '));
  assert.deepStrictEqual(failing(await runChecks(db)), [], 'rolled back: clean again');
});

// ======================= 5. durable saves: database write failures =======================
test('5.1 write failures: chat, session and thesis saves report 503 and leave nothing half-saved', async () => {
  const inner = db;
  const swap = (re) => persistence.useDb(faulty(inner, re));
  try {
    const before = (await call('GET', `/api/v2/theses/${ctx.A}/conversations`, { user: ctx.u1 })).body.length;
    await swap(/INSERT INTO chat_messages/);
    const c = await call('POST', `/api/v2/theses/${ctx.A}/chat`, { user: ctx.u1, body: { message: 'Will this be saved?' } });
    assert(c.status === 503 && !c.body.ok && c.body.error.code === 'storage_unavailable', JSON.stringify(c.body));
    await persistence.useDb(inner);
    assert.strictEqual((await call('GET', `/api/v2/theses/${ctx.A}/conversations`, { user: ctx.u1 })).body.length, before, 'conversation creation rolled back too');

    const o = await onboard(ctx.u2, 'VOO');
    const v = (await call('GET', `/api/v2/thesis/session/${o.sessionId}`, { user: ctx.u2 })).body.version;
    await swap(/UPDATE onboarding_sessions/);
    const s = await call('POST', '/api/v2/thesis/session', { user: ctx.u2, body: { sessionId: o.sessionId, action: 'selectAssets', payload: { symbols: 'VOO' } } });
    assert(s.status === 503 && s.body.error.code === 'storage_unavailable');
    await persistence.useDb(inner);
    const after = (await call('GET', `/api/v2/thesis/session/${o.sessionId}`, { user: ctx.u2 })).body;
    assert(after.version === v && after.stage === 'selecting', 'session unchanged');
    assert.strictEqual((await db.query(`SELECT count(*)::int AS n FROM session_events WHERE session_id = $1 AND action = 'selectAssets'`, [o.sessionId])).rows[0].n, 0, 'no orphan event');

    for (const [action, payload] of [['selectAssets', { symbols: 'VOO' }], ['confirmSelection'], ['createDraft'], ['confirmAssumptions']]) await o.step(action, payload);
    await swap(/INSERT INTO theses/);
    const t = await call('POST', '/api/v2/theses', { user: ctx.u2, body: { sessionId: o.sessionId } });
    assert(t.status === 503 && t.body.error.code === 'storage_unavailable');
    await persistence.useDb(inner);
    assert.deepStrictEqual((await call('GET', '/api/v2/theses', { user: ctx.u2 })).body, [], 'no thesis saved');
    assert.strictEqual((await call('POST', '/api/v2/theses', { user: ctx.u2, body: { sessionId: o.sessionId } })).status, 201, 'retry works once the database is back');

    await swap(/INSERT INTO news_articles/);
    const sd = await postSeed(seed('2026-11-20', { NVDA: [{ ...NVDA_ART, headline: 'HYPOTHETICAL: never stored' }] }));
    assert.strictEqual(sd.status, 503, 'seed refused when its articles cannot be saved');
    await persistence.useDb(inner);
    assert.notStrictEqual(store.get('feed').runDate, '2026-11-20', 'the feed was not replaced either');
  } finally { await persistence.useDb(inner); }
});

// ======================= 6. legacy single-thesis routes in database mode =======================
test('6.1 legacy POST/GET /api/thesis and /api/thesis/news keep their contracts and are persisted for the demo user', async () => {
  const r = await call('POST', '/api/thesis', { body: { goalsText: 'I want to invest $20 every two weeks for 10 years' } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(Object.keys(r.body).sort(), ['assumptions', 'budget', 'createdAt', 'goal', 'horizonYears', 'id', 'tier']);
  assert.deepStrictEqual((await call('GET', '/api/thesis')).body, r.body);
  const demo = await repo.listTheses(db, 'usr_demo');
  assert(demo.length === 1 && demo[0].origin === 'goals_text' && demo[0].monitoringStatus === 'active');
  await postSeed(seed('2026-11-21', { NVDA: [{ ...NVDA_ART, headline: 'HYPOTHETICAL: second Nvidia story', url: 'https://example.com/hypothetical/second' }] })); await settle();
  const news = (await call('GET', '/api/thesis/news')).body;
  assert(Array.isArray(news) && news.length >= 1 && news.every((m) => ['ticker', 'headline', 'url', 'assumptionIndex', 'stance', 'whyItMatters'].every((k) => k in m)), JSON.stringify(news).slice(0, 300));
  const r2 = await call('POST', '/api/thesis', { body: { goalsText: 'Saving $100 a month for 3 years' } });
  const demo2 = await repo.listTheses(db, 'usr_demo');
  assert(demo2.length === 2 && demo2.filter((t) => t.monitoringStatus === 'active').length === 1, 'the new legacy thesis replaces the old as the monitored one; the old is kept');
  assert.deepStrictEqual((await call('GET', '/api/thesis')).body, r2.body);
  const inner = db;
  await persistence.useDb(faulty(inner, /INSERT INTO theses/));
  const failed = await call('POST', '/api/thesis', { body: { goalsText: 'This one cannot be saved' } });
  await persistence.useDb(inner);
  assert.strictEqual(failed.status, 503);
  assert.deepStrictEqual((await call('GET', '/api/thesis')).body, r2.body, 'previous thesis still served');
  assert.strictEqual((await call('GET', '/api/health')).body.storage.backend, 'pglite');
});

test('6.2 the public demo id usr_demo is refused on every /api/v2 route (403), legacy routes keep working', async () => {
  const legacy = (await repo.listTheses(db, 'usr_demo')).find((t) => t.monitoringStatus === 'active');
  assert(legacy, 'the legacy thesis is monitored');
  const id = legacy.thesisId;
  const attempts = [['GET', '/api/v2/users/me'], ['GET', '/api/v2/theses'], ['GET', `/api/v2/theses/${id}`],
    ['PATCH', `/api/v2/theses/${id}`, { monitoringStatus: 'paused' }], ['GET', `/api/v2/theses/${id}/matches`],
    ['GET', `/api/v2/theses/${id}/notifications`], ['GET', `/api/v2/theses/${id}/timeline`], ['GET', `/api/v2/theses/${id}/conversations`],
    ['POST', `/api/v2/theses/${id}/chat`, { message: 'Show me this thesis' }], ['GET', '/api/v2/thesis/sessions'],
    ['POST', '/api/v2/thesis/session', { action: 'onboard', payload: { message: 'hi' } }], ['POST', '/api/v2/theses', { sessionId: 'ses_whatever' }]];
  const chatsBefore = geminiPrompts.chat.length;
  for (const [m, p, body] of attempts) {
    const r = await call(m, p, { user: 'usr_demo', body });
    assert(r.status === 403 && r.body.error.code === 'reserved_user', `${m} ${p} -> ${r.status} ${JSON.stringify(r.body)}`);
  }
  assert.strictEqual(geminiPrompts.chat.length, chatsBefore, 'no Gemini call was made for the refused chat');
  assert.strictEqual((await repo.getThesisRow(db, 'usr_demo', id)).monitoring_status, 'active', 'monitoring could not be paused');
  assert.strictEqual((await call('GET', '/api/thesis')).status, 200, 'legacy GET /api/thesis unaffected');
  assert.strictEqual((await call('GET', '/api/thesis/news')).status, 200, 'legacy GET /api/thesis/news unaffected');
});

// ======================= 7. a real process restart (spawned server) =======================
test('6.3 a newly saved thesis is matched against the stored news at once (no email); resume and list payloads for the website', async () => {
  await settle();
  const before = { emails: emails.length, news: geminiPrompts.news };
  const c = await onboard(ctx.u1, 'NVDA');
  for (const [a, p] of [['selectAssets', { symbols: 'NVDA' }], ['confirmSelection'], ['createDraft']]) await c.step(a, p);
  // resume mid-review: the draft fields the website needs to show the review step again
  const mid = (await call('GET', `/api/v2/thesis/session/${c.sessionId}`, { user: ctx.u1 })).body;
  assert(mid.stage === 'reviewing' && mid.draft.status === 'proposed' && mid.draft.goal && mid.draft.assumptions.length >= 2, JSON.stringify(mid.draft).slice(0, 300));
  assert.deepStrictEqual(mid.draft.selectedAssets.map((a) => a.symbol), ['NVDA']);
  assert(Array.isArray(mid.draft.risks) && mid.draft.budget && mid.draft.savedThesisId === undefined && mid.savedThesisId === null);
  await c.step('confirmAssumptions');
  const saved = await call('POST', '/api/v2/theses', { user: ctx.u1, body: { sessionId: c.sessionId } });
  assert.strictEqual(saved.status, 201);
  const C = saved.body.thesisId;
  await settle(); // the background evaluation of the already-stored feed
  const m = (await call('GET', `/api/v2/theses/${C}/matches`, { user: ctx.u1 })).body;
  assert(m.length >= 1 && m.every((x) => x.thesisId === C && x.article && x.article.headline), 'evidence without waiting for a new seed');
  assert(geminiPrompts.news > before.news, 'evaluated with the same matchNewsDetailed (mock Gemini)');
  const n = (await call('GET', `/api/v2/theses/${C}/notifications`, { user: ctx.u1 })).body;
  assert(m.some((x) => x.stance === 'challenges') && n.length >= 1 && n.every((x) => x.status === 'skipped' && /found when the thesis was saved/.test(x.reason)), JSON.stringify(n));
  assert.strictEqual(emails.length, before.emails, 'no email for news found at save time');
  await pass(); // a later full run never emails those challenges either
  assert.strictEqual(emails.length, before.emails);
  assert.strictEqual((await call('GET', `/api/v2/theses/${C}/notifications`, { user: ctx.u1 })).body.length, n.length);
  // resume after saving + list payloads
  const after = (await call('GET', `/api/v2/thesis/session/${c.sessionId}`, { user: ctx.u1 })).body;
  assert(after.savedThesisId === C && after.draft.status === 'confirmed' && after.draft.confirmedAt);
  const open = await call('POST', '/api/v2/thesis/session', { user: ctx.u1, body: { action: 'onboard', payload: { message: 'I want to save for retirement.' } } });
  const sessions = (await call('GET', '/api/v2/thesis/sessions', { user: ctx.u1 })).body;
  const sc = sessions.find((x) => x.sessionId === c.sessionId); const so = sessions.find((x) => x.sessionId === open.body.sessionId);
  assert(sc && sc.savedThesisId === C && sc.goal && sc.assets.join() === 'NVDA', JSON.stringify(sc));
  assert(so && so.savedThesisId === null && so.stage === 'onboarding', 'an unfinished session is listed as unfinished');
  const lt = (await call('GET', '/api/v2/theses', { user: ctx.u1 })).body.find((t) => t.thesisId === C);
  assert(lt.assumptionCount >= 2 && lt.activity.matches === m.length && lt.activity.challenges >= 1 && lt.activity.lastActivityAt, JSON.stringify(lt.activity));
  assert(!('thesis' in lt) && !('assumptions' in lt), 'list stays a summary');
});

test('7.1 spawned server on PGlite: onboarding, a seed feed and a thesis survive a full process restart', async () => {
  const dir = path.join(TMP, 'spawned-db');
  const port = 4300 + Math.floor(Math.random() * 400);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), LOOP_DB_FILE: path.join(TMP, 'spawned.json'), LLM_MIN_GAP_MS: '0' };
  for (const k of ENV_KEYS) env[k] = '';
  env.LOOP_TEST = '1';
  Object.assign(env, { LOOP_DB: 'pglite', LOOP_PGLITE_DIR: dir, INBOUND_WEBHOOK_SECRET: SECRET, DEMO_SEED: 'false' });
  const sb = `http://localhost:${port}`;
  const start = async () => {
    const c = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; c.stdout.on('data', (d) => (log += d)); c.stderr.on('data', (d) => (log += d));
    for (let i = 0; i < 200; i++) { try { if ((await fetch(sb + '/api/health')).ok) return c; } catch { /* booting */ } await sleep(100); }
    c.kill(); throw new Error(`spawned server did not start:\n${log}`);
  };
  const stop = (c) => new Promise((r) => { c.on('exit', r); c.kill('SIGTERM'); });
  const j = async (m, p, body, user, headers = {}) => (await fetch(sb + p, { method: m, headers: { 'content-type': 'application/json', ...(user ? { 'x-user-id': user } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }));
  let c = await start();
  const user = (await (await j('POST', '/api/v2/users', {})).json()).userId;
  const s = await (await j('POST', '/api/v2/thesis/session', { action: 'onboard', payload: { message: 'I want to invest $50 a month for 5 years, beginner, medium risk.' } }, user)).json();
  assert.strictEqual((await j('POST', '/api/webhook/seed', FIRST, null, { 'x-webhook-secret': SECRET })).status, 200);
  assert.strictEqual((await j('POST', '/api/thesis', { goalsText: 'I want to invest $20 every two weeks for 10 years' })).status, 200);
  const before = await (await j('GET', `/api/v2/thesis/session/${s.sessionId}`, null, user)).json();
  const thesisBefore = await (await j('GET', '/api/thesis')).json();
  await stop(c);
  c = await start();
  try {
    assert.deepStrictEqual(await (await j('GET', `/api/v2/thesis/session/${s.sessionId}`, null, user)).json(), before, 'onboarding resumes after restart');
    const stocks = await j('GET', '/api/stocks?tier=low');
    assert.strictEqual(stocks.headers.get('x-data-source'), 'live', 'seeded feed survived the restart (kv_store)');
    assert.deepStrictEqual(await (await j('GET', '/api/thesis')).json(), thesisBefore, 'legacy thesis survived');
    const h = await (await j('GET', '/api/health')).json();
    assert(h.storage.backend === 'pglite' && h.storage.pendingWrites === 0);
  } finally { await stop(c); }
  assert(!fs.existsSync(path.join(TMP, 'spawned.json')), 'database mode never wrote the JSON file');
});

(async () => {
  let failed = 0;
  try {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_BASE_URL = `http://localhost:${await listen(gemini)}/v1/`;
    process.env.GEMINI_MODEL = 'mock';
    process.env.N8N_NOTIFY_WEBHOOK_URL = `http://localhost:${await listen(hook)}/hook`;
    ({ connectPglite } = require('../server/persistence/db'));
    persistence = require('../server/persistence');
    store = require('../server/store');
    repo = require('../server/persistence/repo');
    pipeline = require('../server/pipeline');
    const app = require('../server/index');
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://localhost:${server.address().port}`;
    for (const [name, fn] of tests) {
      if (name.startsWith('1.3') && !db) { dbDir = path.join(TMP, 'db'); db = await connectPglite(dbDir); await store.init({ db }); }
      try { await fn(); console.log(`PASS  ${name}`); } catch (err) { failed++; console.log(`FAIL  ${name}\n      ${String(err.stack).split('\n').slice(0, 4).join('\n      ')}`); }
    }
  } finally {
    try { await store.flush(); } catch { /* reported by the tests */ }
    await persistence.close().catch(() => {});
    server && server.close(); gemini.close(); hook.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log(failed ? `${failed}/${tests.length} persistence tests FAILED` : `${tests.length}/${tests.length} persistence tests passed`);
  process.exit(failed ? 1 : 0);
})();

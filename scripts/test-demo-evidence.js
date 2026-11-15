// Prepared real-news demo (scripts/demo-evidence.js): one article, two independently confirmed theses.
// Offline: in-memory PGlite, a mock Gemini whose stance depends ONLY on each thesis's own confirmed assumption
// text (no article is hardcoded to a stance), and a notify webhook that must never be called.
// Run: npm run test:demo-evidence
require('./test-env');
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vm = require('vm');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thesis-demo-evidence-'));
for (const k of ['ALPACA_KEY_ID', 'ALPACA_SECRET_KEY', 'FINNHUB_KEY', 'GEMINI_API_KEY', 'GEMINI_BASE_URL', 'GEMINI_MODEL', 'FALLBACK_GEMINI_MODEL', 'NOTIFY_TO_EMAIL', 'N8N_RUN_WEBHOOK_URL', 'DEMO_SEED']) process.env[k] = '';
Object.assign(process.env, { LOOP_DB_FILE: path.join(TMP, 'db.json'), LLM_MIN_GAP_MS: '0', DEMO_SEED: 'false', NOTIFY_TO_EMAIL: 'nobody@example.invalid' });

// The mock reads the thesis's assumption lines and judges each article against them: an assumption that
// expects slowing spending is supported by slowdown news and challenged by growth news, and vice versa.
const SLOW = /slow|downgrade|midterm|snag|fears/i;
const GROW = /financial results|growth accelerates/i;
const prompts = { news: [], chat: [] };
const gemini = http.createServer((q, r) => {
  let b = ''; q.on('data', (d) => (b += d));
  q.on('end', () => {
    const [sys, user] = JSON.parse(b).messages.map((m) => m.content);
    let content = 'not json';
    if (/You compare financial news/.test(sys)) {
      prompts.news.push(user);
      const lines = user.split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => ({ i: Number(l.split('.')[0]), text: l, tickers: (l.split(' | ')[1] || '').split(', ') }));
      const arts = JSON.parse(user.slice(user.lastIndexOf('<<<') + 3, user.lastIndexOf('>>>')));
      const matches = [];
      for (const a of arts) {
        const as = lines.find((l) => l.tickers.includes(a.ticker));
        if (!as || /Volatility/.test(a.headline)) continue; // not about any assumption
        const expectsSlowing = /slow down|squeeze/.test(as.text);
        const slowNews = SLOW.test(a.headline); const growNews = GROW.test(a.headline);
        const stance = !slowNews && !growNews ? 'neutral' : (slowNews === expectsSlowing ? 'supports' : 'challenges');
        matches.push({ article: a.n, assumptionIndex: as.i, relevance: 'direct', stance, whyItMatters: `For assumption ${as.i + 1} (${expectsSlowing ? 'expects slowing' : 'expects growth'}): ${stance}.` });
      }
      content = JSON.stringify({ matches });
    } else if (/research assistant inside THESIS/.test(sys)) {
      prompts.chat.push(user);
      content = JSON.stringify({ answer: [{ text: 'The article reports an analyst expecting slower AI spending growth.', basis: 'evidence', sources: ['E1'] }], followUps: [], insufficientEvidence: false });
    }
    r.setHeader('content-type', 'application/json');
    r.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
const emails = [];
const hook = http.createServer((q, r) => { emails.push(q.url); r.end('{}'); });
const listen = (srv) => new Promise((res) => srv.listen(0, () => res(srv.address().port)));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
let base; let db; let repo; let pipeline; let store; let persistence; let D;
async function call(method, p, { user, body } = {}) {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-user-id': user } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
const count = async (sql, args = []) => (await db.query(sql, args)).rows[0].c;
const ctx = {};
const DEMO = 'usr_thesis_demo';
const RESULTS = 'NVIDIA Announces Financial Results for Second Quarter Fiscal 2027';
const BAIRD = 'Baird downgrades Nvidia to Neutral on potential slowdown, lack of visibility';
const byHead = (ms, hd) => ms.find((m) => m.article.headline === hd);
// Save a confirmed engine session as a thesis through the real route (match-on-save runs in the background).
async function saveThroughApi(user, scenario, profile) {
  const { session } = await D.buildScenario(scenario, profile);
  const saved = await require('../server/thesis').handleThesisAction(session, 'getConfirmedThesis', {});
  const ses = await repo.createSession(db, user, { state: saved.session, version: saved.version, stage: saved.stage, nextActions: saved.nextActions, displayText: null }, { action: 'test', payload: {}, ok: true });
  const r = await call('POST', '/api/v2/theses', { user, body: { sessionId: ses.session_id } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  await pipeline.whenIdle();
  return r.body.thesisId;
}

test('1. other users first: an unrelated user\'s NVDA thesis saved BEFORE and AFTER the snapshot gets none of it', async () => {
  const other = (await call('POST', '/api/v2/users', { body: {} })).body.userId;
  ctx.other = other;
  ctx.otherBefore = await saveThroughApi(other, D.DATA.scenarios.A, D.DATA.scenarios.A.profile);
  assert.strictEqual(await count('SELECT count(*)::int c FROM thesis_matches WHERE thesis_id = $1', [ctx.otherBefore]), 0);
  ctx.otherRows = JSON.stringify((await db.query('SELECT * FROM theses WHERE thesis_id = $1', [ctx.otherBefore])).rows);
});

test('2. prepare Scenario A twice: same thesis, articles stored once, no duplicate matches or checks', async () => {
  const one = await D.prepareScenarioA(db, repo, pipeline);
  assert(one.created && one.out.matches > 0, JSON.stringify(one.out));
  const snap = async () => [await count('SELECT count(*)::int c FROM news_articles'), await count('SELECT count(*)::int c FROM thesis_matches'), await count('SELECT count(*)::int c FROM thesis_article_checks'), await count('SELECT count(*)::int c FROM theses WHERE user_id = $1', [DEMO])];
  const first = await snap();
  const two = await D.prepareScenarioA(db, repo, pipeline);
  assert.strictEqual(two.created, false); assert.strictEqual(two.row.thesis_id, one.row.thesis_id);
  assert.deepStrictEqual(await snap(), first, 'rerun changes nothing');
  assert.strictEqual(first[0], D.DATA.articles.length, 'each real article stored once');
  ctx.A = one.row.thesis_id;
  assert.strictEqual(store.get('feed'), null, 'the live Feed was not touched');
});

test('3. Scenario A evidence: several investments covered, real links, labelled prepared', async () => {
  const ms = (await call('GET', `/api/v2/theses/${ctx.A}/matches`, { user: DEMO })).body;
  ctx.Am = ms;
  assert(new Set(ms.map((m) => m.article.ticker)).size >= 2, 'evidence for at least two investments');
  assert(ms.every((m) => /^https:\/\//.test(m.article.url) && !/example\./.test(m.article.url) && m.article.prepared === true));
  assert.strictEqual(byHead(ms, RESULTS).stance, 'supports');
  assert.strictEqual(byHead(ms, BAIRD).stance, 'challenges');
  assert(!ms.some((m) => m.article.ticker === 'BND'), 'no BND evidence on a thesis without BND');
});

test('4. Scenario B saved through POST /api/v2/theses is matched against the preloaded snapshot on save', async () => {
  assert.strictEqual(await count('SELECT count(*)::int c FROM theses WHERE user_id = $1 AND legacy_id IS NULL', [DEMO]), 0, 'nothing pre-created for B');
  // a live Feed is stored too: demo theses use only the prepared snapshot, everyone else only the Feed
  store.set('feed', { runDate: '2026-11-15', stocks: [{ ticker: 'NVDA', news: [{ headline: 'FEED ONLY: Nvidia slowdown worries return', source: 'Feed', url: 'https://www.cnbc.com/feed-only', datetime: '2026-11-15T10:00:00Z' }] }] });
  ctx.B = await saveThroughApi(DEMO, D.DATA.scenarios.B, { ...D.DATA.scenarios.A.profile, amount: 50, timelineYears: 3 });
  const ms = (await call('GET', `/api/v2/theses/${ctx.B}/matches`, { user: DEMO })).body;
  ctx.Bm = ms;
  assert(ms.length >= 4 && ms.every((m) => m.article.prepared), 'B has its own evidence from the snapshot, and nothing from the Feed');
  assert(ms.some((m) => m.article.ticker === 'BND') && !ms.some((m) => m.article.ticker === 'VOO'), 'evidence follows B\'s own investments');
});

test('5. one article, two theses: opposite stances, separate records and explanations, same article id and URL', async () => {
  for (const hd of [RESULTS, BAIRD]) {
    const a = byHead(ctx.Am, hd); const b = byHead(ctx.Bm, hd);
    assert.notStrictEqual(a.stance, b.stance, hd);
    assert.notStrictEqual(a.matchId, b.matchId);
    assert.strictEqual(a.articleId, b.articleId); assert.strictEqual(a.article.url, b.article.url);
    assert.notStrictEqual(a.whyItMatters, b.whyItMatters);
    assert.notStrictEqual(a.assumptionText, b.assumptionText, 'each judged against its own assumption');
  }
  assert.strictEqual(byHead(ctx.Bm, BAIRD).stance, 'supports'); assert.strictEqual(byHead(ctx.Bm, RESULTS).stance, 'challenges');
});

test('6. no contamination: the other user is unaffected and gets nothing when saving after the snapshot exists', async () => {
  assert.strictEqual(JSON.stringify((await db.query('SELECT * FROM theses WHERE thesis_id = $1', [ctx.otherBefore])).rows), ctx.otherRows);
  const after = await saveThroughApi(ctx.other, D.DATA.scenarios.B, D.DATA.scenarios.A.profile);
  const got = (await call('GET', `/api/v2/theses/${after}/matches`, { user: ctx.other })).body;
  assert.deepStrictEqual(got.map((m) => m.article.headline), ['FEED ONLY: Nvidia slowdown worries return'], 'other users: Feed only, never the snapshot');
  assert(got.every((m) => m.article.prepared === undefined), 'no demo label for other users');
  assert.strictEqual(await count('SELECT count(*)::int c FROM thesis_matches WHERE thesis_id = $1', [ctx.otherBefore]), 0);
  assert.strictEqual((await call('GET', `/api/v2/theses/${ctx.A}/matches`, { user: ctx.other })).status, 404, 'another user cannot read the demo thesis');
});

test('7. no email: challenges are recorded as "shown in the app, not emailed"; the webhook was never called', async () => {
  const rows = (await db.query('SELECT status, count(*)::int c FROM notifications GROUP BY status')).rows;
  assert(rows.length && rows.every((r) => r.status === 'skipped'), JSON.stringify(rows));
  assert.strictEqual(emails.length, 0);
});

test('8. Research Chat on B\'s article uses B\'s assumption and that article, not A\'s', async () => {
  const m = byHead(ctx.Bm, BAIRD);
  const r = await call('POST', `/api/v2/theses/${ctx.B}/chat`, { user: DEMO, body: { message: 'Why does this article support my thesis?', matchId: m.matchId } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const u = prompts.chat[prompts.chat.length - 1];
  assert(u.includes('slow down from its recent very fast pace') && !u.includes('keep spending heavily on AI data centers'), 'B\'s own assumption only');
  assert(/MODE: investigation/.test(u) && u.indexOf(BAIRD) > -1 && u.indexOf('"id": "E1"') < u.indexOf(BAIRD), 'the opened article is E1');
  assert.strictEqual(r.body.citations[0].url, m.article.url, 'citation carries the real source URL');
  assert.strictEqual(r.body.citations[0].matchId, m.matchId);
});

test('9. the app\'s link check: real links kept, placeholder links never shown as working', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const code = src.slice(src.indexOf('const PLACEHOLDER_HOST'), src.indexOf('function extLink'));
  const sandbox = { URL }; vm.runInNewContext(`${code}; this.safeUrl = safeUrl;`, sandbox);
  for (const a of D.DATA.articles) assert.strictEqual(sandbox.safeUrl(a.url), a.url);
  for (const bad of ['https://example.com/hypothetical/nvidia-delays', 'https://news.example.org/x', 'http://localhost:3000/a', 'javascript:alert(1)', 'https://127.0.0.1/a', 'https://site.test/a', null]) assert.strictEqual(sandbox.safeUrl(bad), null, String(bad));
  assert(src.includes("'Same article in your other theses'") && src.includes('Prepared real-news snapshot'));
});

test('10. the demo script refuses tests and any schema other than thesis_dev', () => {
  assert.throws(() => D.guard(), /refuses to run inside tests/);
  const saved = { ...process.env };
  try {
    delete process.env.LOOP_TEST; process.env.LOOP_DB = 'postgres';
    for (const s of ['public', '', 'thesis_prod']) { process.env.PGSCHEMA = s; assert.throws(() => D.guard(), /Refusing schema/); }
    process.env.PGSCHEMA = 'thesis_dev'; D.guard();
  } finally { process.env.LOOP_TEST = saved.LOOP_TEST; process.env.LOOP_DB = saved.LOOP_DB; process.env.PGSCHEMA = saved.PGSCHEMA; }
});

test('11. a selected investment the draft left out can get the user\'s own idea (addAssumption, reviewing only, max 4)', async () => {
  const T = require('../server/thesis');
  let s = T.createOnboardingSession();
  s.profile = { ...s.profile, amount: 50, cadence: 'monthly', timelineYears: 3, purpose: 'learn', riskComfort: 'medium' };
  s = T.confirmSelection(T.selectAssets('NVDA, MSFT, BND', s).session).session;
  s = (await T.createThesisDraft(s, { forceFallback: true })).session;
  while (T.viewAssumptions(s).assumptions.length > 2) s = T.removeAssumption(s, 3).session; // like a draft that skipped BND
  let r = await T.handleThesisAction(s, 'addAssumption', { text: DATA_B().text, challenge: DATA_B().challenge });
  assert(r.ok, JSON.stringify(r.error)); assert.strictEqual(r.result.assumptions ? r.result.assumptions.length : T.viewAssumptions(r.session).assumptions.length, 3);
  assert(T.viewAssumptions(r.session).assumptions[2].tickers.includes('BND'));
  assert((await T.handleThesisAction(r.session, 'addAssumption', { text: '', challenge: 'x' })).error.code === 'invalid_payload');
  const early = await T.handleThesisAction(null, 'onboard', { message: 'I want to save $50 a month' });
  assert(!(await T.handleThesisAction(early.session, 'addAssumption', { text: 'a', challenge: 'b' })).ok, 'not before a draft exists');
});
const DATA_B = () => D.DATA.scenarios.B.assumptions[2];

(async () => {
  const gPort = await listen(gemini); const hPort = await listen(hook);
  Object.assign(process.env, { GEMINI_API_KEY: 'test-key', GEMINI_BASE_URL: `http://127.0.0.1:${gPort}/`, GEMINI_MODEL: 'mock-model', N8N_NOTIFY_WEBHOOK_URL: `http://127.0.0.1:${hPort}/notify` });
  store = require('../server/store');
  persistence = require('../server/persistence');
  pipeline = require('../server/pipeline');
  repo = require('../server/persistence/repo');
  D = require('./demo-evidence');
  const { connectPglite } = require('../server/persistence/db');
  db = await connectPglite(path.join(TMP, 'pglite'));
  await store.init({ db });
  const app = require('../server/index');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS  ${name}`); } catch (err) { failed++; console.log(`FAIL  ${name}\n      ${String(err.stack).split('\n').slice(0, 10).join('\n      ')}`); }
  }
  await pipeline.whenIdle();
  server.close(); gemini.close(); hook.close();
  await store.flush(); await persistence.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failed ? `${failed}/${tests.length} demo evidence tests FAILED` : `${tests.length}/${tests.length} demo evidence tests passed`);
  process.exit(failed ? 1 : 0);
})();

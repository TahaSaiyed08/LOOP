// THESIS web app (public/app.*): offline checks. No real database, Gemini, email or trades.
//   1. static: the page, script and styles are served; every /api/v2 call in app.js matches a real route;
//      the page keeps the disclaimer and makes no recommendation / partnership / verified-account claims
//   2. the browser journey, call for call as app.js makes it, on an in-memory PGlite database with a mock Gemini:
//      demo user -> two separate onboarding sessions -> explore -> select -> confirm -> draft -> resume ->
//      edit -> confirm -> save -> general chat without news -> news -> evidence -> investigation chat with
//      linked citations -> reopen conversations -> restart -> everything still there
//   3. the original site still works: /, /portfolio.html, /api/stocks, /api/paper/portfolio
require('./test-env');
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vm = require('vm');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thesis-app-test-'));
for (const k of ['ALPACA_DATA_URL', 'ALPACA_KEY_ID', 'ALPACA_PAPER_URL', 'ALPACA_SECRET_KEY', 'COUNCIL_MODE', 'DEMO_SEED', 'FALLBACK_GEMINI_MODEL', 'FINNHUB_KEY',
  'GEMINI_API_KEY', 'GEMINI_BASE_URL', 'GEMINI_MODEL', 'INBOUND_WEBHOOK_SECRET', 'NOTIFY_TO_EMAIL', 'PUBLIC_URL', 'N8N_NOTIFY_WEBHOOK_URL', 'N8N_RUN_WEBHOOK_URL']) process.env[k] = '';
const SECRET = 'app-test-secret';
Object.assign(process.env, { LOOP_DB_FILE: path.join(TMP, 'db.json'), LLM_MIN_GAP_MS: '0', INBOUND_WEBHOOK_SECRET: SECRET, DEMO_SEED: 'false' });

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// mock Gemini: chat answers cite E1 in an investigation; news matching "challenges"; everything else falls back
const gemini = http.createServer((q, r) => {
  let b = ''; q.on('data', (d) => (b += d));
  q.on('end', () => {
    const [sys, user] = JSON.parse(b).messages.map((m) => m.content);
    let content = 'not json';
    if (/research assistant inside THESIS/.test(sys)) {
      content = JSON.stringify(/MODE: investigation/.test(user)
        ? { answer: [{ text: 'The article says cloud customers are delaying orders, which is the kind of news you said would challenge assumption 1.', basis: 'evidence', sources: ['E1'] }], followUps: ['What would show demand recovering?'], insufficientEvidence: false }
        : { answer: [{ text: 'Your thesis says demand for NVIDIA chips keeps growing over your time frame.', basis: 'thesis', sources: [] }], followUps: ['What are the main risks?'], insufficientEvidence: false });
    } else if (/You compare financial news/.test(sys)) {
      const arts = JSON.parse(user.slice(user.lastIndexOf('<<<') + 3, user.lastIndexOf('>>>')));
      content = JSON.stringify({ matches: arts.map((a) => ({ article: a.n, assumptionIndex: 0, relevance: 'direct', stance: 'challenges', whyItMatters: 'It relates directly to the first assumption about demand.' })) });
    }
    r.setHeader('content-type', 'application/json');
    r.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
const emails = [];
const hook = http.createServer((q, r) => { let b = ''; q.on('data', (d) => (b += d)); q.on('end', () => { emails.push(b); r.end('{}'); }); });
const listen = (srv) => new Promise((res) => srv.listen(0, () => res(srv.address().port)));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
let base; let server; let store; let persistence; let pipeline; let connectPglite; let db; const dbDir = path.join(TMP, 'pglite');
async function call(method, p, { user, body } = {}) {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-user-id': user } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers, text };
}
async function restart() {
  await store.flush(); await persistence.close(); store._resetForTests();
  db = await connectPglite(dbDir); await store.init({ db });
}
const ctx = {};

// ======================= 1. static =======================
test('1.1 app.html, app.js and app.css are served; the page keeps the disclaimer and the original site is linked', async () => {
  const page = await call('GET', '/app.html');
  assert.strictEqual(page.status, 200);
  for (const s of ['/app.js', '/app.css', '/styles.css', 'Educational research, not investment advice.', 'THESIS', 'href="/"', 'href="/portfolio.html"']) assert(page.text.includes(s), s);
  const js = await call('GET', '/app.js'); const css = await call('GET', '/app.css');
  assert(js.status === 200 && /javascript/.test(js.headers.get('content-type')) && css.status === 200 && /css/.test(css.headers.get('content-type')));
  new vm.Script(read('public/app.js'), { filename: 'app.js' }); // parses
});

test('1.2 every /api/v2 call in app.js matches a route in server/routes/v2.js', async () => {
  const routes = [...read('server/routes/v2.js').matchAll(/router\.(get|post|patch|put|delete)\('([^']+)'/g)].map(([, m, p]) => [m.toUpperCase(), new RegExp(`^${p.replace(/:[a-z]+/gi, '[^/]+')}$`)]);
  const src = read('public/app.js');
  const calls = [...src.matchAll(/api\('(GET|POST|PATCH|PUT|DELETE)', [`'"]([^`'"]+)[`'"]/g)].map(([, m, p]) => [m, p.replace(/\$\{[^}]+\}/g, 'X')]);
  assert(calls.length >= 12, `found ${calls.length} calls`);
  for (const [m, p] of calls) assert(routes.some(([rm, re]) => rm === m && re.test(p)), `${m} ${p} has no route`);
  assert(/fetch\('\/api\/v2\/users', \{ method: 'POST'/.test(src), 'creates the demo user');
});

test('1.3 wording: no recommendations, no fake verified account, no partnership claim, no buy/sell instruction', async () => {
  const text = read('public/app.js') + read('public/app.html');
  assert(!/verified account/i.test(text), 'no verified-account claim');
  assert(/no partnership/i.test(text) && !/partner(ed|s) with|in partnership/i.test(text), 'Investly only as a clearly hypothetical idea');
  const recs = text.match(/recommendation[s]?/gi) || [];
  assert(recs.length && /not recommendations/i.test(text) && recs.length === (text.match(/not recommendations/gi) || []).length, 'the word appears only as "not recommendations"');
  assert(!/\byou should (buy|sell)\b|\bbuy now\b|\bsell now\b/i.test(text));
  assert(/localStorage/.test(read('public/app.js')) && !/localStorage\.setItem\('(thesis|tier)'/.test(read('public/app.js')), 'only the demo user id is kept in the browser');
});

// ======================= 2. the browser journey =======================
test('2.1 demo user: created without a header, recognized on return, an unknown id answers 401 unknown_user', async () => {
  const u = await call('POST', '/api/v2/users', { body: { displayName: 'Demo user' } });
  assert(u.status === 201 && /^usr_/.test(u.body.userId));
  ctx.user = u.body.userId;
  assert.strictEqual((await call('GET', '/api/v2/users/me', { user: ctx.user })).body.userId, ctx.user);
  const unknown = await call('GET', '/api/v2/theses', { user: 'usr_doesnotexist' });
  assert(unknown.status === 401 && unknown.body.error.code === 'unknown_user', 'app.js replaces the id on this answer');
  assert.deepStrictEqual((await call('GET', '/api/v2/theses', { user: ctx.user })).body, [], 'home: no theses yet');
});

const act = async (sessionId, action, payload = {}, expectedVersion) => {
  const r = await call('POST', '/api/v2/thesis/session', { user: ctx.user, body: { sessionId, action, payload, ...(expectedVersion != null ? { expectedVersion } : {}) } });
  assert(r.status < 300 && r.body.ok, `${action}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
};
const resume = async (sid) => (await call('GET', `/api/v2/thesis/session/${sid}`, { user: ctx.user })).body;

test('2.2 two new theses start two separate onboarding sessions; unfinished ones are listed for Home', async () => {
  const a = await call('POST', '/api/v2/thesis/session', { user: ctx.user, body: { action: 'onboard', payload: { message: 'I want to put $50 a month toward buying a home in about 5 years.' } } });
  const b = await call('POST', '/api/v2/thesis/session', { user: ctx.user, body: { action: 'onboard', payload: { message: 'I want to grow $100 a month for retirement over 25 years.' } } });
  assert(a.status === 201 && b.status === 201 && a.body.sessionId !== b.body.sessionId);
  ctx.sA = a.body.sessionId; ctx.sB = b.body.sessionId;
  const ra = await resume(ctx.sA); const rb = await resume(ctx.sB);
  assert(ra.history.some((m) => /home/.test(m.content)) && !ra.history.some((m) => /retirement/.test(m.content)), 'separate conversations');
  assert(rb.history.some((m) => /retirement/.test(m.content)));
  const list = (await call('GET', '/api/v2/thesis/sessions', { user: ctx.user })).body;
  assert(list.filter((s) => [ctx.sA, ctx.sB].includes(s.sessionId)).every((s) => s.savedThesisId === null), 'both unfinished');
});

test('2.3 create flow: chat -> explore -> select -> confirm -> draft -> resume mid-review -> edit -> confirm -> save', async () => {
  let s = await resume(ctx.sA);
  if (s.stage === 'onboarding') { await act(ctx.sA, 'onboard', { message: 'It is for a home. I am a beginner and medium risk is fine.' }, s.version); s = await resume(ctx.sA); }
  assert(['selecting', 'onboarding'].includes(s.stage), s.stage);
  const ex = await act(ctx.sA, 'explore', {}, s.version);
  const cats = ex.result.categories;
  assert(cats.length && cats.every((c) => c.name && c.plainExplanation) && cats.some((c) => c.assets.some((x) => x.symbol === 'NVDA')), 'explore: plain explanations + assets');
  s = await resume(ctx.sA);
  const sel = await act(ctx.sA, 'selectAssets', { symbols: ['NVDA'] }, s.version);
  assert.strictEqual(sel.stage, 'selection_pending');
  s = await resume(ctx.sA);
  assert.deepStrictEqual(s.selection.pending, ['NVDA']);
  assert.deepStrictEqual(s.selectionAssets.pending, [{ symbol: 'NVDA', name: 'NVIDIA', category: 'large_cap' }], 'expanded for the UI');
  // a stale tab gets 409 and the app reloads
  assert.strictEqual((await call('POST', '/api/v2/thesis/session', { user: ctx.user, body: { sessionId: ctx.sA, action: 'confirmSelection', payload: {}, expectedVersion: s.version - 1 } })).status, 409);
  await act(ctx.sA, 'confirmSelection', {}, s.version);
  s = await resume(ctx.sA);
  assert.strictEqual(s.stage, 'drafting');
  await act(ctx.sA, 'createDraft', {}, s.version);
  // page refresh during review: everything the review cards need comes back from the server
  await restart();
  s = await resume(ctx.sA);
  assert(s.stage === 'reviewing' && s.draft.status === 'proposed' && s.draft.goal && s.draft.budget && s.draft.horizonText, JSON.stringify(s.draft).slice(0, 200));
  assert(s.draft.assumptions.length >= 2 && s.draft.assumptions.every((a) => a.text && a.whatWouldChallengeIt));
  assert.deepStrictEqual(s.draft.selectedAssets.map((x) => x.symbol), ['NVDA']);
  const edited = 'HYPOTHETICAL: demand for NVIDIA data-center chips keeps growing as cloud companies expand.';
  await act(ctx.sA, 'editAssumption', { number: 1, text: edited, keepChallenge: true }, s.version);
  s = await resume(ctx.sA);
  assert.strictEqual(s.draft.assumptions[0].text, edited);
  assert.strictEqual((await call('POST', '/api/v2/theses', { user: ctx.user, body: { sessionId: ctx.sA } })).status, 409, 'not saved without explicit confirmation');
  await act(ctx.sA, 'confirmAssumptions', {}, s.version);
  const saved = await call('POST', '/api/v2/theses', { user: ctx.user, body: { sessionId: ctx.sA } });
  assert.strictEqual(saved.status, 201);
  ctx.A = saved.body.thesisId;
  assert.strictEqual(saved.body.assumptions[0].text, edited);
  assert.strictEqual((await resume(ctx.sA)).savedThesisId, ctx.A, 'Home opens it directly instead of repeating onboarding');
});

test('2.4 a second thesis for the same user, from its own session; Home lists both with activity', async () => {
  let s = await resume(ctx.sB);
  if (s.stage === 'onboarding') { await act(ctx.sB, 'onboard', { message: 'Retirement. I am new to this and prefer lower risk.' }, s.version); s = await resume(ctx.sB); }
  for (const [a, p] of [['selectAssets', { symbols: ['VOO'] }], ['confirmSelection'], ['createDraft'], ['confirmAssumptions']]) { await act(ctx.sB, a, p || {}, s.version); s = await resume(ctx.sB); }
  const saved = await call('POST', '/api/v2/theses', { user: ctx.user, body: { sessionId: ctx.sB } });
  assert.strictEqual(saved.status, 201);
  ctx.B = saved.body.thesisId;
  const list = (await call('GET', '/api/v2/theses', { user: ctx.user })).body;
  assert.deepStrictEqual(list.map((t) => t.thesisId).sort(), [ctx.A, ctx.B].sort());
  assert(list.every((t) => t.assumptionCount >= 2 && t.activity && t.monitoringStatus === 'active'));
});

test('2.5 general chat with no news yet: an answer, saved, reopenable', async () => {
  assert.deepStrictEqual((await call('GET', `/api/v2/theses/${ctx.A}/matches`, { user: ctx.user })).body, [], 'no news yet');
  const c = await call('POST', `/api/v2/theses/${ctx.A}/chat`, { user: ctx.user, body: { message: 'Can you explain my thesis in simple terms?' } });
  assert(c.status === 201 && c.body.mode === 'general' && c.body.reply && c.body.citations.length === 0, JSON.stringify(c.body).slice(0, 300));
  ctx.convG = c.body.conversationId;
  const m = (await call('GET', `/api/v2/conversations/${ctx.convG}/messages`, { user: ctx.user })).body;
  assert(m.messages.length === 2 && m.messages[1].segments.length && m.messages[1].meta.followUps.length, 'segments + follow-ups for the UI');
});

test('2.6 news arrives: evidence per assumption with article, publisher and times; nothing is emailed', async () => {
  const FIX = require('../fixtures/seed.sample.json');
  const art = { headline: 'HYPOTHETICAL: Nvidia says cloud customers are delaying chip orders', source: 'Sample Wire', url: 'https://example.com/hypothetical/nvidia-delays', sentiment: -0.5,
    datetime: '2026-11-14T15:00:00Z', summary: 'HYPOTHETICAL SAMPLE: several large cloud customers are delaying data-center GPU orders, the company said.' };
  const seedBody = { runDate: '2026-11-15', stocks: FIX.stocks.filter((x) => ['NVDA', 'VOO'].includes(x.ticker)).map((x) => ({ ...x, news: x.ticker === 'NVDA' ? [art] : [] })) };
  const r = await fetch(`${base}/api/webhook/seed`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET }, body: JSON.stringify(seedBody) });
  assert.strictEqual(r.status, 200);
  await pipeline.whenIdle();
  const m = (await call('GET', `/api/v2/theses/${ctx.A}/matches`, { user: ctx.user })).body;
  assert(m.length === 1 && m[0].stance === 'challenges' && m[0].assumptionIndex === 0 && m[0].whyItMatters, JSON.stringify(m).slice(0, 300));
  const a = m[0].article;
  assert(a.url === art.url && a.publisher === 'Sample Wire' && a.publishedAt && a.ingestedAt && m[0].assessedAt && a.summary);
  ctx.match = m[0].matchId;
  assert.strictEqual(emails.length, 0, 'no email (no webhook configured)');
});

test('2.7 investigate an article: citations link to the stored match + article; the conversation reopens with its article', async () => {
  const c = await call('POST', `/api/v2/theses/${ctx.A}/chat`, { user: ctx.user, body: { message: 'What does this article mean for my thesis?', matchId: ctx.match } });
  assert(c.status === 201 && c.body.mode === 'investigation', JSON.stringify(c.body).slice(0, 300));
  const cit = c.body.citations[0];
  assert(cit && cit.url === 'https://example.com/hypothetical/nvidia-delays' && cit.matchId === ctx.match && cit.articleId, JSON.stringify(c.body.citations));
  assert(c.body.segments.some((s) => s.citations.includes(1)), 'a segment points at [1]');
  ctx.convI = c.body.conversationId;
  const again = await call('POST', `/api/v2/theses/${ctx.A}/chat`, { user: ctx.user, body: { message: 'What would show demand recovering?', conversationId: ctx.convI } });
  assert.strictEqual(again.status, 200);
  const convs = (await call('GET', `/api/v2/theses/${ctx.A}/conversations`, { user: ctx.user })).body;
  assert.deepStrictEqual(convs.map((x) => x.conversationId).sort(), [ctx.convG, ctx.convI].sort());
  assert.deepStrictEqual((await call('GET', `/api/v2/theses/${ctx.B}/conversations`, { user: ctx.user })).body, [], 'the other thesis has its own (empty) chats');
});

test('2.8 backend restart: theses, sessions, evidence, conversations and citations all come back', async () => {
  await restart();
  const list = (await call('GET', '/api/v2/theses', { user: ctx.user })).body;
  assert.strictEqual(list.length, 2);
  const a = list.find((t) => t.thesisId === ctx.A);
  assert(a.activity.matches === 1 && a.activity.challenges === 1 && a.activity.conversations === 2 && a.activity.lastActivityAt);
  const m = (await call('GET', `/api/v2/conversations/${ctx.convI}/messages`, { user: ctx.user })).body;
  assert(m.mode === 'investigation' && m.match.matchId === ctx.match && m.match.article.url && m.messages.length === 4);
  assert(m.messages.map((x) => x.seq).join() === '1,2,3,4' && m.messages[1].citations[0].matchId === ctx.match);
  const n = (await call('GET', `/api/v2/theses/${ctx.A}/notifications`, { user: ctx.user })).body;
  assert(n.length === 1 && n[0].status === 'skipped', 'the challenge is recorded as an alert, not emailed');
  const p = await call('PATCH', `/api/v2/theses/${ctx.A}`, { user: ctx.user, body: { monitoringStatus: 'paused' } });
  assert(p.status === 200 && (await call('GET', `/api/v2/theses/${ctx.A}`, { user: ctx.user })).body.monitoringStatus === 'paused');
});

test('2.9 regression: the "$5 every day" car conversation is saved as daily, reaches "selecting", and Explore works', async () => {
  const start = await call('POST', '/api/v2/thesis/session', { user: ctx.user, body: { action: 'onboard', payload: { message: 'i want to put in 5 dollar every day' } } });
  const sid = start.body.sessionId;
  for (const m of ['for a car', '1 year', 'nope', 'not good', 'yep']) { const s0 = await resume(sid); await act(sid, 'onboard', { message: m }, s0.version); }
  const s = await resume(sid);
  assert.strictEqual(s.stage, 'selecting', `stage ${s.stage}`);
  assert.deepStrictEqual([s.profile.amount, s.profile.cadence, s.profile.timelineYears, s.profile.riskComfort, s.profile.experience], [5, 'daily', 1, 'low', null]);
  assert(s.history.length === 12 && s.history[0].content === 'i want to put in 5 dollar every day', 'every message saved in order');
  const e = await act(sid, 'explore', {}, s.version);
  assert(e.stage === 'selecting' && e.result.categories[0].id === 'cash_like' && e.result.categories[0].selectable === false);
  const after = await resume(sid);
  assert.deepStrictEqual(after.selection, { pending: [], confirmed: [] }, 'exploring selects nothing');
  assert.strictEqual(after.history.length, 12, 'history unchanged');
  // the app shows "$5 every day" from the saved profile
  assert(/daily: 'every day'/.test(read('public/app.js')));
});

test('2.10 partial onboarding over the API: only a goal, Explore right away, still at step 1, nothing selected', async () => {
  const start = await call('POST', '/api/v2/thesis/session', { user: ctx.user, body: { action: 'onboard', payload: { message: 'I want to save for a car.' } } });
  const sid = start.body.sessionId;
  let s = await resume(sid);
  assert.strictEqual(s.stage, 'onboarding');
  const e = await act(sid, 'explore', {}, s.version);
  assert(e.stage === 'onboarding' && e.result.categories.length > 3, 'explore works with an incomplete profile');
  s = await resume(sid);
  assert(s.stage === 'onboarding' && s.nextActions.includes('selectAssets') && s.nextActions.includes('onboard'));
  assert.deepStrictEqual(s.selection, { pending: [], confirmed: [] });
  assert.strictEqual((await call('GET', '/api/v2/thesis/sessions', { user: ctx.user })).body.find((x) => x.sessionId === sid).savedThesisId, null, 'listed as unfinished');
});

// ======================= 3. the original site =======================
test('3.1 the original site and Taha\'s features still work alongside', async () => {
  for (const p of ['/', '/index.html', '/portfolio.html', '/thesis.html', '/feed.js', '/styles.css', '/portfolio.js']) assert.strictEqual((await call('GET', p)).status, 200, p);
  assert((await call('GET', '/')).text.includes('/feed.js'), 'the homepage is still Anne\'s page');
  const feed = await call('GET', '/api/stocks?tier=low');
  assert(feed.status === 200 && Array.isArray(feed.body) && feed.body.length && feed.body.every((r) => r.ticker && r.scoreBreakdown && Number.isFinite(r.matchScore)));
  const pf = await call('GET', '/api/paper/portfolio');
  assert(pf.status === 200 && Array.isArray(pf.body.positions) && Array.isArray(pf.body.trades) && pf.headers.get('x-data-source'));
});

(async () => {
  const gPort = await listen(gemini); const hPort = await listen(hook);
  Object.assign(process.env, { GEMINI_API_KEY: 'test-key', GEMINI_BASE_URL: `http://127.0.0.1:${gPort}/`, GEMINI_MODEL: 'mock-model' });
  void hPort; // no N8N_NOTIFY_WEBHOOK_URL: alerts are recorded, never emailed
  store = require('../server/store');
  persistence = require('../server/persistence');
  pipeline = require('../server/pipeline');
  ({ connectPglite } = require('../server/persistence/db'));
  db = await connectPglite(dbDir);
  await store.init({ db });
  const app = require('../server/index');
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS  ${name}`); } catch (err) { failed++; console.log(`FAIL  ${name}\n      ${String(err.stack).split('\n').slice(0, 14).join('\n      ')}`); }
  }
  await pipeline.whenIdle();
  server.close(); gemini.close(); hook.close();
  await store.flush(); await persistence.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failed ? `${failed}/${tests.length} app tests FAILED` : `${tests.length}/${tests.length} app tests passed`);
  process.exit(failed ? 1 : 0);
})();

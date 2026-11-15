// Local verification of THESIS persistence through the real /api/v2 routes, with HYPOTHETICAL data only.
//   npm run demo:persistence                          throwaway PGlite database (in-process PostgreSQL), offline
//   npm run demo:persistence -- --use-database-url    the database in DATABASE_URL (e.g. TigerData). Writes
//                                                      hypothetical demo rows there; only run it if you mean to.
// No Gemini calls (AI steps use the offline fallbacks), no email, no trades.
//
// 1 create a user  2 start + save onboarding  3 resume it  4 save two confirmed theses
// 5 store a news article and its matching assessments  6 two independent chat conversations
// 7 messages with source citations  8 reload everything through a NEW storage connection  9 print ids + times
const fs = require('fs');
const os = require('os');
const path = require('path');

const useDatabaseUrl = process.argv.includes('--use-database-url');
if (useDatabaseUrl) require('dotenv').config(); // only to read DATABASE_URL
// Never call Gemini, email or trade from this script, whatever the .env holds (dotenv won't override '').
for (const k of ['GEMINI_API_KEY', 'N8N_NOTIFY_WEBHOOK_URL', 'NOTIFY_TO_EMAIL', 'ALPACA_KEY_ID', 'ALPACA_SECRET_KEY', 'FINNHUB_KEY', 'N8N_RUN_WEBHOOK_URL']) process.env[k] = '';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thesis-demo-'));
Object.assign(process.env, { INBOUND_WEBHOOK_SECRET: `demo-${Date.now()}`, LLM_MIN_GAP_MS: '0', LOOP_DB: useDatabaseUrl ? 'postgres' : 'pglite', LOOP_PGLITE_DIR: path.join(dir, 'pglite'), LOOP_DB_FILE: path.join(dir, 'db.json'), DEMO_SEED: 'false' });
if (!useDatabaseUrl) process.env.DATABASE_URL = '';

const store = require('../server/store');
const persistence = require('../server/persistence');
const repo = require('../server/persistence/repo');
const pipeline = require('../server/pipeline');
const app = require('../server/index');

const tty = process.stdout.isTTY;
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
let base;
let server;
async function api(method, p, user, body) {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-user-id': user } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (res.status >= 400) throw new Error(`${method} ${p} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}
async function boot() {
  await store.init();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
}
async function shutdown() {
  await new Promise((r) => server.close(r));
  await store.flush();
  await persistence.close();
  store._resetForTests();
}
const step = (n, text) => console.log(`\n${bold(`${n}.`)} ${text}`);

async function main() {
  console.log(bold('THESIS persistence demo') + dim(`  ·  ${useDatabaseUrl ? 'database: DATABASE_URL (LOOP_DB=postgres)' : 'database: throwaway PGlite'}  ·  hypothetical data  ·  Educational research, not investment advice.`));
  await boot();

  step(1, 'Create a user');
  const user = (await api('POST', '/api/v2/users', null, { displayName: 'Hypothetical Demo User', preferences: { tier: 'low' } })).userId;
  console.log(`   user ${user}`);

  step(2, 'Start onboarding (saved by the server after every action)');
  const say = (sessionId, action, payload) => api('POST', '/api/v2/thesis/session', user, { sessionId, action, payload });
  let r = await say(null, 'onboard', { message: 'I want to invest $50 a month for 5 years, beginner, medium risk.' });
  const s1 = r.sessionId;
  r = await say(s1, 'onboard', { message: 'It is for buying a home.' });
  console.log(`   session ${s1} · version ${r.version} · stage ${r.stage}`);

  step(3, 'Resume the same session (as if the user came back later)');
  const resumed = await api('GET', `/api/v2/thesis/session/${s1}`, user);
  console.log(`   stage ${resumed.stage} · version ${resumed.version} · ${resumed.history.length} chat turns · profile amount $${resumed.profile.amount} ${resumed.profile.cadence}`);

  step(4, 'Save two confirmed theses');
  const finish = async (sessionId, symbols, edit) => {
    for (const [a, p] of [['selectAssets', { symbols }], ['confirmSelection'], ['createDraft'], ...(edit ? [['editAssumption', edit]] : []), ['confirmAssumptions']]) await say(sessionId, a, p || {});
    return api('POST', '/api/v2/theses', user, { sessionId });
  };
  const A = await finish(s1, 'NVDA', { number: 1, text: 'HYPOTHETICAL edit: demand for NVIDIA data-center chips keeps growing as cloud companies expand AI infrastructure.',
    challenge: 'NVIDIA lowering guidance, or cloud customers delaying or cutting chip orders.' });
  const sv = await api('GET', `/api/v2/thesis/session/${s1}`, user);
  console.log(`   assumption 1 edited before confirming · session ${s1} now version ${sv.version}, stage ${sv.stage}`);
  const s2 = (await say(null, 'onboard', { message: 'I want to invest $50 a month for 5 years, beginner, medium risk.' })).sessionId;
  await say(s2, 'onboard', { message: 'It is for buying a home.' });
  const B = await finish(s2, 'NVDA, VOO');
  for (const t of [A, B]) console.log(`   thesis ${t.thesisId} · ${t.selectedAssets.map((a) => a.symbol).join(', ')} · confirmed ${t.confirmedAt} · ${t.assumptions.length} assumptions with challenge criteria`);

  step(5, 'Ingest news through the real n8n seed route, twice (the same batch re-sent), and match it to every thesis');
  const db = persistence.getDb();
  const article = { headline: 'HYPOTHETICAL: Nvidia says cloud customers are delaying chip orders', source: 'Sample Wire (hypothetical)',
    url: 'https://example.com/hypothetical/nvidia-delays', datetime: '2026-11-14T15:00:00Z', sentiment: -0.4,
    summary: 'HYPOTHETICAL SAMPLE: several large cloud customers are delaying data-center GPU orders, the company said.' };
  const stock = (ticker, companyName, category, price, news, extra = {}) => ({ ticker, companyName, category, price, beta: 1.1, dividendYieldPct: 0.5, priceChange5dPct: 1.2,
    avgVolume: 40000000, usListed: true, merPct: null, peRatio: null, marketCapB: null, insider: { count: 0, execBuyer: false, totalUsd: 0 }, news, ...extra });
  const seedBody = { runDate: '2026-11-15', stocks: [
    stock('NVDA', 'NVIDIA Corp (hypothetical seed)', 'large_cap', 140.1, [article], { peRatio: 50, marketCapB: 3400 }),
    stock('VOO', 'Vanguard S&P 500 ETF (hypothetical seed)', 'index_etf', 512.4, [], { merPct: 0.03 }) ] };
  for (const pass of [1, 2]) {
    const res = await fetch(`${base}/api/webhook/seed`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': process.env.INBOUND_WEBHOOK_SECRET }, body: JSON.stringify(seedBody) });
    const out = await res.json();
    if (!res.ok) throw new Error(`seed -> ${res.status} ${JSON.stringify(out)}`);
    await pipeline.whenIdle(); // the unchanged news matching runs in the background after a seed
    const [{ n, seen }] = (await db.query('SELECT count(*)::int AS n, max(seen_count)::int AS seen FROM news_articles WHERE url = $1', [article.url])).rows;
    console.log(`   seed pass ${pass}: accepted ${out.accepted} · stored copies of the article: ${n} (seen ${seen}x)`);
  }
  const articleId = (await db.query('SELECT article_id FROM news_articles WHERE url = $1', [article.url])).rows[0].article_id;
  const matchIds = {};
  for (const t of [A, B]) {
    const m = await api('GET', `/api/v2/theses/${t.thesisId}/matches`, user);
    const mine = m.find((x) => x.articleId === articleId);
    if (!mine) throw new Error(`no stored match for thesis ${t.thesisId}`);
    matchIds[t.thesisId] = mine.matchId;
    const notes = await api('GET', `/api/v2/theses/${t.thesisId}/notifications`, user);
    console.log(`   thesis ${t.thesisId}: ${m.length} match(es), this one ${mine.stance} (A${mine.assumptionIndex + 1}) assessed ${mine.assessedAt} · notifications: ${notes.length ? notes.map((x) => x.status).join(', ') : 'none'}`);
  }
  console.log(`   article ${articleId} · matches ${Object.values(matchIds).join(', ')}`);

  step(6, 'Two independent chat conversations (general on thesis 1, investigation on thesis 2)');
  const g = await api('POST', `/api/v2/theses/${A.thesisId}/chat`, user, { message: 'Can you explain my thesis in simple terms?' });
  const inv = await api('POST', `/api/v2/theses/${B.thesisId}/chat`, user, { message: 'Why does this article matter to me?', matchId: matchIds[B.thesisId] });
  await api('POST', `/api/v2/theses/${B.thesisId}/chat`, user, { message: 'How significant is it?', conversationId: inv.conversationId });
  console.log(`   ${g.conversationId} (general, thesis 1) · ${inv.conversationId} (investigation, thesis 2)`);

  step(7, 'Messages keep their source citations, linked by id to the stored evidence and article');
  console.log(`   assistant cited: ${inv.citations.map((c) => `[${c.id}] ${c.title} · ${c.url} · match ${c.matchId} · article ${c.articleId}`).join(' | ')}`);

  step(8, 'Reload everything through a NEW storage connection');
  await shutdown();
  await boot();
  const theses = await api('GET', '/api/v2/theses', user);
  const msgs = await api('GET', `/api/v2/conversations/${inv.conversationId}/messages`, user);
  console.log(`   ${theses.length} theses · investigation reopened on match ${msgs.matchId} (${msgs.match.article.headline}) · ${msgs.messages.length} messages`);
  for (const m of msgs.messages) console.log(`   #${m.seq} ${m.role} ${m.createdAt}${m.citations.length ? ` cites match ${m.citations[0].matchId} / article ${m.citations[0].articleId}` : ''}`);
  console.log(`   ids to inspect: user ${user} · theses ${A.thesisId}, ${B.thesisId} · conversations ${g.conversationId}, ${inv.conversationId}`);

  step(9, 'Related records with their ids and timestamps (thesis 2 timeline)');
  const tl = await api('GET', `/api/v2/theses/${B.thesisId}/timeline`, user);
  for (const e of tl.events) {
    const id = e.messageId || e.matchId || e.articleId || e.thesisId || e.sessionId || '';
    const what = e.type === 'session_action' ? `${e.action}${e.payload && e.payload.message ? `: "${e.payload.message}"` : e.payload && e.payload.symbols ? `: ${e.payload.symbols}` : ''}`
      : e.type === 'chat_message' ? `${e.role}: ${e.text.slice(0, 70)}${e.text.length > 70 ? '...' : ''}${e.citations ? ` (${e.citations} citation)` : ''}` : e.type;
    console.log(`   ${e.at}  ${what.padEnd(e.type === 'chat_message' || e.type === 'session_action' ? 0 : 22)} ${dim(id)}`);
  }
  await shutdown();
  if (!useDatabaseUrl) fs.rmSync(dir, { recursive: true, force: true });
  console.log(dim(`\nDone. ${useDatabaseUrl ? 'Hypothetical demo rows were written to the DATABASE_URL database.' : 'The throwaway database was deleted.'} No Gemini calls, emails or trades were made.`));
}

main().catch(async (err) => {
  console.error(`demo failed: ${persistence.redact(err.message)}`);
  try { if (server) server.close(); await persistence.close(); } catch { /* already closed */ }
  process.exit(1);
});

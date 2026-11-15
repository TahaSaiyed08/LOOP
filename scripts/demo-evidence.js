// Prepared real-news demo: one shared snapshot of real articles, evaluated by the EXISTING matcher against two
// contrasting theses. Scenario A is pre-saved here; Scenario B is created live in the browser and matched on
// save (server/pipeline.js matchStoredFeedFor -> prepared snapshot, demo user only).
//
//   npm run demo:dry-run      build A and B in memory, run matchNewsDetailed (real Gemini), print the matrix. Writes nothing.
//   npm run demo:prepare      demo user + snapshot + Scenario A + A's evidence (idempotent)
//   npm run demo:verify       read-only: snapshot, demo theses, evidence matrix side by side, notifications
//   npm run demo:reset-b -- <thesisId|sessionId> ...   remove exactly these Scenario B recording attempts
//   npm run demo:reset        remove the demo user's records and the snapshot (other users untouched)
//   npm run demo:unload       remove only the snapshot key
//
// Safety: TigerData schema thesis_dev only (never public), never in tests, no credentials printed, no n8n,
// no email (challenges get a "skipped" notification record), and the live Feed is never touched.
require('dotenv').config();
const path = require('path');

const DATA = require('./demo/same-news-scenarios.json');
const cmd = require.main === module ? process.argv[2] : null;
const args = process.argv.slice(3);
const DRY = cmd === 'dry-run';

function guard() {
  if (process.env.LOOP_TEST === '1') throw new Error('demo-evidence refuses to run inside tests (LOOP_TEST=1).');
  if (DRY) return;
  if (String(process.env.LOOP_DB || '').trim().toLowerCase() !== 'postgres') throw new Error('Needs LOOP_DB=postgres (use the npm demo:* scripts).');
  const schema = String(process.env.PGSCHEMA || '').trim();
  if (schema !== 'thesis_dev') throw new Error(`Refusing schema "${schema || '(none)'}": demo data goes only to thesis_dev.`);
}

const T = require('../server/thesis');
const nulls = { amount: null, cadence: null, timelineYears: null, currency: null, experience: null, riskComfort: null, purpose: null };

// The snapshot in the n8n seed shape (Contract A news items), so the normal pipeline can read it.
function snapshotPayload() {
  const by = new Map();
  for (const a of DATA.articles) {
    if (!by.has(a.ticker)) by.set(a.ticker, []);
    by.get(a.ticker).push({ headline: a.headline, source: a.source, url: a.url, datetime: a.datetime, summary: a.summary, sentiment: null });
  }
  return { runDate: DATA.runDate, stocks: [...by].map(([ticker, news]) => ({ ticker, news })) };
}
const matcherNews = () => snapshotPayload().stocks.flatMap((s) => s.news.map((n) => ({ ticker: s.ticker, ...n })));

// A confirmed thesis through the real engine: profile -> select -> draft (offline template) -> the user's own
// wording for every idea -> confirm. Returns the persistable session and the confirmed thesis.
async function buildScenario(sc, profile) {
  let s = T.createOnboardingSession();
  s.profile = { ...nulls, ...profile };
  let r = T.selectAssets(sc.symbols, s); if (!r.ok) throw new Error(`select: ${r.displayText}`); s = r.session;
  r = T.confirmSelection(s); if (!r.ok) throw new Error(`confirm selection: ${r.displayText}`); s = r.session;
  r = await T.createThesisDraft(s, { forceFallback: true }); if (!r.ok) throw new Error(`draft: ${r.displayText}`); s = r.session;
  const count = () => T.viewAssumptions(s).assumptions.length;
  while (count() < sc.assumptions.length) { r = T.addAssumption(s, sc.assumptions[count()].text, sc.assumptions[count()].challenge); if (!r.ok) throw new Error(`add: ${r.displayText}`); s = r.session; }
  sc.assumptions.forEach((a, i) => { r = T.editAssumption(s, i + 1, a.text, a.challenge); if (!r.ok) throw new Error(`edit ${i + 1}: ${r.displayText}`); s = r.session; });
  while (count() > sc.assumptions.length) { r = T.removeAssumption(s, count()); if (!r.ok) throw new Error(`remove: ${r.displayText}`); s = r.session; }
  r = T.confirmAssumptions(s); if (!r.ok) throw new Error(`confirm: ${r.displayText}`); s = r.session;
  const thesis = T.getConfirmedThesis(s);
  for (const [i, a] of sc.assumptions.entries()) if (!(thesis.assumptionDetails[i].tickers || []).includes(a.ticker)) throw new Error(`assumption ${i + 1} is not linked to ${a.ticker}`);
  return { session: s, thesis };
}

const short = (x, n = 150) => (x || '').replace(/\s+/g, ' ').slice(0, n);
function printMatrix(cols) { // cols: [{ name, matches: [{ headline, ticker, stance, assumptionIndex, whyItMatters }] }]
  for (const a of DATA.articles) {
    console.log(`\n• [${a.ticker}] ${a.headline}\n  ${a.source} · ${a.datetime.slice(0, 10)} · ${a.kind}`);
    for (const c of cols) {
      const m = c.matches.find((x) => x.headline === a.headline);
      console.log(m ? `  ${c.name}: ${m.stance.toUpperCase()} (assumption ${m.assumptionIndex + 1}${m.relevance ? `, ${m.relevance}` : ''}) - ${short(m.whyItMatters)}` : `  ${c.name}: not linked to this thesis`);
    }
  }
}

async function dryRun() {
  const A = await buildScenario(DATA.scenarios.A, DATA.scenarios.A.profile);
  const B = await buildScenario(DATA.scenarios.B, { ...DATA.scenarios.A.profile, timelineYears: 3, amount: 50, purpose: 'learn whether AI spending is cooling' });
  const news = matcherNews();
  const cols = [];
  for (const [name, x] of [['A', A], ['B', B]]) {
    const { matches, stats } = await T.matchNewsDetailed(x.thesis, news);
    console.log(`Scenario ${name}: ${matches.length} matches, analyzed by ${stats.analyzedBy}${stats.fallbackReason ? ` (${stats.fallbackReason})` : ''}, skipped unrelated: ${stats.skippedUnrelated}`);
    cols.push({ name, matches });
  }
  printMatrix(cols);
  console.log('\nDry run: nothing was written.');
}

// Idempotent: demo user, snapshot key, Scenario A (reused by its demo id), then the snapshot matched for A.
async function prepareScenarioA(db, repo, pipeline) {
  const USER = pipeline.DEMO_EVIDENCE_USER;
  await db.query(`INSERT INTO users (user_id, display_name, preferences) VALUES ($1, 'THESIS demo', '{"demo":"same-news"}'::jsonb) ON CONFLICT (user_id) DO NOTHING`, [USER]);
  await db.query(`INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [pipeline.PREPARED_KEY, JSON.stringify({ label: DATA.label, provenance: DATA.provenance, verifiedAt: DATA.verifiedAt, payload: snapshotPayload() })]);
  let row = await repo.legacyThesisRow(db, USER, DATA.scenarios.A.id);
  const created = !row;
  if (!row) {
    const { session, thesis } = await buildScenario(DATA.scenarios.A, DATA.scenarios.A.profile);
    const saved = await T.handleThesisAction(session, 'getConfirmedThesis', {});
    const ses = await repo.createSession(db, USER, { state: saved.session, version: saved.version, stage: saved.stage, nextActions: saved.nextActions, displayText: 'Scenario A (prepared for the demo)' },
      { action: 'demoPrepare', payload: { scenario: 'A' }, ok: true });
    row = (await repo.createThesis(db, USER, { ...thesis, demo: { scenario: 'A', label: DATA.label } }, { origin: 'session', sessionId: ses.session_id, legacyId: DATA.scenarios.A.id })).row;
  }
  const out = await pipeline.matchPreparedNews(row.thesis_id);
  if (out && out.error) throw new Error(out.error);
  return { row, created, out };
}

async function main() {
  guard();
  if (DRY) return dryRun();
  const persistence = require('../server/persistence');
  const repo = require('../server/persistence/repo');
  const pipeline = require('../server/pipeline');
  await persistence.init();
  const db = persistence.getDb();
  const USER = pipeline.DEMO_EVIDENCE_USER;
  const A_ID = DATA.scenarios.A.id;
  const demoUrls = DATA.articles.map((a) => a.url);
  const thesesOfDemo = async () => (await db.query(`SELECT thesis_id, legacy_id, session_id, goal, created_at FROM theses WHERE user_id = $1 ORDER BY created_at`, [USER])).rows;
  const matrixFor = async (thesisId) => (await db.query(`SELECT m.stance, m.assumption_index, m.relevance, m.why_it_matters, a.headline, a.ticker
    FROM thesis_matches m JOIN news_articles a ON a.article_id = m.article_id WHERE m.thesis_id = $1`, [thesisId])).rows
    .map((r) => ({ stance: r.stance, assumptionIndex: r.assumption_index, relevance: r.relevance, whyItMatters: r.why_it_matters, headline: r.headline, ticker: r.ticker }));
  const base = `http://localhost:${process.env.DEMO_PORT || 3001}/app.html?user=${USER}`;

  try {
    if (cmd === 'prepare') {
      const { row, created, out } = await prepareScenarioA(db, repo, pipeline);
      console.log(`Scenario A ${created ? 'saved' : 'already saved (reused)'}: ${row.thesis_id}`);
      console.log(`Matched the snapshot: ${out.matches || 0} new match(es) this run (0 on a rerun is expected).`);
      printMatrix([{ name: 'A', matches: await matrixFor(row.thesis_id) }]);
      console.log(`\nOpen Scenario A: ${base}#/thesis/${row.thesis_id}/evidence`);
    } else if (cmd === 'verify') {
      const snap = await repo.getKvFresh(db, pipeline.PREPARED_KEY);
      console.log(`snapshot: ${snap ? `${snap.payload.stocks.reduce((n, s) => n + s.news.length, 0)} articles (${snap.label})` : 'NOT loaded'}`);
      const arts = (await db.query(`SELECT article_id, url FROM news_articles WHERE url = ANY($1::text[])`, [demoUrls])).rows;
      console.log(`articles stored once each: ${arts.length}/${demoUrls.length} ${arts.length === new Set(arts.map((a) => a.url)).size ? 'no duplicates' : 'DUPLICATES'}`);
      const bad = arts.filter((a) => !/^https:\/\//.test(a.url) || /example\.(com|org|net)/.test(a.url));
      console.log(`article links: ${bad.length ? `${bad.length} INVALID` : 'all real https links'}`);
      const ts = await thesesOfDemo();
      const cols = [];
      for (const t of ts) {
        const kind = t.legacy_id === A_ID ? 'A (prepared)' : 'B or other attempt';
        console.log(`thesis ${t.thesis_id} [${kind}] session=${t.session_id} created=${t.created_at.toISOString()}\n  goal: ${t.goal}`);
        cols.push({ name: t.legacy_id === A_ID ? 'A' : `B ${t.thesis_id.slice(0, 11)}`, matches: await matrixFor(t.thesis_id) });
      }
      const open = (await db.query(`SELECT s.session_id, s.stage, s.updated_at FROM onboarding_sessions s WHERE s.user_id = $1 AND NOT EXISTS (SELECT 1 FROM theses t WHERE t.session_id = s.session_id) ORDER BY s.updated_at`, [USER])).rows;
      for (const s of open) console.log(`unsaved session ${s.session_id} stage=${s.stage} updated=${s.updated_at.toISOString()}`);
      const n = (await db.query(`SELECT status, count(*)::int AS c FROM notifications WHERE user_id = $1 GROUP BY status`, [USER])).rows;
      console.log(`demo notifications: ${n.map((r) => `${r.status}=${r.c}`).join(', ') || 'none'} ${n.some((r) => r.status === 'sent') ? '(SENT FOUND!)' : '(none emailed)'}`);
      printMatrix(cols);
      const a = ts.find((t) => t.legacy_id === A_ID);
      if (a) console.log(`\nOpen Scenario A: ${base}#/thesis/${a.thesis_id}/evidence\nStart Scenario B: ${base}#/new`);
    } else if (cmd === 'reset-b') {
      if (!args.length) throw new Error('Name the exact Scenario B thesis or session ids to remove (see npm run demo:verify).');
      for (const id of args) {
        if (/^th_/.test(id)) {
          const { rows } = await db.query('SELECT thesis_id, legacy_id, session_id FROM theses WHERE thesis_id = $1 AND user_id = $2', [id, USER]);
          if (!rows[0]) { console.log(`${id}: not a demo-user thesis, skipped`); continue; }
          if (rows[0].legacy_id === A_ID) { console.log(`${id}: this is Scenario A, kept`); continue; }
          await db.transaction(async (tx) => {
            await tx.query('DELETE FROM theses WHERE thesis_id = $1 AND user_id = $2', [id, USER]); // cascades: matches, checks, notifications, chats
            if (rows[0].session_id) await tx.query('DELETE FROM onboarding_sessions WHERE session_id = $1 AND user_id = $2', [rows[0].session_id, USER]);
          });
          console.log(`${id}: removed (with its session, evidence, notifications and chats)`);
        } else if (/^ses_/.test(id)) {
          const { rows } = await db.query(`SELECT s.session_id FROM onboarding_sessions s WHERE s.session_id = $1 AND s.user_id = $2
            AND NOT EXISTS (SELECT 1 FROM theses t WHERE t.session_id = s.session_id)`, [id, USER]);
          if (!rows[0]) { console.log(`${id}: not an unsaved demo-user session, skipped`); continue; }
          await db.query('DELETE FROM onboarding_sessions WHERE session_id = $1 AND user_id = $2', [id, USER]);
          console.log(`${id}: unsaved session removed`);
        } else console.log(`${id}: not a thesis (th_…) or session (ses_…) id, skipped`);
      }
    } else if (cmd === 'reset' || cmd === 'unload') {
      await db.query('DELETE FROM kv_store WHERE key = $1', [pipeline.PREPARED_KEY]);
      console.log('snapshot removed');
      if (cmd === 'reset') {
        await db.transaction(async (tx) => {
          const t = await tx.query('DELETE FROM theses WHERE user_id = $1', [USER]);
          const s = await tx.query('DELETE FROM onboarding_sessions WHERE user_id = $1', [USER]);
          // snapshot articles that no other thesis still refers to
          const a = await tx.query(`DELETE FROM news_articles a WHERE a.url = ANY($1::text[])
            AND NOT EXISTS (SELECT 1 FROM thesis_matches m WHERE m.article_id = a.article_id)
            AND NOT EXISTS (SELECT 1 FROM thesis_article_checks c WHERE c.article_id = a.article_id)`, [demoUrls]);
          console.log(`demo user: ${t.rowCount} thesis(es), ${s.rowCount} session(s) removed; ${a.rowCount} unreferenced snapshot article(s) removed`);
        });
      }
    } else {
      throw new Error('Usage: node scripts/demo-evidence.js dry-run|prepare|verify|reset-b <ids>|reset|unload');
    }
  } finally {
    await persistence.close();
  }
}

if (require.main === module) main().catch((err) => {
  let msg = String(err && err.message);
  try { msg = require('../server/persistence').redact(msg); } catch { /* */ }
  console.error(`demo-evidence: ${msg}`);
  process.exit(1);
});
module.exports = { snapshotPayload, buildScenario, prepareScenarioA, guard, DATA, path };

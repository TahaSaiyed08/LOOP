// LOOP backend entry. Only Taha edits this file.
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const llm = require('./llm');
const alpaca = require('./alpaca');
const paper = require('./paper');
const crypto = require('crypto');
const store = require('./store');
const feedLib = require('./feed');
const thesisEngine = require('./thesis');
const pipeline = require('./pipeline');
const sentiment = require('./sentiment');
const { TIERS } = require('./scoring');
const persistence = require('./persistence');
const repo = require('./persistence/repo');
const { requestTracker, createShutdown } = require('./shutdown');

const app = express();
const tracker = requestTracker(); // first: graceful shutdown waits for every request still in progress
app.use(tracker.middleware);
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (req, res) => {
  const feed = store.get('feed');
  res.json({
    ok: true,
    llmConfigured: llm.isConfigured(),
    alpacaConfigured: alpaca.hasCredentials(),
    thesisIsStub: Boolean(thesisEngine.IS_STUB),
    feedRunDate: feed ? feed.runDate : null,
    feedReceivedAt: feed ? feed.receivedAt : null,
    sentimentMissing: feed ? feedLib.sentimentMissing(feed.stocks) : null,
    storage: store.health(), // { backend: json|postgres|pglite, relational, pendingWrites?, lastError? }
  });
});

function warnIfNoSentiment(payload, where) {
  if (feedLib.sentimentMissing(payload.stocks)) {
    console.warn(`[WARNING] ${where}: news sentiment is null for EVERY ticker. The news component (up to 20% of each score) is a constant. Do not demo this feed.`);
  }
}

// Contract A: n8n -> backend. Header x-webhook-secret must equal INBOUND_WEBHOOK_SECRET.
function secretOk(req) {
  const want = process.env.INBOUND_WEBHOOK_SECRET;
  const got = req.get('x-webhook-secret');
  if (!want || !got) return false;
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post('/api/webhook/seed', async (req, res) => {
  if (!process.env.INBOUND_WEBHOOK_SECRET) return res.status(503).json({ error: 'INBOUND_WEBHOOK_SECRET is not configured on the server' });
  if (!secretOk(req)) return res.status(401).json({ error: 'bad or missing x-webhook-secret' });
  let clean;
  try { clean = feedLib.validateSeed(req.body); }
  catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  if (!clean.stocks.length) return res.status(400).json({ error: 'no valid stocks in payload', rejected: clean.rejected });

  const sent = await sentiment.applySentiment(clean.stocks); // before storing, so scoring always sees it
  if (persistence.isEnabled()) { // database mode: keep every article (deduplicated) before accepting the feed
    try { await repo.upsertArticles(persistence.getDb(), clean.stocks.flatMap((st) => (st.news || []).map((n) => ({ ticker: st.ticker, ...n }))), { runDate: clean.runDate }); }
    catch (err) { console.error('[seed] could not save news articles:', persistence.redact(err.message)); return res.status(503).json({ error: 'storage unavailable; the seed was not saved, please retry' }); }
  }
  store.set('feed', { runDate: clean.runDate, receivedAt: new Date().toISOString(), stocks: clean.stocks });
  warnIfNoSentiment(clean, `seed ${clean.runDate}`);
  console.log(`[seed] ${clean.runDate}: accepted ${clean.stocks.length}, rejected ${clean.rejected.length}, sentiment scored ${sent.scored} cached ${sent.cached}${sent.failed ? ' (FAILED)' : ''}`);
  pipeline.refreshThesisMatches(); // background: match news to the saved thesis, maybe email
  pipeline.refreshCouncil(); // background: bull/bear/verdict text per stock; never affects ranking
  res.json({ ok: true, runDate: clean.runDate, accepted: clean.stocks.length, rejected: clean.rejected, sentiment: sent });
});

// Contract B: the ranked feed. Serves fixtures (X-Data-Source: fixture) until a seed has arrived.
app.get('/api/stocks', (req, res) => {
  const tier = String(req.query.tier || '');
  if (!TIERS.includes(tier)) return res.status(400).json({ error: 'tier must be low, medium or high' });
  const payload = store.get('feed');
  if (!payload) {
    res.set('X-Data-Source', 'fixture');
    return res.json(require(`../fixtures/feed.${tier}.sample.json`));
  }
  res.set('X-Data-Source', 'live');
  res.json(feedLib.buildFeed(payload, tier, { council: store.get('council', {}), matches: store.get('thesisMatches', []) }));
});

// Contract C: thesis (engine is Vamsi's; server/thesis.js is a stub until his file lands)
app.post('/api/thesis', async (req, res) => {
  // Two ways in. { session }: persist the user-confirmed thesis from the onboarding session exactly as Vamsi's
  // getConfirmedThesis(session) returns it (selectedAssets, assumptions, assumptionDetails included).
  // { goalsText }: build a plain Contract C thesis from free text.
  if (req.body && req.body.session && typeof req.body.session === 'object') {
    try {
      const confirmed = thesisEngine.getConfirmedThesis(req.body.session);
      if (!confirmed) return res.status(409).json({ error: 'no confirmed thesis in this session; confirm the assumptions first' });
      if (!TIERS.includes(confirmed.tier) || !Array.isArray(confirmed.assumptions)) return res.status(502).json({ error: 'confirmed thesis is invalid' });
      if (!(await recordLegacyThesis(confirmed, 'session', res))) return;
      store.set('thesis', confirmed);
      store.set('thesisMatches', []);
      pipeline.refreshThesisMatches();
      return res.json(confirmed);
    } catch (err) {
      console.warn('[thesis/session]', err.message);
      return res.status(400).json({ error: 'could not read the onboarding session' });
    }
  }
  const goalsText = req.body && typeof req.body.goalsText === 'string' ? req.body.goalsText.trim() : '';
  if (!goalsText || goalsText.length > 2000) return res.status(400).json({ error: 'goalsText is required (max 2000 characters)' });
  try {
    const thesis = await thesisEngine.createThesis(goalsText);
    if (!thesis || !TIERS.includes(thesis.tier) || !Array.isArray(thesis.assumptions)) {
      return res.status(502).json({ error: 'thesis engine returned an invalid thesis' });
    }
    if (!(await recordLegacyThesis(thesis, 'goals_text', res))) return;
    store.set('thesis', thesis);
    store.set('thesisMatches', []);
    pipeline.refreshThesisMatches();
    res.json(thesis);
  } catch (err) {
    console.warn('[thesis]', err.message);
    res.status(502).json({ error: 'could not create thesis' });
  }
});

// Database mode: the legacy single thesis is also saved as a thesis of the demo user (and becomes its one
// monitored legacy thesis, as before). Returns false after answering 503 if the database did not confirm.
async function recordLegacyThesis(thesis, origin, res) {
  if (!persistence.isEnabled()) return true;
  try {
    await repo.createThesis(persistence.getDb(), persistence.DEMO_USER_ID, thesis, { origin, legacyId: String(thesis.id), pauseOtherLegacy: true });
    return true;
  } catch (err) {
    console.error('[thesis] could not save the thesis:', persistence.redact(err.message));
    res.status(503).json({ error: 'storage unavailable; the thesis was not saved, please retry' });
    return false;
  }
}

app.get('/api/thesis', (req, res) => {
  const thesis = store.get('thesis');
  if (!thesis) return res.status(404).json({ error: 'no thesis saved yet' });
  res.json(thesis);
});

// Thesis news matches (Contract C match shape). Empty until a thesis exists and a seed has been matched.
app.get('/api/thesis/news', (req, res) => {
  res.json(store.get('thesis') ? store.get('thesisMatches', []) : []);
});

// Contract D: paper trading
app.post('/api/paper/buy', async (req, res) => {
  const ticker = String((req.body && req.body.ticker) || '').trim().toUpperCase();
  const amountUsd = Number(req.body && req.body.amountUsd);
  if (!/^[A-Z.]{1,6}(\/[A-Z]{3,4})?$/.test(ticker)) return res.status(400).json({ error: 'ticker is required, e.g. "VOO"' });
  if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > 100000) {
    return res.status(400).json({ error: 'amountUsd must be a number between 0 and 100000' });
  }
  try {
    res.json(await paper.buy(ticker, Math.round(amountUsd * 100) / 100));
  } catch (err) {
    console.warn('[paper/buy]', err.message);
    res.status(err.code === 'NO_PRICE' ? 404 : 502).json({ error: err.message });
  }
});

// X-Data-Source: live (Alpaca prices for every position, no sample trades) or fixture (any fallback).
app.get('/api/paper/portfolio', async (req, res) => {
  try {
    const { portfolio, source } = await paper.getPortfolio();
    res.set('X-Data-Source', source);
    res.json(portfolio);
  } catch (err) {
    console.warn('[paper/portfolio] falling back to fixture:', err.message);
    res.set('X-Data-Source', 'fixture');
    res.json(require('../fixtures/portfolio.sample.json')); // never render empty
  }
});

// Admin: clear the "challenge email already sent today" flag so a rehearsal does not burn the demo's email.
// Guarded by the same x-webhook-secret as the seed endpoint.
app.post('/api/admin/reset-notify', (req, res) => {
  if (!process.env.INBOUND_WEBHOOK_SECRET) return res.status(503).json({ error: 'INBOUND_WEBHOOK_SECRET is not configured on the server' });
  if (!secretOk(req)) return res.status(401).json({ error: 'bad or missing x-webhook-secret' });
  const previous = store.get('notifyLastSentDate', null);
  store.set('notifyLastSentDate', null);
  console.log(`[admin] reset-notify (was ${previous})`);
  res.json({ ok: true, previous });
});

// Admin: trigger the n8n daily workflow from the UI without exposing its URL to the browser.
// Guarded by x-webhook-secret. Returns immediately; the workflow posts its seed to /api/webhook/seed when done.
app.post('/api/admin/run-pipeline', async (req, res) => {
  if (!process.env.INBOUND_WEBHOOK_SECRET) return res.status(503).json({ error: 'INBOUND_WEBHOOK_SECRET is not configured on the server' });
  if (!secretOk(req)) return res.status(401).json({ error: 'bad or missing x-webhook-secret' });
  const url = process.env.N8N_RUN_WEBHOOK_URL;
  if (!url) return res.status(503).json({ error: 'N8N_RUN_WEBHOOK_URL is not set on the server, so the pipeline cannot be started from here' });
  // Fire and forget: n8n's webhook may not answer until the whole workflow finishes (about 2 minutes).
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'loop-admin', requestedAt: new Date().toISOString() }) })
    .then((r) => { if (!r.ok) console.warn(`[admin] run-pipeline: n8n answered HTTP ${r.status}`); })
    .catch((err) => console.warn('[admin] run-pipeline: could not reach n8n:', err.message));
  console.log('[admin] run-pipeline requested');
  res.status(202).json({ ok: true, started: true, previousRunDate: (store.get('feed') || {}).runDate || null });
});

// Persistent multi-thesis API (sessions, theses, chat, evidence history, timeline). docs/persistence.md
app.use('/api/v2', require('./routes/v2'));

app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  // Storage first (JSON: no-op; LOOP_DB=postgres|pglite: connect, migrate, load). A configured database that
  // cannot be reached stops the boot loudly instead of silently serving temporary JSON data.
  store.init().then(() => {
    const server = app.listen(PORT, () => {
      console.log(`LOOP server on :${PORT}`);
      if (thesisEngine.IS_STUB) console.warn('[WARNING] server/thesis.js is the STUB; drop in the real file from Vamsi.');
      const feed = store.get('feed');
      if (feed) warnIfNoSentiment(feed, 'stored feed');
      paper.bootDemoSeed();
    });
    // SIGTERM (Render deploy/restart) or Ctrl-C: finish active requests and the news pipeline (bounded), then
    // flush storage and close the database. server/shutdown.js
    const shutdown = createShutdown({ server, tracker, pipelineIdle: pipeline.isIdle, flush: () => store.flush(), close: () => persistence.close() });
    const onSignal = (signal) => shutdown(signal).finally(() => process.exit(0));
    process.once('SIGTERM', () => onSignal('SIGTERM'));
    process.once('SIGINT', () => onSignal('SIGINT'));
  }).catch((err) => {
    console.error(`[storage] FATAL: ${err.message}. The server did not start.`);
    process.exit(1);
  });
}
module.exports = app;

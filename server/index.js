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

const app = express();
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
    sentimentMissing: feed ? feedLib.sentimentMissing(feed.stocks) : null,
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
  const goalsText = req.body && typeof req.body.goalsText === 'string' ? req.body.goalsText.trim() : '';
  if (!goalsText || goalsText.length > 2000) return res.status(400).json({ error: 'goalsText is required (max 2000 characters)' });
  try {
    const thesis = await thesisEngine.createThesis(goalsText);
    if (!thesis || !TIERS.includes(thesis.tier) || !Array.isArray(thesis.assumptions)) {
      return res.status(502).json({ error: 'thesis engine returned an invalid thesis' });
    }
    store.set('thesis', thesis);
    store.set('thesisMatches', []);
    pipeline.refreshThesisMatches();
    res.json(thesis);
  } catch (err) {
    console.warn('[thesis]', err.message);
    res.status(502).json({ error: 'could not create thesis' });
  }
});

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

app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`LOOP server on :${PORT}`);
    if (thesisEngine.IS_STUB) console.warn('[WARNING] server/thesis.js is the STUB; drop in the real file from Vamsi.');
    const feed = store.get('feed');
    if (feed) warnIfNoSentiment(feed, 'stored feed');
    paper.bootDemoSeed();
  });
}
module.exports = app;

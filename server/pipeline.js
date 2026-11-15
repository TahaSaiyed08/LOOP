// Daily thesis step: match the day's news against the saved thesis, store matches, maybe email.
// Also runs the council (bull/bear/verdict text) per stock after a seed; it never affects ranking.
const store = require('./store');
const thesisEngine = require('./thesis');
const { maybeNotify } = require('./notify');
const council = require('./council');
const llm = require('./llm');
const { TIERS, rankForTier } = require('./scoring');

const MAX_NEWS = 30; // matchNews batches everything into one LLM call, capped

// Prefer headlines for tickers that surface in the tier lists; otherwise newest first.
function collectNews(payload) {
  const items = [];
  for (const s of payload.stocks) for (const n of s.news || []) items.push({ ticker: s.ticker, ...n });
  items.sort((a, b) => String(b.datetime || '').localeCompare(String(a.datetime || '')));
  return items.slice(0, MAX_NEWS);
}

let running = false;

async function refreshThesisMatches() {
  const thesis = store.get('thesis');
  const payload = store.get('feed');
  if (!thesis || !payload || running) return { skipped: true };
  running = true;
  try {
    const news = collectNews(payload);
    const matches = news.length ? await thesisEngine.matchNews(thesis, news) : [];
    store.set('thesisMatches', matches);
    const notified = await maybeNotify(thesis, matches);
    return { matches: matches.length, notified };
  } catch (err) {
    console.warn('[pipeline] thesis match failed:', err.message);
    return { error: err.message };
  } finally {
    running = false;
  }
}

// Unique tickers across all three tier top-10s, with the scorer's output attached (first tier wins).
function councilTargets(payload) {
  const seen = new Map();
  for (const tier of TIERS) {
    for (const r of rankForTier(payload.stocks, tier).slice(0, 10)) {
      if (!seen.has(r.stock.ticker)) seen.set(r.stock.ticker, { ...r.stock, tier, matchScore: r.matchScore, scoreBreakdown: r.scoreBreakdown });
    }
  }
  return [...seen.values()];
}

// Background: one council per stock, results land in store 'council' as they finish, so the feed fills in
// progressively. Entries for the same runDate and mode are reused, so reseeding during rehearsal is free.
// With no LLM key, or on any failure, text stays null (graceful degradation).
let councilRunning = false;
let councilAgain = false;

async function refreshCouncil() {
  if (councilRunning) { councilAgain = true; return { skipped: true }; }
  const payload = store.get('feed');
  if (!payload) return { skipped: true };
  if (!llm.isConfigured()) { console.warn('[council] GEMINI_API_KEY not set; bull/bear/verdict stay null'); return { skipped: true }; }
  councilRunning = true;
  const mode = council.normalizeMode();
  let ok = 0, failed = 0;
  try {
    const old = store.get('council', {});
    const next = {};
    const todo = [];
    for (const t of councilTargets(payload)) {
      const prev = old[t.ticker];
      if (prev && prev.runDate === payload.runDate && prev.mode === mode) next[t.ticker] = prev;
      else todo.push(t);
    }
    store.set('council', next);
    for (const t of todo) {
      const r = await council.councilForStock(t, mode);
      if (!r) { failed++; continue; }
      ok++;
      next[t.ticker] = { ...r, runDate: payload.runDate, mode };
      store.set('council', next);
    }
    console.log(`[council] ${payload.runDate} (${mode}): ${ok} done, ${failed} failed, ${Object.keys(next).length - ok} reused`);
    return { ok, failed };
  } catch (err) {
    console.warn('[council] run failed:', err.message);
    return { error: err.message };
  } finally {
    councilRunning = false;
    if (councilAgain) { councilAgain = false; refreshCouncil(); }
  }
}

module.exports = { refreshThesisMatches, collectNews, refreshCouncil, councilTargets };

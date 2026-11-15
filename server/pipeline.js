// Daily thesis step: match the day's news against the saved thesis, store matches, maybe email.
// Also runs the council (bull/bear/verdict text) per stock after a seed; it never affects ranking.
const store = require('./store');
const thesisEngine = require('./thesis');
const { maybeNotify } = require('./notify');
const council = require('./council');
const llm = require('./llm');
const { TIERS, rankForTier } = require('./scoring');
const persistence = require('./persistence');
const repo = require('./persistence/repo');

const MAX_NEWS = 30; // matchNews batches everything into one LLM call, capped

// Prefer headlines for tickers that surface in the tier lists; otherwise newest first.
function collectNews(payload) {
  const items = [];
  for (const s of payload.stocks) for (const n of s.news || []) items.push({ ticker: s.ticker, ...n });
  items.sort((a, b) => String(b.datetime || '').localeCompare(String(a.datetime || '')));
  return items.slice(0, MAX_NEWS);
}

let running = false;
let jsonRun = null; // JSON mode: the thesis-match run in progress, if any

async function refreshThesisMatches() {
  if (persistence.isEnabled()) return refreshPersisted();
  const thesis = store.get('thesis');
  const payload = store.get('feed');
  if (!thesis || !payload || running) return { skipped: true };
  running = true;
  let done;
  jsonRun = new Promise((r) => { done = r; }); // lets a graceful shutdown wait for this run (whenIdle)
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
    jsonRun = null;
    done();
  }
}

// ---------- database mode (LOOP_DB=postgres|pglite) ----------
// Same news selection and the same matchNewsDetailed classification as above, but for EVERY monitored thesis,
// with history: an article is evaluated once per thesis assumption version (later runs only evaluate new or
// previously unanalyzed articles), every assessment is kept, and each challenge email is a notification record
// whose status reflects what really happened. The legacy kv 'thesis'/'thesisMatches' keep working as before.
// maybeNotify reasons that are final decisions (not delivery failures): recorded as "skipped", never retried.
const FINAL_SKIPS = new Set(['no challenging match', 'N8N_NOTIFY_WEBHOOK_URL not set', 'NOTIFY_TO_EMAIL not set', 'already sent today']);
// notify.js aborts the webhook call after 8 s ("This operation was aborted"). The request had already been
// sent, so n8n may still have emailed: the delivery status is UNKNOWN, and it is not retried automatically.
const UNCERTAIN = /\baborted\b|\btime(?:d)?\s?out\b|timeout/i;

// maybeNotify result -> notification outcome. "sent" only when maybeNotify confirmed delivery (2xx).
function notificationOutcome(r) {
  if (r && r.sent === true) return 'sent';
  const reason = r && r.reason;
  if (reason === 'send in progress') return 'pending';
  if (FINAL_SKIPS.has(reason)) return 'skipped';
  if (UNCERTAIN.test(String(reason || ''))) return 'uncertain';
  return 'failed';
}

async function notifyMatch(db, thesisRow, matchRow, notification = null) {
  const m = matchRow.match;
  const claim = notification || await repo.claimNotification(db, {
    userId: thesisRow.user_id, thesisId: thesisRow.thesis_id, matchId: matchRow.match_id, articleId: matchRow.article_id,
    payload: { ticker: m.ticker, headline: m.headline, stance: m.stance, whyItMatters: m.whyItMatters, thesisGoal: thesisRow.data.goal },
  });
  if (!claim) return { notificationId: null, status: 'already_handled' };
  let r;
  try { r = await maybeNotify(thesisRow.data, [m]); } catch (err) { r = { sent: false, reason: err.message }; }
  const outcome = notificationOutcome(r);
  const reason = outcome === 'uncertain' ? `delivery uncertain: the email webhook did not answer in time (${r.reason}); it may have been sent, so it is not retried` : r && r.reason;
  try {
    await repo.finishNotification(db, claim.notification_id, outcome, reason);
  } catch (err) {
    console.error(`[notify] ERROR: ${outcome} notification ${claim.notification_id} could not be recorded:`, persistence.redact(err.message));
  }
  return { notificationId: claim.notification_id, status: outcome, reason: (r && r.reason) || null };
}

async function retryClaimed(db, row) {
  const claim = await repo.claimNotification(db, { userId: row.user_id, thesisId: row.thesis_id, matchId: row.match_id, articleId: row.article_id, payload: null });
  if (!claim) return null;
  const [thesisRow, matchRow] = [await repo.getThesisRow(db, row.user_id, row.thesis_id), await repo.getMatchRow(db, row.user_id, row.match_id)];
  if (!thesisRow || !matchRow) { await repo.finishNotification(db, claim.notification_id, 'skipped', 'thesis or match no longer available'); return null; }
  return notifyMatch(db, thesisRow, matchRow, claim);
}

// The kv thesis (legacy POST /api/thesis) must be a monitored thesis row too, e.g. if it was saved before the
// database was enabled.
async function ensureLegacyThesis(db) {
  const kv = store.get('thesis');
  if (!kv || kv.id == null) return null;
  const found = await repo.legacyThesisRow(db, persistence.DEMO_USER_ID, String(kv.id));
  if (found) return found;
  return (await repo.createThesis(db, persistence.DEMO_USER_ID, kv, { origin: 'legacy', legacyId: String(kv.id), pauseOtherLegacy: true })).row;
}

const SAVE_TIME_REASON = 'found when the thesis was saved (earlier news); shown in the app, not emailed';
async function recordWithoutEmail(db, thesisRow, matchRow) {
  const m = matchRow.match;
  const claim = await repo.claimNotification(db, {
    userId: thesisRow.user_id, thesisId: thesisRow.thesis_id, matchId: matchRow.match_id, articleId: matchRow.article_id,
    payload: { ticker: m.ticker, headline: m.headline, stance: m.stance, whyItMatters: m.whyItMatters, thesisGoal: thesisRow.data.goal },
  });
  if (!claim) return { notificationId: null, status: 'already_handled' };
  await repo.finishNotification(db, claim.notification_id, 'skipped', SAVE_TIME_REASON);
  return { notificationId: claim.notification_id, status: 'skipped', reason: SAVE_TIME_REASON };
}

let current = null; // the database-mode run in progress, if any
let currentKind = null; // 'thesis' while matchStoredFeedFor runs
// Resolves when no thesis-match run (either mode) is in progress. Used by tests and by graceful shutdown.
const whenIdle = () => Promise.all([current, jsonRun].filter(Boolean)).then(() => undefined);
const isIdle = () => !running;

// A thesis was just saved: evaluate the already-stored feed for it now (background), instead of waiting for
// the next n8n seed. Waits for a run in progress, then runs with the same lock. Never emails.
async function matchStoredFeedFor(thesisId) {
  while (current) await current.catch(() => {});
  const payload = store.get('feed');
  if (!payload || !persistence.isEnabled()) return { skipped: true };
  running = true;
  currentKind = 'thesis';
  current = runPersisted(payload, { thesisId, notify: false }).finally(() => { running = false; current = null; currentKind = null; });
  return current;
}

function refreshPersisted() {
  // a seed must never be skipped because a single new thesis is being evaluated: run right after it
  if (running && currentKind === 'thesis' && current) return current.catch(() => {}).then(() => refreshPersisted());
  const payload = store.get('feed');
  if (!payload || running) return Promise.resolve({ skipped: true });
  running = true;
  current = runPersisted(payload).finally(() => { running = false; current = null; });
  return current;
}

// opts.thesisId: evaluate the stored feed for that one thesis only (a thesis just saved), with the same news
// selection and the same matchNewsDetailed rules. opts.notify === false: never email. A challenge found then
// gets a "skipped" notification record (the idempotency key), so a later run never emails it either.
async function runPersisted(payload, opts = {}) {
  try {
    const db = persistence.getDb();
    const news = collectNews(payload);
    const ids = await repo.upsertArticles(db, news, { runDate: payload.runDate, touch: false });
    const articleIdOf = (n) => (ids.get(repo.articleKey(n.ticker, n.headline)) || {}).articleId;
    // matcher form (ticker uppercased, headline trimmed + cut at 300) -> article id, to map matches back exactly
    const byMatcherKey = new Map(news.map((n) => [`${String(n.ticker || '').trim().toUpperCase()}|${String(n.headline || '').trim().slice(0, 300)}`, articleIdOf(n)]));
    const legacy = opts.thesisId ? null : await ensureLegacyThesis(db);
    const theses = (await repo.activeTheses(db)).filter((t) => !opts.thesisId || t.thesis_id === opts.thesisId);
    let total = 0;
    const notified = [];
    for (const t of theses) {
      const checked = await repo.checkedArticleIds(db, t.thesis_id, t.assumption_version, news.map(articleIdOf).filter(Boolean));
      const todo = news.filter((n) => articleIdOf(n) && !checked.has(articleIdOf(n)));
      if (!todo.length) continue;
      const { matches, stats } = await thesisEngine.matchNewsDetailed(t.data, todo);
      const withIds = matches.map((m) => ({ articleId: byMatcherKey.get(`${m.ticker}|${m.headline}`), match: m })).filter((x) => x.articleId);
      // Evaluated for good: everything when the run was fully analysed (or needed no AI); otherwise only
      // articles with a real AI analysis, so fallback placeholders are evaluated again next time.
      const fully = stats.analyzedBy === 'gemini' || stats.analyzedBy === 'none';
      const checkedIds = fully ? todo.map(articleIdOf) : withIds.filter((x) => !x.match.unanalyzed).map((x) => x.articleId);
      const fresh = await repo.recordAssessment(db, t, { matches: withIds, checkedIds: [...new Set(checkedIds)], analyzedBy: stats.analyzedBy });
      total += fresh.length;
      for (const row of fresh.filter((r) => r.stance === 'challenges')) {
        const full = await repo.getMatchRow(db, t.user_id, row.match_id);
        notified.push(opts.notify === false ? await recordWithoutEmail(db, t, full) : await notifyMatch(db, t, full));
      }
    }
    if (opts.thesisId) return { matches: total, theses: theses.length, notified };
    // Sends interrupted by a server stop: bounded recovery first (see repo.recoverStaleSending), then retries.
    const recovered = await repo.recoverStaleSending(db, { lastSentDate: store.get('notifyLastSentDate') });
    if (recovered.length) console.warn(`[notify] ${recovered.length} interrupted email send(s) found; delivery status is uncertain: ${recovered.map((n) => `${n.notification_id} (${n.attempts < repo.NOTIFY_MAX_ATTEMPTS ? 'one more attempt' : 'not retried'})`).join(', ')}`);
    for (const row of await repo.retryableNotifications(db)) {
      if (notified.some((n) => n.notificationId === row.notification_id)) continue;
      const out = await retryClaimed(db, row);
      if (out) notified.push(out);
    }
    if (legacy) {
      const current = await repo.legacyThesisRow(db, persistence.DEMO_USER_ID, String(legacy.legacy_id));
      store.set('thesisMatches', await repo.matchesForArticles(db, current.thesis_id, current.assumption_version, news.map(articleIdOf).filter(Boolean)));
    }
    return { matches: total, theses: theses.length, notified };
  } catch (err) {
    console.error('[pipeline] thesis match failed:', persistence.redact(err.message));
    return { error: persistence.redact(err.message) };
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

module.exports = { refreshThesisMatches, collectNews, refreshCouncil, councilTargets, refreshPersisted, matchStoredFeedFor, whenIdle, isIdle, notificationOutcome };

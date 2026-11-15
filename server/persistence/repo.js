// Data access for the relational THESIS tables (schema: migrations/001_init.sql).
// Every function takes the db adapter first (server/persistence/db.js) and uses parameterized SQL only.
// Everything the API reports as saved (sessions, theses, chat turns) is written in an awaited transaction:
// if the database does not confirm, the function throws and nothing is half-written.
// Reads are scoped by user_id wherever a user is involved: another user's record looks like "not found".
const crypto = require('crypto');

const newId = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
const J = (v) => JSON.stringify(v === undefined ? null : v);
const iso = (d) => (d == null ? null : new Date(d).toISOString());
const isUniqueViolation = (err) => err && (err.code === '23505' || /duplicate key|unique constraint/i.test(String(err.message)));

class ConflictError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; this.status = 409; Object.assign(this, extra); }
}

// ---------- users ----------
const userOut = (r) => r && { userId: r.user_id, displayName: r.display_name, preferences: r.preferences, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) };

async function createUser(db, { displayName = null, preferences = {} } = {}) {
  const { rows } = await db.query('INSERT INTO users (user_id, display_name, preferences) VALUES ($1, $2, $3::jsonb) RETURNING *',
    [newId('usr'), displayName, J(preferences && typeof preferences === 'object' ? preferences : {})]);
  return userOut(rows[0]);
}
async function getUser(db, userId) {
  const { rows } = await db.query('SELECT * FROM users WHERE user_id = $1', [userId]);
  return userOut(rows[0]) || null;
}

// ---------- onboarding sessions ----------
function insertEvent(q, sessionId, userId, e, stage, version) {
  return q.query(`INSERT INTO session_events (event_id, session_id, user_id, action, payload, ok, error_code, stage_after, version_after)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
  [newId('evt'), sessionId, userId, String(e.action || 'unknown').slice(0, 40), J(e.payload || {}), Boolean(e.ok), e.errorCode || null, stage || null, version == null ? null : version]);
}

async function getSession(db, userId, sessionId) {
  const { rows } = await db.query('SELECT * FROM onboarding_sessions WHERE session_id = $1 AND user_id = $2', [sessionId, userId]);
  return rows[0] || null;
}
// Each session with a short summary and the thesis already saved from it (if any), so the UI can show
// "unfinished" sessions and open saved ones directly.
async function listSessions(db, userId) {
  const { rows } = await db.query(`SELECT s.session_id, s.stage, s.version, s.created_at, s.updated_at, s.last_display_text,
      s.state->'profile' AS profile, s.state->'selection' AS selection, s.state->'thesisDraft'->'draft'->>'goal' AS draft_goal, s.state->'thesisDraft'->'draft'->'selectedAssets' AS draft_assets,
      (SELECT t.thesis_id FROM theses t WHERE t.session_id = s.session_id AND t.user_id = s.user_id ORDER BY t.created_at DESC LIMIT 1) AS saved_thesis_id
    FROM onboarding_sessions s WHERE s.user_id = $1 ORDER BY s.updated_at DESC LIMIT 50`, [userId]);
  return rows.map((r) => {
    const sel = r.selection || {};
    const pick = [sel.confirmed, sel.pending, r.draft_assets].find((x) => Array.isArray(x) && x.length) || [];
    const assets = pick.map((a) => (a && typeof a === 'object' ? a.symbol : a)).filter((x) => typeof x === 'string');
    return { sessionId: r.session_id, stage: r.stage, version: r.version, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
      savedThesisId: r.saved_thesis_id || null, goal: r.draft_goal || (r.profile && r.profile.purpose) || null, assets,
      lastDisplayText: r.last_display_text ? String(r.last_display_text).slice(0, 240) : null };
  });
}
async function savedThesisIdForSession(db, userId, sessionId) {
  const { rows } = await db.query('SELECT thesis_id FROM theses WHERE session_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1', [sessionId, userId]);
  return rows[0] ? rows[0].thesis_id : null;
}

// next = { state, version, stage, nextActions, displayText }
async function createSession(db, userId, next, event) {
  return db.transaction(async (tx) => {
    const id = newId('ses');
    const { rows } = await tx.query(`INSERT INTO onboarding_sessions (session_id, user_id, state, version, stage, next_actions, last_display_text)
      VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb, $7) RETURNING *`,
    [id, userId, J(next.state), next.version, next.stage, J(next.nextActions || []), next.displayText || null]);
    await insertEvent(tx, id, userId, event, next.stage, next.version);
    return rows[0];
  });
}

// Compare-and-swap: only saves if the stored version is still `expectedVersion`; otherwise ConflictError.
async function updateSession(db, userId, sessionId, expectedVersion, next, event) {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query(`UPDATE onboarding_sessions SET state = $1::jsonb, version = $2, stage = $3, next_actions = $4::jsonb,
      last_display_text = $5, updated_at = now() WHERE session_id = $6 AND user_id = $7 AND version = $8 RETURNING *`,
    [J(next.state), next.version, next.stage, J(next.nextActions || []), next.displayText || null, sessionId, userId, expectedVersion]);
    if (!rows.length) throw new ConflictError('version_conflict', 'This session changed elsewhere. Reload it and try again.');
    await insertEvent(tx, sessionId, userId, event, next.stage, next.version);
    return rows[0];
  });
}
async function recordSessionEvent(db, userId, sessionId, event, stage, version) {
  await insertEvent(db, sessionId, userId, event, stage, version);
}

// ---------- theses ----------
function thesisColumns(data) {
  const details = Array.isArray(data.assumptionDetails) && data.assumptionDetails.length
    ? data.assumptionDetails : (Array.isArray(data.assumptions) ? data.assumptions : []).map((t) => ({ text: t }));
  return {
    goal: typeof data.goal === 'string' ? data.goal : null,
    selectedAssets: Array.isArray(data.selectedAssets) ? data.selectedAssets : [],
    assumptions: details.map((a, i) => ({ index: i, text: a.text, tickers: Array.isArray(a.tickers) ? a.tickers : [], whatWouldChallengeIt: a.whatWouldChallengeIt || null })),
  };
}
function thesisOut(r, { full = true } = {}) {
  if (!r) return null;
  const meta = {
    thesisId: r.thesis_id, userId: r.user_id, sessionId: r.session_id, origin: r.origin, goal: r.goal,
    selectedAssets: r.selected_assets, monitoringStatus: r.monitoring_status, assumptionVersion: r.assumption_version,
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), confirmedAt: iso(r.confirmed_at), assumptionsConfirmedAt: iso(r.source_confirmed_at),
  };
  return full ? { ...meta, assumptions: r.assumptions, thesis: r.data } : meta;
}

// -> { row, created }. Saving the same confirmed session twice (or the same legacy thesis id) returns the
// existing row instead of a duplicate. `pauseOtherLegacy` keeps the legacy single-thesis behaviour: a new
// legacy thesis replaces the previous one as the monitored thesis (the old one stays saved, paused).
async function createThesis(db, userId, data, { origin, sessionId = null, legacyId = null, pauseOtherLegacy = false } = {}) {
  const confirmedAt = data.assumptionsConfirmedAt ? new Date(data.assumptionsConfirmedAt) : null;
  const findExisting = async (q) => {
    if (sessionId && confirmedAt) {
      const { rows } = await q.query('SELECT * FROM theses WHERE user_id = $1 AND session_id = $2 AND source_confirmed_at = $3', [userId, sessionId, confirmedAt]);
      if (rows[0]) return rows[0];
    }
    if (legacyId) {
      const { rows } = await q.query('SELECT * FROM theses WHERE user_id = $1 AND legacy_id = $2', [userId, legacyId]);
      if (rows[0]) return rows[0];
    }
    return null;
  };
  try {
    return await db.transaction(async (tx) => {
      const existing = await findExisting(tx);
      if (existing) return { row: existing, created: false };
      const id = newId('th');
      const cols = thesisColumns(data);
      if (pauseOtherLegacy) {
        await tx.query(`UPDATE theses SET monitoring_status = 'paused', updated_at = now() WHERE user_id = $1 AND legacy_id IS NOT NULL AND monitoring_status = 'active'`, [userId]);
      }
      const { rows } = await tx.query(`INSERT INTO theses (thesis_id, user_id, session_id, origin, legacy_id, data, goal, selected_assets, assumptions, source_confirmed_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::jsonb, $10) RETURNING *`,
      [id, userId, sessionId, origin, legacyId, J({ ...data, id }), cols.goal, J(cols.selectedAssets), J(cols.assumptions), confirmedAt]);
      if (sessionId) await insertEvent(tx, sessionId, userId, { action: 'saveThesis', payload: { thesisId: id }, ok: true }, 'confirmed', null);
      return { row: rows[0], created: true };
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await findExisting(db); // a concurrent save of the same thesis won the race
    if (!existing) throw err;
    return { row: existing, created: false };
  }
}

async function getThesisRow(db, userId, thesisId) {
  const { rows } = await db.query('SELECT * FROM theses WHERE thesis_id = $1 AND user_id = $2', [thesisId, userId]);
  return rows[0] || null;
}
// List view, with a small activity summary per thesis (additive fields).
async function listTheses(db, userId) {
  const { rows } = await db.query(`SELECT t.*,
      (SELECT count(*)::int FROM thesis_matches m WHERE m.thesis_id = t.thesis_id) AS match_count,
      (SELECT count(*)::int FROM thesis_matches m WHERE m.thesis_id = t.thesis_id AND m.stance = 'challenges') AS challenge_count,
      (SELECT max(m.assessed_at) FROM thesis_matches m WHERE m.thesis_id = t.thesis_id) AS last_evidence_at,
      (SELECT count(*)::int FROM chat_conversations c WHERE c.thesis_id = t.thesis_id) AS conversation_count,
      (SELECT max(c.updated_at) FROM chat_conversations c WHERE c.thesis_id = t.thesis_id) AS last_chat_at
    FROM theses t WHERE t.user_id = $1 ORDER BY t.created_at DESC`, [userId]);
  return rows.map((r) => {
    const times = [r.created_at, r.last_evidence_at, r.last_chat_at].filter(Boolean).map((d) => new Date(d).getTime());
    return { ...thesisOut(r, { full: false }), assumptionCount: Array.isArray(r.assumptions) ? r.assumptions.length : 0,
      activity: { matches: r.match_count, challenges: r.challenge_count, lastEvidenceAt: iso(r.last_evidence_at),
        conversations: r.conversation_count, lastChatAt: iso(r.last_chat_at), lastActivityAt: times.length ? new Date(Math.max(...times)).toISOString() : null } };
  });
}
async function setMonitoring(db, userId, thesisId, status) {
  const { rows } = await db.query('UPDATE theses SET monitoring_status = $1, updated_at = now() WHERE thesis_id = $2 AND user_id = $3 RETURNING *', [status, thesisId, userId]);
  return rows[0] || null;
}
async function activeTheses(db) {
  const { rows } = await db.query(`SELECT * FROM theses WHERE monitoring_status = 'active' ORDER BY created_at`);
  return rows;
}
async function legacyThesisRow(db, userId, legacyId) {
  const { rows } = await db.query('SELECT * FROM theses WHERE user_id = $1 AND legacy_id = $2', [userId, legacyId]);
  return rows[0] || null;
}

// ---------- news articles ----------
const normHeadline = (h) => String(h || '').replace(/\s+/g, ' ').trim().slice(0, 300);
const normTicker = (t) => (typeof t === 'string' ? t.trim().toUpperCase() : '');
// Same normalization as the matcher (normalizeNewsItems), so a match maps back to exactly one article.
const articleKey = (ticker, headline) => crypto.createHash('sha256').update(`${normTicker(ticker)}|${normHeadline(headline).toLowerCase()}`).digest('hex').slice(0, 40);
function validTime(v) { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d : null; }
function safeHttpUrl(u) {
  if (typeof u !== 'string' || !u.trim() || u.length > 2000) return null;
  try { const x = new URL(u.trim()); return x.protocol === 'https:' || x.protocol === 'http:' ? u.trim() : null; } catch { return null; }
}

// items: [{ ticker, headline, summary, source, url, datetime }] (pipeline / Contract A news).
// touch=true (a new seed): bump last_seen_at/seen_count and fill a missing summary/url/publisher.
// touch=false (pipeline lookup): only create missing rows. -> Map(dedupeKey -> { articleId, inserted })
async function upsertArticles(db, items, { runDate = null, touch = true } = {}) {
  const out = new Map();
  const list = (Array.isArray(items) ? items : []).filter((n) => n && normHeadline(n.headline));
  if (!list.length) return out;
  const conflict = touch
    ? `DO UPDATE SET last_seen_at = now(), seen_count = news_articles.seen_count + 1,
        summary = COALESCE(news_articles.summary, EXCLUDED.summary), url = COALESCE(news_articles.url, EXCLUDED.url),
        publisher = COALESCE(news_articles.publisher, EXCLUDED.publisher), published_at = COALESCE(news_articles.published_at, EXCLUDED.published_at)`
    : 'DO UPDATE SET dedupe_key = EXCLUDED.dedupe_key';
  await db.transaction(async (tx) => {
    for (const n of list) {
      const key = articleKey(n.ticker, n.headline);
      if (out.has(key)) continue;
      const summary = typeof n.summary === 'string' && n.summary.trim() ? n.summary.trim().slice(0, 4000) : null;
      const publisher = typeof n.source === 'string' ? n.source.slice(0, 120) : typeof n.publisher === 'string' ? n.publisher.slice(0, 120) : null;
      const { rows } = await tx.query(`INSERT INTO news_articles (article_id, dedupe_key, ticker, headline, summary, publisher, url, published_at, first_run_date)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (dedupe_key) ${conflict} RETURNING article_id, (xmax = 0) AS inserted`,
      [newId('art'), key, normTicker(n.ticker) || null, normHeadline(n.headline), summary, publisher, safeHttpUrl(n.url), validTime(n.datetime), runDate || null]);
      out.set(key, { articleId: rows[0].article_id, inserted: rows[0].inserted });
    }
  });
  return out;
}

// ---------- thesis matches (evidence history) ----------
async function checkedArticleIds(db, thesisId, version, articleIds) {
  if (!articleIds.length) return new Set();
  const { rows } = await db.query('SELECT article_id FROM thesis_article_checks WHERE thesis_id = $1 AND assumption_version = $2 AND article_id = ANY($3::text[])', [thesisId, version, articleIds]);
  return new Set(rows.map((r) => r.article_id));
}

// Persists one matchNewsDetailed run for one thesis. `checkedIds` are articles that were genuinely evaluated
// (they won't be sent to Gemini again for this assumption version); `matches` are its outputs with their
// article ids. Existing assessments are kept; only an unanalyzed placeholder is replaced by a real analysis.
// -> rows that were inserted or upgraded now (the ones that may need a notification).
async function recordAssessment(db, thesis, { matches, checkedIds, analyzedBy }) {
  const version = thesis.assumption_version;
  const texts = Array.isArray(thesis.assumptions) ? thesis.assumptions : [];
  return db.transaction(async (tx) => {
    const fresh = [];
    for (const { articleId, match: m } of matches) {
      const a = texts[m.assumptionIndex];
      const { rows } = await tx.query(`INSERT INTO thesis_matches (match_id, thesis_id, article_id, assumption_version, assumption_index, assumption_text,
          stance, assessed_stance, relevance, evidence, provisional, unanalyzed, why_it_matters, analyzed_by, model, match)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
        ON CONFLICT (thesis_id, article_id, assumption_version) DO UPDATE SET
          assumption_index = EXCLUDED.assumption_index, assumption_text = EXCLUDED.assumption_text, stance = EXCLUDED.stance,
          assessed_stance = EXCLUDED.assessed_stance, relevance = EXCLUDED.relevance, evidence = EXCLUDED.evidence,
          provisional = EXCLUDED.provisional, unanalyzed = EXCLUDED.unanalyzed, why_it_matters = EXCLUDED.why_it_matters,
          analyzed_by = EXCLUDED.analyzed_by, model = EXCLUDED.model, match = EXCLUDED.match, assessed_at = now()
        WHERE thesis_matches.unanalyzed AND NOT EXCLUDED.unanalyzed
        RETURNING *`,
      [newId('mat'), thesis.thesis_id, articleId, version, m.assumptionIndex, a ? a.text : null, m.stance, m.assessedStance || null,
        m.relevance || null, m.evidence || null, m.provisional == null ? null : Boolean(m.provisional), Boolean(m.unanalyzed),
        m.whyItMatters || null, m.analyzedBy || null, m.model || null, J(m)]);
      if (rows[0]) fresh.push(rows[0]);
    }
    const matchedIds = new Set(matches.map((x) => x.articleId));
    for (const id of checkedIds) {
      await tx.query(`INSERT INTO thesis_article_checks (thesis_id, article_id, assumption_version, matched, analyzed_by)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [thesis.thesis_id, id, version, matchedIds.has(id), analyzedBy || null]);
    }
    return fresh;
  });
}

const MATCH_SELECT = `SELECT m.*, a.ticker, a.headline, a.summary AS article_summary, a.publisher, a.url, a.published_at, a.ingested_at
  FROM thesis_matches m JOIN news_articles a ON a.article_id = m.article_id`;
const STANCE_ORDER = { challenges: 0, supports: 1, neutral: 2 };

function matchOut(r) {
  return {
    matchId: r.match_id, thesisId: r.thesis_id, articleId: r.article_id, assessedAt: iso(r.assessed_at),
    assumptionIndex: r.assumption_index, assumptionText: r.assumption_text, assumptionVersion: r.assumption_version,
    stance: r.stance, assessedStance: r.assessed_stance, relevance: r.relevance, evidence: r.evidence, provisional: r.provisional,
    unanalyzed: r.unanalyzed, whyItMatters: r.why_it_matters, analyzedBy: r.analyzed_by, model: r.model,
    article: { ticker: r.ticker, headline: r.headline, summary: r.article_summary, publisher: r.publisher, url: r.url, publishedAt: iso(r.published_at), ingestedAt: iso(r.ingested_at) },
  };
}
// The evidence item thesisChat expects (saved match shape), built from the ORIGINAL saved article.
function evidenceItem(r) {
  return { ...r.match, ticker: r.ticker, headline: r.headline, url: r.url, summary: r.article_summary != null ? r.article_summary : r.match.summary || null,
    publisher: r.publisher, source: r.publisher, datetime: iso(r.published_at) };
}

async function listMatches(db, userId, thesisId, { limit = 100 } = {}) {
  const { rows } = await db.query(`${MATCH_SELECT} JOIN theses t ON t.thesis_id = m.thesis_id
    WHERE m.thesis_id = $1 AND t.user_id = $2 ORDER BY m.assessed_at DESC, m.match_id LIMIT $3`, [thesisId, userId, limit]);
  return rows;
}
async function getMatchRow(db, userId, matchId) {
  const { rows } = await db.query(`${MATCH_SELECT} JOIN theses t ON t.thesis_id = m.thesis_id WHERE m.match_id = $1 AND t.user_id = $2`, [matchId, userId]);
  return rows[0] || null;
}
// Legacy GET /api/thesis/news: this run's articles for one thesis, in the matcher's order, original shape.
async function matchesForArticles(db, thesisId, version, articleIds) {
  if (!articleIds.length) return [];
  const { rows } = await db.query(`SELECT match FROM thesis_matches WHERE thesis_id = $1 AND assumption_version = $2 AND article_id = ANY($3::text[])`, [thesisId, version, articleIds]);
  return rows.map((r) => r.match).sort((a, b) => STANCE_ORDER[a.stance] - STANCE_ORDER[b.stance]
    || (a.relevance === 'direct' ? 0 : 1) - (b.relevance === 'direct' ? 0 : 1) || Number(a.unanalyzed) - Number(b.unanalyzed));
}

// ---------- notifications ----------
const NOTIFY_MAX_ATTEMPTS = 3;
const STALE_SENDING_MINUTES = 10; // a send takes at most ~8 s (notify.js timeout); older "sending" = the server stopped
const notificationKey = (thesisId, articleId) => `challenge_email:${thesisId}:${articleId}`;

// Creates the notification row once per (thesis, article) and atomically claims it for one delivery attempt.
// Claimable: pending, or failed with attempts left. A "sending" row is never claimed directly: if the server
// stopped mid-send, recoverStaleSending() first decides (bounded) whether it may be tried again.
// -> the claimed row, or null (already sent, finally skipped, out of attempts, or being sent right now).
async function claimNotification(db, { userId, thesisId, matchId, articleId, payload }) {
  const key = notificationKey(thesisId, articleId);
  return db.transaction(async (tx) => {
    await tx.query(`INSERT INTO notifications (notification_id, user_id, thesis_id, match_id, type, status, idempotency_key, payload)
      VALUES ($1, $2, $3, $4, 'challenge_email', 'pending', $5, $6::jsonb) ON CONFLICT (idempotency_key) DO NOTHING`,
    [newId('ntf'), userId, thesisId, matchId, key, J(payload)]);
    const { rows } = await tx.query(`UPDATE notifications SET status = 'sending', attempts = attempts + 1, last_attempt_at = now()
      WHERE idempotency_key = $1 AND (status = 'pending' OR (status = 'failed' AND attempts < $2)) RETURNING *`, [key, NOTIFY_MAX_ATTEMPTS]);
    return rows[0] || null;
  });
}
// outcome: 'sent' (delivery confirmed), 'failed' (retryable), 'skipped' (final), 'pending' (try again later),
// 'uncertain' (the webhook did not answer in time: the email MAY have gone out; recorded as failed with no
// attempts left, so it is never re-sent automatically and a duplicate email is avoided)
async function finishNotification(db, notificationId, outcome, reason = null) {
  const sql = {
    sent: `UPDATE notifications SET status = 'sent', sent_at = now(), reason = NULL WHERE notification_id = $1`,
    failed: `UPDATE notifications SET status = 'failed', failed_at = now(), reason = $2 WHERE notification_id = $1`,
    skipped: `UPDATE notifications SET status = 'skipped', reason = $2 WHERE notification_id = $1`,
    pending: `UPDATE notifications SET status = 'pending', reason = $2 WHERE notification_id = $1`,
    uncertain: `UPDATE notifications SET status = 'failed', failed_at = now(), reason = $2, attempts = GREATEST(attempts, ${NOTIFY_MAX_ATTEMPTS}) WHERE notification_id = $1`,
  }[outcome];
  if (!sql) throw new Error(`unknown notification outcome ${outcome}`);
  await db.query(sql, outcome === 'sent' ? [notificationId] : [notificationId, reason ? String(reason).slice(0, 300) : null]);
}

// Bounded recovery for rows left in "sending" when the server stopped during a delivery (crash, SIGKILL, or a
// shutdown that ran out of time). Whether that email went out is unknown, so:
//   - if an email was recorded as sent on the UTC day of that attempt (`lastSentDate`, notify.js's daily
//     marker), it may well have been this one: recorded as failed with no attempts left (never re-sent);
//   - otherwise the send most likely never completed: recorded as failed with exactly ONE attempt left, so the
//     normal retry (attempt cap, 2-day window, active thesis, daily email limit) may try it once more
//     (never beyond the 3-attempt cap).
// Only rows idle for STALE_SENDING_MINUTES are touched, so an in-progress send is never interrupted.
// -> the recovered rows
async function recoverStaleSending(db, { lastSentDate = null } = {}) {
  const day = typeof lastSentDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(lastSentDate) ? lastSentDate : null;
  const { rows } = await db.query(`UPDATE notifications SET status = 'failed', failed_at = now(),
      attempts = CASE WHEN to_char(last_attempt_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') = $2 THEN GREATEST(attempts, $3)
                      ELSE GREATEST(attempts, $3 - 1) END,
      reason = CASE WHEN to_char(last_attempt_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') = $2
                    THEN 'delivery uncertain: the server stopped during the send, and an email was sent that day (not retried)'
                    WHEN attempts >= $3 THEN 'delivery uncertain: the server stopped during the send (no attempts left)'
                    ELSE 'delivery uncertain: the server stopped during the send (one more attempt allowed)' END
    WHERE status = 'sending' AND last_attempt_at < now() - make_interval(mins => $1) RETURNING *`,
  [STALE_SENDING_MINUTES, day, NOTIFY_MAX_ATTEMPTS]);
  return rows;
}
// Earlier failed (or deferred) deliveries worth another attempt: recent, attempts left, thesis still monitored.
async function retryableNotifications(db) {
  const { rows } = await db.query(`SELECT n.notification_id, n.thesis_id, n.match_id, n.user_id, m.article_id
    FROM notifications n JOIN thesis_matches m ON m.match_id = n.match_id JOIN theses t ON t.thesis_id = n.thesis_id
    WHERE t.monitoring_status = 'active' AND n.created_at > now() - interval '2 days'
      AND ((n.status = 'failed' AND n.attempts < $1) OR n.status = 'pending') ORDER BY n.created_at`, [NOTIFY_MAX_ATTEMPTS]);
  return rows;
}
async function listNotifications(db, userId, thesisId) {
  const { rows } = await db.query(`SELECT * FROM notifications WHERE thesis_id = $1 AND user_id = $2 ORDER BY created_at`, [thesisId, userId]);
  return rows.map((r) => ({ notificationId: r.notification_id, thesisId: r.thesis_id, matchId: r.match_id, type: r.type, channel: r.channel,
    status: r.status, reason: r.reason, attempts: r.attempts, payload: r.payload, createdAt: iso(r.created_at),
    lastAttemptAt: iso(r.last_attempt_at), sentAt: iso(r.sent_at), failedAt: iso(r.failed_at) }));
}

// ---------- chat ----------
const conversationOut = (r) => r && { conversationId: r.conversation_id, thesisId: r.thesis_id, mode: r.mode, matchId: r.match_id, title: r.title, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) };
const messageOut = (r) => ({ messageId: r.message_id, conversationId: r.conversation_id, thesisId: r.thesis_id, seq: r.seq, role: r.role,
  content: r.content, citations: r.citations, segments: r.segments, meta: r.meta, createdAt: iso(r.created_at) });
// The history entry thesisChat expects, rebuilt from a saved message.
const historyEntry = (r, thesisId) => (r.role === 'assistant'
  ? { role: 'assistant', content: r.content, citations: r.citations, thesisId, at: iso(r.created_at) }
  : { role: 'user', content: r.content, thesisId, at: iso(r.created_at) });

async function getConversation(db, userId, conversationId) {
  const { rows } = await db.query('SELECT * FROM chat_conversations WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId]);
  return rows[0] || null;
}
async function listConversations(db, userId, thesisId) {
  const { rows } = await db.query(`SELECT c.*, (SELECT count(*)::int FROM chat_messages x WHERE x.conversation_id = c.conversation_id) AS message_count
    FROM chat_conversations c WHERE c.thesis_id = $1 AND c.user_id = $2 ORDER BY c.updated_at DESC`, [thesisId, userId]);
  return rows.map((r) => ({ ...conversationOut(r), messageCount: r.message_count }));
}
async function getMessageRows(db, conversationId) {
  const { rows } = await db.query('SELECT * FROM chat_messages WHERE conversation_id = $1 ORDER BY seq', [conversationId]);
  return rows;
}

// One user question + one assistant answer, atomically (the conversation is created in the same transaction
// when new). The conversation row is locked so concurrent turns get consecutive seq numbers.
async function saveChatTurn(db, { userId, thesisId, conversationId = null, mode, matchId = null, title = null, userText, userAt, assistant, assistantAt }) {
  return db.transaction(async (tx) => {
    let conv;
    if (conversationId) {
      const { rows } = await tx.query('SELECT * FROM chat_conversations WHERE conversation_id = $1 AND user_id = $2 AND thesis_id = $3 FOR UPDATE', [conversationId, userId, thesisId]);
      if (!rows[0]) throw new ConflictError('conversation_not_found', 'This conversation no longer exists.');
      conv = rows[0];
    } else {
      const { rows } = await tx.query(`INSERT INTO chat_conversations (conversation_id, user_id, thesis_id, mode, match_id, title, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`, [newId('conv'), userId, thesisId, mode, matchId, title, userAt]);
      conv = rows[0];
    }
    const { rows: [{ max }] } = await tx.query('SELECT COALESCE(MAX(seq), 0)::int AS max FROM chat_messages WHERE conversation_id = $1', [conv.conversation_id]);
    const insert = (seq, role, content, at, extra = {}) => tx.query(`INSERT INTO chat_messages (message_id, conversation_id, thesis_id, user_id, seq, role, content, citations, segments, meta, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11) RETURNING *`,
    [newId('msg'), conv.conversation_id, thesisId, userId, seq, role, content, J(extra.citations || []), J(extra.segments || []), J(extra.meta || {}), at]);
    const u = (await insert(max + 1, 'user', userText, userAt)).rows[0];
    const a = (await insert(max + 2, 'assistant', assistant.content, assistantAt, assistant)).rows[0];
    const { rows: [updated] } = await tx.query('UPDATE chat_conversations SET updated_at = $2 WHERE conversation_id = $1 RETURNING *', [conv.conversation_id, assistantAt]);
    return { conversation: updated, userMessage: u, assistantMessage: a };
  });
}

// ---------- timeline ----------
async function thesisTimeline(db, userId, thesisId) {
  const t = await getThesisRow(db, userId, thesisId);
  if (!t) return null;
  const ev = [];
  const push = (at, type, detail) => { if (at) ev.push({ ...detail, at: iso(at), type }); }; // detail can never overwrite at/type
  if (t.session_id) {
    const { rows: [s] } = await db.query('SELECT created_at FROM onboarding_sessions WHERE session_id = $1', [t.session_id]);
    if (s) push(s.created_at, 'onboarding_started', { sessionId: t.session_id });
    const { rows } = await db.query('SELECT * FROM session_events WHERE session_id = $1 ORDER BY created_at, event_id', [t.session_id]);
    for (const e of rows) push(e.created_at, 'session_action', { action: e.action, payload: e.payload, ok: e.ok, errorCode: e.error_code, stage: e.stage_after });
  }
  push(t.source_confirmed_at, 'assumptions_confirmed', { assumptions: t.assumptions });
  push(t.created_at, 'thesis_saved', { thesisId: t.thesis_id, origin: t.origin });
  const { rows: arts } = await db.query(`SELECT a.*, c.checked_at, c.matched FROM news_articles a
    LEFT JOIN thesis_article_checks c ON c.article_id = a.article_id AND c.thesis_id = $1
    WHERE a.article_id IN (SELECT article_id FROM thesis_article_checks WHERE thesis_id = $1 UNION SELECT article_id FROM thesis_matches WHERE thesis_id = $1)`, [thesisId]);
  for (const a of arts) {
    const ref = { articleId: a.article_id, ticker: a.ticker, headline: a.headline, url: a.url };
    push(a.published_at, 'article_published', ref);
    push(a.ingested_at, 'article_ingested', ref);
    push(a.checked_at, 'article_evaluated', { ...ref, matched: a.matched });
  }
  for (const m of await listMatches(db, userId, thesisId, { limit: 1000 })) {
    push(m.assessed_at, 'evidence_assessed', { matchId: m.match_id, articleId: m.article_id, assumptionIndex: m.assumption_index, stance: m.stance, relevance: m.relevance, whyItMatters: m.why_it_matters });
  }
  for (const n of await listNotifications(db, userId, thesisId)) {
    push(n.createdAt, 'notification_triggered', { notificationId: n.notificationId, matchId: n.matchId, notificationType: n.type });
    if (n.sentAt) push(n.sentAt, 'notification_sent', { notificationId: n.notificationId, matchId: n.matchId });
    if (n.failedAt) push(n.failedAt, 'notification_failed', { notificationId: n.notificationId, reason: n.reason });
    if (n.status === 'skipped') push(n.lastAttemptAt || n.createdAt, 'notification_skipped', { notificationId: n.notificationId, reason: n.reason });
  }
  const { rows: msgs } = await db.query('SELECT * FROM chat_messages WHERE thesis_id = $1 AND user_id = $2 ORDER BY created_at, seq', [thesisId, userId]);
  for (const m of msgs) push(m.created_at, 'chat_message', { conversationId: m.conversation_id, messageId: m.message_id, role: m.role, text: m.content.slice(0, 300), citations: m.citations.length });
  const ORDER = ['onboarding_started', 'session_action', 'assumptions_confirmed', 'thesis_saved', 'article_published', 'article_ingested', 'article_evaluated', 'evidence_assessed', 'notification_triggered', 'notification_sent', 'notification_failed', 'notification_skipped', 'chat_message'];
  return ev.sort((a, b) => a.at.localeCompare(b.at) || ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
}

module.exports = {
  savedThesisIdForSession,
  newId, ConflictError, isUniqueViolation,
  createUser, getUser,
  getSession, listSessions, createSession, updateSession, recordSessionEvent,
  createThesis, getThesisRow, listTheses, setMonitoring, activeTheses, legacyThesisRow, thesisOut,
  articleKey, upsertArticles,
  checkedArticleIds, recordAssessment, listMatches, getMatchRow, matchesForArticles, matchOut, evidenceItem,
  claimNotification, finishNotification, recoverStaleSending, retryableNotifications, listNotifications, notificationKey,
  NOTIFY_MAX_ATTEMPTS, STALE_SENDING_MINUTES,
  getConversation, listConversations, getMessageRows, saveChatTurn, conversationOut, messageOut, historyEntry,
  thesisTimeline,
};

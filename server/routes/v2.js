// /api/v2: persistent, multi-thesis routes (mounted by server/index.js). Need LOOP_DB=postgres|pglite;
// otherwise every route answers 503 persistence_not_configured. Contracts: docs/persistence.md.
//
// Identity: X-User-Id from POST /api/v2/users. This is a demo identifier, NOT authentication: anyone who
// knows an id can act as that user. Records of other users are always answered as 404.
// Saves are awaited database transactions: a route never reports success before the database confirms it.
const express = require('express');
const persistence = require('../persistence');
const repo = require('../persistence/repo');
const thesisEngine = require('../thesis');
const pipeline = require('../pipeline');
const { TIERS } = require('../scoring');

const router = express.Router();
const ID_RE = /^[A-Za-z0-9_-]{3,80}$/;
const fail = (res, status, code, message, extra = {}) => res.status(status).json({ ok: false, error: { code, message }, ...extra });

router.use((req, res, next) => {
  if (!persistence.isEnabled()) return fail(res, 503, 'persistence_not_configured', 'Saving theses needs the database. Start the server with LOOP_DB=postgres (and DATABASE_URL) or LOOP_DB=pglite.');
  next();
});

// Every handler: storage errors become 503 "not saved" (with no database details), conflicts 409.
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res, persistence.getDb());
  } catch (err) {
    if (err && err.status === 409) return fail(res, 409, err.code, err.message);
    console.error(`[v2] ${req.method} ${req.route ? req.route.path : req.path} failed:`, persistence.redact(err && err.message));
    if (!res.headersSent) fail(res, 503, 'storage_unavailable', 'This was not saved because the database is unavailable. Please try again.');
  }
};

async function currentUser(req, res, db) {
  const id = req.get('x-user-id');
  if (!id || !ID_RE.test(id)) { fail(res, 401, 'missing_user', 'Send the X-User-Id header returned by POST /api/v2/users.'); return null; }
  // The legacy demo user's id is public (it is in the code), so it can never be used here: otherwise anyone
  // could read the legacy thesis's evidence and chats, or pause its monitoring. Legacy routes are unaffected.
  if (id === persistence.DEMO_USER_ID) { fail(res, 403, 'reserved_user', 'This account is reserved for the original single-thesis routes. Create your own user with POST /api/v2/users.'); return null; }
  const user = await repo.getUser(db, id);
  if (!user) { fail(res, 401, 'unknown_user', 'Unknown user id.'); return null; }
  return user;
}
const validId = (x) => typeof x === 'string' && ID_RE.test(x);

// ---------- users ----------
router.post('/users', handle(async (req, res, db) => {
  const b = req.body || {};
  const displayName = typeof b.displayName === 'string' ? b.displayName.trim().slice(0, 80) || null : null;
  const preferences = b.preferences && typeof b.preferences === 'object' && !Array.isArray(b.preferences) && JSON.stringify(b.preferences).length <= 2000 ? b.preferences : {};
  res.status(201).json(await repo.createUser(db, { displayName, preferences }));
}));
router.get('/users/me', handle(async (req, res, db) => {
  const user = await currentUser(req, res, db); if (!user) return;
  res.json(user);
}));

// ---------- onboarding sessions (docs/thesis-session-api.md) ----------
// What the user typed/chose, kept for the timeline (bounded).
function eventPayload(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return {};
  const s = JSON.stringify(p);
  return s.length <= 4000 ? p : { truncated: true, preview: s.slice(0, 4000) };
}
const publicSession = (r, sessionId) => { const { session, ...rest } = r; return { ...rest, sessionId }; };

router.post('/thesis/session', handle(async (req, res, db) => {
  const user = await currentUser(req, res, db); if (!user) return;
  const { sessionId = null, action, payload = {}, expectedVersion = null } = req.body || {};
  if (sessionId != null && !validId(sessionId)) return fail(res, 400, 'invalid_session_id', 'sessionId is not valid.');
  if (expectedVersion != null && !Number.isInteger(expectedVersion)) return fail(res, 400, 'invalid_payload', 'expectedVersion must be an integer.');
  let row = null;
  if (sessionId) {
    row = await repo.getSession(db, user.userId, sessionId);
    if (!row) return fail(res, 404, 'session_not_found', 'No saved onboarding session with this id.');
    if (expectedVersion != null && expectedVersion !== row.version) return fail(res, 409, 'version_conflict', 'This session changed elsewhere. Reload it and try again.', { version: row.version });
  }
  // The stored session is the only input: a session object from the client is never accepted.
  const r = await thesisEngine.handleThesisAction(row ? row.state : null, action, payload, { expectedVersion: row ? row.version : undefined });
  const event = { action: typeof action === 'string' ? action : 'invalid', payload: eventPayload(payload), ok: r.ok, errorCode: r.error && r.error.code };
  const next = { state: r.session, version: r.version, stage: r.stage, nextActions: r.nextActions, displayText: r.displayText };
  if (!row) {
    if (!r.ok) return res.json(publicSession(r, null)); // nothing to resume: don't create an empty session
    const created = await repo.createSession(db, user.userId, next, event);
    return res.status(201).json(publicSession(r, created.session_id));
  }
  if (r.ok && r.changed) await repo.updateSession(db, user.userId, row.session_id, row.version, next, event);
  else await repo.recordSessionEvent(db, user.userId, row.session_id, event, row.stage, row.version);
  res.json(publicSession(r, row.session_id));
}));

router.get('/thesis/sessions', handle(async (req, res, db) => {
  const user = await currentUser(req, res, db); if (!user) return;
  res.json(await repo.listSessions(db, user.userId));
}));

// Resume: what the UI needs to continue (no raw engine state).
router.get('/thesis/session/:id', handle(async (req, res, db) => {
  const user = await currentUser(req, res, db); if (!user) return;
  const row = validId(req.params.id) ? await repo.getSession(db, user.userId, req.params.id) : null;
  if (!row) return fail(res, 404, 'session_not_found', 'No saved onboarding session with this id.');
  const s = row.state || {};
  const td = s.thesisDraft || null;
  res.json({
    sessionId: row.session_id, version: row.version, stage: row.stage, nextActions: row.next_actions, displayText: row.last_display_text,
    history: Array.isArray(s.history) ? s.history : [], profile: s.profile || null,
    selection: s.selection || { pending: [], confirmed: [] },
    // the same picks with names and categories (additive), for the UI
    selectionAssets: { pending: assetsOf((s.selection || {}).pending), confirmed: assetsOf((s.selection || {}).confirmed) },
    // `status` + `assumptions` as before; the other draft fields (additive) let the UI resume the review step.
    draft: td ? resumeDraft(td) : null,
    savedThesisId: await repo.savedThesisIdForSession(db, user.userId, row.session_id),
    createdAt: row.created_at && new Date(row.created_at).toISOString(), updatedAt: row.updated_at && new Date(row.updated_at).toISOString(),
  });
}));

let UNIVERSE = [];
try { UNIVERSE = require('../../scripts/universe'); } catch { UNIVERSE = []; } // the same list the engine uses
const assetsOf = (list) => (Array.isArray(list) ? list : []).map((x) => {
  const sym = x && typeof x === 'object' ? x.symbol : x;
  const u = UNIVERSE.find((a) => a.ticker === sym);
  return { symbol: sym, name: u ? u.companyName : (x && x.name) || null, category: u ? u.category : (x && x.category) || null };
}).filter((a) => typeof a.symbol === 'string');

function resumeDraft(td) {
  const d = td.draft || {};
  return {
    status: td.status, assumptions: d.assumptionDetails || [], confirmedAt: td.confirmedAt || null, revision: td.revision || null,
    goal: d.goal || null, budget: d.budget || null, horizonYears: d.horizonYears == null ? null : d.horizonYears, tier: d.tier || null,
    horizonText: d.horizon && d.horizon.text ? d.horizon.text : null, horizonNote: d.horizonNote || null,
    selectedAssets: Array.isArray(d.selectedAssets) ? d.selectedAssets : [], risks: Array.isArray(d.risks) ? d.risks : [], disclaimer: d.disclaimer || null,
  };
}

// ---------- theses ----------
router.post('/theses', handle(async (req, res, db) => {
  const user = await currentUser(req, res, db); if (!user) return;
  const { sessionId } = req.body || {};
  if (!validId(sessionId)) return fail(res, 400, 'invalid_session_id', 'sessionId is required.');
  const row = await repo.getSession(db, user.userId, sessionId);
  if (!row) return fail(res, 404, 'session_not_found', 'No saved onboarding session with this id.');
  const confirmed = thesisEngine.getConfirmedThesis(row.state);
  if (!confirmed) return fail(res, 409, 'not_confirmed', 'Confirm the assumptions before saving the thesis.');
  if (!TIERS.includes(confirmed.tier) || !Array.isArray(confirmed.assumptions)) return fail(res, 502, 'invalid_thesis', 'The confirmed thesis is invalid.');
  const { row: t, created } = await repo.createThesis(db, user.userId, confirmed, { origin: 'session', sessionId: row.session_id });
  // Evaluate the news already stored for this new thesis now (background, same matching rules, never emails),
  // so its evidence does not wait for the next n8n seed.
  if (created) pipeline.matchStoredFeedFor(t.thesis_id).catch((err) => console.error('[v2] matching the stored news for a new thesis failed:', persistence.redact(err && err.message)));
  res.status(created ? 201 : 200).json({ ...repo.thesisOut(t), created });
}));

router.get('/theses', handle(async (req, res, db) => {
  const user = await currentUser(req, res, db); if (!user) return;
  res.json(await repo.listTheses(db, user.userId));
}));

async function ownThesis(req, res, db) {
  const user = await currentUser(req, res, db); if (!user) return {};
  const t = validId(req.params.id) ? await repo.getThesisRow(db, user.userId, req.params.id) : null;
  if (!t) { fail(res, 404, 'thesis_not_found', 'No saved thesis with this id.'); return {}; }
  return { user, t };
}

router.get('/theses/:id', handle(async (req, res, db) => {
  const { t } = await ownThesis(req, res, db); if (!t) return;
  res.json(repo.thesisOut(t));
}));

router.patch('/theses/:id', handle(async (req, res, db) => {
  const { user, t } = await ownThesis(req, res, db); if (!t) return;
  const status = req.body && req.body.monitoringStatus;
  if (!['active', 'paused'].includes(status)) return fail(res, 400, 'invalid_payload', 'monitoringStatus must be "active" or "paused".');
  res.json(repo.thesisOut(await repo.setMonitoring(db, user.userId, t.thesis_id, status)));
}));

router.get('/theses/:id/matches', handle(async (req, res, db) => {
  const { user, t } = await ownThesis(req, res, db); if (!t) return;
  res.json((await repo.listMatches(db, user.userId, t.thesis_id, { limit: 200 })).map(repo.matchOut));
}));

router.get('/theses/:id/notifications', handle(async (req, res, db) => {
  const { user, t } = await ownThesis(req, res, db); if (!t) return;
  res.json(await repo.listNotifications(db, user.userId, t.thesis_id));
}));

router.get('/theses/:id/timeline', handle(async (req, res, db) => {
  const { user, t } = await ownThesis(req, res, db); if (!t) return;
  res.json({ thesisId: t.thesis_id, events: await repo.thesisTimeline(db, user.userId, t.thesis_id) });
}));

// ---------- thesis chat (docs/thesis-chat-api.md) ----------
const CHAT_EVIDENCE = 30;
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
const sameText = (a, b) => norm(a) === norm(b);
// thesisChat may shorten a long headline (300 chars), so a cited title can be a prefix of the stored one.
const sameHeadline = (stored, cited) => { const s = norm(stored); const c = norm(cited); return Boolean(c) && (s === c || (c.length >= 200 && s.startsWith(c))); };

router.post('/theses/:id/chat', handle(async (req, res, db) => {
  const { user, t } = await ownThesis(req, res, db); if (!t) return;
  const { message, conversationId = null, matchId = null } = req.body || {};
  if (conversationId != null && !validId(conversationId)) return fail(res, 400, 'invalid_conversation_id', 'conversationId is not valid.');
  if (matchId != null && !validId(matchId)) return fail(res, 400, 'invalid_match_id', 'matchId is not valid.');
  let conv = null;
  if (conversationId) {
    conv = await repo.getConversation(db, user.userId, conversationId);
    if (!conv || conv.thesis_id !== t.thesis_id) return fail(res, 404, 'conversation_not_found', 'No conversation with this id for this thesis.');
    if (matchId && matchId !== conv.match_id) return fail(res, 400, 'conversation_mode_fixed', 'A conversation keeps the article it was opened on. Start a new conversation for another article.');
  }
  // An investigation always gets ITS saved article and assessment (loaded by id, however old), as E1.
  const focusId = conv ? conv.match_id : matchId;
  let focus = null;
  if (focusId) {
    focus = await repo.getMatchRow(db, user.userId, focusId);
    if (!focus || focus.thesis_id !== t.thesis_id) return fail(res, 404, 'match_not_found', 'No saved news match with this id for this thesis.');
  }
  const recent = await repo.listMatches(db, user.userId, t.thesis_id, { limit: CHAT_EVIDENCE });
  const rows = focus ? [focus, ...recent.filter((r) => r.match_id !== focus.match_id)] : recent;
  const history = conv ? (await repo.getMessageRows(db, conv.conversation_id)).slice(-20).map((m) => repo.historyEntry(m, t.data.id)) : [];
  const userAt = new Date();
  const result = await thesisEngine.thesisChat(t.data, history, message, { evidence: rows.map(repo.evidenceItem), focus: focus ? 0 : undefined });
  if (!result.ok) return fail(res, result.error.code === 'invalid_message' ? 400 : 422, result.error.code, result.error.message);
  const assistantAt = new Date(Math.max(Date.now(), userAt.getTime() + 1)); // the answer is always after the question
  const mode = focus ? 'investigation' : 'general';
  // Link each citation to the stored evidence it came from (additive: matchId + articleId). thesisChat numbers
  // evidence per request (E1, E2...) and keeps the FIRST row per ticker+headline, in the order we passed
  // (focus first, then newest), so the first row with the same ticker and headline is the cited one.
  result.citations = (result.citations || []).map((c) => {
    const row = rows.find((r) => sameText(r.ticker, c.ticker) && sameHeadline(r.headline, c.title));
    return { ...c, matchId: row ? row.match_id : null, articleId: row ? row.article_id : null };
  });
  const saved = await repo.saveChatTurn(db, {
    userId: user.userId, thesisId: t.thesis_id, conversationId: conv ? conv.conversation_id : null, mode, matchId: focus ? focus.match_id : null,
    title: (focus ? focus.headline : message.trim()).slice(0, 120), userText: message.trim(), userAt,
    assistant: { content: result.reply, citations: result.citations, segments: result.segments,
      meta: { mode: result.mode, source: result.source, model: result.model, fallbackReason: result.fallbackReason, followUps: result.followUps,
        insufficientEvidence: result.insufficientEvidence, removedClaims: result.removedClaims, droppedCitations: result.droppedCitations } },
    assistantAt,
  });
  const { history: _omit, ...rest } = result;
  res.status(conv ? 200 : 201).json({ ...rest, conversationId: saved.conversation.conversation_id, matchId: saved.conversation.match_id,
    userMessageId: saved.userMessage.message_id, assistantMessageId: saved.assistantMessage.message_id,
    askedAt: userAt.toISOString(), answeredAt: assistantAt.toISOString() });
}));

router.get('/theses/:id/conversations', handle(async (req, res, db) => {
  const { user, t } = await ownThesis(req, res, db); if (!t) return;
  res.json(await repo.listConversations(db, user.userId, t.thesis_id));
}));

router.get('/conversations/:id/messages', handle(async (req, res, db) => {
  const user = await currentUser(req, res, db); if (!user) return;
  const conv = validId(req.params.id) ? await repo.getConversation(db, user.userId, req.params.id) : null;
  if (!conv) return fail(res, 404, 'conversation_not_found', 'No conversation with this id.');
  const focus = conv.match_id ? await repo.getMatchRow(db, user.userId, conv.match_id) : null;
  res.json({ ...repo.conversationOut(conv), match: focus ? repo.matchOut(focus) : null, messages: (await repo.getMessageRows(db, conv.conversation_id)).map(repo.messageOut) });
}));

module.exports = router;

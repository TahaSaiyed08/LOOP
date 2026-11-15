// THESIS web app (public/app.html). Vanilla JS, no build step.
// Source of truth: the backend (/api/v2, TigerData). The browser keeps ONE durable value, the demo user id
// (localStorage "thesis.userId"); theses, sessions, evidence and chats are always loaded from the server.
// Educational research, not investment advice.
'use strict';

// ---------- small helpers ----------
const USER_KEY = 'thesis.userId';
const EXPLORE_TIER_KEY = 'thesis.exploreTier';
const ID_RE = /^[A-Za-z0-9_-]{3,80}$/;
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
// Replace an element's content. Flattens arrays and skips null/false (replaceChildren would print "null").
function put(el, ...kids) { el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false).map((k) => (k instanceof Node ? k : document.createTextNode(String(k))))); return el; }
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : null);
function extLink(url, text, cls) {
  const u = safeUrl(url);
  return u ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer', class: cls }, text, h('span', { class: 'sr-only' }, ' (opens in a new tab)')) : h('span', { class: cls }, text);
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: still works for this visit */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
function rel(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = (Date.now() - t) / 1000;
  if (s < -60) return dateTime.format(new Date(t));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) { const d = Math.floor(s / 86400); return `${d} day${d === 1 ? '' : 's'} ago`; }
  return dateOnly.format(new Date(t));
}
function timeTag(iso, prefix) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return h('time', { datetime: new Date(t).toISOString(), title: dateTime.format(new Date(t)) }, prefix ? `${prefix} ` : '', rel(iso));
}
const money = (n) => (Number.isFinite(n) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n % 1 ? 2 : 0 }).format(n) : '—');
const CADENCE = { daily: 'every day', weekly: 'every week', biweekly: 'every two weeks', monthly: 'every month', one_time: 'one time', yearly: 'every year' };
const CATEGORY = {
  index_etf: ['Broad-market ETF', 'One fund that holds hundreds of companies at once, so no single company decides the result.'],
  bond_etf: ['Bond ETF', 'A fund of loans to governments or companies. Usually steadier than stocks, but affected by interest rates.'],
  dividend_etf: ['Dividend ETF', 'A fund of companies that regularly pay part of their profits to shareholders.'],
  sector_etf: ['Sector ETF', 'A fund focused on one industry, such as technology or health care. Less spread out than a broad fund.'],
  reit: ['REIT', 'A company that owns property (offices, apartments, warehouses) and pays out most of its rental income.'],
  large_cap: ['Large company stock', 'A share of one big, established company. Its price depends heavily on that one company.'],
  mid_cap: ['Mid-size company stock', 'A share of one medium-sized company. Often more ups and downs than large companies.'],
  small_cap: ['Small company stock', 'A share of one smaller company. Can grow faster, and can fall faster.'],
  thematic_etf: ['Thematic ETF', 'A fund built around one idea or trend, such as clean energy.'],
  crypto: ['Crypto', 'A digital currency. Prices can swing very sharply in a single day.'],
};
const catName = (c) => (CATEGORY[c] ? CATEGORY[c][0] : c || '');
const STANCE = {
  supports: ['Supports', '▲', 'This news is consistent with the assumption.'],
  challenges: ['Challenges', '▼', 'This news points against the assumption. Worth a closer look.'],
  neutral: ['Neutral', '●', 'Related, but it does not clearly change the assumption.'],
};
function stanceChip(stance) {
  const s = STANCE[stance] || STANCE.neutral;
  return h('span', { class: 'stance', dataset: { stance: STANCE[stance] ? stance : 'neutral' }, title: s[2] }, h('span', { 'aria-hidden': 'true' }, s[1]), ` ${s[0]}`);
}
const statebox = (lines, { error = false, action = null, role } = {}) =>
  h('div', { class: `statebox${error ? ' error' : ''}`, role: role || (error ? 'alert' : 'status') }, lines.map((l) => h('p', {}, l)), action);
const loading = (text = 'Loading…') => h('div', {}, statebox([text]), h('div', { class: 'skel', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
const retryBtn = (fn, label = 'Try again') => h('button', { class: 'btn', type: 'button', onclick: fn }, label);

// ---------- identity (demo-grade, not a login) ----------
let userPromise = null;
function ensureUser() {
  if (userPromise) return userPromise;
  userPromise = (async () => {
    const fromUrl = new URLSearchParams(location.search).get('user');
    if (fromUrl && ID_RE.test(fromUrl) && fromUrl !== 'usr_demo') store.set(USER_KEY, fromUrl);
    const saved = store.get(USER_KEY);
    if (saved && ID_RE.test(saved)) return saved;
    const res = await fetch('/api/v2/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Demo user' }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.userId) throw new ApiError(res.status, body.error && body.error.code, (body.error && body.error.message) || 'Could not create a demo profile.');
    store.set(USER_KEY, body.userId);
    return body.userId;
  })();
  userPromise.catch(() => { userPromise = null; });
  return userPromise;
}
function forgetUser() { store.del(USER_KEY); userPromise = null; }

class ApiError extends Error {
  constructor(status, code, message, body) { super(message); this.status = status; this.code = code || null; this.body = body || null; }
}
// /api/v2 call. An unknown user id (e.g. a different database) is replaced by a new demo profile once.
async function api(method, path, body, { retried = false } = {}) {
  const userId = await ensureUser();
  let res;
  try {
    res = await fetch(`/api/v2${path}`, { method, headers: { 'content-type': 'application/json', 'x-user-id': userId }, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'network', 'The server could not be reached. Check that it is running and try again.');
  }
  const json = await res.json().catch(() => null);
  const err = json && json.error;
  if (res.status === 401 && err && err.code === 'unknown_user' && !retried) { forgetUser(); return api(method, path, body, { retried: true }); }
  if (!res.ok) throw new ApiError(res.status, err && err.code, (err && err.message) || `The server answered HTTP ${res.status}.`, json);
  if (json && json.ok === false) throw new ApiError(422, err && err.code, (err && err.message) || 'That did not work. Please try again.', json);
  return { status: res.status, body: json };
}
function errorBox(err, retry) {
  if (err && err.code === 'persistence_not_configured') {
    return statebox(['Saving theses needs the database, and it is not switched on.', 'Start the server with "npm run start:tigerdata" (or LOOP_DB=pglite for a local database).'], { error: true });
  }
  return statebox(['Something went wrong.', (err && err.message) || 'Unknown error.'], { error: true, action: retry ? retryBtn(retry) : null });
}

// ---------- router ----------
let renderToken = 0;
const view = () => $('#view');
function parseRoute() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  return { parts, query: new URLSearchParams(queryPart) };
}
function setNav(name) {
  document.querySelectorAll('.sitenav a[data-nav]').forEach((a) => { if (a.dataset.nav === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
}
function setTitle(t) { document.title = t ? `${t} · THESIS` : 'THESIS · Investment research companion'; }
async function render() {
  const token = ++renderToken;
  const live = () => token === renderToken;
  const { parts, query } = parseRoute();
  const root = view();
  try {
    if (!parts.length) { setNav('home'); return await renderHome(root, live); }
    if (parts[0] === 'new') { setNav('home'); return renderNew(root); }
    if (parts[0] === 'create' && ID_RE.test(parts[1] || '')) { setNav('home'); return await renderCreate(root, live, parts[1]); }
    if (parts[0] === 'thesis' && ID_RE.test(parts[1] || '')) { setNav('home'); return await renderWorkspace(root, live, parts[1], parts[2] || 'overview', parts[3] || null, query); }
    if (parts[0] === 'explore') { setNav('explore'); return await renderExplore(root, live); }
    setNav(null);
    put(root, statebox(['This page does not exist.'], { action: h('a', { class: 'btn', href: '#/' }, 'Go to my theses') }));
  } catch (err) {
    if (!live()) return;
    console.error(err);
    put(root, errorBox(err, render));
  }
}
window.addEventListener('hashchange', () => { render(); view().focus({ preventScroll: true }); window.scrollTo(0, 0); });

// ---------- Home / My theses ----------
const STAGE_LABEL = {
  onboarding: 'Talking about your goal', selecting: 'Choosing investments', selection_pending: 'Confirming your picks',
  drafting: 'Ready to write the draft', reviewing: 'Reviewing assumptions', confirmed: 'Confirmed, ready to save',
};

async function renderHome(root, live) {
  setTitle('My theses');
  const listBox = h('div', {}, loading('Loading your theses…'));
  const unfinishedBox = h('div');
  put(root, 
    h('section', { class: 'hero' },
      h('p', { class: 'eyebrow' }, 'Your research companion'),
      h('h1', {}, 'Understand your investments, one thesis at a time.'),
      h('p', { class: 'lead' }, 'THESIS listens to your goal, helps you explore investments, turns your choices into a few personal research ideas, and then follows the news against each one, with sources you can open.'),
      h('div', { class: 'hero-actions' },
        h('a', { class: 'btn primary', href: '#/new' }, 'Create a new thesis'),
        h('a', { class: 'btn', href: '#/explore' }, 'Explore market candidates'))),
    h('ol', { class: 'howitworks', 'aria-label': 'How it works' },
      h('li', {}, h('b', {}, 'Talk'), h('span', {}, 'Tell us your goal in your own words. No long forms.')),
      h('li', {}, h('b', {}, 'Choose'), h('span', {}, 'Explore investments explained simply, and pick the ones you want to research.')),
      h('li', {}, h('b', {}, 'Confirm'), h('span', {}, 'Review the assumptions behind your thesis, edit them, then confirm.')),
      h('li', {}, h('b', {}, 'Follow'), h('span', {}, 'See which news supports or challenges each assumption, and ask questions any time.'))),
    h('section', { class: 'section', 'aria-labelledby': 'mytheses' }, h('div', { class: 'sectionhead' }, h('h2', { id: 'mytheses' }, 'My theses'), h('a', { class: 'btn small', href: '#/new' }, '+ New thesis')), listBox),
    unfinishedBox,
    profileCard(),
    h('aside', { class: 'card future' },
      h('p', { class: 'eyebrow' }, 'Idea for later'),
      h('p', {}, 'In future, THESIS could connect to managed-investing platforms (for example Investly) so you could research what you already hold. That is not available today, and THESIS has no partnership with any platform.')),
  );
  let theses; let sessions;
  try {
    [theses, sessions] = await Promise.all([api('GET', '/theses').then((r) => r.body), api('GET', '/thesis/sessions').then((r) => r.body)]);
  } catch (err) {
    if (!live()) return;
    put(listBox, errorBox(err, render));
    return;
  }
  if (!live()) return;
  put(listBox, theses.length
    ? h('div', { class: 'cardgrid' }, theses.map(thesisCard))
    : statebox(['You have no saved theses yet.', 'Create your first one: it takes a few minutes of conversation.'], { action: h('a', { class: 'btn', href: '#/new' }, 'Create a thesis') }));
  const unfinished = sessions.filter((s) => !s.savedThesisId);
  if (unfinished.length) {
    put(unfinishedBox, h('section', { class: 'section', 'aria-labelledby': 'unfinished' },
      h('div', { class: 'sectionhead' }, h('h2', { id: 'unfinished' }, 'Unfinished theses'), h('span', { class: 'quiet' }, 'Pick up where you left off.')),
      h('div', { class: 'cardgrid' }, unfinished.map((s) => h('a', { class: 'card sessioncard', href: `#/create/${s.sessionId}` },
        h('span', { class: 'pill' }, STAGE_LABEL[s.stage] || s.stage),
        h('b', {}, s.goal || 'New thesis (still getting to know your goal)'),
        s.assets && s.assets.length ? h('span', { class: 'assetchips' }, s.assets.map((a) => h('span', { class: 'assetchip' }, a))) : null,
        h('span', { class: 'quiet' }, timeTag(s.updatedAt, 'Last updated'), ' · Resume →'))))));
  }
}
function thesisCard(t) {
  const a = t.activity || {};
  return h('a', { class: 'card thesiscard', href: `#/thesis/${t.thesisId}` },
    h('span', { class: `pill ${t.monitoringStatus === 'active' ? 'on' : 'off'}` }, t.monitoringStatus === 'active' ? 'Following the news' : 'Paused'),
    h('b', { class: 'cardtitle' }, t.goal || 'Untitled thesis'),
    h('span', { class: 'assetchips' }, (t.selectedAssets || []).map((x) => h('span', { class: 'assetchip', title: x.name }, x.symbol))),
    h('span', { class: 'cardmeta' }, `${t.assumptionCount || 0} assumptions · ${a.matches || 0} news item${a.matches === 1 ? '' : 's'}${a.challenges ? ` (${a.challenges} challenging)` : ''} · ${a.conversations || 0} conversation${a.conversations === 1 ? '' : 's'}`),
    h('span', { class: 'quiet' }, timeTag(a.lastActivityAt || t.createdAt, 'Last activity')));
}
function profileCard() {
  const id = store.get(USER_KEY);
  return h('aside', { class: 'card profilenote' },
    h('p', { class: 'eyebrow' }, 'Demo profile'),
    h('p', {}, 'There is no login yet. Your theses are saved in the database under a demo profile id that this browser remembers. Anyone with the id can open them, so do not enter personal details.'),
    id ? h('p', { class: 'quiet' }, 'Profile id: ', h('code', {}, id)) : null,
    h('button', { class: 'btn small', type: 'button', onclick: () => { if (window.confirm('Start over with a new, empty demo profile? Your current theses stay saved under the old id.')) { forgetUser(); render(); } } }, 'Start over with a new demo profile'));
}

// ---------- Create thesis: first message ----------
const STARTERS = ['I want to put $50 a month toward buying a home in about 5 years.', 'I want to grow $100 a month for retirement over 25 years.', 'I keep hearing about NVIDIA and want to understand it before investing $20 every two weeks.'];
function renderNew(root) {
  setTitle('New thesis');
  const input = h('textarea', { id: 'firstmsg', rows: '4', maxlength: '2000', placeholder: 'For example: I want to invest $50 a month for 5 years to save for a home.', 'aria-label': 'Your goal, in your own words' });
  const err = h('p', { class: 'error', role: 'alert' });
  const send = h('button', { class: 'btn primary', type: 'submit' }, 'Start');
  const form = h('form', { class: 'composer', onsubmit: async (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) { err.textContent = 'Tell me a little about your goal to begin.'; input.focus(); return; }
    err.textContent = ''; send.disabled = true; input.disabled = true; send.textContent = 'Thinking…';
    try {
      const r = await api('POST', '/thesis/session', { action: 'onboard', payload: { message } });
      if (!r.body.sessionId) throw new ApiError(422, null, r.body.displayText || 'Could not start a thesis. Please try again.');
      location.replace(`#/create/${r.body.sessionId}`);
    } catch (e2) {
      err.textContent = e2.code === 'persistence_not_configured' ? 'Saving needs the database. Start the server with npm run start:tigerdata.' : e2.message;
      send.disabled = false; input.disabled = false; send.textContent = 'Start';
    }
  } }, input, h('div', { class: 'composerrow' }, err, send));
  put(root, 
    stepper(0),
    h('section', { class: 'chatcol solo' },
      h('h1', {}, 'New thesis'),
      h('div', { class: 'transcript' },
        bubble('assistant', 'Hi! In your own words, what would you like this money to do? For example: how much you can put in, how often, for how long, and what it is for. There are no wrong answers, and I will explain any term along the way.')),
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Example goals' }, STARTERS.map((s) => h('button', { class: 'chip', type: 'button', onclick: () => { input.value = s; input.focus(); } }, s))),
      form));
  input.focus();
}
function bubble(role, text, extra) {
  return h('div', { class: `bubble ${role}` },
    h('span', { class: 'who', 'aria-hidden': 'true' }, role === 'user' ? 'You' : 'THESIS'),
    h('span', { class: 'sr-only' }, role === 'user' ? 'You said: ' : 'THESIS said: '), h('div', { class: 'bubbletext' }, text), extra || null);
}
const STEPS = ['Your goal', 'Explore', 'Choose', 'Draft', 'Confirm & save'];
const STAGE_STEP = { onboarding: 0, selecting: 1, selection_pending: 2, drafting: 3, reviewing: 3, confirmed: 4 };
function stepper(active, done = false) {
  return h('ol', { class: 'stepper', 'aria-label': `Progress: step ${Math.min(active + 1, STEPS.length)} of ${STEPS.length}` }, STEPS.map((s, i) => {
    const state = done || i < active ? 'done' : i === active ? 'now' : 'todo';
    return h('li', { class: state, 'aria-current': !done && i === active ? 'step' : null },
      h('span', { class: 'dot', 'aria-hidden': 'true' }, state === 'done' ? '✓' : String(i + 1)), h('span', { class: 'steplabel' }, s),
      h('span', { class: 'sr-only' }, state === 'done' ? ' (done)' : state === 'now' ? ' (current step)' : ''));
  }));
}
// What each stage is about, as the page heading (the judge should get it at a glance).
const STAGE_HEAD = {
  onboarding: ['Tell THESIS about your goal', 'Answer in your own words. THESIS asks only what it needs, and explains any term along the way.'],
  selecting: ['Explore and choose what to research', 'Kinds of investments, explained simply. Picking one only decides what your thesis studies; nothing is bought.'],
  selection_pending: ['Confirm what to research', 'Check your picks. You can still change them.'],
  drafting: ['Write your thesis draft', 'THESIS turns your goal and picks into a few research ideas you can check against the news.'],
  reviewing: ['Review your thesis draft', 'Read each research idea, edit anything that does not sound like you, then confirm.'],
  confirmed: ['Confirm & save', 'Save the thesis so THESIS can follow the news against each idea.'],
};

// ---------- Create thesis: the conversation + next step ----------
const STAGE_HINT = {
  onboarding: 'Tell me a bit more about your goal, or look at investments on the right.',
  selecting: 'Here is how the main kinds of investments behave, explained simply, on the right. Picking is optional, and you can keep chatting or ask about any term.',
  selection_pending: 'Got it. Please confirm your picks on the right.',
  drafting: 'Your picks are confirmed. Next, I will write a first draft of your thesis.',
  reviewing: 'Here is your draft. Read each assumption on the right, edit anything that does not sound like you, then confirm.',
  confirmed: 'Your assumptions are confirmed. Save the thesis to start following the news.',
};
// What a draft still needs, from the LATEST saved profile (history is shown as it was; guidance is current).
const DRAFT_NEEDS = [['purpose', 'what the money is for'], ['amount', 'roughly how much you will put in'], ['cadence', 'how often you will add money'], ['timelineYears', 'when you will need the money']];
const OPTIONAL = [['riskComfort', 'how you feel about ups and downs'], ['experience', 'how familiar you are with investing']];
const listText = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
function profileGaps(p) {
  const prof = p || {};
  return { needed: DRAFT_NEEDS.filter(([k]) => prof[k] == null).map(([, t]) => t), optional: OPTIONAL.filter(([k]) => prof[k] == null).map(([, t]) => t) };
}
function onboardingHint(s, lastAction) {
  if (lastAction === 'explore') return 'Here is how the main kinds of investments behave, on the right. Looking does not pick anything, and you can keep chatting at any time.';
  const { needed } = profileGaps(s.profile);
  return needed.length ? `To write your thesis draft later, I still need ${listText(needed)}. You can also look at investments on the right at any time.` : STAGE_HINT.selecting;
}
// sessionId -> { result, key }: the explore result and the profile it was computed from (this visit only).
// The intro, time-frame note and per-category notes depend on the profile, so a result only counts while the
// LATEST saved profile still matches; when goal, amount, cadence, timeline or risk comfort change it is stale.
const exploreCache = new Map();
const EXPLORE_FIELDS = ['purpose', 'amount', 'cadence', 'timelineYears', 'riskComfort', 'experience'];
const exploreKey = (profile) => JSON.stringify(EXPLORE_FIELDS.map((k) => (profile && profile[k] != null ? profile[k] : null)));
function currentExplore(ui) {
  const hit = exploreCache.get(ui.sid);
  return hit && hit.key === exploreKey(ui.s.profile) ? hit.result : null;
}
async function renderCreate(root, live, sid) {
  setTitle('New thesis');
  put(root, loading('Loading your thesis conversation…'));
  let s;
  try { s = (await api('GET', `/thesis/session/${sid}`)).body; } catch (err) {
    if (!live()) return;
    put(root, err.status === 404 ? statebox(['This thesis conversation was not found for your demo profile.'], { action: h('a', { class: 'btn', href: '#/' }, 'Go to my theses') }) : errorBox(err, render));
    return;
  }
  if (!live()) return;
  const ui = { s, sid, busy: false, notice: null, lastText: s.displayText, editing: null, confirmChecked: false, selected: new Set(selectionSymbols(s)) };
  const redraw = () => { if (live()) drawCreate(root, ui, live); };
  ui.redraw = redraw;
  ui.act = async (action, payload = {}) => {
    if (ui.busy) return null;
    ui.busy = true; ui.notice = null; ui.lastAction = action; redraw();
    try {
      const r = await api('POST', '/thesis/session', { sessionId: sid, action, payload, expectedVersion: ui.s.version });
      ui.lastText = r.body.displayText || ui.lastText;
      const shownBefore = Boolean(currentExplore(ui));
      ui.s = (await api('GET', `/thesis/session/${sid}`)).body;
      if (action === 'explore' && r.body.result) exploreCache.set(sid, { result: r.body.result, key: exploreKey(ui.s.profile) });
      else if (exploreCache.has(sid) && !currentExplore(ui)) { exploreCache.delete(sid); if (shownBefore) ui.refreshExplore = true; } // profile changed
      ui.selected = new Set(selectionSymbols(ui.s));
      return r.body;
    } catch (err) {
      if (err.status === 409) {
        ui.notice = { error: true, text: 'This thesis changed in another tab or window. Showing the latest version.' };
        try { ui.s = (await api('GET', `/thesis/session/${sid}`)).body; } catch { /* keep the old view */ }
      } else ui.notice = { error: true, text: err.message, code: err.code, body: err.body };
      return null;
    } finally {
      ui.busy = false; redraw();
      // the panel was open on an older profile: fetch it again once, for the profile just saved
      if (ui.refreshExplore) { ui.refreshExplore = false; ui.act('explore'); }
    }
  };
  redraw();
  if (s.stage === 'selecting' && !currentExplore(ui)) ui.act('explore');
}
function selectionSymbols(s) {
  const sel = s.selection || {};
  const list = (sel.pending && sel.pending.length ? sel.pending : sel.confirmed) || [];
  return list.map((a) => (a && typeof a === 'object' ? a.symbol : a)).filter(Boolean);
}
// picks with names (the server expands the stored symbols); plain symbols still work
function picks(s, which) {
  const full = s.selectionAssets && s.selectionAssets[which];
  if (Array.isArray(full)) return full;
  return ((s.selection && s.selection[which]) || []).map((a) => (a && typeof a === 'object' ? a : { symbol: a, name: null, category: null }));
}

function drawCreate(root, ui, live) {
  const s = ui.s;
  const saved = Boolean(s.savedThesisId) && s.stage === 'confirmed';
  const actions = new Set(s.nextActions || []);
  // transcript: the saved conversation, plus the latest step message when it is not already the last reply
  const hist = Array.isArray(s.history) ? s.history : [];
  const lastAssistant = [...hist].reverse().find((m) => m.role === 'assistant');
  // After a panel step (explore, pick, draft...) the engine's long text duplicates the panel: show one short line.
  const tail = ui.lastText && (!lastAssistant || lastAssistant.content !== ui.lastText) ? (saved ? 'This thesis is saved. Open it to see its news and ask questions.' : s.stage === 'onboarding' ? onboardingHint(s, ui.lastAction) : STAGE_HINT[s.stage] || null) : null;
  const transcript = h('div', { class: 'transcript', 'aria-label': 'Conversation' },
    hist.map((m) => bubble(m.role === 'user' ? 'user' : 'assistant', m.content)),
    tail ? bubble('assistant', tail) : null,
    ui.busy ? h('div', { class: 'bubble assistant typing', role: 'status' }, 'Thinking…') : null);

  const canChat = actions.has('onboard') && !saved;
  const input = h('textarea', { rows: '3', maxlength: '2000', disabled: ui.busy || !canChat, placeholder: canChat ? 'Reply, or ask what a term means (for example: "What is an ETF?")' : 'Use the panel to continue.', 'aria-label': 'Your reply', oninput: (e) => { ui.draftText = e.target.value; } });
  input.value = ui.draftText || '';
  const composer = canChat ? h('form', { class: 'composer', onsubmit: (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    ui.act('onboard', { message }).then((out) => { if (out) { ui.draftText = ''; ui.redraw(); } });
  } }, input, h('div', { class: 'composerrow' }, h('span', { class: 'quiet' }, 'Ask about any term, any time.'), h('button', { class: 'btn primary', type: 'submit', disabled: ui.busy }, ui.busy ? 'Thinking…' : 'Send'))) : null;

  const step = saved ? 4 : STAGE_STEP[s.stage] != null ? STAGE_STEP[s.stage] : 0;
  const [title, sub] = saved ? ['Your thesis is saved', 'THESIS now connects new articles to your research ideas.'] : STAGE_HEAD[s.stage] || STAGE_HEAD.onboarding;
  const wide = ['reviewing', 'confirmed'].includes(s.stage) || saved;
  put(root,
    h('header', { class: 'pagehead' },
      h('div', {}, h('p', { class: 'eyebrow' }, 'New thesis'), h('h1', {}, title), h('p', { class: 'lead' }, sub)),
      stepper(step, saved)),
    ui.notice ? h('p', { class: `notice${ui.notice.error ? ' error' : ''}`, role: 'alert' }, ui.notice.text) : null,
    h('div', { class: `creategrid stage-${s.stage}${wide ? ' wide' : ''}` },
      h('section', { class: 'chatcol', 'aria-label': 'Conversation with THESIS' },
        h('div', { class: 'chatcard' },
          h('div', { class: 'chathead' }, h('span', { class: 'avatar-mark', 'aria-hidden': 'true' }, 'T'), h('div', {}, h('b', {}, 'Conversation'), h('span', { class: 'quiet' }, 'Saved after every message'))),
          transcript, composer)),
      h('div', { class: 'panelcol', role: 'region', 'aria-label': 'Current step' }, profileSummary(s.profile, wide), nextStepPanel(ui, actions, saved))));
  const t = $('.transcript', root);
  if (t) t.scrollTop = t.scrollHeight;
  if (composer && !ui.busy && ui.lastAction === 'onboard') input.focus({ preventScroll: true });
}

function profileSummary(p, compact) {
  if (!p) return null;
  const rows = [
    ['Goal', p.purpose ? p.purpose.charAt(0).toUpperCase() + p.purpose.slice(1) : null],
    ['Contribution', p.amount != null ? `${money(p.amount)}${p.cadence ? ` ${CADENCE[p.cadence] || p.cadence}` : ''}` : null],
    ['Time frame', p.timelineYears != null ? `${p.timelineYears} year${p.timelineYears === 1 ? '' : 's'}` : null],
    ['Comfort with ups and downs', p.riskComfort],
    ['Experience', p.experience],
  ];
  if (compact) return null; // the draft shows its own summary
  return h('section', { class: 'card compact profilecard-mini', 'aria-label': 'What THESIS understood so far' },
    h('p', { class: 'label' }, 'What I understood so far'),
    h('dl', { class: 'tiles' }, rows.map(([k, v]) => h('div', { class: `tile${v ? '' : ' missing'}` }, h('dt', {}, k), h('dd', {}, v || 'not yet')))));
}

function nextStepPanel(ui, actions, saved) {
  const s = ui.s;
  const busy = ui.busy;
  const btn = (label, onclick, primary = false, disabled = false) => h('button', { class: `btn${primary ? ' primary' : ''}`, type: 'button', disabled: busy || disabled, onclick }, label);
  if (saved) {
    return h('section', { class: 'card' }, h('h2', { class: 'cardh' }, 'Saved'), h('p', {}, 'This thesis is saved. News will be connected to its assumptions, and you can ask the research assistant about it any time.'),
      h('a', { class: 'btn primary', href: `#/thesis/${s.savedThesisId}` }, 'Open the thesis'));
  }
  switch (s.stage) {
    case 'onboarding': {
      const gaps = profileGaps(s.profile);
      const explored = Boolean(currentExplore(ui));
      return h('div', {},
        h('section', { class: 'card' }, h('h2', { class: 'cardh' }, 'What I still need'),
          gaps.needed.length
            ? h('p', {}, `To write your thesis draft later, I still need ${listText(gaps.needed)}. Answer on the left in your own words.`)
            : h('p', {}, 'I have what I need about your goal.'),
          gaps.optional.length ? h('p', { class: 'quiet' }, `Optional: ${listText(gaps.optional)}. You can skip these.`) : null,
          actions.has('explore') && !explored ? h('p', { class: 'quiet' }, 'You can look at investments at any time. Looking does not pick anything.') : null,
          actions.has('explore') && !explored ? btn(busy && ui.lastAction === 'explore' ? 'Loading…' : 'Show investments to explore', () => ui.act('explore')) : null),
        explored ? explorePanel(ui) : null);
    }
    case 'selecting':
    case 'selection_pending':
    case 'drafting': {
      const parts = [];
      if (s.stage === 'selection_pending') {
        const pending = picks(s, 'pending');
        parts.push(h('section', { class: 'card highlight' }, h('h2', { class: 'cardh' }, 'Confirm your picks'),
          h('p', {}, 'You chose these to research. Nothing is bought: this only decides what your thesis is about.'),
          h('ul', { class: 'picklist' }, pending.map((a) => h('li', {}, h('b', {}, a.symbol), ` ${a.name || ''}`, a.category ? h('span', { class: 'quiet' }, ` · ${catName(a.category)}`) : null))),
          h('div', { class: 'row' }, btn('Yes, research these', () => ui.act('confirmSelection'), true))));
      }
      if (s.stage === 'drafting') {
        const confirmed = picks(s, 'confirmed');
        parts.push(h('section', { class: 'card highlight' }, h('h2', { class: 'cardh' }, 'Write the draft'),
          h('p', {}, `Your picks are confirmed: ${confirmed.map((a) => a.symbol).join(', ')}. Next, I will write a first draft of your thesis: your goal, the assumptions behind it, and what would challenge each one.`),
          btn(busy ? 'Writing your draft…' : 'Write my thesis draft', () => ui.act('createDraft'), true),
          h('p', { class: 'quiet' }, 'This can take a few seconds.')));
      }
      parts.push(explorePanel(ui));
      return h('div', {}, parts);
    }
    case 'reviewing':
      return draftPanel(ui);
    case 'confirmed':
      if (ui.forceReview) return draftPanel(ui);
      return h('section', { class: 'card highlight' }, h('h2', { class: 'cardh' }, 'Save your thesis'),
        h('p', {}, 'Your assumptions are confirmed. Save the thesis so news can be connected to it and you can come back to it any time.'),
        s.draft ? draftSummary(s.draft) : null,
        h('div', { class: 'row' },
          btn(busy ? 'Saving…' : 'Save thesis', async () => {
            ui.busy = true; ui.redraw();
            try {
              const r = await api('POST', '/theses', { sessionId: ui.sid });
              location.hash = `#/thesis/${r.body.thesisId}`;
            } catch (err) { ui.busy = false; ui.notice = { error: true, text: err.message }; ui.redraw(); }
          }, true),
          actions.has('editAssumption') ? btn('Edit an assumption', () => { ui.forceReview = true; ui.redraw(); }) : null),
        h('p', { class: 'quiet' }, 'Editing an assumption returns the thesis to review, and you confirm it again.'));
    default:
      return statebox([`Unknown step: ${s.stage}`]);
  }
}

const EXPLORE_FIRST = 4; // kinds shown before "show more": a beginner sees a few, not dozens of tickers
function explorePanel(ui) {
  const result = currentExplore(ui);
  if (!result) {
    return h('section', { class: 'card' }, h('h2', { class: 'cardh' }, 'Explore investments'),
      h('p', {}, 'See the main kinds of investments you can research, explained in plain words.'),
      h('button', { class: 'btn', type: 'button', disabled: ui.busy, onclick: () => ui.act('explore') }, ui.busy ? 'Loading…' : 'Show investments to explore'));
  }
  const max = 5;
  const count = h('span', { class: 'quiet', 'aria-live': 'polite' });
  const useBtn = h('button', { class: 'btn primary', type: 'button' }, 'Use these investments');
  const refresh = () => {
    count.textContent = ui.selected.size ? `Selected ${ui.selected.size} of ${max}: ${[...ui.selected].join(', ')}` : 'Nothing picked yet. Pick 1 to 5 when you are ready.';
    useBtn.disabled = ui.busy || !ui.selected.size;
    root.querySelectorAll('input[type=checkbox][data-symbol]').forEach((c) => { c.disabled = ui.busy || (!c.checked && ui.selected.size >= max); });
  };
  useBtn.onclick = () => ui.act('selectAssets', { symbols: [...ui.selected] });
  const all = result.categories || [];
  const context = all.filter((c) => c.selectable === false);
  const kinds = all.filter((c) => c.selectable !== false);
  const showAll = ui.showAllKinds || kinds.slice(EXPLORE_FIRST).some((c) => (c.assets || []).some((a) => ui.selected.has(a.symbol)));
  const visible = showAll ? kinds : kinds.slice(0, EXPLORE_FIRST);
  // the same time-frame warning is often attached to every kind: say it once
  const seenNotes = new Set(result.horizonNote ? [result.horizonNote] : []);
  const note = (t) => { if (!t || seenNotes.has(t)) return null; seenNotes.add(t); return t; };
  const kindCard = (c) => {
    const fit = note(c.fitNote);
    const n = (c.assets || []).length;
    return h('details', { class: 'category', open: (c.assets || []).some((a) => ui.selected.has(a.symbol)) || null },
      h('summary', {}, h('span', { class: 'cattitle' }, h('b', {}, c.name), c.plainExplanation ? h('span', { class: 'catline' }, c.plainExplanation) : null),
        h('span', { class: 'catmeta' }, c.volatility ? h('span', { class: `pill vol-${String(c.volatility).replace(/\s+/g, '-')}` }, `Ups and downs: ${c.volatility}`) : null, n ? h('span', { class: 'quiet' }, `${n} to research`) : null)),
      h('div', { class: 'catbody' },
        c.howItBehaves ? h('p', {}, c.howItBehaves) : null,
        fit ? h('p', { class: 'fitnote' }, h('b', {}, 'For your goal: '), fit) : null,
        h('div', { class: 'assetpick' }, (c.assets || []).map((a) => {
          const box = h('input', { type: 'checkbox', 'data-symbol': a.symbol, checked: ui.selected.has(a.symbol) || null, onchange: (e) => { if (e.target.checked) ui.selected.add(a.symbol); else ui.selected.delete(a.symbol); refresh(); } });
          return h('label', { class: 'assetoption' }, box, h('b', {}, a.symbol), h('span', {}, a.name || ''));
        }))));
  };
  const root = h('section', { class: 'card explore' },
    h('div', { class: 'cardtop' }, h('h2', { class: 'cardh' }, 'Explore & learn'), h('span', { class: 'pill' }, 'Researching is not buying')),
    result.intro ? h('p', {}, result.intro) : null,
    result.horizonNote ? h('p', { class: 'fitnote' }, h('b', {}, 'About your time frame: '), result.horizonNote) : null,
    context.map((c) => h('div', { class: 'category context' },
      h('p', { class: 'label' }, 'Often compared for money you need soon'),
      h('b', {}, 'Savings accounts and GICs'),
      c.plainExplanation ? h('p', {}, c.plainExplanation) : null,
      h('p', { class: 'quiet' }, 'Shown for comparison only. They are not stocks or ETFs, so THESIS cannot research them here.'))),
    h('p', { class: 'quiet' }, 'Open a kind to see what you could research. Picking only decides what your thesis studies, and you can change it before confirming.'),
    h('div', { class: 'categories' }, visible.map(kindCard)),
    kinds.length > EXPLORE_FIRST ? h('button', { class: 'linkbtn', type: 'button', 'aria-expanded': String(showAll), onclick: () => { ui.showAllKinds = !showAll; ui.redraw(); } },
      showAll ? 'Show fewer kinds' : `Show ${kinds.length - EXPLORE_FIRST} more kinds of investments`) : null,
    h('div', { class: 'stickyrow' }, count, useBtn));
  refresh();
  return root;
}

function draftSummary(d) {
  const contrib = d.budget ? (d.budget.amount > 0 ? `${money(d.budget.amount)} ${CADENCE[d.budget.cadence] || d.budget.cadence || ''}` : 'Not stated') : null;
  return h('div', { class: 'draftsummary' },
    d.goal ? h('div', { class: 'goalline' }, h('span', { class: 'label' }, 'Goal'), h('p', {}, d.goal)) : null,
    h('dl', { class: 'tiles' },
      contrib ? h('div', { class: 'tile' }, h('dt', {}, 'Contribution'), h('dd', {}, contrib)) : null,
      h('div', { class: 'tile' }, h('dt', {}, 'Time frame'), h('dd', {}, d.horizonText || (d.horizonYears ? `${d.horizonYears} years` : 'Not stated'))),
      d.profile && d.profile.riskComfort ? h('div', { class: 'tile' }, h('dt', {}, 'Comfort with ups and downs'), h('dd', {}, d.profile.riskComfort)) : null),
    d.selectedAssets && d.selectedAssets.length ? h('div', { class: 'researching' }, h('span', { class: 'label' }, 'Researching'),
      h('ul', { class: 'assetlist' }, d.selectedAssets.map((a) => h('li', {}, h('b', {}, a.symbol), h('span', {}, a.name || ''), a.category ? h('small', {}, catName(a.category)) : null)))) : null);
}

function draftPanel(ui) {
  const d = ui.s.draft || { assumptions: [] };
  const busy = ui.busy;
  const notice = ui.notice;
  const list = (d.assumptions || []).map((a, i) => {
    const n = i + 1;
    if (ui.editing === i) {
      const text = h('textarea', { rows: '3', maxlength: '400', 'aria-label': `Assumption ${n}` }); text.value = a.text || '';
      const chal = h('textarea', { rows: '2', maxlength: '400', 'aria-label': `What would challenge assumption ${n}` }); chal.value = a.whatWouldChallengeIt || '';
      return h('li', { class: 'assumption editing' },
        h('label', {}, h('span', { class: 'label' }, `Research idea ${n}`), text),
        h('label', {}, h('span', { class: 'label' }, 'What would challenge it (the news to watch for)'), chal),
        notice && notice.code === 'challenge_decision_needed' ? h('p', { class: 'error' }, notice.text) : null,
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', type: 'button', disabled: busy, onclick: async () => {
            const newText = text.value.trim(); const newChal = chal.value.trim();
            const textChanged = newText !== (a.text || '').trim(); const chalChanged = newChal !== (a.whatWouldChallengeIt || '').trim();
            if (!textChanged && !chalChanged) { ui.editing = null; ui.redraw(); return; }
            const payload = { number: n };
            if (textChanged) payload.text = newText;
            if (chalChanged) payload.challenge = newChal; else if (textChanged) payload.keepChallenge = true;
            const out = await ui.act('editAssumption', payload);
            if (out) { ui.editing = null; ui.confirmChecked = false; ui.forceReview = false; ui.redraw(); }
          } }, busy ? 'Saving…' : 'Save change'),
          h('button', { class: 'btn', type: 'button', disabled: busy, onclick: () => { ui.editing = null; ui.notice = null; ui.redraw(); } }, 'Cancel')));
    }
    return h('li', { class: 'assumption' },
      h('div', { class: 'ahead' }, h('span', { class: 'anum', 'aria-hidden': 'true' }, String(n)),
        h('span', { class: 'assetchips' }, (a.tickers || []).map((t) => h('span', { class: 'assetchip' }, t))),
        h('button', { class: 'btn small ghost', type: 'button', disabled: busy || ui.editing != null, 'aria-label': `Edit research idea ${n}`, onclick: () => { ui.editing = i; ui.notice = null; ui.redraw(); } }, 'Edit')),
      h('p', { class: 'atext' }, h('span', { class: 'sr-only' }, `Research idea ${n}: `), a.text),
      h('div', { class: 'achal' }, h('span', { class: 'label' }, 'What would challenge it'), h('p', {}, a.whatWouldChallengeIt || 'not set')));
  });
  const check = h('input', { type: 'checkbox', id: 'confirmcheck', checked: ui.confirmChecked || null, disabled: busy || ui.editing != null, onchange: (e) => { ui.confirmChecked = e.target.checked; confirmBtn.disabled = busy || !ui.confirmChecked; } });
  const confirmBtn = h('button', { class: 'btn primary', type: 'button', disabled: busy || !ui.confirmChecked || ui.editing != null, onclick: () => ui.act('confirmAssumptions') }, busy ? 'Confirming…' : 'Confirm research ideas');
  const confirmedStage = ui.s.stage === 'confirmed';
  return h('div', { class: 'draft' },
    h('section', { class: 'card' },
      h('div', { class: 'cardtop' }, h('h2', { class: 'cardh' }, 'Your thesis draft'), h('span', { class: `pill${confirmedStage ? ' on' : ''}` }, confirmedStage ? 'Confirmed · not saved yet' : 'Proposed · not saved')),
      draftSummary({ ...d, profile: ui.s.profile })),
    h('section', { class: 'card' },
      h('div', { class: 'cardtop' }, h('h2', { class: 'cardh' }, 'Research ideas to check against the news'), h('span', { class: 'quiet' }, `${(d.assumptions || []).length} ideas`)),
      h('p', { class: 'quiet' }, 'Each idea is something worth finding out, not a prediction. After you save, THESIS shows which news supports or challenges each one.'),
      h('ol', { class: 'assumptions' }, list)),
    d.risks && d.risks.length ? h('section', { class: 'card risks' },
      h('div', { class: 'cardtop' }, h('h2', { class: 'cardh' }, 'Risks to keep in mind'), h('span', { class: 'quiet' }, `${d.risks.length}`)),
      riskList(d.risks)) : null,
    h('section', { class: 'card highlight confirmcard' },
      confirmedStage
        ? h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', disabled: busy, onclick: () => { ui.forceReview = false; ui.editing = null; ui.redraw(); } }, 'Done, keep them as confirmed'))
        : [h('label', { class: 'confirmline', for: 'confirmcheck' }, check, h('span', {}, 'I have read these research ideas and they describe what I want to find out.')),
          h('div', { class: 'row spread' }, confirmBtn,
            h('button', { class: 'btn ghost', type: 'button', disabled: busy, onclick: () => { if (window.confirm('Write a new draft? Your edits to this draft will be replaced.')) ui.act('createDraft'); } }, 'Write a new draft'))],
      h('p', { class: 'quiet' }, d.disclaimer || 'Educational research, not investment advice.')));
}

// ---------- Thesis workspace ----------
async function renderWorkspace(root, live, id, tab, sub, query) {
  put(root, loading('Opening your thesis…'));
  let t;
  try { t = (await api('GET', `/theses/${id}`)).body; } catch (err) {
    if (!live()) return;
    put(root, err.status === 404 ? statebox(['This thesis was not found for your demo profile.'], { action: h('a', { class: 'btn', href: '#/' }, 'Go to my theses') }) : errorBox(err, render));
    return;
  }
  if (!live()) return;
  setTitle(t.goal || 'Thesis');
  const data = t.thesis || {};
  const body = h('div', { class: 'tabbody' });
  const tabs = [['overview', 'Overview', ''], ['evidence', 'News evidence', '/evidence'], ['chat', 'Research chat', '/chat']];
  const monitoring = t.monitoringStatus === 'active';
  const toggle = h('button', { class: 'btn small', type: 'button', onclick: async () => {
    toggle.disabled = true;
    try { await api('PATCH', `/theses/${id}`, { monitoringStatus: monitoring ? 'paused' : 'active' }); render(); } catch (err) { toggle.disabled = false; window.alert(err.message); }
  } }, monitoring ? 'Pause news monitoring' : 'Resume news monitoring');
  put(root, 
    h('p', { class: 'crumbs' }, h('a', { href: '#/' }, '← My theses')),
    h('header', { class: 'wshead' },
      h('div', {}, h('p', { class: 'eyebrow' }, 'Thesis'), h('h1', {}, t.goal || 'Untitled thesis'),
        h('p', { class: 'assetchips' }, (t.selectedAssets || []).map((a) => h('span', { class: 'assetchip', title: `${a.name || ''}${a.category ? ` · ${catName(a.category)}` : ''}` }, a.symbol)))),
      h('div', { class: 'wsstatus' }, h('span', { class: `pill ${monitoring ? 'on' : 'off'}` }, monitoring ? 'Following the news' : 'Monitoring paused'), toggle)),
    h('nav', { class: 'tabs wstabs', 'aria-label': 'Thesis sections' }, tabs.map(([key, label, suffix]) => h('a', { href: `#/thesis/${id}${suffix}`, class: 'tab', 'aria-current': tab === key ? 'page' : null }, label))),
    body);
  if (tab === 'evidence') return renderEvidence(body, live, t, query);
  if (tab === 'chat') return renderChat(body, live, t, sub, query);
  return renderOverview(body, live, t, data);
}

async function renderOverview(body, live, t, data) {
  const alerts = h('div', {}, loading('Loading alerts…'));
  const activity = h('div');
  const assumptions = Array.isArray(t.assumptions) ? t.assumptions : [];
  put(body, 
    h('div', { class: 'overviewgrid' },
      h('section', { class: 'card' }, h('h2', { class: 'cardh' }, 'Your plan'),
        h('dl', { class: 'facts' },
          h('div', {}, h('dt', {}, 'Goal'), h('dd', {}, t.goal || 'Not stated')),
          h('div', {}, h('dt', {}, 'Contribution'), h('dd', {}, data.budget && data.budget.amount > 0 ? `${money(data.budget.amount)} ${CADENCE[data.budget.cadence] || data.budget.cadence || ''}` : 'Not stated')),
          h('div', {}, h('dt', {}, 'Time frame'), h('dd', {}, (data.horizon && data.horizon.text) || (data.horizonYears > 0 ? `${data.horizonYears} years` : 'Not stated'))),
          h('div', {}, h('dt', {}, 'Confirmed'), h('dd', {}, timeTag(t.assumptionsConfirmedAt || t.confirmedAt) || '—'))),
        h('h3', {}, 'Investments you chose'),
        h('ul', { class: 'picklist' }, (t.selectedAssets || []).map((a) => h('li', {}, h('b', {}, a.symbol), ` ${a.name || ''}`, a.category ? h('span', { class: 'quiet' }, ` · ${catName(a.category)}`) : null, CATEGORY[a.category] ? h('small', { class: 'explain' }, CATEGORY[a.category][1]) : null)))),
      h('section', { class: 'card' }, h('h2', { class: 'cardh' }, 'Your confirmed assumptions'),
        h('p', { class: 'quiet' }, 'News is checked against these. "What would challenge it" is the kind of news that would make you rethink.'),
        h('ol', { class: 'assumptions' }, assumptions.map((a, i) => h('li', { class: 'assumption' },
          h('p', { class: 'atext' }, h('b', {}, `${i + 1}. `), a.text),
          h('p', { class: 'achal' }, h('span', { class: 'label' }, 'What would challenge it: '), a.whatWouldChallengeIt || 'not set')))),
        h('div', { class: 'row' }, h('a', { class: 'btn primary', href: `#/thesis/${t.thesisId}/chat` }, 'Ask the research assistant'), h('a', { class: 'btn', href: `#/thesis/${t.thesisId}/evidence` }, 'See news evidence')))),
    Array.isArray(data.risks) && data.risks.length ? h('details', { class: 'card risks' }, h('summary', {}, `Risks to keep in mind (${data.risks.length})`), riskList(data.risks)) : null,
    h('section', { class: 'card' }, h('h2', { class: 'cardh' }, 'Alerts'), alerts),
    activity);
  try {
    const [n, tl] = await Promise.all([api('GET', `/theses/${t.thesisId}/notifications`).then((r) => r.body), api('GET', `/theses/${t.thesisId}/timeline`).then((r) => r.body)]);
    if (!live()) return;
    const NOTE = { sent: 'Email sent', skipped: 'Not emailed', failed: 'Email failed', pending: 'Waiting to send', sending: 'Sending' };
    put(alerts, n.length
      ? h('ul', { class: 'alertlist' }, n.map((x) => h('li', {}, stanceChip('challenges'), ' ', h('b', {}, (x.payload && x.payload.headline) || 'News item'), h('span', { class: 'quiet' }, ` · ${NOTE[x.status] || x.status}`, x.reason ? ` (${x.reason})` : '', ' · ', timeTag(x.createdAt)))))
      : h('p', { class: 'quiet' }, 'No alerts. When news challenges one of your assumptions, it is recorded here (and emailed once email is set up for this demo).'));
    const LABEL = { onboarding_started: 'Started the conversation', assumptions_confirmed: 'Confirmed the assumptions', thesis_saved: 'Saved the thesis', article_ingested: 'News article received', evidence_assessed: 'News checked against the thesis', chat_message: 'Research chat', notification_triggered: 'Alert created', notification_sent: 'Alert emailed', notification_skipped: 'Alert recorded (not emailed)', notification_failed: 'Alert email failed' };
    const events = (tl.events || []).filter((e) => LABEL[e.type]).slice(-8).reverse();
    if (events.length) put(activity, h('section', { class: 'card' }, h('h2', { class: 'cardh' }, 'Recent activity'), h('ul', { class: 'activity' }, events.map((e) => h('li', {}, h('span', {}, LABEL[e.type]), h('span', { class: 'quiet' }, timeTag(e.at)))))));
  } catch (err) {
    if (!live()) return;
    put(alerts, errorBox(err));
  }
}

async function renderEvidence(body, live, t, query) {
  put(body, loading('Loading news evidence…'));
  let matches;
  try { matches = (await api('GET', `/theses/${t.thesisId}/matches`)).body; } catch (err) { if (live()) put(body, errorBox(err, render)); return; }
  if (!live()) return;
  const assumptions = Array.isArray(t.assumptions) ? t.assumptions : [];
  const intro = h('div', { class: 'legend' },
    h('p', {}, 'Each news item is linked to one of your assumptions. ', stanceChip('supports'), ' consistent with it · ', stanceChip('challenges'), ' points against it · ', stanceChip('neutral'), ' related, no clear change.'),
    h('p', { class: 'quiet' }, 'THESIS reads the headline and a short summary, not the full article. Open the original source to read more.'));
  if (!matches.length) {
    put(body, intro, statebox(['No news is connected to this thesis yet.', t.monitoringStatus === 'active' ? 'News is checked after each daily update. New theses are checked against the latest news right after saving, so if this stays empty there was no related news in it.' : 'Monitoring is paused, so new news is not checked.'], { action: h('a', { class: 'btn', href: `#/thesis/${t.thesisId}/chat` }, 'Ask the research assistant instead') }));
    return;
  }
  const groups = new Map();
  for (const m of matches) { const k = Number.isInteger(m.assumptionIndex) ? m.assumptionIndex : -1; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
  const focus = query.get('focus');
  put(body, intro, [...groups.keys()].sort((a, b) => a - b).map((k) => h('section', { class: 'evgroup' },
    h('h2', { class: 'cardh' }, k >= 0 ? `Assumption ${k + 1}` : 'Other news', k >= 0 && assumptions[k] ? h('span', { class: 'quiet evassumption' }, assumptions[k].text) : null),
    groups.get(k).map((m) => evidenceCard(t, m, m.matchId === focus)))));
  if (focus) { const el = document.getElementById(`ev-${focus}`); if (el) { el.scrollIntoView({ block: 'center' }); el.focus({ preventScroll: true }); } }
}
function evidenceCard(t, m, focused) {
  const a = m.article || {};
  return h('article', { class: `card evcard${focused ? ' focused' : ''}`, id: `ev-${m.matchId}`, tabindex: '-1' },
    h('div', { class: 'evtop' }, stanceChip(m.stance), a.ticker ? h('span', { class: 'assetchip' }, a.ticker) : null),
    h('h3', { class: 'evheadline' }, extLink(a.url, a.headline || 'Untitled article')),
    h('p', { class: 'quiet' }, a.publisher || 'Unknown publisher', a.publishedAt ? [' · ', timeTag(a.publishedAt, 'published')] : null),
    a.summary ? h('p', { class: 'evsummary' }, a.summary) : h('p', { class: 'quiet' }, 'Only the headline is available for this article.'),
    m.whyItMatters ? h('p', {}, h('b', {}, 'Why it matters: '), m.whyItMatters) : null,
    h('p', { class: 'quiet small' }, m.unanalyzed ? 'Quick first-pass check (the AI was unavailable); it will be checked again.' : 'Checked by AI', ' · ', timeTag(m.assessedAt, 'assessed')),
    h('div', { class: 'row' }, h('a', { class: 'btn small primary', href: `#/thesis/${t.thesisId}/chat/new?match=${encodeURIComponent(m.matchId)}` }, 'Investigate with AI'), safeUrl(a.url) ? extLink(a.url, 'Open original source', 'btn small') : null));
}

// ---------- Research chat ----------
// Risks: "about your goal" (timeline, feelings about losses) apart from "about the investments you picked".
// Older drafts have no scope, so they render as one plain list.
function riskList(risks) {
  const item = (r) => h('li', { class: 'riskitem' }, h('b', {}, r.title || ''), r.explanation ? h('p', {}, r.explanation) : null);
  const goal = risks.filter((r) => r.scope === 'goal');
  const inv = risks.filter((r) => r.scope !== 'goal');
  if (!goal.length || !inv.length) return h('ul', { class: 'risklist' }, risks.map(item));
  return h('div', { class: 'riskgroups' },
    h('div', {}, h('p', { class: 'label' }, 'About your goal'), h('ul', { class: 'risklist' }, goal.map(item))),
    h('div', {}, h('p', { class: 'label' }, 'About the investments you picked'), h('ul', { class: 'risklist' }, inv.map(item))));
}

const SUGGEST_GENERAL = ['Can you explain my thesis in simple terms?', 'What are the main risks in my thesis?', 'What news should I watch for?'];
const SUGGEST_ARTICLE = ['What does this article mean for my thesis?', 'Which assumption does it affect, and how much?', 'What would I need to see next to be more confident?'];

async function renderChat(body, live, t, convId, query) {
  put(body, loading('Loading conversations…'));
  let convs;
  try { convs = (await api('GET', `/theses/${t.thesisId}/conversations`)).body; } catch (err) { if (live()) put(body, errorBox(err, render)); return; }
  if (!live()) return;
  const side = h('aside', { class: 'convlist', 'aria-label': 'Conversations' },
    h('a', { class: 'btn small primary', href: `#/thesis/${t.thesisId}/chat/new` }, '+ New conversation'),
    convs.length ? h('ul', {}, convs.map((c) => h('li', {}, h('a', { href: `#/thesis/${t.thesisId}/chat/${c.conversationId}`, 'aria-current': c.conversationId === convId ? 'page' : null },
      h('span', { class: 'pill' }, c.mode === 'investigation' ? 'Article' : 'General'), h('b', {}, c.title || 'Conversation'),
      h('span', { class: 'quiet' }, `${c.messageCount} message${c.messageCount === 1 ? '' : 's'} · `, timeTag(c.updatedAt)))))) : h('p', { class: 'quiet' }, 'No conversations yet.'));
  const main = h('section', { class: 'chatmain' });
  put(body, h('div', { class: 'chatgrid' }, side, main));

  // which conversation: an existing one, a new investigation (?match=) or a new general one
  if (convId && convId !== 'new') return openConversation(main, live, t, convId);
  const matchId = convId === 'new' ? query.get('match') : null;
  let focus = null;
  if (matchId) {
    try { focus = (await api('GET', `/theses/${t.thesisId}/matches`)).body.find((m) => m.matchId === matchId) || null; } catch { focus = null; }
    if (!live()) return;
    if (!focus) { put(main, statebox(['That news item was not found for this thesis.'], { action: h('a', { class: 'btn', href: `#/thesis/${t.thesisId}/evidence` }, 'Back to evidence') })); return; }
  }
  if (!convId && convs.length) { location.replace(`#/thesis/${t.thesisId}/chat/${convs[0].conversationId}`); return; }
  drawConversation(main, live, t, { conversationId: null, matchId, focus, messages: [] });
}

async function openConversation(main, live, t, convId) {
  put(main, loading('Opening the conversation…'));
  let c;
  try { c = (await api('GET', `/conversations/${convId}/messages`)).body; } catch (err) {
    if (!live()) return;
    put(main, err.status === 404 ? statebox(['This conversation was not found.'], { action: h('a', { class: 'btn', href: `#/thesis/${t.thesisId}/chat/new` }, 'Start a new conversation') }) : errorBox(err, render));
    return;
  }
  if (!live()) return;
  if (c.thesisId !== t.thesisId) { location.replace(`#/thesis/${c.thesisId}/chat/${convId}`); return; }
  drawConversation(main, live, t, { conversationId: c.conversationId, matchId: c.matchId, focus: c.match, messages: c.messages || [] });
}

function drawConversation(main, live, t, conv) {
  const state = { sending: false, pending: null, error: null };
  const isInvestigation = Boolean(conv.matchId);
  const draw = () => {
    const last = [...conv.messages].reverse().find((m) => m.role === 'assistant');
    const followUps = !state.sending && last && last.meta && Array.isArray(last.meta.followUps) ? last.meta.followUps.slice(0, 3) : [];
    const suggestions = conv.messages.length ? followUps : (isInvestigation ? SUGGEST_ARTICLE : SUGGEST_GENERAL);
    const input = h('textarea', { rows: '3', maxlength: '2000', disabled: state.sending, placeholder: isInvestigation ? 'Ask about this article and your thesis…' : 'Ask anything about your thesis…', 'aria-label': 'Your question', oninput: (e) => { state.draft = e.target.value; } });
    input.value = state.draft || '';
    const send = (text) => ask(text);
    put(main, 
      h('header', { class: 'chathead' },
        h('p', { class: 'eyebrow' }, isInvestigation ? 'Investigating an article' : 'Research chat'),
        h('p', { class: 'quiet' }, isInvestigation ? 'This conversation is about one news item and how it relates to your confirmed assumptions.' : 'Ask about your thesis, its investments or the news connected to it. Answers cite their sources.')),
      conv.focus ? focusCard(t, conv.focus) : null,
      h('div', { class: 'messages', 'aria-label': 'Messages' },
        conv.messages.length ? conv.messages.map((m) => messageView(t, m)) : h('p', { class: 'quiet' }, 'No messages yet. Ask your first question below.'),
        state.pending ? bubble('user', state.pending) : null,
        state.sending ? h('div', { class: 'bubble assistant typing', role: 'status' }, 'Researching your question…') : null),
      state.error ? h('p', { class: 'notice error', role: 'alert' }, state.error) : null,
      suggestions.length ? h('div', { class: 'chips', role: 'group', 'aria-label': 'Suggested questions' }, suggestions.map((s) => h('button', { class: 'chip', type: 'button', disabled: state.sending, onclick: () => send(s) }, s))) : null,
      h('form', { class: 'composer', onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (v) send(v); } },
        input,
        h('div', { class: 'composerrow' }, h('span', { class: 'quiet' }, 'Uses your saved thesis and news headlines/summaries. Educational research, not investment advice.'), h('button', { class: 'btn primary', type: 'submit', disabled: state.sending }, state.sending ? 'Sending…' : 'Send'))));
    const box = $('.messages', main);
    if (box) box.scrollTop = box.scrollHeight;
  };
  async function ask(text) {
    if (state.sending) return;
    state.sending = true; state.pending = text; state.error = null; draw();
    try {
      const body = { message: text };
      if (conv.conversationId) body.conversationId = conv.conversationId; else if (conv.matchId) body.matchId = conv.matchId;
      const r = await api('POST', `/theses/${t.thesisId}/chat`, body);
      if (!live()) return;
      const id = r.body.conversationId;
      if (!conv.conversationId) { location.replace(`#/thesis/${t.thesisId}/chat/${id}`); return; } // reloads from the server
      const fresh = (await api('GET', `/conversations/${id}/messages`)).body;
      if (!live()) return;
      conv.messages = fresh.messages || [];
      state.pending = null; state.draft = '';
    } catch (err) {
      state.error = err.message; state.draft = text; state.pending = null;
    } finally { state.sending = false; if (live()) draw(); }
  }
  draw();
}

function focusCard(t, m) {
  const a = m.article || {};
  return h('article', { class: 'card focuscard' },
    h('div', { class: 'evtop' }, stanceChip(m.stance), a.ticker ? h('span', { class: 'assetchip' }, a.ticker) : null, h('span', { class: 'quiet' }, Number.isInteger(m.assumptionIndex) ? `Linked to assumption ${m.assumptionIndex + 1}` : '')),
    h('h3', { class: 'evheadline' }, extLink(a.url, a.headline || 'Untitled article')),
    h('p', { class: 'quiet' }, a.publisher || 'Unknown publisher', a.publishedAt ? [' · ', timeTag(a.publishedAt, 'published')] : null),
    a.summary ? h('p', { class: 'evsummary' }, a.summary) : null);
}

function messageView(t, m) {
  if (m.role === 'user') return h('div', { class: 'bubble user' }, h('span', { class: 'sr-only' }, 'You asked: '), h('div', { class: 'bubbletext' }, m.content), h('span', { class: 'msgtime quiet' }, timeTag(m.createdAt)));
  const cites = Array.isArray(m.citations) ? m.citations : [];
  const sourceId = (n) => `src-${m.messageId}-${n}`;
  const citeBtn = (n) => {
    const c = cites[n - 1];
    return h('button', { class: 'cite', type: 'button', 'aria-label': `Source ${n}${c ? `: ${c.title}` : ''}`, title: c ? c.title : `Source ${n}`, onclick: () => {
      const el = document.getElementById(sourceId(n));
      if (el) { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); el.focus({ preventScroll: true }); }
    } }, String(n));
  };
  const segs = Array.isArray(m.segments) && m.segments.length ? m.segments : [{ text: m.content, basis: 'general', citations: [] }];
  const meta = m.meta || {};
  return h('div', { class: 'bubble assistant' },
    h('span', { class: 'sr-only' }, 'THESIS answered: '),
    segs.map((s) => h('p', { class: `seg basis-${s.basis || 'general'}` }, s.text, (s.citations || []).length ? h('span', { class: 'cites' }, (s.citations || []).map(citeBtn)) : null)),
    meta.source === 'fallback' ? h('p', { class: 'quiet small' }, 'The AI assistant was unavailable, so this is a plain summary from your saved thesis and news.') : null,
    cites.length ? h('div', { class: 'sources' }, h('p', { class: 'label' }, 'Sources'), h('ol', {}, cites.map((c, i) => h('li', { id: sourceId(i + 1), tabindex: '-1' },
      extLink(c.url, c.title || 'Untitled article', 'sourcetitle'),
      h('span', { class: 'quiet' }, [c.publisher, c.ticker].filter(Boolean).join(' · '), c.datetime ? [' · ', timeTag(c.datetime)] : null),
      h('span', { class: 'quiet small' }, c.evidence === 'headline_and_summary' ? 'Based on the headline and a short summary' : 'Based on the headline only'),
      c.matchId ? h('a', { class: 'small', href: `#/thesis/${t.thesisId}/evidence?focus=${encodeURIComponent(c.matchId)}` }, 'See it in News evidence') : null)))) : null,
    h('span', { class: 'msgtime quiet' }, timeTag(m.createdAt)));
}

// ---------- Explore (Taha's ranked feed, Contract B) ----------
const TIER_LABEL = { low: 'Lower risk', medium: 'Medium risk', high: 'Higher risk' };
const MEASURES = [
  ['signal', 'Signal', 'Recent price movement and trading activity.'],
  ['riskFit', 'Risk fit', 'How well its ups and downs match this risk level.'],
  ['cost', 'Cost', 'Fees for funds, or how expensive the price looks for companies.'],
  ['quality', 'Quality', 'How solid the fund or company appears.'],
  ['news', 'News', 'How recent news changes the outlook.'],
];
async function renderExplore(root, live) {
  setTitle('Explore');
  let tier = store.get(EXPLORE_TIER_KEY);
  if (!TIER_LABEL[tier]) tier = 'low';
  const listBox = h('div', {}, loading('Loading market candidates…'));
  const prov = h('p', { class: 'provline quiet', role: 'status' }, 'Checking where this data comes from…');
  put(root, 
    h('section', { class: 'hero small' },
      h('p', { class: 'eyebrow' }, 'Explore'),
      h('h1', {}, 'Market candidates'),
      h('p', { class: 'lead' }, 'A daily list ranked by a fixed scoring model (no AI decides the ranking). An AI council then writes a plain-language case for and against each one. These are candidates to research, not recommendations.'),
      h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/new' }, 'Research one in a new thesis'), h('a', { class: 'btn', href: '/portfolio.html' }, 'Practice with paper money'))),
    h('div', { class: 'tierbar', role: 'group', 'aria-label': 'Risk level of the list' }, Object.entries(TIER_LABEL).map(([k, label]) => h('button', { class: `chip${k === tier ? ' on' : ''}`, type: 'button', 'aria-pressed': String(k === tier), onclick: () => { store.set(EXPLORE_TIER_KEY, k); render(); } }, label))),
    prov, listBox);
  let rows; let source; let health = null;
  try {
    const res = await fetch(`/api/stocks?tier=${encodeURIComponent(tier)}`);
    if (!res.ok) throw new Error(`The server answered HTTP ${res.status}.`);
    rows = await res.json();
    source = res.headers.get('X-Data-Source');
    try { health = await (await fetch('/api/health')).json(); } catch { health = null; }
  } catch (err) {
    if (!live()) return;
    put(listBox, statebox(['We could not load the market candidates.', err.message], { error: true, action: retryBtn(render) }));
    prov.textContent = '';
    return;
  }
  if (!live()) return;
  prov.textContent = source === 'fixture' ? 'Sample data: the daily pipeline has not run since the server restarted.'
    : source === 'live' ? `Live data from the daily pipeline${health && health.feedReceivedAt ? `, received ${rel(health.feedReceivedAt)}` : ''}.` : 'Data source unknown.';
  if (!Array.isArray(rows) || !rows.length) { put(listBox, statebox(['No candidates for this risk level yet.', 'They appear after the next daily pipeline run.'])); return; }
  put(listBox, h('div', { class: 'candlist' }, rows.map(candidateCard)),
    h('p', { class: 'quiet' }, `${rows.length < 10 ? `${rows.length} candidates right now; the list is never padded to ten.` : 'Top 10 for this risk level.'} The full original feed is still available on the `, h('a', { href: '/' }, 'TFSA Gold site'), '.'));
}
function candidateCard(r) {
  const b = r.scoreBreakdown || {};
  const hasAi = r.bullCase || r.bearCase || r.verdict;
  return h('article', { class: 'card candidate' },
    h('div', { class: 'candhead' },
      h('span', { class: 'rank' }, `#${r.rank}`),
      h('div', {}, h('b', {}, r.ticker), h('span', { class: 'quiet' }, ` ${r.companyName || ''}`), h('p', { class: 'quiet small' }, catName(r.category), CATEGORY[r.category] ? ` · ${CATEGORY[r.category][1]}` : '')),
      h('div', { class: 'candscore', title: 'The five measures below, added up (out of 100).' }, h('b', {}, String(r.matchScore)), h('span', { class: 'quiet small' }, '/100')),
      h('span', { class: 'quiet' }, Number.isFinite(r.price) ? money(r.price) : '')),
    r.why ? h('p', {}, r.why) : null,
    h('div', { class: 'measures' }, MEASURES.map(([k, label, tip]) => {
      const v = Number.isFinite(b[k]) ? b[k] : 0;
      return h('div', { class: 'measure' }, h('span', { class: 'mlabel' }, h('b', {}, label), h('small', {}, tip)), h('span', { class: 'track', 'aria-hidden': 'true' }, h('span', { class: 'fill', style: `width:${v * 5}%` })), h('span', { class: 'mval' }, `${v}/20`));
    })),
    h('details', { class: 'analysis' },
      h('summary', {}, hasAi ? 'Read the case for and against' : 'Headlines'),
      r.bullCase ? h('div', { class: 'case' }, h('p', { class: 'label' }, 'The case for'), h('p', {}, r.bullCase)) : null,
      r.bearCase ? h('div', { class: 'case' }, h('p', { class: 'label' }, 'The case against'), h('p', {}, r.bearCase)) : null,
      r.verdict ? h('div', { class: 'case' }, h('p', { class: 'label' }, 'Overall read'), h('p', {}, r.verdict)) : null,
      !hasAi ? h('p', { class: 'quiet' }, 'The AI council has not written an explanation for this one yet.') : null,
      (r.newsTags || []).length ? h('ul', { class: 'headlines' }, r.newsTags.map((n) => h('li', {}, stanceChip(n.stance), ' ', extLink(n.url, n.headline)))) : null,
      h('p', { class: 'quiet small' }, 'AI-written explanation of a score the scoring model already set. Educational research, not investment advice.')));
}

render();

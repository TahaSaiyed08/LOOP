// Tests for handleThesisAction (server/thesis.js), the stateless session action handler for a web route.
// Offline: a scripted callLLM for onboarding and forceFallback for exploration/drafts. No key, no network,
// nothing saved, monitored, emailed or traded. Run: npm run test:session
const assert = require('assert');
const { handleThesisAction, SESSION_ACTIONS, createOnboardingSession } = require('../server/thesis');

function fakeLLM(replies) {
  return async () => {
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return typeof r === 'string' ? r : JSON.stringify(r);
  };
}
const nulls = { amount: null, cadence: null, timelineYears: null, currency: null, experience: null, riskComfort: null, purpose: null };
const llmReply = (o) => ({ intent: 'goal_exploration', reply: 'OK.', tickers: [], ambiguities: [], nextQuestion: null, ...o, profileUpdates: { ...nulls, ...(o.profileUpdates || {}) } });
const OFF = { forceFallback: true };
const RESPONSE_KEYS = ['ok', 'action', 'error', 'session', 'version', 'changed', 'stage', 'nextActions', 'displayText', 'result'];
const roundTrip = (x) => JSON.parse(JSON.stringify(x));
const NVDA_TEXT = 'Demand for NVIDIA AI data-center chips keeps growing as cloud companies expand AI infrastructure.';
const NVDA_CHALLENGE = 'NVIDIA lowering guidance, or cloud customers cutting AI infrastructure spending.';

function assertResponse(r) {
  for (const k of RESPONSE_KEYS) assert(k in r, `response is missing "${k}"`);
  assert.deepStrictEqual(roundTrip(r), r, 'response must be JSON-safe');
  assert(Number.isInteger(r.session.version) && r.session.version === r.version, 'session carries its version');
  assert(!('fallbackReason' in (r.result || {})), 'provider error details are not returned');
  assert(!r.result || !('session' in r.result), 'session is returned once, at the top level');
  const text = JSON.stringify(r);
  assert(!/api[_-]?key|authorization|bearer\s/i.test(text), 'no credentials in the response');
  return r;
}
async function act(session, action, payload, opts = OFF) {
  return assertResponse(await handleThesisAction(session, action, payload, opts));
}

// Profile via two scripted onboarding turns, then the response session is round-tripped like a DB would.
async function onboarded() {
  const llm = fakeLLM([
    llmReply({ reply: 'Starting small is a great way to learn.', profileUpdates: { amount: 50, cadence: 'monthly' } }),
    llmReply({ reply: 'Five years gives you room to learn.', profileUpdates: { purpose: 'build long-term wealth', timelineYears: 5, experience: 'beginner', riskComfort: 'medium' } }),
  ]);
  const a = await act(null, 'onboard', { message: 'I want to invest $50 a month.' }, { callLLM: llm });
  const b = await act(roundTrip(a.session), 'onboard', { message: 'For long-term wealth, over five years. I am a beginner, medium risk.' }, { callLLM: llm });
  return { a, b };
}
async function reviewing() {
  const { b } = await onboarded();
  const sel = await act(b.session, 'selectAssets', { symbols: 'NVDA, VOO' });
  const conf = await act(sel.session, 'confirmSelection');
  return act(conf.session, 'createDraft');
}

const tests = [
  ['full sequence: onboard -> explore -> select -> confirm -> draft -> edit -> confirm -> thesis', async () => {
    const { a, b } = await onboarded();
    assert.strictEqual(a.ok, true); assert.strictEqual(a.version, 1); assert.strictEqual(a.stage, 'onboarding');
    assert.strictEqual(b.version, 2); assert.strictEqual(b.stage, 'selecting');
    assert.deepStrictEqual(b.nextActions, ['explore', 'selectAssets', 'onboard']);
    assert.strictEqual(b.session.profile.amount, 50);

    const ex = await act(b.session, 'explore');
    assert(ex.ok && Array.isArray(ex.result.categories) && ex.result.categories.length, 'exploration lists categories');
    assert.strictEqual(ex.changed, false); assert.strictEqual(ex.version, 2, 'explore does not change the session');

    const sel = await act(ex.session, 'selectAssets', { symbols: 'NVDA, VOO' });
    assert(sel.ok && sel.result.needsConfirmation); assert.strictEqual(sel.stage, 'selection_pending');
    assert.deepStrictEqual(sel.session.selection.confirmed, [], 'selecting does not confirm');
    assert.strictEqual(sel.nextActions[0], 'confirmSelection');

    const conf = await act(sel.session, 'confirmSelection');
    assert(conf.ok); assert.strictEqual(conf.stage, 'drafting');
    assert.deepStrictEqual(conf.session.selection.confirmed, ['NVDA', 'VOO']);

    const dr = await act(roundTrip(conf.session), 'createDraft');
    assert(dr.ok, dr.displayText); assert.strictEqual(dr.stage, 'reviewing');
    assert.strictEqual(dr.result.monitoringActivated, false);
    assert.deepStrictEqual(dr.nextActions, ['editAssumption', 'confirmAssumptions', 'createDraft']);

    const ed = await act(dr.session, 'editAssumption', { number: 1, text: NVDA_TEXT, challenge: NVDA_CHALLENGE });
    assert(ed.ok, ed.displayText); assert.strictEqual(ed.session.thesisDraft.draft.assumptionDetails[0].text, NVDA_TEXT);

    const ca = await act(ed.session, 'confirmAssumptions');
    assert(ca.ok); assert.strictEqual(ca.stage, 'confirmed');

    const th = await act(roundTrip(ca.session), 'getConfirmedThesis');
    assert(th.ok); assert.strictEqual(th.changed, false); assert.strictEqual(th.version, ca.version);
    const t = th.result.thesis;
    for (const k of ['id', 'goal', 'budget', 'horizonYears', 'tier', 'assumptions', 'createdAt']) assert(k in t, `Contract C field ${k}`);
    assert.strictEqual(t.assumptions[0], NVDA_TEXT);
    assert.strictEqual(t.assumptionStatus, 'confirmed');
    assert.deepStrictEqual(t.selectedAssets.map((x) => x.symbol), ['NVDA', 'VOO']);
  }],
  ['unknown and non-string actions are rejected with the supported list', async () => {
    for (const action of ['deleteEverything', '', null, 42, { a: 1 }]) {
      const r = await act(createOnboardingSession(), action, {});
      assert.strictEqual(r.ok, false); assert.strictEqual(r.error.code, 'unknown_action');
      for (const a of SESSION_ACTIONS) assert(r.error.message.includes(a));
    }
  }],
  ['missing or garbage session: only onboard may start fresh', async () => {
    for (const bad of [null, undefined, 'session', 7, ['x']]) {
      for (const action of SESSION_ACTIONS.filter((x) => x !== 'onboard')) {
        const r = await act(bad, action, { symbols: 'VOO', number: 1, text: 'x' });
        assert.strictEqual(r.error.code, 'missing_session', `${action} with ${JSON.stringify(bad)}`);
        assert.strictEqual(r.version, 0);
      }
    }
    const llm = fakeLLM([llmReply({ reply: 'Hi.' })]);
    const r = await act(null, 'onboard', { message: 'hello' }, { callLLM: llm });
    assert(r.ok); assert.strictEqual(r.version, 1);
  }],
  ['invalid payloads change nothing', async () => {
    const s = (await onboarded()).b.session;
    const cases = [
      ['onboard', {}], ['onboard', { message: '   ' }], ['onboard', { message: 'x'.repeat(2001) }], ['onboard', { message: 5 }],
      ['selectAssets', {}], ['selectAssets', { symbols: '' }], ['selectAssets', { symbols: [1, 2] }], ['selectAssets', { symbols: Array(21).fill('VOO') }],
      ['editAssumption', { number: 0, text: 'x' }], ['editAssumption', { number: '1', text: 'x' }], ['editAssumption', { number: 1 }],
      ['editAssumption', { number: 1, text: 'x', keepChallenge: 'yes' }],
    ];
    for (const [action, payload] of cases) {
      const r = await act(s, action, payload);
      assert.strictEqual(r.error && r.error.code, 'invalid_payload', `${action} ${JSON.stringify(payload).slice(0, 60)}`);
      assert.strictEqual(r.version, s.version); assert.strictEqual(r.changed, false);
    }
    const r = await act(s, 'selectAssets', 'not an object');
    assert.strictEqual(r.error.code, 'invalid_payload', 'a non-object payload is treated as empty');
  }],
  ['safeguards: no draft before confirmation, no thesis before assumptions are confirmed', async () => {
    const { b } = await onboarded();
    const early = await act(b.session, 'createDraft');
    assert.strictEqual(early.error.code, 'selection_not_confirmed');
    const sel = await act(b.session, 'selectAssets', { symbols: ['VOO'] });
    const pending = await act(sel.session, 'createDraft');
    assert.strictEqual(pending.error.code, 'selection_not_confirmed', 'a pending selection is not enough');
    assert.strictEqual(pending.version, sel.version);
    assert.strictEqual((await act(sel.session, 'getConfirmedThesis')).error.code, 'not_confirmed');
    const nothing = await act(b.session, 'confirmSelection');
    assert.strictEqual(nothing.error.code, 'nothing_pending');
    const unsupported = await act(b.session, 'selectAssets', { symbols: 'NOTAREALTICKER' });
    assert.strictEqual(unsupported.ok, false); assert.deepStrictEqual(unsupported.session.selection.pending, []);

    const dr = await reviewing();
    assert.strictEqual((await act(dr.session, 'getConfirmedThesis')).error.code, 'not_confirmed', 'a proposed draft is not a thesis');
    const noDecision = await act(dr.session, 'editAssumption', { number: 1, text: NVDA_TEXT });
    assert.strictEqual(noDecision.error.code, 'challenge_decision_needed');
    assert.strictEqual(noDecision.version, dr.version);
    assert.strictEqual((await act(dr.session, 'editAssumption', { number: 9, text: NVDA_TEXT, keepChallenge: true })).error.code, 'bad_index');
  }],
  ['editing a confirmed thesis returns it to review', async () => {
    const dr = await reviewing();
    const ca = await act(dr.session, 'confirmAssumptions');
    assert.strictEqual(ca.stage, 'confirmed');
    const ed = await act(ca.session, 'editAssumption', { number: 1, text: NVDA_TEXT, keepChallenge: true });
    assert(ed.ok, ed.displayText); assert.strictEqual(ed.stage, 'reviewing');
    assert.strictEqual((await act(ed.session, 'getConfirmedThesis')).error.code, 'not_confirmed');
    const crit = await act(ed.session, 'editAssumption', { number: 2, challenge: 'Falling S&P 500 earnings or a US recession.' });
    assert(crit.ok, crit.displayText); assert.strictEqual(crit.version, ed.version + 1, 'challenge-only edit');
  }],
  ['session version: +1 per change, unchanged on reads and failures, legacy sessions start at 0', async () => {
    const dr = await reviewing();
    const v = dr.version;
    const ca = await act(dr.session, 'confirmAssumptions');
    assert.strictEqual(ca.version, v + 1);
    const again = await act(ca.session, 'confirmAssumptions');
    assert(again.ok && again.result.alreadyConfirmed); assert.strictEqual(again.version, v + 1, 'no-op confirm keeps the version');
    const legacy = { ...ca.session }; delete legacy.version;
    assert.strictEqual((await act(legacy, 'getConfirmedThesis')).version, 0, 'a session saved before versions existed is version 0');
    for (const bad of [-1, 1.5, '3']) assert.strictEqual((await act({ ...ca.session, version: bad }, 'getConfirmedThesis')).version, 0);
    const okCheck = await act(ca.session, 'getConfirmedThesis', {}, { ...OFF, expectedVersion: v + 1 });
    assert(okCheck.ok);
    const stale = await act(ca.session, 'editAssumption', { number: 1, text: NVDA_TEXT, keepChallenge: true }, { ...OFF, expectedVersion: v });
    assert.strictEqual(stale.error.code, 'version_conflict'); assert.strictEqual(stale.stage, 'confirmed', 'a stale write changes nothing');
  }],
  ['persisted session holds only engine state: unknown or injected fields are dropped', async () => {
    const { b } = await onboarded();
    const dirty = { ...b.session, apiKey: 'secret-value', rawLLM: '{...}', isAdmin: true, profile: { ...b.session.profile, amount: 'lots', evil: 1 } };
    const r = await act(dirty, 'explore');
    const keys = Object.keys(r.session).sort();
    assert.deepStrictEqual(keys, ['activeFlow', 'askedFields', 'history', 'lastQuestionField', 'profile', 'profileDetails', 'selection', 'thesisDraft', 'tickers', 'version'].sort());
    assert(!('evil' in r.session.profile)); assert.notStrictEqual(r.session.profile.amount, 'lots');
    assert(!JSON.stringify(r).includes('secret-value'));
  }],
  ['an engine exception becomes ok:false and leaves the session unchanged', async () => {
    const { b } = await onboarded();
    const boom = { callLLM: async () => { throw new TypeError('boom'); } };
    const r = await handleThesisAction(b.session, 'onboard', { message: 'More about ETFs?' }, boom);
    assertResponse(r);
    assert(r.ok, 'a model failure inside onboarding is already handled by its fallback');
    const weird = await handleThesisAction({ ...b.session, get selection() { throw new Error('bad getter'); } }, 'explore', {}, OFF);
    assertResponse(weird);
    assert.strictEqual(weird.ok, false); assert.strictEqual(weird.error.code, 'internal_error');
  }],
];

(async () => {
  const warn = console.warn; console.warn = () => {};
  let pass = 0;
  for (const [i, [name, fn]] of tests.entries()) {
    try { await fn(); pass++; console.log(`PASS  ${i + 1}. ${name}`); } catch (e) { console.log(`FAIL  ${i + 1}. ${name}\n      ${e.stack.split('\n').slice(0, 3).join('\n      ')}`); }
  }
  console.warn = warn;
  console.log(`\n${pass}/${tests.length} session handler tests passed`);
  process.exit(pass === tests.length ? 0 : 1);
})();

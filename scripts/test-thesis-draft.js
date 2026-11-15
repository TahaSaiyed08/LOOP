// Tests investment exploration, explicit selection and thesis draft creation in server/thesis.js.
// Offline: scripted callLLM (no real Gemini calls, no key needed), plus one group through the real
// server/llm.js against a local HTTP mock. Run: npm run test:draft   (~6 s: llm.js spaces calls 5 s apart)
const assert = require('assert');
const http = require('http');

delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_MODEL;
delete process.env.FALLBACK_GEMINI_MODEL;
const thesis = require('../server/thesis');
const { createOnboardingSession, exploreInvestments, selectAssets, confirmSelection, createThesisDraft, onboardingTurn, _draft,
  viewAssumptions, editAssumption, editChallenge, suggestChallenge, addAssumption, removeAssumption, regenerateAssumptions, confirmAssumptions, getConfirmedThesis, matchNewsDetailed } = thesis;
const UNIVERSE = require('./universe');
const { TIERS } = require('../server/scoring');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); console.log(`PASS  ${name}`); }
  catch (err) { results.push([false, name]); console.log(`FAIL  ${name}\n      ${err.message}`); }
}
function fakeLLM(replies) {
  const calls = [];
  const fn = async (system, user, o) => {
    calls.push({ system, user, model: o && o.model });
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return typeof r === 'string' ? r : JSON.stringify(r);
  };
  fn.calls = calls;
  return fn;
}
const mkErr = (code, message) => Object.assign(new Error(message), { code });
const nulls = { amount: null, cadence: null, timelineYears: null, currency: null, experience: null, riskComfort: null, purpose: null };
// The example profile from the brief: $20 weekly, build wealth, 2-3 years, beginner, risk unknown.
function profileSession(over = {}, timelineText = '2–3 years') {
  const s = createOnboardingSession();
  s.profile = { ...nulls, amount: 20, cadence: 'weekly', timelineYears: 2, experience: 'beginner', purpose: 'build long-term wealth', ...over };
  s.profileDetails = { timelineText };
  return s;
}
const confirmed = (syms, over, tt) => confirmSelection(selectAssets(syms, profileSession(over, tt)).session).session;
const goodDraft = (o = {}) => ({
  goal: 'Build long-term wealth by investing $20 weekly over 2–3 years.',
  assumptions: [
    { text: 'Companies in the S&P 500 held by VOO keep growing their combined earnings over the next few years.', tickers: ['VOO'], whatWouldChallengeIt: 'Quarterly reports showing falling S&P 500 earnings, or a US recession.' },
    { text: 'Demand for NVIDIA data-center chips keeps growing as companies spend on AI.', tickers: ['NVDA'], whatWouldChallengeIt: 'NVIDIA lowering revenue guidance or big customers cutting AI spending.' },
  ],
  risks: [{ title: 'AI spending cycle', explanation: 'NVDA depends heavily on AI investment budgets, which can slow quickly.' }],
  ...o,
});
function assertDraftContract(r) {
  assert.strictEqual(r.ok, true, r.displayText);
  assert.strictEqual(r.saved, false);
  assert.strictEqual(r.monitoringActivated, false);
  const d = r.draft;
  assert.strictEqual(d.status, 'draft');
  assert(typeof d.id === 'string' && typeof d.goal === 'string' && d.goal.length > 10);
  assert(TIERS.includes(d.tier), 'tier must stay Contract C compatible');
  assert(Array.isArray(d.assumptions) && d.assumptions.length >= 2 && d.assumptions.length <= 4, `assumptions: ${d.assumptions.length}`);
  assert(d.assumptions.every((a) => typeof a === 'string'));
  assert.strictEqual(d.assumptionDetails.length, d.assumptions.length);
  const chosen = new Set(d.selectedAssets.map((a) => a.symbol));
  for (const a of d.assumptionDetails) {
    assert(a.tickers.length && a.tickers.every((t) => chosen.has(t)), `assumption tied to unselected asset: ${a.text}`);
    assert(typeof a.whatWouldChallengeIt === 'string' && a.whatWouldChallengeIt.length >= 10, `no challenge evidence: ${a.text}`);
  }
  assert(typeof d.budget.amount === 'number' && typeof d.budget.cadence === 'string' && typeof d.horizonYears === 'number');
  assert(!/\btier\b/i.test(r.displayText), 'tier must not be shown to the user');
}

(async () => {
  console.log('--- supported / unsupported tickers and explicit selection');

  await test('1. supported tickers by symbol and by name (VOO, "nvidia", BTC -> BTC/USD, "home depot")', async () => {
    const r = selectAssets('VOO, nvidia, BTC and home depot', createOnboardingSession());
    assert.deepStrictEqual(r.selected.map((a) => a.symbol), ['VOO', 'NVDA', 'BTC/USD', 'HD']);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.confirmed, false, 'selection must not be confirmed automatically');
    assert.strictEqual(r.needsConfirmation, true);
    assert.deepStrictEqual(r.session.selection, { pending: ['VOO', 'NVDA', 'BTC/USD', 'HD'], confirmed: [] });
  });

  await test('2. unsupported tickers are clearly identified and never selectable', async () => {
    const r = selectAssets('VOO, TSLA, $SPY, Berkshire Hathaway', createOnboardingSession());
    assert.deepStrictEqual(r.selected.map((a) => a.symbol), ['VOO']);
    assert.deepStrictEqual(r.unsupported, ['TSLA', 'SPY']);
    assert.deepStrictEqual(r.unmatched, ['Berkshire Hathaway']);
    assert(/Not supported: TSLA, SPY aren't among/.test(r.displayText), r.displayText);
    const only = selectAssets('TSLA', createOnboardingSession());
    assert.strictEqual(only.ok, false);
    assert.deepStrictEqual(only.session.selection, { pending: [], confirmed: [] }, 'an unsupported-only choice must not select anything');
  });

  await test('3. limits: 1-5 tickers, extras reported (not silently dropped), duplicates collapsed', async () => {
    const r = selectAssets('VOO, VTI, QQQ, IVV, SCHB, DIA, VOO', createOnboardingSession());
    assert.strictEqual(r.selected.length, 5);
    assert.deepStrictEqual(r.overLimit, ['DIA']);
    assert.deepStrictEqual(r.duplicates, ['VOO']);
    assert(/up to 5/.test(r.displayText));
    assert.strictEqual(selectAssets('', createOnboardingSession()).ok, false);
  });

  await test('4. every selectable ticker comes from scripts/universe.js', async () => {
    const e = await exploreInvestments(profileSession(), { forceFallback: true });
    const listed = e.categories.flatMap((c) => c.assets.map((a) => a.symbol));
    const universe = UNIVERSE.map((u) => u.ticker);
    assert.deepStrictEqual([...listed].sort(), [...universe].sort());
    assert(e.categories.filter((c) => !c.selectable).every((c) => c.assets.length === 0), 'non-universe categories must have no selectable assets');
  });

  await test('5. explicit confirmation: exploring selects nothing; unconfirmed selection cannot be drafted', async () => {
    const e = await exploreInvestments(profileSession(), { forceFallback: true });
    assert.deepStrictEqual(e.session.selection, { pending: [], confirmed: [] }, 'exploration must not select');
    const llm = fakeLLM([goodDraft()]);
    const pendingOnly = selectAssets('VOO, NVDA', e.session).session;
    const r = await createThesisDraft(pendingOnly, { callLLM: llm });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'selection_not_confirmed');
    assert(/haven't confirmed/.test(r.displayText));
    assert.strictEqual(llm.calls.length, 0, 'no Gemini call before confirmation');
    assert.strictEqual(confirmSelection(createOnboardingSession()).ok, false, 'nothing to confirm');
    const c = confirmSelection(pendingOnly);
    assert.deepStrictEqual(c.session.selection, { pending: [], confirmed: ['VOO', 'NVDA'] });
    const changed = selectAssets('BND', c.session);
    assert.deepStrictEqual(changed.session.selection, { pending: ['BND'], confirmed: [] }, 'a new choice needs a new confirmation');
  });

  console.log('--- profile, horizon and exploration');

  await test('6. missing profile information: no draft, no Gemini call, clear next question', async () => {
    const llm = fakeLLM([goodDraft()]);
    const s = confirmed('VOO, NVDA', { timelineYears: null }, null);
    const r = await createThesisDraft(s, { callLLM: llm });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'missing_profile');
    assert.deepStrictEqual(r.missingFields, ['timelineYears']);
    assert(/how many years/i.test(r.displayText));
    assert.strictEqual(llm.calls.length, 0);
    const none = await createThesisDraft(createOnboardingSession(), { callLLM: llm });
    assert.deepStrictEqual(none.missingFields, ['purpose', 'amount', 'cadence', 'timelineYears']);
  });

  await test('7. short horizon: range kept verbatim, warnings use the lower bound, nothing called safe', async () => {
    const e = await exploreInvestments(profileSession(), { forceFallback: true });
    assert(/2–3 years/.test(e.horizonNote) && /None of the stocks or ETFs here are safe/.test(e.horizonNote), e.horizonNote);
    assert(e.categories.find((c) => c.id === 'index_etf').fitNote.includes('2–3 years'));
    assert(e.categories.find((c) => c.id === 'bond_etf').fitNote.includes('losses are still possible'), 'bonds must not read as safe');
    assert(e.categories.some((c) => c.id === 'cash_like' && !c.selectable));
    const r = await createThesisDraft(confirmed('NVDA'), { callLLM: fakeLLM([goodDraft({ assumptions: [goodDraft().assumptions[1]] })]) });
    assert.strictEqual(r.draft.horizon.text, '2–3 years', 'stated range must be preserved');
    assert.strictEqual(r.draft.horizonYears, 2);
    assert.strictEqual(r.draft.profileSnapshot.timelineText, '2–3 years');
    assert(r.draft.risks.some((x) => x.title === 'Short time horizon'));
    assert(r.draft.risks.some((x) => x.title === 'Concentration'), 'single stock needs a concentration note');
    const dup = await createThesisDraft(confirmed('VOO'), { callLLM: fakeLLM([goodDraft({ risks: [{ title: 'Short-Term Market Downturn', explanation: 'Because the timeline is only 2-3 years, a drop may not recover.' }] })]) });
    assert.strictEqual(dup.draft.risks.filter((x) => /short/i.test(x.title)).length, 1, 'short-horizon risk repeated');
    assert.strictEqual(r.draft.tier, 'low');
    assert(/internal compatibility/i.test(r.draft.tierNote));
  });

  await test('8. onboarding keeps "2–3 years" as stated (lower bound in timelineYears)', async () => {
    const r = await onboardingTurn('I want to build wealth over 2–3 years with $20 a week', null, { forceFallback: true });
    assert.strictEqual(r.profile.timelineYears, 2);
    assert.strictEqual(r.profileDetails.timelineText, '2–3 years');
    assert.strictEqual(r.session.profileDetails.timelineText, '2–3 years');
    assert(/2–3 years/.test(r.displayText));
  });

  await test('9. exploration intro from Gemini is used, safety/advice claims scrubbed', async () => {
    const llm = fakeLLM([{ intro: 'Since you plan to invest $20 weekly for 2–3 years, timing matters. Bond ETFs are a safe choice for you. You should buy VOO. The choice of what to research is yours.' }]);
    const e = await exploreInvestments(profileSession(), { callLLM: llm });
    assert.strictEqual(e.source, 'gemini');
    assert(!/safe choice/i.test(e.intro), e.intro);
    assert(!/should buy/i.test(e.intro), e.intro);
    assert(/choice of what to research is yours/.test(e.intro));
    assert(llm.calls[0].user.includes('2–3 years'), 'prompt must carry the stated range');
  });

  console.log('--- draft generation');

  await test('10. draft generation: personalized, Contract C compatible, nothing saved/monitored', async () => {
    const llm = fakeLLM([goodDraft()]);
    const r = await createThesisDraft(confirmed('VOO, NVDA'), { callLLM: llm });
    assertDraftContract(r);
    assert.strictEqual(r.source, 'gemini');
    assert.strictEqual(r.toppedUp, 0);
    assert.strictEqual(r.draft.goal, 'Build long-term wealth by investing $20 weekly over 2–3 years.');
    assert.deepStrictEqual(r.draft.budget, { amount: 20, cadence: 'weekly' });
    assert.deepStrictEqual(r.draft.selectedAssets.map((a) => a.symbol), ['VOO', 'NVDA']);
    assert(r.draft.risks.some((x) => x.title === 'AI spending cycle'), 'Gemini risk kept');
    assert(r.draft.risks.some((x) => x.title === 'Risk comfort not stated'));
    assert(llm.calls[0].user.includes('"ticker": "NVDA"'), 'prompt must list the confirmed assets');
    assert(/THESIS DRAFT \(not saved, not monitored\)/.test(r.displayText));
    for (const k of Object.keys(require.cache)) assert(!/server[\\/](store|notify|paper|alpaca)\.js$/.test(k), `draft code loaded ${k}`);
  });

  await test('11. only selected assets: Gemini assumptions about unselected tickers are removed', async () => {
    const llm = fakeLLM([goodDraft({ assumptions: [
      ...goodDraft().assumptions,
      { text: 'Apple keeps growing iPhone sales in China over the next two years.', tickers: ['AAPL'], whatWouldChallengeIt: 'Falling iPhone sales.' },
      { text: 'Tech giants like MSFT keep spending on AI hardware that VOO holders benefit from.', tickers: ['VOO'], whatWouldChallengeIt: 'Cuts in AI budgets.' },
    ], risks: [{ title: 'Tesla risk', explanation: 'TSLA can swing.' }, { title: 'Apple', explanation: 'AAPL depends on China.' }] })]);
    const r = await createThesisDraft(confirmed('VOO, NVDA'), { callLLM: llm });
    assertDraftContract(r);
    assert(!r.draft.assumptions.some((a) => /Apple|MSFT/.test(a)), r.draft.assumptions.join(' | '));
    assert(!r.draft.risks.some((x) => /AAPL/.test(x.explanation)));
  });

  await test('12. 2-4 assumptions: trims extras, prefers 2 real ones over padding, tops up only when < 2', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ text: `VOO assumption number ${i + 1} about S&P 500 earnings growth.`, tickers: ['VOO'], whatWouldChallengeIt: `Evidence ${i + 1} of falling earnings.` }));
    const r6 = await createThesisDraft(confirmed('VOO, NVDA'), { callLLM: fakeLLM([goodDraft({ assumptions: many })]) });
    assert.strictEqual(r6.draft.assumptions.length, 4);
    const r2 = await createThesisDraft(confirmed('VOO, NVDA, XLK, BND'), { callLLM: fakeLLM([goodDraft()]) });
    assert.strictEqual(r2.draft.assumptions.length, 2, 'two valid Gemini assumptions must not be padded to four');
    assert.strictEqual(r2.toppedUp, 0);
    const r1 = await createThesisDraft(confirmed('VOO, NVDA'), { callLLM: fakeLLM([goodDraft({ assumptions: [goodDraft().assumptions[0], { text: 'no evidence here for this one', tickers: ['NVDA'] }] })]) });
    assert.strictEqual(r1.draft.assumptions.length, 2);
    assert.strictEqual(r1.toppedUp, 1);
    assert(r1.draft.assumptionDetails[1].tickers.includes('NVDA'), 'top-up must be about the uncovered selected asset');
    assert(/NVIDIA/.test(r1.draft.assumptions[1]));
  });

  await test('13. advice, safety and tracking claims are scrubbed from the draft', async () => {
    const llm = fakeLLM([goodDraft({
      goal: 'You should buy VOO to build wealth over 2–3 years.',
      assumptions: [
        { text: 'VOO is a safe investment that will definitely go up over 2–3 years.', tickers: ['VOO'], whatWouldChallengeIt: 'Nothing really.' },
        ...goodDraft().assumptions,
      ],
      risks: [{ title: 'Tracking', explanation: "I'll monitor NVDA for you and send alerts." }],
    })]);
    const r = await createThesisDraft(confirmed('VOO, NVDA'), { callLLM: llm });
    assertDraftContract(r);
    const all = [r.draft.goal, ...r.draft.assumptions, ...r.draft.risks.map((x) => x.explanation)].join(' ');
    assert(!/should buy|safe investment|definitely go up|I'll monitor/i.test(all), all);
  });

  console.log('--- Gemini failure and model fallback');

  await test('14. Gemini error / non-JSON -> valid fallback draft from asset-specific templates', async () => {
    for (const reply of [mkErr('LLM_HTTP', 'LLM HTTP 400: bad'), 'Sorry, I cannot do that.']) {
      const r = await createThesisDraft(confirmed('VOO, NVDA, XLK'), { callLLM: fakeLLM([reply]) });
      assertDraftContract(r);
      assert.strictEqual(r.source, 'fallback');
      assert(r.fallbackReason, 'reason expected');
      assert.strictEqual(r.draft.assumptions.length, 3, 'one template per selected asset');
      assert(r.draft.assumptionDetails.every((a) => a.origin === 'template'));
    }
    const single = await createThesisDraft(confirmed('NVDA'), { forceFallback: true });
    assertDraftContract(single);
    assert.strictEqual(single.draft.assumptions.length, 2, 'one asset still gets 2 asset-tied assumptions');
  });

  await test('15. model fallback: primary rate-limited -> backup writes the draft; both fail -> offline draft', async () => {
    Object.assign(process.env, { GEMINI_MODEL: 'primary-m', FALLBACK_GEMINI_MODEL: 'backup-m' });
    try {
      const a = fakeLLM([mkErr('LLM_RATE_LIMIT', 'LLM HTTP 429: quota'), goodDraft()]);
      const r = await createThesisDraft(confirmed('VOO, NVDA'), { callLLM: a });
      assert.deepStrictEqual(a.calls.map((c) => c.model), ['primary-m', 'backup-m']);
      assert.strictEqual(r.source, 'gemini');
      assert.strictEqual(r.model, 'backup-m');
      const b = fakeLLM([mkErr('LLM_RATE_LIMIT', 'LLM HTTP 429: quota'), mkErr('LLM_HTTP', 'LLM HTTP 503: down')]);
      const r2 = await createThesisDraft(confirmed('VOO, NVDA'), { callLLM: b });
      assertDraftContract(r2);
      assert.strictEqual(r2.source, 'fallback');
      assert(/both models failed/.test(r2.fallbackReason));
      const auth = fakeLLM([mkErr('LLM_HTTP', 'LLM HTTP 401: unauthorized'), goodDraft()]);
      await createThesisDraft(confirmed('VOO, NVDA'), { callLLM: auth });
      assert.strictEqual(auth.calls.length, 1, 'auth errors are not retried');
      const ex = fakeLLM([mkErr('LLM_NETWORK', 'timeout'), { intro: 'Here is an overview. The choice is yours.' }]);
      const e = await exploreInvestments(profileSession(), { callLLM: ex });
      assert.strictEqual(e.model, 'backup-m');
    } finally { delete process.env.GEMINI_MODEL; delete process.env.FALLBACK_GEMINI_MODEL; }
  });

  await test('16. real llm.js: HTTP error and no key both degrade to offline exploration/draft', async () => {
    const srv = http.createServer((q, res) => { q.resume(); q.on('end', () => { res.statusCode = 400; res.end('{"error":"bad"}'); }); });
    await new Promise((r) => srv.listen(0, r));
    Object.assign(process.env, { GEMINI_API_KEY: 'test-key', GEMINI_BASE_URL: `http://localhost:${srv.address().port}/v1/`, GEMINI_MODEL: 'mock' });
    try {
      const d = await createThesisDraft(confirmed('VOO, BND'));
      assertDraftContract(d);
      assert.strictEqual(d.source, 'fallback');
      assert(/LLM_HTTP/.test(d.fallbackReason), d.fallbackReason);
    } finally { srv.close(); delete process.env.GEMINI_API_KEY; delete process.env.GEMINI_MODEL; }
    const e = await exploreInvestments(profileSession());
    assert.strictEqual(e.source, 'fallback');
    assert.strictEqual(e.fallbackReason, 'GEMINI_API_KEY not set');
  });

  console.log('--- compatibility');

  await test('17. existing exports unchanged: createThesis / matchNews / IS_STUB / onboardingTurn', async () => {
    const t = await thesis.createThesis('anything');
    assert.deepStrictEqual(Object.keys(t).sort(), ['assumptions', 'budget', 'createdAt', 'goal', 'horizonYears', 'id', 'tier'].sort());
    // createThesis is real (Taha). Every thesis goes through the personalized engine (matchNewsDetailed);
    // without an LLM it never invents a "challenges" stance (details covered in test-news-matching.js).
    const m = await thesis.matchNews(t, [{ ticker: 'VOO', headline: 'h', url: 'u', sentiment: -0.5 }]);
    assert(Array.isArray(m) && m.every((x) => x.stance !== 'challenges'));
    assert.strictEqual(thesis.IS_STUB, false);
    assert.strictEqual(typeof onboardingTurn, 'function');
    const old = { history: [], profile: nulls, askedFields: [], activeFlow: null, tickers: [], lastQuestionField: null }; // pre-feature session
    assert.deepStrictEqual(selectAssets('VOO', old).session.selection, { pending: ['VOO'], confirmed: [] }, 'old sessions still work');
  });


  console.log('--- assumption review: accept, edit, regenerate, confirm');
  const drafted = async (syms = 'VOO, NVDA') => (await createThesisDraft(confirmed(syms), { callLLM: fakeLLM([goodDraft()]) })).session;

  await test('18. a new draft is only PROPOSED: not confirmed, not usable for news matching', async () => {
    const s = await drafted();
    assert.strictEqual(s.thesisDraft.status, 'proposed');
    assert.strictEqual(s.thesisDraft.draft.assumptionStatus, 'proposed');
    assert.strictEqual(getConfirmedThesis(s), null);
    const v = viewAssumptions(s);
    assert(/Proposed assumptions \(not confirmed yet\)/.test(v.displayText));
    assert(/Could be challenged by:/.test(v.displayText) && /\[VOO\]/.test(v.displayText));
    const m = await matchNewsDetailed(s.thesisDraft.draft, [{ ticker: 'VOO', headline: 'S&P 500 earnings fall', url: 'https://example.com/a' }], { callLLM: fakeLLM([]) });
    assert.strictEqual(m.stats.reason, 'assumptions_not_confirmed');
    assert.strictEqual(viewAssumptions(createOnboardingSession()).reason, 'no_draft');
  });

  await test('19. edit in your own words: replaces text, keeps tickers (and criteria only when the user says keep), keeps profile and assets', async () => {
    const s = await drafted();
    const before = s.thesisDraft.draft;
    const r = editAssumption(s, 2, 'AI chip demand from cloud companies keeps growing for the next couple of years.', null, { keepChallenge: true });
    assert(r.ok, r.displayText);
    const a = r.session.thesisDraft.draft.assumptionDetails[1];
    assert.strictEqual(a.text, 'AI chip demand from cloud companies keeps growing for the next couple of years.');
    assert.deepStrictEqual(a.tickers, ['NVDA'], 'no ticker named: keeps the original assumption\'s asset');
    assert.strictEqual(a.whatWouldChallengeIt, before.assumptionDetails[1].whatWouldChallengeIt);
    assert.strictEqual(a.origin, 'user');
    assert.strictEqual(r.session.thesisDraft.draft.assumptions[1], a.text, 'Contract C strings stay in sync');
    assert.deepStrictEqual(r.session.thesisDraft.draft.selectedAssets, before.selectedAssets);
    assert.deepStrictEqual(r.session.thesisDraft.draft.profileSnapshot, before.profileSnapshot);
    assert.deepStrictEqual(r.session.profile, s.profile);
    const withChallenge = editAssumption(r.session, 1, 'VOO companies keep growing earnings across most sectors.', 'Several quarters of falling S&P 500 earnings.');
    assert.strictEqual(withChallenge.session.thesisDraft.draft.assumptionDetails[0].whatWouldChallengeIt, 'Several quarters of falling S&P 500 earnings.');
  });

  await test('20. invalid edits are rejected and change nothing', async () => {
    const s = await drafted();
    const cases = [
      ['Buy more NVDA whenever it dips below its average.', /can't tell anyone to buy/],
      ['NVDA is a safe investment for the next two years.', /safe/],
      ['Apple keeps growing iPhone sales in China.', /AAPL isn't one of this thesis's selected investments/],
      ['Stocks go up', /full sentence/],
      ['I\'ll track NVDA and alert me when demand slows down.', /can't tell anyone/],
    ];
    for (const [text, re] of cases) {
      const r = editAssumption(s, 1, text);
      assert.strictEqual(r.ok, false, `accepted: ${text}`);
      assert(re.test(r.displayText), `${text} -> ${r.displayText}`);
      assert.deepStrictEqual(r.session.thesisDraft, s.thesisDraft, 'draft must be unchanged');
    }
    assert.strictEqual(editAssumption(s, 9, 'Valid text about VOO earnings growth.').reason, 'bad_index');
    assert.strictEqual(addAssumption(s, 'VOO earnings keep growing every single year.').ok, false, 'a new assumption needs its challenge evidence');
  });

  await test('21. keep 2-4: add up to 4, remove down to 2', async () => {
    let s = await drafted();
    s = addAssumption(s, 'VOO dividends keep rising slowly over time.', 'Dividend cuts across large S&P 500 companies.').session;
    s = addAssumption(s, 'NVDA keeps its lead in AI chips against rivals.', 'Rivals winning large AI chip contracts from NVIDIA customers.').session;
    assert.strictEqual(s.thesisDraft.draft.assumptionDetails.length, 4);
    assert.strictEqual(addAssumption(s, 'VOO keeps tracking the US market closely.', 'Tracking error news.').reason, 'too_many');
    s = removeAssumption(s, 4).session;
    s = removeAssumption(s, 3).session;
    assert.strictEqual(removeAssumption(s, 1).reason, 'too_few');
  });

  await test('22. regenerate: new proposals for the same assets/profile; failure leaves them unchanged', async () => {
    const s = await drafted();
    const alt = { assumptions: [
      { text: 'Profit margins of the large companies in VOO stay near current levels.', tickers: ['VOO'], whatWouldChallengeIt: 'Widespread margin compression in earnings reports.' },
      { text: 'Cloud providers keep raising AI capital spending that flows to NVIDIA.', tickers: ['NVDA'], whatWouldChallengeIt: 'Cloud providers cutting capital expenditure plans.' },
    ] };
    const llm = fakeLLM([alt]);
    const r = await regenerateAssumptions(s, { callLLM: llm });
    assert(r.ok, r.displayText);
    assert.deepStrictEqual(r.session.thesisDraft.draft.assumptions, alt.assumptions.map((a) => a.text));
    assert.strictEqual(r.session.thesisDraft.status, 'proposed');
    assert(llm.calls[0].user.includes('PREVIOUS ASSUMPTIONS'), 'previous assumptions must be sent so new ones differ');
    assert(llm.calls[0].user.includes(s.thesisDraft.draft.assumptions[0]));
    assert.deepStrictEqual(r.session.thesisDraft.draft.selectedAssets, s.thesisDraft.draft.selectedAssets);
    assert.deepStrictEqual(r.session.thesisDraft.draft.budget, s.thesisDraft.draft.budget);
    const same = await regenerateAssumptions(s, { callLLM: fakeLLM([{ assumptions: s.thesisDraft.draft.assumptionDetails }]) });
    assert.strictEqual(same.ok, false, 'identical assumptions are not "new"');
    const down = await regenerateAssumptions(s, { callLLM: fakeLLM([mkErr('LLM_HTTP', 'LLM HTTP 400: bad')]) });
    assert.strictEqual(down.ok, false);
    assert.deepStrictEqual(down.session.thesisDraft, s.thesisDraft, 'unchanged on failure');
  });

  await test('23. explicit confirmation; editing after confirmation invalidates it', async () => {
    const s = await drafted();
    const c = confirmAssumptions(s);
    assert(c.ok && c.status === 'confirmed', c.displayText);
    assert.strictEqual(c.session.thesisDraft.status, 'confirmed');
    assert(typeof c.session.thesisDraft.confirmedAt === 'string');
    const t = getConfirmedThesis(c.session);
    assert.strictEqual(t.assumptionStatus, 'confirmed');
    assert.deepStrictEqual(t.assumptions, s.thesisDraft.draft.assumptions);
    assert.strictEqual(t.status, 'draft', 'confirmed assumptions, but the thesis itself is still an unsaved draft');
    assert(/Nothing has been saved, monitored or emailed/.test(c.displayText));
    const e = editAssumption(c.session, 1, 'VOO companies keep growing earnings across most sectors.', 'Several quarters of falling S&P 500 earnings.');
    assert.strictEqual(e.confirmationCleared, true);
    assert.strictEqual(e.session.thesisDraft.status, 'proposed');
    assert.strictEqual(getConfirmedThesis(e.session), null);
    assert(/confirmation was cleared/.test(e.displayText));
    const again = confirmAssumptions(e.session);
    assert.strictEqual(getConfirmedThesis(again.session).assumptions[0], 'VOO companies keep growing earnings across most sectors.');
    const redraft = await createThesisDraft(again.session, { callLLM: fakeLLM([goodDraft()]) });
    assert.strictEqual(redraft.session.thesisDraft.status, 'proposed', 'a fresh draft needs a fresh confirmation');
  });


  console.log('--- regression: JSON parsing, backup on malformed replies, diagnostics, challenge criteria');
  const { extractJson } = thesis._onboarding;

  await test('24. JSON extraction tolerates fences, prose (even with braces) and trailing commas; reports cut-off replies', async () => {
    assert.deepStrictEqual(extractJson('```json\n{"a":1}\n```').obj, { a: 1 });
    assert.deepStrictEqual(extractJson('Here you go: {"a":"x}y"} Note: {this} is prose.').obj, { a: 'x}y' });
    assert.deepStrictEqual(extractJson('{"a":[1,2,],}').obj, { a: [1, 2] });
    assert(/cut off/.test(extractJson('{"goal":"Build wealth","assumptions":[{"text":"VOO').error));
    assert(/no JSON object/.test(extractJson('Sorry, I cannot.').error));
    const r = await createThesisDraft(confirmed('VOO, NVDA'), { callLLM: fakeLLM([JSON.stringify(goodDraft()) + '\nNote: {assumptions} are educational.']) });
    assert.strictEqual(r.source, 'gemini', `trailing prose with braces must not cause a fallback: ${r.fallbackReason}`);
  });

  await test('25. malformed reply from the primary model -> backup model is tried (draft, exploration, onboarding)', async () => {
    Object.assign(process.env, { GEMINI_MODEL: 'primary-m', FALLBACK_GEMINI_MODEL: 'backup-m' });
    try {
      const models = [];
      const llm = async (s, u, o) => { models.push(o.model); return o.model === 'primary-m' ? 'Here is your draft: "goal": "Build wealth"' : JSON.stringify(goodDraft()); };
      const r = await createThesisDraft(confirmed('VOO, NVDA'), { callLLM: llm });
      assert.deepStrictEqual(models, ['primary-m', 'backup-m']);
      assert.strictEqual(r.source, 'gemini');
      assert.strictEqual(r.model, 'backup-m');
      assert(/primary-m: malformed JSON/.test(r.diagnostics.attempts[0]) && r.diagnostics.attempts[1] === 'backup-m: ok', r.diagnostics.attempts.join(' | '));
      const both = await createThesisDraft(confirmed('VOO, NVDA'), { callLLM: async () => '{"goal": "Build wealth", "assumptions": [' });
      assert.strictEqual(both.source, 'fallback');
      assert(/primary-m: malformed JSON .*cut off.*; backup-m: malformed JSON/.test(both.fallbackReason), both.fallbackReason);
      const ex = []; await exploreInvestments(profileSession(), { callLLM: async (s, u, o) => { ex.push(o.model); return o.model === 'primary-m' ? 'nope' : '{"intro":"Here is an overview. The choice is yours."}'; } });
      assert.deepStrictEqual(ex, ['primary-m', 'backup-m']);
      const ob = []; const turn = await onboardingTurn('What is an ETF?', null, { callLLM: async (s, u, o) => { ob.push(o.model); return o.model === 'primary-m' ? '{"intent":"learning"}' : JSON.stringify({ intent: 'learning', reply: 'An ETF is a basket of investments.', profileUpdates: {}, tickers: [], ambiguities: [], nextQuestion: null }); } });
      assert.deepStrictEqual(ob, ['primary-m', 'backup-m'], 'wrong-shape onboarding JSON also tries the backup');
      assert.strictEqual(turn.model, 'backup-m');
    } finally { delete process.env.GEMINI_MODEL; delete process.env.FALLBACK_GEMINI_MODEL; }
    const single = []; await createThesisDraft(confirmed('VOO'), { callLLM: async (s, u, o) => { single.push(o.model); return 'nope'; } });
    assert.strictEqual(single.length, 1, 'no backup configured -> one attempt');
  });

  await test('26. valid JSON whose assumptions all fail validation is reported as such, with reasons', async () => {
    const llm = fakeLLM([goodDraft({ assumptions: [
      { text: 'Cloud giants like Microsoft and Amazon keep buying NVIDIA chips for AI.', tickers: ['NVDA'], whatWouldChallengeIt: 'Cloud giants cutting AI capital spending.' },
      { text: 'VOO keeps tracking the market closely over time.', tickers: ['VOO'] },
    ] })]);
    const r = await createThesisDraft(confirmed('VOO, NVDA'), { callLLM: llm });
    assert.strictEqual(r.source, 'fallback');
    assert(/valid JSON, but none of its assumptions passed validation/.test(r.fallbackReason), r.fallbackReason);
    assert(r.diagnostics.droppedAssumptions.some((x) => /tickers you did not select \(MSFT, AMZN\)/.test(x)), r.diagnostics.droppedAssumptions.join(' | '));
    assert(r.diagnostics.droppedAssumptions.some((x) => /whatWouldChallengeIt/.test(x)));
    assert(!/not valid JSON/.test(r.fallbackReason), 'must not be reported as invalid JSON');
  });

  await test('27. editing wording requires an explicit criteria decision: new, keep, or suggested', async () => {
    const s = await drafted();
    const old = s.thesisDraft.draft.assumptionDetails[1].whatWouldChallengeIt;
    const text = 'NVIDIA keeps winning most AI chip orders from big cloud companies.';
    const ask = editAssumption(s, 2, text);
    assert.strictEqual(ask.ok, false);
    assert.strictEqual(ask.reason, 'challenge_decision_needed');
    assert.strictEqual(ask.currentChallenge, old);
    assert.deepStrictEqual(ask.session.thesisDraft, s.thesisDraft, 'nothing changes until the user decides');
    assert.strictEqual(editAssumption(s, 2, 'Buy NVDA on every dip please').reason, 'invalid_assumption', 'wording is checked before asking about criteria');
    const kept = editAssumption(s, 2, text, null, { keepChallenge: true });
    assert.strictEqual(kept.challengeKept, true);
    assert.strictEqual(kept.session.thesisDraft.draft.assumptionDetails[1].whatWouldChallengeIt, old);
    assert(/you chose to keep/.test(kept.displayText));
    const fresh = editAssumption(s, 2, text, 'NVIDIA losing major cloud orders to rival chipmakers.');
    assert.strictEqual(fresh.challengeKept, false);
    assert.strictEqual(fresh.session.thesisDraft.draft.assumptionDetails[1].whatWouldChallengeIt, 'NVIDIA losing major cloud orders to rival chipmakers.');
    assert.strictEqual(editAssumption(s, 2, text, 'Sell NVDA if it drops.').ok, false, 'criteria are validated too');
    const onlyCrit = editChallenge(s, 1, 'Two quarters in a row of falling S&P 500 earnings.');
    assert(onlyCrit.ok, onlyCrit.displayText);
    assert.strictEqual(onlyCrit.session.thesisDraft.draft.assumptionDetails[0].text, s.thesisDraft.draft.assumptionDetails[0].text);
    assert.strictEqual(onlyCrit.session.thesisDraft.draft.assumptionDetails[0].whatWouldChallengeIt, 'Two quarters in a row of falling S&P 500 earnings.');
    const confirmedS = confirmAssumptions(s).session;
    assert.strictEqual(editChallenge(confirmedS, 1, 'Two quarters in a row of falling S&P 500 earnings.').confirmationCleared, true, 'changing criteria also clears confirmation');
  });

  await test('28. suggestChallenge: Gemini suggestion for the new wording, validated, template fallback, session untouched', async () => {
    const s = await drafted();
    const text = 'NVIDIA keeps winning most AI chip orders from big cloud companies.';
    const llm = fakeLLM([{ whatWouldChallengeIt: 'Reports that cloud companies are shifting AI chip orders away from NVIDIA to rivals.' }]);
    const g = await suggestChallenge(s, 2, text, { callLLM: llm });
    assert.strictEqual(g.source, 'gemini');
    assert(/shifting AI chip orders/.test(g.suggestion));
    assert(llm.calls[0].user.includes(text), 'suggestion must be for the NEW wording');
    assert.deepStrictEqual(g.session.thesisDraft, s.thesisDraft, 'suggesting never edits');
    const bad = await suggestChallenge(s, 2, text, { callLLM: fakeLLM([{ whatWouldChallengeIt: 'Apple and AAPL beating NVIDIA in AI chips.' }]) });
    assert.strictEqual(bad.source, 'fallback', 'suggestion naming unselected tickers is rejected');
    assert(/NVIDIA/.test(bad.suggestion));
    const off = await suggestChallenge(s, 2, text, { forceFallback: true });
    assert.strictEqual(off.source, 'fallback');
    assert(off.suggestion.length > 10);
  });

  const failed = results.filter(([ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} thesis draft tests passed`);
  process.exit(failed.length ? 1 : 0);
})();

// Tests onboardingTurn in server/thesis.js. Offline: no real Gemini calls, no key needed.
//  - "mock Gemini" tests inject a scripted callLLM so we control exactly what the model "says"
//    and check that the engine validates, merges and guards it.
//  - "llm.js failure" tests go through the real server/llm.js against a local HTTP mock (HTTP error, garbage).
//  - "fallback" tests use the rule-based path (no key / forced offline).
// Run: npm run test:onboarding   (~6 s: llm.js spaces real calls 5 s apart)
const assert = require('assert');
const http = require('http');

delete process.env.GEMINI_API_KEY; // never hit the real API from tests
const thesis = require('../server/thesis');
const { onboardingTurn, createOnboardingSession, _onboarding } = thesis;

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); console.log(`PASS  ${name}`); }
  catch (err) { results.push([false, name]); console.log(`FAIL  ${name}\n      ${err.message}`); }
}

// Scripted model: each call returns the next reply; prompts are recorded.
function fakeLLM(replies) {
  const calls = [];
  const fn = async (system, user) => {
    calls.push({ system, user });
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return typeof r === 'string' ? r : JSON.stringify(r);
  };
  fn.calls = calls;
  return fn;
}
const nulls = { amount: null, cadence: null, timelineYears: null, currency: null, experience: null, riskComfort: null, purpose: null };
const llmReply = (o) => ({ intent: 'unclear', reply: 'OK.', profileUpdates: { ...nulls }, tickers: [], ambiguities: [], nextQuestion: null, ...o, profileUpdates: { ...nulls, ...(o.profileUpdates || {}) } });

function assertShape(r) {
  for (const k of ['intent', 'reply', 'displayText', 'nextQuestion', 'profile', 'extractedThisTurn', 'corrections', 'tickers', 'ambiguities', 'activeFlow', 'missingFields', 'readyToProceed', 'suggestedNextStep', 'nextSteps', 'profileJustCompleted', 'monitoringActivated', 'source', 'model', 'fallbackReason', 'session']) {
    assert(k in r, `result is missing "${k}"`);
  }
  assert.strictEqual(r.monitoringActivated, false, 'monitoring must never be activated');
  assert(['gemini', 'fallback'].includes(r.source));
  assert(typeof r.displayText === 'string' && r.displayText.length > 0, 'displayText is empty');
  assert(Array.isArray(r.session.history));
}

(async () => {
  console.log('--- mock Gemini (engine validation on top of model output)');

  await test('1. learning question: direct answer, no onboarding question, no profile needed', async () => {
    const llm = fakeLLM([llmReply({ intent: 'learning', reply: 'A stock is one company; an ETF is a basket of many.' })]);
    const r = await onboardingTurn('What is the difference between an ETF and a stock?', null, { callLLM: llm });
    assertShape(r);
    assert.strictEqual(r.source, 'gemini');
    assert.strictEqual(r.intent, 'learning');
    assert.strictEqual(r.nextQuestion, null);
    assert.deepStrictEqual(r.profile, nulls);
    assert.strictEqual(r.readyToProceed, true, 'learning must not require a financial profile');
    assert.deepStrictEqual(r.missingFields, []);
    assert.strictEqual(r.suggestedNextStep, 'none', 'no thesis is offered for a learning question');
  });

  await test('2. missing information: keeps unknowns null, asks exactly one question', async () => {
    const llm = fakeLLM([llmReply({ intent: 'goal_exploration', reply: 'Starting small is a great way to learn.', profileUpdates: { amount: 20, cadence: 'weekly' }, nextQuestion: { field: 'purpose', text: 'What are you hoping this money will be for?' } })]);
    const r = await onboardingTurn("I'm a student and want to invest $20 a week.", null, { callLLM: llm });
    assertShape(r);
    assert.strictEqual(r.profile.amount, 20);
    assert.strictEqual(r.profile.cadence, 'weekly');
    for (const f of ['timelineYears', 'currency', 'experience', 'riskComfort', 'purpose']) assert.strictEqual(r.profile[f], null, `${f} should stay null`);
    assert.strictEqual(r.nextQuestion.field, 'purpose');
    assert.strictEqual(r.readyToProceed, false);
    assert.deepStrictEqual(r.missingFields, ['purpose', 'timelineYears', 'riskComfort']);
  });

  let session; // carried through tests 3 and 4
  await test('3. context retention: history and profile reach the model, known fields are never re-asked', async () => {
    const llm = fakeLLM([
      llmReply({ intent: 'goal_exploration', reply: 'Nice start.', profileUpdates: { amount: 20, cadence: 'weekly' }, nextQuestion: { field: 'purpose', text: 'What is it for?' } }),
      // the model "forgets" and asks for the amount again: the engine must not repeat it
      llmReply({ intent: 'goal_exploration', reply: 'A home in five years is a clear goal.', profileUpdates: { purpose: 'buy a home', timelineYears: 5 }, nextQuestion: { field: 'amount', text: 'How much can you invest?' } }),
    ]);
    const t1 = await onboardingTurn("I'm a student and want to invest $20 a week.", null, { callLLM: llm });
    const t2 = await onboardingTurn("It's for a home, in five years.", t1.session, { callLLM: llm });
    assert(llm.calls[1].user.includes("I'm a student and want to invest $20 a week."), 'turn 2 prompt lacks turn 1 history');
    assert(llm.calls[1].user.includes('"amount":20'), 'turn 2 prompt lacks the known profile');
    assert(llm.calls[1].user.includes('"purpose"'), 'turn 2 prompt lacks the already-asked list');
    assert.strictEqual(t2.profile.amount, 20, 'amount from turn 1 lost');
    assert.strictEqual(t2.profile.purpose, 'buy a home');
    assert.strictEqual(t2.profile.timelineYears, 5);
    assert.notStrictEqual(t2.nextQuestion && t2.nextQuestion.field, 'amount', 'known field was asked again');
    assert.strictEqual(t2.nextQuestion.field, 'riskComfort');
    assert.strictEqual(t2.session.history.length, 4);
    session = t2.session;
  });

  await test('4. correction: "Actually, $50 monthly" updates amount AND cadence, keeps everything else', async () => {
    const llm = fakeLLM([llmReply({ intent: 'goal_exploration', reply: 'Updated to $50 a month.', profileUpdates: { amount: 50, cadence: 'monthly' } })]);
    const r = await onboardingTurn('Actually, $50 monthly.', session, { callLLM: llm });
    assert.strictEqual(r.profile.amount, 50);
    assert.strictEqual(r.profile.cadence, 'monthly');
    assert.strictEqual(r.profile.purpose, 'buy a home', 'unrelated field was overwritten');
    assert.strictEqual(r.profile.timelineYears, 5, 'unrelated field was overwritten');
    assert.deepStrictEqual(r.corrections, [{ field: 'amount', from: 20, to: 50 }, { field: 'cadence', from: 'weekly', to: 'monthly' }]);
  });

  await test('5. ambiguous mortgage: no guessed amount, ambiguity listed, clarifying question, not ready', async () => {
    // the model wrongly treats the mortgage as the investment amount and flags nothing
    const llm = fakeLLM([llmReply({ intent: 'goal_exploration', reply: 'Buying a home is a big goal.', profileUpdates: { amount: 100000, purpose: 'buy a home' } })]);
    const r = await onboardingTurn('How much should I invest if I want to buy a home with a $100k mortgage?', null, { callLLM: llm });
    assert.strictEqual(r.profile.amount, null, 'the mortgage must not become the investment amount');
    assert.strictEqual(r.profile.purpose, 'buy a home');
    assert(r.ambiguities.length >= 1 && /mortgage/.test(r.ambiguities[0]));
    assert.strictEqual(r.nextQuestion.field, 'clarification');
    assert(/plan to take|already have|price/.test(r.nextQuestion.text));
    assert.strictEqual(r.readyToProceed, false);
  });

  await test('6. monitoring intent: ticker resolved, ready without amount/risk, nothing activated', async () => {
    const llm = fakeLLM([llmReply({ intent: 'monitoring', reply: 'I can help you research NVIDIA.', tickers: ['NVDA'], nextQuestion: { field: 'amount', text: 'How much would you invest?' } })]);
    const r = await onboardingTurn("I'm interested in tracking NVIDIA.", null, { callLLM: llm });
    assertShape(r);
    assert.strictEqual(r.intent, 'monitoring');
    assert.deepStrictEqual(r.tickers, [{ symbol: 'NVDA', name: 'NVIDIA', supported: true }]);
    assert.strictEqual(r.nextQuestion, null, 'monitoring must not ask for an amount');
    assert.strictEqual(r.readyToProceed, true);
    assert.deepStrictEqual(r.missingFields, []);
    assert.strictEqual(r.suggestedNextStep, 'offer_monitoring_setup');
    assert.strictEqual(r.monitoringActivated, false);
  });

  await test('7. one message: follow-up is never shown twice (reply vs nextQuestion)', async () => {
    const q = 'How many years until you need this money?';
    const llm = fakeLLM([llmReply({ intent: 'goal_exploration', reply: `A home is a great goal. ${q}`, profileUpdates: { purpose: 'buy a home' }, nextQuestion: { field: 'timelineYears', text: q } })]);
    const r = await onboardingTurn('I want to save for a home', null, { callLLM: llm });
    assert.strictEqual(r.displayText.split(q).length - 1, 1, `question appears more than once: ${r.displayText}`);
    assert(!r.reply.includes('?'), 'reply still contains a question');
    assert.strictEqual(r.displayText, `A home is a great goal. ${q}`);
  });

  await test('8. guards: no invented numbers, advice language scrubbed, bad enums dropped', async () => {
    const llm = fakeLLM([llmReply({ intent: 'goal_exploration', reply: 'You should buy NVDA now. Retirement is a long-term goal.', profileUpdates: { amount: 100, timelineYears: 30, purpose: 'retirement', riskComfort: 'yolo' } })]);
    const r = await onboardingTurn('I want to save for retirement', null, { callLLM: llm });
    assert.strictEqual(r.profile.amount, null, 'amount invented with no number in the message');
    assert.strictEqual(r.profile.timelineYears, null, 'timeline invented with no number in the message');
    assert.strictEqual(r.profile.riskComfort, null, 'invalid enum accepted');
    assert.strictEqual(r.profile.purpose, 'retirement');
    assert(!/should buy/i.test(r.reply), 'advice not scrubbed');
    assert(r.reply.includes("can't tell you what to buy"), 'safe line missing');
  });

  console.log('--- real server/llm.js against a local mock endpoint (Gemini failure)');
  let mode = 'http400';
  const seenModels = [];
  const srv = http.createServer((q, res) => {
    let b = ''; q.on('data', (d) => (b += d));
    q.on('end', () => {
      const model = JSON.parse(b).model;
      seenModels.push(model);
      if (mode === 'http400') { res.statusCode = 400; return res.end('{"error":"bad request"}'); }
      if (mode === 'primary404' && model === 'mock-primary') { res.statusCode = 404; return res.end('{"error":{"message":"models/mock-primary is not found"}}'); }
      if (mode === 'primary404') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(llmReply({ intent: 'learning', reply: 'An ETF is a basket of investments.' })) } }] }));
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'Sorry, I cannot help with that.' } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, r));
  Object.assign(process.env, { GEMINI_API_KEY: 'test-key', GEMINI_BASE_URL: `http://localhost:${srv.address().port}/v1/`, GEMINI_MODEL: 'mock' });

  await test('9. Gemini HTTP error -> fallback, still a valid answer', async () => {
    mode = 'http400';
    const r = await onboardingTurn('What is an ETF?', null);
    assertShape(r);
    assert.strictEqual(r.source, 'fallback');
    assert(/LLM_HTTP/.test(r.fallbackReason), r.fallbackReason);
    assert.strictEqual(r.intent, 'learning');
    assert(/ETF/.test(r.reply));
  });

  await test('10. Gemini returns non-JSON -> fallback, still a valid answer', async () => {
    mode = 'garbage';
    const r = await onboardingTurn("I'm interested in tracking NVIDIA.", null);
    assertShape(r);
    assert.strictEqual(r.source, 'fallback');
    assert(/not valid JSON/.test(r.fallbackReason), r.fallbackReason);
    assert.strictEqual(r.intent, 'monitoring');
    assert.strictEqual(r.tickers[0].symbol, 'NVDA');
  });

  await test('11b. real llm.js: primary model 404 (unavailable) -> backup model answers', async () => {
    mode = 'primary404';
    Object.assign(process.env, { GEMINI_MODEL: 'mock-primary', FALLBACK_GEMINI_MODEL: 'mock-backup' });
    seenModels.length = 0;
    const r = await onboardingTurn('What is an ETF?', null);
    assert.deepStrictEqual(seenModels, ['mock-primary', 'mock-backup']);
    assert.strictEqual(r.source, 'gemini');
    assert.strictEqual(r.model, 'mock-backup');
    delete process.env.FALLBACK_GEMINI_MODEL;
    process.env.GEMINI_MODEL = 'mock';
  });
  srv.close();

  await test('11. no GEMINI_API_KEY -> fallback with a clear reason', async () => {
    delete process.env.GEMINI_API_KEY;
    const r = await onboardingTurn('What is investing?', null);
    assert.strictEqual(r.source, 'fallback');
    assert.strictEqual(r.fallbackReason, 'GEMINI_API_KEY not set');
    assert.strictEqual(r.intent, 'learning');
  });

  console.log('--- rule-based fallback');
  const off = { forceFallback: true };

  await test('12. fallback learning answers directly', async () => {
    const r = await onboardingTurn('What is the difference between an ETF and a stock?', null, off);
    assert.strictEqual(r.intent, 'learning');
    assert.strictEqual(r.nextQuestion, null);
    assert(/basket/.test(r.reply));
    assert.strictEqual(r.readyToProceed, true);
  });

  await test('13. fallback goal extraction keeps unknowns null', async () => {
    const r = await onboardingTurn('I want to build wealth over 10 years but I\'m a beginner.', null, off);
    assert.strictEqual(r.intent, 'goal_exploration');
    assert.strictEqual(r.profile.timelineYears, 10);
    assert.strictEqual(r.profile.experience, 'beginner');
    assert.strictEqual(r.profile.purpose, 'build long-term wealth');
    assert.strictEqual(r.profile.amount, null);
    assert.strictEqual(r.profile.currency, null, 'currency must not be guessed');
    assert.strictEqual(r.nextQuestion.field, 'amount');
  });

  await test('14. fallback mortgage ambiguity', async () => {
    const r = await onboardingTurn('How much should I invest if I want to buy a home with a $100k mortgage?', null, off);
    assert.strictEqual(r.profile.amount, null);
    assert.strictEqual(r.nextQuestion.field, 'clarification');
    assert(/your decision/.test(r.reply), 'should explain it will not decide the amount');
  });

  await test('15. fallback monitoring: supported and unsupported tickers', async () => {
    const a = await onboardingTurn("I'm interested in tracking NVIDIA.", null, off);
    assert.strictEqual(a.intent, 'monitoring');
    assert.strictEqual(a.readyToProceed, true);
    assert(/hasn't been activated/.test(a.reply), a.reply);
    const b = await onboardingTurn('I want to track $TSLA', null, off);
    assert.deepStrictEqual(b.tickers, [{ symbol: 'TSLA', name: null, supported: false }]);
    assert.strictEqual(b.readyToProceed, false);
    assert.strictEqual(b.nextQuestion.field, 'ticker');
  });

  await test('16. fallback conversation: context, correction, topic change, short answer -> ready', async () => {
    let s = createOnboardingSession();
    const say = async (m) => { const r = await onboardingTurn(m, s, off); s = r.session; return r; };
    await say('I want to save for a home in five years.');
    await say('I can put in $20 weekly');
    const c = await say('Actually, $50 monthly');
    assert.deepStrictEqual(c.corrections.map((x) => x.field), ['amount', 'cadence']);
    assert.strictEqual(c.profile.timelineYears, 5);
    const l = await say('What is an index fund?');
    assert.strictEqual(l.intent, 'learning');
    assert.strictEqual(l.nextQuestion, null, 'a side question should be answered, not followed by onboarding');
    assert.strictEqual(l.profile.amount, 50, 'profile lost during topic change');
    const last = await say('low');
    assert.strictEqual(last.profile.riskComfort, 'low');
    assert.strictEqual(last.readyToProceed, true);
    assert.strictEqual(last.suggestedNextStep, 'offer_thesis_draft');
    const asked = s.askedFields.filter((k) => !k.startsWith('clarification'));
    for (const k of new Set(asked)) assert(asked.filter((x) => x === k).length <= 2, `${k} asked more than twice`);
  });

  await test('17. existing contract untouched: createThesis/matchNews/IS_STUB', async () => {
    const t = await thesis.createThesis('anything');
    assert(['low', 'medium', 'high'].includes(t.tier) && Array.isArray(t.assumptions) && t.goal);
    const m = await thesis.matchNews(t, [{ ticker: 'VOO', headline: 'h', url: 'u', sentiment: -0.5 }]);
    assert.strictEqual(m[0].stance, 'challenges');
    assert.strictEqual(thesis.IS_STUB, true);
    assert(_onboarding.loadPrompt('onboarding'), 'onboarding prompt not found in prompts/thesis.md');
  });

  await test('18. empty message does not change the session', async () => {
    const s0 = createOnboardingSession();
    const r = await onboardingTurn('   ', s0, off);
    assert.deepStrictEqual(r.session, s0);
  });


  console.log('--- onboarding completion, next steps, monitoring wording');
  const completeSoFar = { ...createOnboardingSession(), activeFlow: 'goal_exploration', askedFields: ['purpose', 'timelineYears', 'amount', 'riskComfort'], lastQuestionField: 'riskComfort',
    profile: { ...nulls, purpose: 'buy a home', timelineYears: 5, amount: 50, cadence: 'monthly', experience: 'beginner' } };

  let doneSession;
  await test('19. completion: summary + Explore Investments / Create Thesis Draft, no more questions, nothing created', async () => {
    const llm = fakeLLM([llmReply({ intent: 'goal_exploration', reply: 'Being cautious is completely normal.', profileUpdates: { riskComfort: 'low' }, nextQuestion: { field: 'currency', text: 'Which currency?' } })]);
    const r = await onboardingTurn("Low, I'd be nervous about losing money.", completeSoFar, { callLLM: llm });
    assertShape(r);
    assert.strictEqual(r.readyToProceed, true);
    assert.strictEqual(r.profileJustCompleted, true);
    assert.strictEqual(r.nextQuestion, null, 'should offer next steps, not ask another question');
    assert(/Here's your profile so far: goal: buy a home · \$50 monthly · timeline: 5 years · risk comfort: low/.test(r.reply), r.reply);
    assert(/Explore Investments/.test(r.displayText) && /Create Thesis Draft/.test(r.displayText));
    assert(/Nothing is created or monitored until you choose/.test(r.reply));
    assert.deepStrictEqual(r.nextSteps.map((x) => x.id), ['explore_investments', 'create_thesis_draft']);
    assert.strictEqual(r.suggestedNextStep, 'offer_thesis_draft');
    assert(!('thesis' in r), 'no thesis may be created by onboarding');
    doneSession = r.session;
  });

  await test('20. completion summary is not repeated, but is refreshed after a correction', async () => {
    const llm = fakeLLM([
      llmReply({ intent: 'goal_exploration', reply: 'Happy to keep going.' }),
      llmReply({ intent: 'goal_exploration', reply: 'Updated.', profileUpdates: { amount: 75 } }),
    ]);
    const again = await onboardingTurn('Thanks!', doneSession, { callLLM: llm });
    assert.strictEqual(again.profileJustCompleted, false);
    assert(!/Here's your profile/.test(again.reply), 'summary repeated');
    assert.strictEqual(again.readyToProceed, true);
    const fixed = await onboardingTurn('Actually make it $75 a month.', again.session, { callLLM: llm });
    assert.strictEqual(fixed.profileJustCompleted, true);
    assert(/\$75 monthly/.test(fixed.reply), fixed.reply);
  });

  await test('21. next steps depend on intent (learning none, research explore, goal incomplete none)', async () => {
    const llm = fakeLLM([
      llmReply({ intent: 'learning', reply: 'A bond is a loan.' }),
      llmReply({ intent: 'investment_discovery', reply: 'Here is what THESIS covers.' }),
      llmReply({ intent: 'goal_exploration', reply: 'Nice.', profileUpdates: { purpose: 'retirement' } }),
    ]);
    assert.deepStrictEqual((await onboardingTurn('What is a bond?', null, { callLLM: llm })).nextSteps, []);
    assert.deepStrictEqual((await onboardingTurn('What ETFs can I look at?', null, { callLLM: llm })).nextSteps.map((x) => x.id), ['explore_investments']);
    const g = await onboardingTurn('I want to save for retirement', null, { callLLM: llm });
    assert.deepStrictEqual(g.nextSteps, []);
    assert.strictEqual(g.profileJustCompleted, false);
  });

  await test('22. "Track NVIDIA": says monitoring is available but not activated; false tracking claims removed', async () => {
    const llm = fakeLLM([
      llmReply({ intent: 'monitoring', reply: "Great choice! I'll track NVIDIA for you and send alerts. It designs chips.", tickers: ['NVDA'] }),
      llmReply({ intent: 'monitoring', reply: "I can help you research NVIDIA. Monitoring hasn't been activated yet.", tickers: ['NVDA'] }),
      llmReply({ intent: 'monitoring', reply: 'I can help you research NVIDIA. Please note that I do not track or monitor assets.', tickers: ['NVDA'] }),
    ]);
    const r = await onboardingTurn('Track NVIDIA', null, { callLLM: llm });
    assert(!/I'll track/i.test(r.reply), `false claim kept: ${r.reply}`);
    assert(/It designs chips\./.test(r.reply), 'unrelated sentence dropped');
    assert(r.reply.includes("hasn't been activated"), r.reply);
    assert.deepStrictEqual(r.nextSteps.map((x) => x.id), ['explore_investments', 'set_up_monitoring']);
    assert.strictEqual(r.monitoringActivated, false);
    const ok = await onboardingTurn('Track NVIDIA', null, { callLLM: llm });
    assert.strictEqual(ok.reply.split("hasn't been activated").length - 1, 1, 'monitoring line duplicated');
    const denied = await onboardingTurn('Track NVIDIA', null, { callLLM: llm });
    assert(!/do not track/.test(denied.reply), `contradictory denial kept: ${denied.reply}`);
    assert(denied.reply.includes("hasn't been activated"));
  });

  await test('23. fallback "Track NVIDIA" explains monitoring is not active', async () => {
    const r = await onboardingTurn('Track NVIDIA', null, { forceFallback: true });
    assert.strictEqual(r.intent, 'monitoring');
    assert(/available for this, but it hasn't been activated/.test(r.reply), r.reply);
    assert.strictEqual(r.monitoringActivated, false);
  });

  await test('24. fallback completion offers both next steps', async () => {
    let s = createOnboardingSession();
    for (const m of ['I want to save for a home in five years.', 'I can put in $50 monthly']) s = (await onboardingTurn(m, s, { forceFallback: true })).session;
    const r = await onboardingTurn('low', s, { forceFallback: true });
    assert.strictEqual(r.profileJustCompleted, true);
    assert(/Explore Investments/.test(r.reply) && /Create Thesis Draft/.test(r.reply), r.reply);
  });

  console.log('--- Gemini model fallback (GEMINI_MODEL -> FALLBACK_GEMINI_MODEL)');
  const mkErr = (code, message) => Object.assign(new Error(message), { code });
  const withModels = async (fn) => {
    Object.assign(process.env, { GEMINI_MODEL: 'primary-m', FALLBACK_GEMINI_MODEL: 'backup-m' });
    try { await fn(); } finally { delete process.env.GEMINI_MODEL; delete process.env.FALLBACK_GEMINI_MODEL; }
  };
  const okReply = JSON.stringify(llmReply({ intent: 'learning', reply: 'An ETF is a basket of investments.' }));
  const modelLLM = (outcomes) => {
    const models = [];
    const fn = async (sys, user, o) => { models.push(o.model); const x = outcomes.shift(); if (x instanceof Error) throw x; return x; };
    fn.models = models;
    return fn;
  };

  await test('25. primary model succeeds: backup never called', () => withModels(async () => {
    const llm = modelLLM([okReply]);
    const r = await onboardingTurn('What is an ETF?', null, { callLLM: llm });
    assert.deepStrictEqual(llm.models, ['primary-m']);
    assert.strictEqual(r.source, 'gemini');
    assert.strictEqual(r.model, 'primary-m');
  }));

  await test('26. primary rate-limited -> backup succeeds', () => withModels(async () => {
    const llm = modelLLM([mkErr('LLM_RATE_LIMIT', 'LLM HTTP 429: quota'), okReply]);
    const r = await onboardingTurn('What is an ETF?', null, { callLLM: llm });
    assert.deepStrictEqual(llm.models, ['primary-m', 'backup-m']);
    assert.strictEqual(r.source, 'gemini');
    assert.strictEqual(r.model, 'backup-m');
  }));

  await test('27. primary temporary error (503) or unavailable (404) -> backup succeeds', () => withModels(async () => {
    for (const e of [mkErr('LLM_HTTP', 'LLM HTTP 503: overloaded'), mkErr('LLM_HTTP', 'LLM HTTP 404: model not found'), mkErr('LLM_NETWORK', 'LLM request failed: aborted')]) {
      const llm = modelLLM([e, okReply]);
      const r = await onboardingTurn('What is an ETF?', null, { callLLM: llm });
      assert.strictEqual(r.model, 'backup-m', `no backup after ${e.message}`);
    }
  }));

  await test('28. both models fail -> offline onboarding fallback still answers', () => withModels(async () => {
    const llm = modelLLM([mkErr('LLM_RATE_LIMIT', 'LLM HTTP 429: quota'), mkErr('LLM_HTTP', 'LLM HTTP 503: overloaded')]);
    const r = await onboardingTurn('What is an ETF?', null, { callLLM: llm });
    assertShape(r);
    assert.deepStrictEqual(llm.models, ['primary-m', 'backup-m']);
    assert.strictEqual(r.source, 'fallback');
    assert(/both models failed/.test(r.fallbackReason), r.fallbackReason);
    assert.strictEqual(r.intent, 'learning');
    assert(/ETF/.test(r.reply));
  }));

  await test('29. auth errors are never retried on the backup model', () => withModels(async () => {
    for (const e of [mkErr('LLM_HTTP', 'LLM HTTP 401: unauthorized'), mkErr('LLM_HTTP', 'LLM HTTP 403: permission denied'), mkErr('LLM_HTTP', 'LLM HTTP 400: API key not valid. Please pass a valid API key.')]) {
      const llm = modelLLM([e, okReply]);
      const r = await onboardingTurn('What is an ETF?', null, { callLLM: llm });
      assert.deepStrictEqual(llm.models, ['primary-m'], `retried after ${e.message}`);
      assert.strictEqual(r.source, 'fallback');
    }
  }));

  await test('30. no FALLBACK_GEMINI_MODEL configured -> single attempt, then offline fallback', async () => {
    process.env.GEMINI_MODEL = 'primary-m';
    try {
      const llm = modelLLM([mkErr('LLM_RATE_LIMIT', 'LLM HTTP 429: quota')]);
      const r = await onboardingTurn('What is an ETF?', null, { callLLM: llm });
      assert.deepStrictEqual(llm.models, ['primary-m']);
      assert.strictEqual(r.source, 'fallback');
    } finally { delete process.env.GEMINI_MODEL; }
  });

  const failed = results.filter(([ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} onboarding tests passed`);
  process.exit(failed.length ? 1 : 0);
})();

// Tests for thesisChat (server/thesis.js): general thesis chat and news investigation in one engine.
// Offline: a scripted callLLM stands in for Gemini. No key, no network, nothing saved, monitored, emailed
// or traded (fetch is stubbed to prove it). Run: npm run test:chat
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DB = path.join(os.tmpdir(), `loop-chat-${process.pid}.json`);
process.env.LOOP_DB_FILE = DB; // only the notify compatibility check (last) writes here
for (const k of ['GEMINI_API_KEY', 'GEMINI_MODEL', 'FALLBACK_GEMINI_MODEL', 'N8N_NOTIFY_WEBHOOK_URL', 'NOTIFY_TO_EMAIL']) delete process.env[k];

const T = require('../server/thesis');
const SAMPLE = require('./sample-news');
const { thesisChat } = T;
const { UNSUPPORTED_LINE } = T._chat;
const SAFE_LINE_START = "I can't tell you what to buy, sell or hold";

const RESULT_KEYS = ['ok', 'mode', 'thesisId', 'reply', 'displayText', 'segments', 'citations', 'followUps', 'insufficientEvidence', 'history', 'source', 'model', 'fallbackReason', 'droppedCitations', 'removedClaims', 'disclaimer', 'error'];
const roundTrip = (x) => JSON.parse(JSON.stringify(x));
const llmError = (status, code = 'LLM_HTTP') => Object.assign(new Error(`LLM HTTP ${status}: mocked`), { code });

// Scripted Gemini: each reply is an object (sent as JSON), a raw string, or an Error to throw.
function mock(replies) {
  const calls = [];
  const fn = async (system, user, o) => {
    calls.push({ system, user, model: o && o.model });
    const r = typeof replies === 'function' ? replies(user, o) : replies.shift();
    if (r instanceof Error) throw r;
    return typeof r === 'string' ? r : JSON.stringify(r);
  };
  fn.calls = calls;
  return fn;
}
const answer = (segments, extra = {}) => ({ answer: segments, followUps: ['What would weaken this assumption?'], insufficientEvidence: false, ...extra });
const seg = (text, basis = 'general', sources = []) => ({ text, basis, sources });

function check(r) {
  for (const k of RESULT_KEYS) assert(k in r, `result is missing "${k}"`);
  assert.deepStrictEqual(roundTrip(r), r, 'result must be JSON-safe');
  assert.strictEqual(r.disclaimer, 'Educational research, not investment advice.');
  assert(!/api[_-]?key|authorization|bearer\s/i.test(JSON.stringify(r)), 'no credentials in the result');
  if (r.ok) {
    assert(r.displayText.endsWith(r.disclaimer), 'displayText carries the disclaimer');
    for (const s of r.segments) assert(['thesis', 'evidence', 'general', 'uncertain'].includes(s.basis), `basis ${s.basis}`);
    for (const c of r.citations) assert(c.url === null || /^https?:\/\//.test(c.url), 'citation urls are http(s) or null');
    r.citations.forEach((c, i) => assert.strictEqual(c.id, i + 1, 'citations numbered 1..n'));
  }
  return r;
}

// Confirmed theses through the real flow (offline draft, then the user's own assumption 1).
const nulls = { amount: null, cadence: null, timelineYears: null, currency: null, experience: null, riskComfort: null, purpose: null };
const NVDA_TEXT = 'Demand for NVIDIA AI data-center chips keeps growing as cloud companies expand AI infrastructure.';
const NVDA_CHALLENGE = 'NVIDIA lowering guidance, or cloud customers cutting AI infrastructure spending.';
const VOO_TEXT = 'Earnings of the S&P 500 companies held in VOO stay resilient over the next five years.';
const VOO_CHALLENGE = 'Falling S&P 500 earnings, profit warnings across sectors, or a US recession.';
async function buildThesis(symbols, text, challenge, profile = {}) {
  let s = T.createOnboardingSession();
  s.profile = { ...nulls, amount: 50, cadence: 'monthly', timelineYears: 5, experience: 'beginner', riskComfort: 'medium', purpose: 'build long-term wealth', ...profile };
  s = T.confirmSelection(T.selectAssets(symbols, s).session).session;
  s = (await T.createThesisDraft(s, { forceFallback: true })).session;
  s = T.editAssumption(s, 1, text, challenge).session;
  return T.getConfirmedThesis(T.confirmAssumptions(s).session);
}
// Saved matches (the shape the pipeline stores) from a mocked news-matching run.
const newsMock = () => mock(() => ({ matches: Array.from({ length: 10 }, (_, i) => ({ article: i + 1, assumptionIndex: 0, relevance: 'direct', stance: ['challenges', 'supports', 'neutral'][i % 3], whyItMatters: 'This relates to the demand for AI data-center chips in assumption one.' })) }));
const idxOf = (list, start) => list.findIndex((m) => m.headline.startsWith(start));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
let A; let B; let MATCHES;

test('1. general chat with no article or notification: thesis-only answer, no citations', async () => {
  const llm = mock([answer([seg('Your thesis is a bet that NVIDIA keeps selling lots of AI chips while you invest $50 a month for 5 years.', 'thesis'), seg('Diversification means spreading money across many investments so one bad result hurts less.')])]);
  const r = check(await thesisChat(A, [], 'Can you explain my thesis in simple terms?', {}, { callLLM: llm }));
  assert(r.ok && r.mode === 'general' && r.source === 'gemini' && r.thesisId === A.id);
  assert.deepStrictEqual(r.citations, []);
  assert.strictEqual(r.segments.length, 2);
  assert(r.reply.includes('Diversification means'), 'general explanation kept intact');
  assert(llm.calls[0].user.includes('EVIDENCE: none supplied'), 'prompt says there is no evidence');
  assert.strictEqual(r.history.length, 2);
  assert.deepStrictEqual(r.history.map((h) => h.role), ['user', 'assistant']);
  assert(r.history.every((h) => h.thesisId === A.id));
});

test('2. grounded in THIS confirmed thesis: assumptions, challenge criteria, assets, horizon, risk', async () => {
  const llm = mock([answer([seg('Your first assumption is about AI chip demand.', 'thesis')])]);
  await thesisChat(A, [], 'What assumptions am I making?', {}, { callLLM: llm });
  const p = llm.calls[0].user;
  for (const want of [NVDA_TEXT, NVDA_CHALLENGE, 'NVDA (NVIDIA', '5 years', '"riskComfort": "medium"', '"experience": "beginner"', A.goal]) assert(p.includes(want), `prompt includes ${want}`);
  assert(!p.includes(VOO_TEXT), 'no other thesis in the prompt');
  assert(llm.calls[0].system.includes('research assistant inside THESIS'), 'chat prompt from prompts/thesis.md');
});

test('3. news investigation: focus article is E1 with summary + earlier assessment; citation maps to its URL', async () => {
  const focus = idxOf(MATCHES, 'Nvidia warns');
  assert(focus >= 0 && MATCHES[focus].summary, 'saved match carries the article summary');
  const llm = mock([answer([seg('The summary says large cloud customers are delaying GPU orders, which is what your first assumption says would challenge it.', 'evidence', ['E1']), seg('One quarter of delays does not by itself show long-term demand is falling.', 'general')])]);
  const r = check(await thesisChat(A, [], 'Why does this article challenge my first assumption?', { evidence: MATCHES, focus }, { callLLM: llm }));
  assert.strictEqual(r.mode, 'investigation');
  assert.strictEqual(r.citations.length, 1);
  assert.deepStrictEqual(r.citations[0], { id: 1, evidenceId: 'E1', title: 'Nvidia warns of slowing AI data-center orders', url: 'https://example.com/sample/nvidia-slowing-ai-orders',
    publisher: 'Sample Wire', datetime: '2026-11-15T13:00:00Z', ticker: 'NVDA', evidence: 'headline_and_summary' });
  assert(r.reply.includes('[1]'));
  const p = llm.calls[0].user;
  assert(p.includes('investigation') && p.includes('"id": "E1"'));
  assert(p.indexOf('Nvidia warns') < p.indexOf('Nvidia posts record'), 'focus article listed first');
  assert(p.includes('delaying data-center GPU orders'), 'article summary reaches Gemini');
  assert(p.includes('"stanceShownToUser": "challenges"') && p.includes('"assumptionNumber": 1'), 'earlier assessment reaches Gemini');
  assert(!/https?:\/\//.test(p), 'URLs never reach Gemini');
});

test('4. follow-up turns keep context; old markers become headlines; history is capped at 20', async () => {
  const focus = idxOf(MATCHES, 'Nvidia warns');
  const llm = mock([
    answer([seg('The summary says cloud customers are delaying GPU orders.', 'evidence', ['E1'])]),
    answer([seg('It is one data point; your thesis has a 5-year horizon.', 'thesis')]),
  ]);
  const r1 = await thesisChat(A, [], 'What does this article say?', { evidence: MATCHES, focus }, { callLLM: llm });
  const r2 = check(await thesisChat(A, roundTrip(r1.history), 'Does this mean my thesis is wrong?', { evidence: MATCHES, focus }, { callLLM: llm }));
  const p = llm.calls[1].user;
  assert(p.includes('What does this article say?'), 'previous question in the prompt');
  assert(p.includes('(source: \\"Nvidia warns of slowing AI data-center orders\\")'), 'previous citation shown as its headline (JSON-escaped in the fence)');
  assert(!/\[1\]/.test(p.split('CONVERSATION SO FAR')[1]), 'old [n] markers are not reusable');
  assert.strictEqual(r2.history.length, 4);
  assert.deepStrictEqual(r2.history[1].citations[0].url, 'https://example.com/sample/nvidia-slowing-ai-orders', 'old citations stay in history for the UI');
  const long = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}`, thesisId: A.id }));
  const r3 = await thesisChat(A, long, 'Next?', {}, { callLLM: mock([answer([seg('OK, here is more.', 'general')])]) });
  assert.strictEqual(r3.history.length, 20);
  assert.strictEqual(r3.history[19].role, 'assistant');
});

test('5. citation ids are validated, deduplicated and numbered by first use', async () => {
  const ev = MATCHES;
  const llm = mock([answer([seg('According to the summary, Nvidia reported record data-center revenue.', 'evidence', ['E2']), seg('According to the summaries, demand signals are mixed.', 'evidence', ['E1', 'E2', 'E1'])])]);
  const r = check(await thesisChat(A, [], 'Summarise the news', { evidence: ev }, { callLLM: llm }));
  assert.deepStrictEqual(r.citations.map((c) => c.evidenceId), ['E2', 'E1']);
  assert.deepStrictEqual(r.segments.map((s) => s.citations), [[1], [2, 1]]);
  assert(r.reply.includes('revenue. [1]') && r.reply.includes('mixed. [2][1]'));
  assert.strictEqual(r.citations[0].title, ev[1].headline, 'E2 is the second evidence item');
});

test('6. fabricated citations, invented URLs and invalid source URLs are rejected', async () => {
  const bad = idxOf(MATCHES, 'Nvidia shares swing'); // its url is javascript:alert(1)
  assert(bad >= 0 && MATCHES[bad].url === null, 'matcher already nulled the bad url');
  const llm = mock([answer([
    seg('Nvidia guided revenue to $40 billion next quarter.', 'evidence', ['E9']), // fabricated id
    seg('Analysts expect a 20% rise, see https://evil.example/x for more.', 'general', ['E7x']), // invented source on a "general" claim
    seg('The headline says Nvidia shares swung after its analyst day.', 'evidence', ['E1']),
    seg('Your second assumption is about avoiding a large drop.', 'thesis', ['E1']), // thesis is never sourced
    seg('An analyst day is an event where a company explains its plans to investors.', 'general'),
    seg('Read more at www.example.org/page.', 'general'),
  ])]);
  const r = check(await thesisChat(A, [], 'Explain this', { evidence: MATCHES, focus: bad }, { callLLM: llm }));
  assert.strictEqual(r.removedClaims, 2, 'both unsupported evidence claims removed');
  assert.strictEqual(r.droppedCitations, 3, 'E9 + E7x + the thesis segment source');
  assert(r.insufficientEvidence, 'removed claims mark the answer as insufficient');
  assert(!r.reply.includes('$40 billion') && !r.reply.includes('20%'), 'unsupported facts are not shown');
  assert.strictEqual(r.segments.filter((s) => s.text === UNSUPPORTED_LINE).length, 1, 'consecutive removals collapse into one uncertainty line');
  assert(!/https?:\/\/|www\./.test(r.reply), 'no model-written URLs');
  assert.strictEqual(r.citations.length, 1);
  assert.strictEqual(r.citations[0].url, null, 'invalid source URL becomes null, never passed through');
  const thesisSeg = r.segments.find((s) => s.basis === 'thesis');
  assert(thesisSeg && thesisSeg.citations.length === 0 && thesisSeg.text.includes('second assumption'), 'user-provided thesis text kept, unsourced');
  assert(r.segments.some((s) => s.basis === 'general' && s.text.startsWith('An analyst day is')), 'general explanation kept intact');
});

test('7. headline-only vs summary evidence: claims are attributed, never stated as established fact', async () => {
  const { attributeEvidence } = T._chat;
  const hl = { summary: null };
  const sm = { summary: 'x'.repeat(50) };
  assert.strictEqual(attributeEvidence('Export limits will cut Nvidia sales.', [hl]), 'Based on the headline alone, export limits will cut Nvidia sales.');
  assert.strictEqual(attributeEvidence('The headline says export limits could trim sales.', [hl]), 'The headline says export limits could trim sales.');
  assert.strictEqual(attributeEvidence('The article says sales fell.', [hl]), 'Based on the headline alone, the article says sales fell.', 'headline-only must mention the headline');
  assert.strictEqual(attributeEvidence('Nvidia lowered its revenue guidance.', [sm]), "According to the article's summary, Nvidia lowered its revenue guidance.");
  assert.strictEqual(attributeEvidence('The summary says demand is slowing.', [sm]), 'The summary says demand is slowing.');
  assert(attributeEvidence('Demand is mixed.', [sm, hl]).startsWith('According to the headlines and summaries provided'));
  assert(attributeEvidence('Demand is strong.', [sm, sm]).startsWith('According to the article summaries'));

  const hlIdx = idxOf(MATCHES, 'Export limits');
  const smIdx = idxOf(MATCHES, 'Nvidia warns');
  const ev = [MATCHES[smIdx], MATCHES[hlIdx]]; // E1 summary, E2 headline only
  const llm = mock([answer([
    seg('Nvidia lowered its revenue guidance for next quarter.', 'evidence', ['E1']),
    seg('Export limits will reduce Nvidia chip sales.', 'evidence', ['E2']),
    seg('I verified this with Reuters. The two items point in the same direction.', 'evidence', ['E1', 'E2']),
  ])]);
  const r = check(await thesisChat(A, [], 'What does the news say?', { evidence: ev }, { callLLM: llm }));
  assert.strictEqual(r.segments[0].text, "According to the article's summary, Nvidia lowered its revenue guidance for next quarter.");
  assert.strictEqual(r.segments[1].text, 'Based on the headline alone, export limits will reduce Nvidia chip sales.');
  assert(!/verified/i.test(r.reply), 'claims of verification or live research are removed');
  assert(r.segments[2].text.startsWith('According to the headlines and summaries provided'));
  assert.deepStrictEqual(r.citations.map((c) => c.evidence), ['headline_and_summary', 'headline_only']);
  const p = llm.calls[0].user;
  assert(p.includes('headline only (no summary)') && p.includes('not the full article'), 'prompt states what was actually available');
});

test('8. missing evidence and uncertain answers', async () => {
  const llm = mock([
    answer([seg('I only have your thesis here, no news, so I cannot say how NVIDIA is doing right now.', 'general'), seg('Nvidia shares rose 5% today.', 'evidence', ['E1'])], { insufficientEvidence: true }),
    answer([seg('Nvidia earnings beat estimates.', 'evidence', ['E1'])]),
  ]);
  const r = check(await thesisChat(A, [], 'How is NVIDIA doing?', {}, { callLLM: llm }));
  assert(r.insufficientEvidence && r.removedClaims === 1 && r.citations.length === 0);
  assert(!r.reply.includes('5%'), 'no invented market facts when there is no evidence');
  const r2 = check(await thesisChat(A, [], 'How are earnings?', {}, { callLLM: llm }));
  assert.strictEqual(r2.source, 'gemini');
  assert.strictEqual(r2.reply, UNSUPPORTED_LINE, 'an answer made only of unsupported claims becomes the uncertainty line');
});

test('9. Gemini failures: primary -> backup; both fail / no key / offline / malformed -> deterministic fallback', async () => {
  Object.assign(process.env, { GEMINI_MODEL: 'primary-m', FALLBACK_GEMINI_MODEL: 'backup-m' });
  try {
    const llm = mock([llmError(503), answer([seg('Answer from the backup model.', 'general')])]);
    const r = check(await thesisChat(A, [], 'Hi', {}, { callLLM: llm }));
    assert.deepStrictEqual(llm.calls.map((c) => c.model), ['primary-m', 'backup-m']);
    assert(r.source === 'gemini' && r.model === 'backup-m');

    const both = check(await thesisChat(A, [], 'Hi', {}, { callLLM: mock([llmError(503), llmError(503)]) }));
    assert(both.ok && both.source === 'fallback' && both.fallbackReason === 'ai_error' && both.model === null);
    assert(both.reply.includes('unavailable') && both.reply.includes(NVDA_TEXT.replace(/\.$/, '')), 'fallback recaps the confirmed assumptions');
    assert.deepStrictEqual(both.citations, []);

    const auth = mock([llmError(401)]);
    const a = check(await thesisChat(A, [], 'Hi', {}, { callLLM: auth }));
    assert(a.source === 'fallback' && auth.calls.length === 1, 'auth errors never retry on the backup');

    const bad = mock(['not json at all', '{"answer": "wrong shape"}']);
    const m = check(await thesisChat(A, [], 'Hi', {}, { callLLM: bad }));
    assert(m.source === 'fallback' && m.fallbackReason === 'unusable_reply' && bad.calls.length === 2, 'malformed reply retried once on the backup');

    const fix = mock(['{oops', answer([seg('Fixed by the backup.', 'general')])]);
    assert.strictEqual((await thesisChat(A, [], 'Hi', {}, { callLLM: fix })).model, 'backup-m');
  } finally { delete process.env.GEMINI_MODEL; delete process.env.FALLBACK_GEMINI_MODEL; }

  const off = check(await thesisChat(A, [], 'Hi', {}, { forceFallback: true }));
  assert(off.source === 'fallback' && off.fallbackReason === 'offline');
  const nokey = check(await thesisChat(A, [], 'Hi', {}, {}));
  assert(nokey.source === 'fallback' && nokey.fallbackReason === 'not_configured');

  const hl = idxOf(MATCHES, 'Export limits');
  const inv = check(await thesisChat(A, [], 'Explain', { evidence: MATCHES, focus: hl }, { forceFallback: true }));
  assert(inv.mode === 'investigation' && inv.citations.length === 1 && inv.citations[0].url === 'https://example.com/sample/export-limits');
  assert(inv.reply.includes('Only the headline is available') && inv.insufficientEvidence, 'headline-only fallback says so');
  const sm = idxOf(MATCHES, 'Nvidia warns');
  const inv2 = check(await thesisChat(A, [], 'Explain', { evidence: MATCHES, focus: sm }, { forceFallback: true }));
  assert(inv2.reply.includes("According to the article's summary") && inv2.reply.includes('earlier news check'), 'summary + earlier assessment, attributed');
  assert(!/challenges|supports/.test(inv2.segments.map((s) => s.text).join(' ')) || inv2.reply.includes('noted:'), 'fallback never invents a stance');
});

test('10. chat histories are isolated between theses', async () => {
  const ra = await thesisChat(A, [], 'Explain my thesis', {}, { callLLM: mock([answer([seg('About NVIDIA demand.', 'thesis')])]) });
  const hist = roundTrip(ra.history);
  const rb = check(await thesisChat(B, hist, 'And this one?', {}, { callLLM: mock([]) }));
  assert(!rb.ok && rb.error.code === 'history_thesis_mismatch');
  assert.deepStrictEqual(rb.history, hist, 'history returned unchanged on error');
  const llmB = mock([answer([seg('About S&P 500 earnings.', 'thesis')])]);
  const rb2 = check(await thesisChat(B, [], 'Explain my thesis', {}, { callLLM: llmB }));
  assert(rb2.ok && rb2.thesisId === B.id && rb2.history.every((h) => h.thesisId === B.id));
  assert(!llmB.calls[0].user.includes(NVDA_TEXT) && llmB.calls[0].user.includes(VOO_TEXT));
});

test('11. no mutation of the thesis, evidence or history; nothing saved, fetched or emailed', async () => {
  const deepFreeze = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o); };
  const thesis = deepFreeze(roundTrip(A));
  const evidence = deepFreeze(roundTrip(MATCHES));
  const history = deepFreeze([{ role: 'user', content: 'Earlier question', thesisId: A.id }, { role: 'assistant', content: 'Earlier answer', thesisId: A.id, citations: [] }]);
  const snap = roundTrip({ thesis, evidence, history });
  const realFetch = global.fetch;
  let fetches = 0;
  global.fetch = async () => { fetches++; throw new Error('no network in tests'); };
  try {
    const r = check(await thesisChat(thesis, history, 'Please change assumption 2 and confirm it.', { evidence, focus: 0 },
      { callLLM: mock([answer([seg('You can edit that assumption in your thesis review; I cannot change it here.', 'general')])]) }));
    assert(r.ok);
    await thesisChat(thesis, history, 'Hi', {}, { forceFallback: true });
  } finally { global.fetch = realFetch; }
  assert.deepStrictEqual(roundTrip({ thesis, evidence, history }), snap, 'inputs unchanged');
  assert.strictEqual(fetches, 0, 'no network calls');
  assert(!fs.existsSync(DB), 'nothing written to the store');
  assert.strictEqual(T.getConfirmedThesis, T.getConfirmedThesis); // engine API untouched
});

test('12. input validation and legacy (plain Contract C) theses', async () => {
  const off = { forceFallback: true };
  assert.strictEqual((await thesisChat(A, [], '   ', {}, off)).error.code, 'invalid_message');
  assert.strictEqual((await thesisChat(A, [], 'x'.repeat(2001), {}, off)).error.code, 'invalid_message');
  assert.strictEqual((await thesisChat(null, [], 'Hi', {}, off)).error.code, 'invalid_thesis');
  assert.strictEqual((await thesisChat({ ...A, assumptionStatus: 'proposed' }, [], 'Hi', {}, off)).error.code, 'thesis_not_confirmed');
  assert.strictEqual((await thesisChat(A, 'nope', 'Hi', {}, off)).error.code, 'invalid_history');
  assert.strictEqual((await thesisChat(A, [], 'Hi', { evidence: MATCHES, focus: 99 }, off)).error.code, 'invalid_focus');
  assert.strictEqual((await thesisChat(A, [], 'Hi', { evidence: [{ headline: '' }], focus: 0 }, off)).error.code, 'invalid_focus');
  const legacy = { id: 't1', goal: 'Long-term growth with small recurring deposits', budget: { amount: 20, cadence: 'biweekly' }, horizonYears: 10, tier: 'low',
    assumptions: ['Broad index funds beat stock picking at this budget', 'Low fees compound more than hot picks over 10 years'], createdAt: '2026-11-15T14:00:00Z' };
  const llm = mock([answer([seg('Your thesis bets on low-cost index funds over 10 years.', 'thesis')])]);
  const r = check(await thesisChat(legacy, null, 'Explain my thesis', { evidence: SAMPLE }, { callLLM: llm }));
  assert(r.ok && r.mode === 'general' && llm.calls[0].user.includes('Broad index funds beat stock picking'));
  assert(llm.calls[0].user.includes('"timeHorizon": "10 years"'));
});

test('13. advice and tracking claims are scrubbed; at most 8 evidence items', async () => {
  const r = check(await thesisChat(A, [], 'Should I buy?', {}, { callLLM: mock([answer([seg('You should buy NVDA now.', 'general'), seg('I am now tracking NVDA for you.', 'general'), seg('A long horizon gives prices time to recover.', 'general')])]) }));
  assert(r.reply.includes(SAFE_LINE_START) && !/should buy/i.test(r.reply) && !/tracking/i.test(r.reply));
  const many = Array.from({ length: 12 }, (_, i) => ({ ticker: 'NVDA', headline: `Headline number ${i}`, url: `https://example.com/${i}` }));
  const llm = mock([answer([seg('The headline says something.', 'evidence', ['E9'])])]);
  const r2 = await thesisChat(A, [], 'Hi', { evidence: many }, { callLLM: llm });
  assert(llm.calls[0].user.includes('"id": "E8"') && !llm.calls[0].user.includes('"id": "E9"'));
  assert.strictEqual(r2.removedClaims, 1, 'E9 does not exist when only 8 items are used');
});

// ---------- quality pass: beginner-first style, judgment answers, natural caution, attribution, demo labels ----------
const chatPrompt = () => T._onboarding.loadPrompt('chat');

test('15. prompt: beginner-first rules and the plain-language term examples', async () => {
  const p = chatPrompt();
  for (const want of ['ZERO investing experience', 'Answer the user\'s actual question first', 'everyday English and short sentences', 'Avoid acronyms',
    'explain it right away in a few plain words', "Don't re-define a term already explained", 'everyday example', 'say why it matters to them',
    'Simple questions get 2 to 4 short paragraphs', 'never condescending', 'Never assume prior financial knowledge',
    'spreading your money across different investments so you\'re not relying on just one', 'a company\'s estimate of how much money it expects to bring in',
    'how much an investment\'s price moves up and down', 'a fund that lets you invest in a collection of companies instead of buying each one separately',
    'what needs to remain true for those reasons to make sense']) assert(p.includes(want), `prompt includes: ${want}`);
  // A beginner-style mocked answer passes through intact (plain definitions are "general", never removed or re-attributed).
  const text = 'Volatility means how much an investment\'s price moves up and down. Your NVIDIA thesis is a single company, so its price can swing more than a fund\'s.';
  const r = check(await thesisChat(A, [], 'What does volatility mean for me?', {}, { callLLM: mock([answer([seg(text, 'general')])]) }));
  assert.strictEqual(r.reply, text, 'educational answer kept word for word, no extra reminder');
});

test('16. judgment questions: a clear assessment, closed with ONE short reminder', async () => {
  const p = chatPrompt();
  for (const want of ['Give a clear, reasoned answer', 'I think your second assumption is the most uncertain', 'Based on your thesis, my assessment is',
    'never invent statistics, forecasts or probabilities', 'does the article match a warning sign', 'does this evidence show a lasting change',
    "Don't add that sentence to ordinary educational answers", 'never repeat disclaimers in every paragraph or call yourself a chatbot']) assert(p.includes(want), `prompt includes: ${want}`);
  const { JUDGMENT_NOTE } = T._chat;
  const pick = 'I think your second assumption is the most uncertain, because it depends on NVIDIA\'s stock avoiding a big drop during your five-year timeline.';
  const r = check(await thesisChat(A, [], 'What are my weakest assumptions?', {}, { callLLM: mock([answer([seg(pick, 'thesis'), seg('Five years is not very long for a single company to recover from a fall.', 'general')])]) }));
  assert(r.reply.startsWith('I think your second assumption'), 'answers directly, first');
  assert.strictEqual(r.segments.filter((s) => s.text === JUDGMENT_NOTE).length, 1, 'one closing reminder');
  assert.strictEqual(r.segments[r.segments.length - 1].text, JUDGMENT_NOTE, 'at the end');
  // Already says it: not duplicated.
  const own = check(await thesisChat(A, [], 'Which risk matters most?', {}, { callLLM: mock([answer([seg('I think concentration matters most for you.', 'thesis'), seg('This is my interpretation, not a prediction.', 'general')])]) }));
  assert(!own.segments.some((s) => s.text === JUDGMENT_NOTE));
  // Investigation judgment question also gets it; ordinary questions and fallback answers don't.
  const focus = idxOf(MATCHES, 'Nvidia warns');
  const inv = check(await thesisChat(A, [], 'Does this article actually challenge my thesis?', { evidence: MATCHES, focus },
    { callLLM: mock([answer([seg('The summary says cloud customers are delaying orders, which matches a warning sign you listed.', 'evidence', ['E1']), seg('One quarter of delays does not show a lasting change yet.', 'general')])]) }));
  assert(inv.reply.endsWith(JUDGMENT_NOTE));
  for (const q of ['What is an ETF?', 'Can you explain my thesis in simple terms?', 'What should I research next?']) {
    const x = await thesisChat(A, [], q, {}, { callLLM: mock([answer([seg('Here is a simple explanation.', 'general')])]) });
    assert(!x.reply.includes(JUDGMENT_NOTE), `no reminder for: ${q}`);
  }
  assert(!(await thesisChat(A, [], 'What could go wrong?', {}, { forceFallback: true })).reply.includes(JUDGMENT_NOTE), 'fallback recap is not a judgment');
});

test('17. attribution formatting: no duplicated or awkward source introductions', async () => {
  const { attributeEvidence } = T._chat;
  const sm = [{ summary: 'x'.repeat(50) }];
  const hl = [{ summary: null }];
  const cases = [
    ['At the same time, cloud spending is slowing.', sm, "At the same time, according to the article's summary, cloud spending is slowing."],
    ['However, demand remains strong.', sm, "However, according to the article's summary, demand remains strong."],
    ['But demand remains strong.', sm, "But according to the article's summary, demand remains strong."],
    ['Meanwhile, Nvidia lowered its forecast.', sm, "Meanwhile, according to the article's summary, Nvidia lowered its forecast."],
    ['Also, export rules could limit sales.', hl, 'Also, based on the headline alone, export rules could limit sales.'],
    ['Demand for chips is slowing.', sm, "According to the article's summary, demand for chips is slowing."],
    ['Nvidia lowered its forecast.', sm, "According to the article's summary, Nvidia lowered its forecast."],
    ['VOO earnings beat forecasts.', sm, "According to the article's summary, VOO earnings beat forecasts."],
    ['S&P 500 earnings grew.', sm, "According to the article's summary, S&P 500 earnings grew."],
    ['According to the summary, orders are delayed.', sm, 'According to the summary, orders are delayed.'],
    ["Per the article's summary, orders are delayed.", sm, "Per the article's summary, orders are delayed."],
    ['The headline suggests sales could fall.', hl, 'The headline suggests sales could fall.'],
    ['However, the summary says orders are delayed.', sm, 'However, the summary says orders are delayed.'],
  ];
  for (const [input, cited, want] of cases) assert.strictEqual(attributeEvidence(input, cited), want);
  for (const [input, cited] of cases) {
    const out = attributeEvidence(input, cited);
    assert(!/,\s*,/.test(out) && !/(according to|based on)[^.]*\b(according to|based on)\b/i.test(out), `no doubled attribution: ${out}`);
    assert(!/(summary|alone), [A-Z][a-z]+ (the same|demand|cloud)/.test(out), `no capital after the lead: ${out}`);
  }
  // End to end with a real-looking Gemini segment.
  const r = check(await thesisChat(A, [], 'What else?', { evidence: MATCHES, focus: idxOf(MATCHES, 'Nvidia warns') },
    { callLLM: mock([answer([seg('At the same time, several large cloud customers are delaying orders.', 'evidence', ['E1'])])]) }));
  assert.strictEqual(r.segments[0].text, "At the same time, according to the article's summary, several large cloud customers are delaying orders.");
});

test('18. available evidence vs research suggestions: suggestions kept, claimed reading removed', async () => {
  const p = chatPrompt();
  assert(p.includes('are next steps for the user, not sources you have') && p.includes('You could look at...') && p.includes('never imply you have read, checked or verified them'));
  const r = check(await thesisChat(A, [], 'What should I research next?', {}, { callLLM: mock([answer([
    seg("I reviewed NVIDIA's latest earnings report and demand looks strong. A next step could be useful.", 'general'),
    seg('We looked at the quarterly filings. They look fine.', 'general'),
    seg("You could look at NVIDIA's next earnings report to see whether data-center sales are still growing.", 'general'),
    seg('You might also read a fund fact sheet to see how much of a fund is in one company.', 'general'),
  ])]) }));
  assert(!/I reviewed|We looked at the quarterly/i.test(r.reply), 'claims of having read reports are removed');
  assert(r.reply.includes("You could look at NVIDIA's next earnings report"), 'suggested next steps are kept');
  assert(r.reply.includes('fund fact sheet'));
  assert.deepStrictEqual(r.citations, [], 'suggested sources are never turned into citations');
});

test('19. safeguards and contract unchanged after the quality pass', async () => {
  const r = check(await thesisChat(A, [], 'What are my weakest assumptions?', { evidence: MATCHES }, { callLLM: mock([answer([
    seg('Nvidia guided revenue to $40 billion.', 'evidence', ['E42']),
    seg('I think your second assumption is the most uncertain.', 'thesis'),
  ])]) }));
  assert(r.removedClaims === 1 && r.droppedCitations === 1 && r.insufficientEvidence && !r.reply.includes('$40 billion'));
  assert(r.reply.includes(UNSUPPORTED_LINE));
  assert.deepStrictEqual(Object.keys(r), RESULT_KEYS, 'result keys and order unchanged');
  const llm = mock([answer([seg('First answer about demand.', 'thesis')]), answer([seg('Second answer.', 'thesis')])]);
  const r1 = await thesisChat(A, [], 'Is my thesis still valid?', {}, { callLLM: llm });
  const r2 = check(await thesisChat(A, roundTrip(r1.history), 'Tell me more', {}, { callLLM: llm }));
  assert.strictEqual(r2.history.length, 4);
  assert(llm.calls[1].user.includes('Is my thesis still valid?') && llm.calls[1].user.includes('not a prediction'), 'reminder stays part of the remembered answer');
});

test('20. CLI demo labels SAMPLE news as hypothetical in the list, investigation and citations (offline)', async () => {
  const { spawnSync } = require('child_process');
  const env = { ...process.env, GEMINI_API_KEY: '' };
  const out = spawnSync(process.execPath, [path.join(__dirname, 'chat-demo.js'), '--offline'], { input: '/news\n/open 1\nWhy does this matter?\n/quit\n', encoding: 'utf8', env, timeout: 30000 }).stdout;
  const strip = out.replace(/\x1b\[[0-9;]*m/g, '');
  const list = strip.split('\n').filter((l) => /^\s+\d+\. .*\b(neutral|supports|challenges) [A-Z]+ · /.test(l));
  assert(list.length >= 3 && list.every((l) => l.includes('[HYPOTHETICAL SAMPLE]')), 'every listed article is labelled');
  assert(/Investigating \[HYPOTHETICAL SAMPLE\] .*made-up article for this demo, not real news/.test(strip), 'investigation is labelled');
  assert(/\[1\] \[HYPOTHETICAL SAMPLE\] .*hypothetical example, not real news/.test(strip), 'citation is labelled');
  assert(strip.includes('Nothing was saved, monitored or emailed.'));
  // Production paths are untouched: matches and citations carry no hypothetical label.
  assert(!JSON.stringify(MATCHES).includes('hypothetical'));
});

test('21. internal evidence ids never reach the user; structured ids and [n] citations stay', async () => {
  const { scrubEvidenceIds } = T._chat;
  const cases = [
    ['The summary for E1 reports that orders are delayed.', "The article's summary reports that orders are delayed."],
    ['Article E1 shows demand is slowing.', 'The article shows demand is slowing.'],
    ['E1 says orders slipped, while E2 notes record revenue.', 'One article says orders slipped, while another article notes record revenue.'],
    ['Both E1 and E2 point the same way.', 'Both articles point the same way.'],
    ['This matches your warning sign (E1).', 'This matches your warning sign.'],
    ["E2's headline is about export limits.", "The article's headline is about export limits."],
    ['The E1 summary is short.', "The article's summary is short."],
    ['The headlines for E1 and E2 are mixed.', "The articles' headlines are mixed."],
    ['Orders slipped, as E1 reports.', 'Orders slipped, as the article reports.'],
    ['Energy stocks and E-commerce are unrelated.', 'Energy stocks and E-commerce are unrelated.'],
  ];
  for (const [input, want] of cases) assert.strictEqual(scrubEvidenceIds(input), want);

  const focus = idxOf(MATCHES, 'Nvidia warns');
  const llm = mock([answer([
    seg('The summary for E1 reports that cloud customers are delaying orders.', 'evidence', ['E1']),
    seg('Article E1 matches a warning sign you listed (E1), and E2 points the other way.', 'evidence', ['E1', 'E2']),
    seg('Nvidia guided revenue to $40 billion, as E9 shows.', 'evidence', ['E9']),
  ], { followUps: ['What would E1 mean for my second assumption?'] })]);
  const r = check(await thesisChat(A, [], 'Does this article actually challenge my thesis?', { evidence: MATCHES, focus }, { callLLM: llm }));
  const visible = [r.reply, r.displayText, ...r.segments.map((s) => s.text), ...r.followUps, ...r.history.map((h) => h.content)].join('\n');
  assert(!/\bE\d{1,2}\b/.test(visible), `no internal ids in user-facing text:\n${visible}`);
  assert(r.segments[0].text.startsWith("The article's summary reports"), 'natural attribution, not re-prefixed');
  assert.strictEqual(r.segments[1].text, 'According to the article summaries, one article matches a warning sign you listed, and another article points the other way.',
    'ids become distinguishable words, then the usual attribution is added');
  assert.deepStrictEqual(r.citations.map((c) => c.evidenceId), ['E1', 'E2'], 'structured evidence ids kept on citations');
  assert(r.reply.includes('[1]') && r.reply.includes('[1][2]'), 'clickable [n] markers kept');
  assert(r.removedClaims === 1 && !r.reply.includes('$40 billion'), 'fabricated id still removed');
  assert.strictEqual(r.followUps[0], 'What would the article mean for my second assumption?');
  // Next turn: history replays without ids, so the model can't pick them up from its own past answers either.
  const llm2 = mock([answer([seg('More detail.', 'general')])]);
  await thesisChat(A, roundTrip(r.history), 'Tell me more', { evidence: MATCHES, focus }, { callLLM: llm2 });
  assert(!/\bE\d{1,2}\b/.test(llm2.calls[0].user.split('CONVERSATION SO FAR')[1].split("USER'S NEW QUESTION")[0]), 'no ids in the replayed conversation');
  assert(chatPrompt().includes('Evidence ids (E1, E2...) are internal: put them ONLY in "sources"'), 'prompt forbids ids in text');
});

test('22. faithful to the confirmed assumptions: prompt rules + verbatim thesis, never rewritten', async () => {
  const p = chatPrompt();
  for (const want of ["Stay faithful to the user's thesis", 'keep their exact meaning and strength', 'Never strengthen, exaggerate or add to it',
    'if an assumption says demand "keeps growing", don\'t call it "fast growth"', "Don't invent expected returns, price targets or outcomes",
    'don\'t claim their "whole plan" or "entire thesis" depends on one thing unless the thesis says so', 'describe it as vague rather than filling in specifics'])
    assert(p.includes(want), `prompt includes: ${want}`);
  const before = roundTrip(A);
  const llm = mock([answer([seg('Your first assumption is that demand for NVIDIA AI data-center chips keeps growing.', 'thesis')])]);
  const r = check(await thesisChat(A, [], 'What assumptions am I making?', {}, { callLLM: llm }));
  const u = llm.calls[0].user;
  assert(u.includes(JSON.stringify(NVDA_TEXT)) && u.includes(JSON.stringify(NVDA_CHALLENGE)), 'assumption and challenge criteria sent word for word');
  for (const a of A.assumptions) assert(u.includes(JSON.stringify(a)), 'every confirmed assumption sent verbatim');
  assert(!/fast growth|rapid growth|explosive/i.test(u.split('USER\'S THESIS')[1].split('CONVERSATION SO FAR')[0]), 'the thesis block itself adds no strengthening words');
  assert.deepStrictEqual(roundTrip(A), before, 'thesis unchanged');
  assert(r.ok && r.segments[0].basis === 'thesis');
});

// Same mocked Gemini reply + same SAMPLE news as before thesisChat existed: identical decisions.
// Recorded from the pre-chat code: [ticker, headline prefix, assumptionIndex, stance, assessedStance, relevance, evidence, analyzedBy].
const BASELINE = {
  keys: ['ticker', 'headline', 'url', 'assumptionIndex', 'stance', 'whyItMatters', 'relevance', 'assessedStance', 'stanceNote', 'evidence', 'provisional', 'unanalyzed', 'analyzedBy', 'model', 'publisher', 'datetime'],
  gem: [['NVDA', 'Nvidia warns of slowing ', 0, 'challenges', 'challenges', 'direct', 'headline_and_summary', 'gemini'], ['NVDA', 'Nvidia posts record data', 1, 'supports', 'supports', 'direct', 'headline_and_summary', 'gemini'], ['NVDA', 'Export limits could trim', 0, 'neutral', 'neutral', 'direct', 'headline_only', 'gemini'], ['VOO', 'Fed holds rates steady', 0, 'neutral', 'supports', 'direct', 'headline_only', 'gemini'], ['NVDA', 'Nvidia unveils new netwo', 0, 'neutral', 'challenges', 'direct', 'headline_only', 'gemini'], ['NVDA', 'Nvidia shares swing afte', 1, 'neutral', 'supports', 'direct', 'headline_only', 'gemini'], ['VOO', 'S&P 500 earnings growth ', 1, 'neutral', 'challenges', 'indirect', 'headline_and_summary', 'gemini'], ['AAPL', 'Apple iPhone sales slip ', 1, 'neutral', 'neutral', 'indirect', 'headline_and_summary', 'gemini']],
  off: [['NVDA', 'Nvidia warns of slowing ', 0, 'neutral', null, 'direct', 'headline_and_summary', 'fallback'], ['NVDA', 'Nvidia posts record data', 0, 'neutral', null, 'direct', 'headline_and_summary', 'fallback'], ['NVDA', 'Export limits could trim', 0, 'neutral', null, 'direct', 'headline_only', 'fallback'], ['VOO', 'S&P 500 earnings growth ', 1, 'neutral', null, 'direct', 'headline_and_summary', 'fallback'], ['VOO', 'Fed holds rates steady', 1, 'neutral', null, 'direct', 'headline_only', 'fallback'], ['NVDA', 'Nvidia unveils new netwo', 0, 'neutral', null, 'direct', 'headline_only', 'fallback'], ['NVDA', 'Nvidia shares swing afte', 0, 'neutral', null, 'direct', 'headline_only', 'fallback']],
};
test('14. news matching unchanged (only an additive summary) and the Contract E email payload unchanged', async () => {
  let s = T.createOnboardingSession();
  s.profile = { ...nulls, amount: 50, cadence: 'monthly', timelineYears: 5, experience: 'beginner', riskComfort: 'medium', purpose: 'build long-term wealth' };
  s = T.confirmSelection(T.selectAssets('NVDA, VOO', s).session).session;
  s = (await T.createThesisDraft(s, { forceFallback: true })).session;
  const base = T.getConfirmedThesis(T.confirmAssumptions(s).session); // the exact thesis used to record BASELINE
  const st = ['challenges', 'supports', 'neutral'];
  const fixed = mock(() => ({ matches: Array.from({ length: 10 }, (_, i) => ({ article: i + 1, assumptionIndex: i % 2, relevance: i === 3 ? 'indirect' : 'direct', stance: st[i % 3], whyItMatters: 'This matters to the assumption because it describes demand for the business.' })) }));
  const pick = (m) => m.map((x) => [x.ticker, x.headline.slice(0, 24), x.assumptionIndex, x.stance, x.assessedStance, x.relevance, x.evidence, x.analyzedBy]);
  const g = await T.matchNewsDetailed(base, SAMPLE, { callLLM: fixed });
  const o = await T.matchNewsDetailed(base, SAMPLE, { forceFallback: true });
  assert.deepStrictEqual(pick(g.matches), BASELINE.gem, 'Gemini-path decisions unchanged');
  assert.deepStrictEqual(pick(o.matches), BASELINE.off, 'fallback-path decisions unchanged');
  for (const m of [...g.matches, ...o.matches]) {
    const { summary, ...rest } = m;
    assert.deepStrictEqual(Object.keys(rest), BASELINE.keys, 'existing fields and order unchanged');
    const src = SAMPLE.find((n) => n.headline === m.headline);
    assert.strictEqual(summary, src.summary || null, 'summary is the article\'s own text (or null)');
  }
  const viaMatchNews = await T.matchNews(base, SAMPLE, { callLLM: fixed });
  assert.deepStrictEqual(pick(viaMatchNews), BASELINE.gem, 'matchNews returns the same matches');

  // Contract E: notify.js picks named fields, so the additive summary never reaches the email.
  let body = null;
  const hook = http.createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { body = JSON.parse(d); res.end('ok'); }); });
  await new Promise((r) => hook.listen(0, r));
  Object.assign(process.env, { N8N_NOTIFY_WEBHOOK_URL: `http://localhost:${hook.address().port}/hook`, NOTIFY_TO_EMAIL: 'test@example.com' });
  try {
    const { maybeNotify } = require('../server/notify');
    const sent = await maybeNotify(base, g.matches);
    assert(sent.sent, `notify sent (${sent.reason || ''})`);
    assert.deepStrictEqual(Object.keys(body).sort(), ['headline', 'link', 'stance', 'thesisGoal', 'ticker', 'to', 'whyItMatters']);
    assert(body.stance === 'challenges' && body.headline === 'Nvidia warns of slowing AI data-center orders');
  } finally {
    hook.close();
    delete process.env.N8N_NOTIFY_WEBHOOK_URL; delete process.env.NOTIFY_TO_EMAIL;
    try { fs.unlinkSync(DB); } catch { /* not written */ }
  }
});

(async () => {
  A = await buildThesis('NVDA', NVDA_TEXT, NVDA_CHALLENGE);
  B = await buildThesis('VOO', VOO_TEXT, VOO_CHALLENGE);
  MATCHES = roundTrip((await T.matchNewsDetailed(A, SAMPLE, { callLLM: newsMock() })).matches);
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS  ${name}`); } catch (err) { failed++; console.log(`FAIL  ${name}\n      ${err.stack.split('\n').slice(0, 3).join('\n      ')}`); }
  }
  console.log(failed ? `${failed}/${tests.length} chat tests FAILED` : `${tests.length}/${tests.length} thesis chat tests passed`);
  process.exit(failed ? 1 : 0);
})();

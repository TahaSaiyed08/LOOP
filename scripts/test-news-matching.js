// Tests matchNews / matchNewsDetailed in server/thesis.js. Offline: a scripted Gemini that reads the
// articles in each prompt and answers per headline (so tests don't depend on batch order), plus one test
// through the real server/llm.js against a local HTTP mock. Run: npm run test:news   (~6 s)
const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');

process.env.LOOP_DB_FILE = path.join(os.tmpdir(), `loop-news-${process.pid}.json`); // pipeline.js is loaded read-only below
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_MODEL;
delete process.env.FALLBACK_GEMINI_MODEL;
const thesis = require('../server/thesis');
const { matchNews, matchNewsDetailed, createOnboardingSession, selectAssets, confirmSelection, createThesisDraft, editAssumption, confirmAssumptions, getConfirmedThesis } = thesis;
const SAMPLE = require('./sample-news');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); console.log(`PASS  ${name}`); }
  catch (err) { results.push([false, name]); console.log(`FAIL  ${name}\n      ${err.message}`); }
}
const mkErr = (code, message) => Object.assign(new Error(message), { code });
const H = (k) => SAMPLE.find((a) => a.headline.startsWith(k)).headline;

// Scripted Gemini: rules[headline] = { relevance, stance, assumptionIndex?, whyItMatters? } (missing = omitted).
function judge(rules, { extra = [] } = {}) {
  const calls = [];
  const fn = async (system, user, o) => {
    calls.push({ user, model: o && o.model });
    const fenced = user.slice(user.lastIndexOf('<<<') + 3, user.lastIndexOf('>>>'));
    const articles = JSON.parse(fenced);
    const matches = [];
    for (const a of articles) {
      const r = rules[a.headline];
      if (!r) continue;
      matches.push({ article: a.n, assumptionIndex: r.assumptionIndex ?? 0, relevance: r.relevance, stance: r.stance,
        whyItMatters: r.whyItMatters || `This ${a.ticker} article bears on the assumption about AI and earnings growth.`, ...(r.inject || {}) });
    }
    return JSON.stringify({ matches: [...matches, ...extra] });
  };
  fn.calls = calls;
  return fn;
}
const nulls = { amount: null, cadence: null, timelineYears: null, currency: null, experience: null, riskComfort: null, purpose: null };

// Builds a CONFIRMED thesis through the real flow: profile -> select -> confirm -> draft (offline) -> edit -> confirm.
async function confirmedThesis(symbols, text, challenge) {
  let s = createOnboardingSession();
  s.profile = { ...nulls, amount: 50, cadence: 'monthly', timelineYears: 5, experience: 'beginner', riskComfort: 'medium', purpose: 'build long-term wealth' };
  s = confirmSelection(selectAssets(symbols, s).session).session;
  s = (await createThesisDraft(s, { forceFallback: true })).session;
  const e = editAssumption(s, 1, text, challenge);
  assert(e.ok, e.displayText);
  const c = confirmAssumptions(e.session);
  assert(c.ok, c.displayText);
  return { thesis: getConfirmedThesis(c.session), session: c.session };
}

(async () => {
  const A = await confirmedThesis('NVDA', 'Demand for NVIDIA AI data-center chips keeps growing as cloud companies expand AI infrastructure.', 'NVIDIA lowering guidance, or cloud customers cutting AI infrastructure spending.');
  const B = await confirmedThesis('VOO', 'Earnings of the S&P 500 companies held in VOO stay resilient over the next five years.', 'Falling S&P 500 earnings, profit warnings across sectors, or a US recession.');
  const slowing = H('Nvidia warns');
  const record = H('Nvidia posts record');
  const exportLimits = H('Export limits');

  console.log('--- thesis-specific relevance');

  await test('1. direct NVIDIA news (with summary) challenges the NVDA thesis', async () => {
    const llm = judge({ [slowing]: { relevance: 'direct', stance: 'challenges', whyItMatters: 'Delayed orders from cloud customers point to slower AI data-center demand, which is exactly what this assumption depends on.' } });
    const { matches, stats } = await matchNewsDetailed(A.thesis, SAMPLE, { callLLM: llm });
    const m = matches.find((x) => x.headline === slowing);
    assert.strictEqual(m.stance, 'challenges');
    assert.strictEqual(m.relevance, 'direct');
    assert.strictEqual(m.evidence, 'headline_and_summary');
    assert.strictEqual(m.provisional, false);
    assert.strictEqual(m.analyzedBy, 'gemini');
    assert.strictEqual(m.ticker, 'NVDA');
    assert.strictEqual(m.url, 'https://example.com/sample/nvidia-slowing-ai-orders');
    assert.strictEqual(m.assumptionIndex, 0);
    assert.strictEqual(matches[0].stance, 'challenges', 'challenges sorted first (notify uses the first one)');
    assert.strictEqual(stats.batches, 1);
  });

  await test('2. positive NVIDIA news supports the related assumption', async () => {
    const llm = judge({ [record]: { relevance: 'direct', stance: 'supports', whyItMatters: 'Record data-center revenue shows AI infrastructure demand is still growing, as the assumption expects.' } });
    const m = (await matchNews(A.thesis, SAMPLE, { callLLM: llm })).find((x) => x.headline === record);
    assert.strictEqual(m.stance, 'supports');
    assert.strictEqual(m.relevance, 'direct');
  });

  await test('3. the same NVIDIA article: challenges the NVDA thesis, only indirect + neutral for the VOO thesis', async () => {
    // even if the model over-reaches and says "direct challenges" for VOO, NVDA is just one holding inside VOO
    const llm = judge({ [slowing]: { relevance: 'direct', stance: 'challenges', whyItMatters: 'Slower AI orders at one large company could weigh a little on overall index earnings.' } });
    const a = (await matchNews(A.thesis, [SAMPLE[0]], { callLLM: llm }))[0];
    const b = (await matchNews(B.thesis, [SAMPLE[0]], { callLLM: llm }))[0];
    assert.strictEqual(a.stance, 'challenges');
    assert.strictEqual(b.stance, 'neutral');
    assert.strictEqual(b.relevance, 'indirect');
    assert.strictEqual(b.assessedStance, 'challenges');
    assert.strictEqual(b.stanceNote, 'indirect');
    assert(/indirect/i.test(b.whyItMatters), b.whyItMatters);
    assert(llm.calls[1].user.includes('etf_holding: NVDA is one holding inside VOO'), 'prompt must flag the ETF-holding link');
  });

  await test('4. unrelated tickers are filtered out before Gemini (no call when nothing is relevant)', async () => {
    const llm = judge({});
    const { stats } = await matchNewsDetailed(A.thesis, SAMPLE, { callLLM: llm });
    assert.strictEqual(stats.skippedUnrelated, 5, 'VOO x2, KO, XLE, AAPL are not about NVDA');
    assert.deepStrictEqual(stats.skipped.sort(), ['AAPL', 'KO', 'VOO', 'VOO', 'XLE']);
    assert(!llm.calls[0].user.includes('Coca-Cola'), 'unrelated article sent to Gemini');
    const none = judge({});
    const r = await matchNewsDetailed(A.thesis, [{ ticker: 'KO', headline: 'Coca-Cola raises prices', url: 'https://example.com/x' }, { ticker: 'TSLA', headline: 'Tesla recalls cars', url: 'https://example.com/y' }], { callLLM: none });
    assert.deepStrictEqual(r.matches, []);
    assert.strictEqual(none.calls.length, 0);
    assert.strictEqual(r.stats.reason, 'no_relevant_articles');
    const xle = await matchNewsDetailed(B.thesis, [{ ticker: 'XLE', headline: 'Oil slips as supply outlook improves', url: 'https://example.com/z' }], { callLLM: none });
    assert.strictEqual(xle.stats.skippedUnrelated, 1, 'XLE is not inside VOO in the holdings map');
  });

  console.log('--- nothing that would trigger an email unless the evidence is direct and beyond a headline');

  await test('5. headline-only evidence is provisional and returned as neutral (Gemini view kept)', async () => {
    const llm = judge({ [exportLimits]: { relevance: 'direct', stance: 'challenges', whyItMatters: 'Export limits could reduce NVIDIA chip sales, which would challenge the demand assumption.' } });
    const m = (await matchNews(A.thesis, SAMPLE, { callLLM: llm })).find((x) => x.headline === exportLimits);
    assert.strictEqual(m.stance, 'neutral');
    assert.strictEqual(m.assessedStance, 'challenges');
    assert.strictEqual(m.stanceNote, 'headline_only');
    assert.strictEqual(m.provisional, true);
    assert.strictEqual(m.evidence, 'headline_only');
    assert(/headline alone/i.test(m.whyItMatters), m.whyItMatters);
  });

  await test('6. no notification-triggering "challenges" from headline-only, indirect or fallback results', async () => {
    const all = Object.fromEntries(SAMPLE.map((a) => [a.headline, { relevance: 'direct', stance: 'challenges', whyItMatters: 'This could challenge the assumption that earnings and demand keep growing.' }]));
    const b = await matchNews(B.thesis, SAMPLE, { callLLM: judge(all) });
    const challengedB = b.filter((m) => m.stance === 'challenges');
    assert.deepStrictEqual(challengedB.map((m) => m.headline), [H('S&P 500 earnings')], 'only the direct VOO article with a summary may challenge');
    const offline = await matchNews(A.thesis, SAMPLE, { forceFallback: true });
    assert(offline.length && offline.every((m) => m.stance === 'neutral' && m.unanalyzed && m.analyzedBy === 'fallback'));
  });

  console.log('--- sources and malformed output');

  await test('7. invalid or missing URLs become null; Gemini can never supply a URL or headline', async () => {
    const llm = judge({
      [H('Nvidia unveils')]: { relevance: 'direct', stance: 'supports', inject: { url: 'https://invented.example/x', headline: 'Invented headline', ticker: 'AAPL' } },
      [H('Nvidia shares swing')]: { relevance: 'direct', stance: 'neutral' },
    });
    const ms = await matchNews(A.thesis, SAMPLE, { callLLM: llm });
    const noUrl = ms.find((m) => m.headline === H('Nvidia unveils'));
    const badUrl = ms.find((m) => m.headline === H('Nvidia shares swing'));
    assert.strictEqual(noUrl.url, null);
    assert.strictEqual(noUrl.ticker, 'NVDA');
    assert.strictEqual(badUrl.url, null, 'javascript: URL must be dropped');
    assert(!ms.some((m) => m.headline === 'Invented headline' || /invented/.test(String(m.url))));
    assert.strictEqual(thesis._news.safeUrl('not a url'), null);
    assert.strictEqual(thesis._news.safeUrl('ftp://example.com/x'), null);
  });

  await test('8. malformed Gemini output is rejected safely', async () => {
    const garbage = async () => 'Sorry, here is my analysis in prose.';
    const g = await matchNewsDetailed(A.thesis, SAMPLE, { callLLM: garbage });
    assert(g.matches.every((m) => m.analyzedBy === 'fallback' && m.stance === 'neutral'), 'non-JSON must fall back');
    assert(/not valid JSON/.test(g.stats.fallbackReason), g.stats.fallbackReason);
    const wrongShape = await matchNewsDetailed(A.thesis, SAMPLE, { callLLM: async () => '{"matches":"none"}' });
    assert.strictEqual(wrongShape.stats.analyzedBy, 'fallback');
    const bad = judge({ [slowing]: { relevance: 'direct', stance: 'challenges', whyItMatters: 'Slower AI orders at NVIDIA directly challenge the demand assumption.' } }, { extra: [
      { article: 99, assumptionIndex: 0, relevance: 'direct', stance: 'challenges', whyItMatters: 'Article index out of range here.' },
      { article: 2, assumptionIndex: 7, relevance: 'direct', stance: 'supports', whyItMatters: 'Assumption index out of range here.' },
      { article: 2, assumptionIndex: 0, relevance: 'very', stance: 'bullish', whyItMatters: 'Bad enums in this one for sure.' },
      { article: 3, assumptionIndex: 0, relevance: 'direct', stance: 'neutral', whyItMatters: 'Unlike TSLA, this one is fine.' },
      { article: 4, assumptionIndex: 0, relevance: 'direct', stance: 'supports', whyItMatters: 'ok' },
    ] });
    const ms = await matchNews(A.thesis, SAMPLE, { callLLM: bad });
    assert.deepStrictEqual(ms.map((m) => m.headline), [slowing], `only the valid match survives: ${ms.map((m) => m.headline).join(' | ')}`);
    const advice = judge({ [record]: { relevance: 'direct', stance: 'supports', whyItMatters: 'You should buy more NVDA now. Record data-center revenue shows AI demand growing.' } });
    const m = (await matchNews(A.thesis, SAMPLE, { callLLM: advice }))[0];
    assert(!/should buy/i.test(m.whyItMatters), m.whyItMatters);
  });

  console.log('--- batching and models');

  await test('9. articles are batched: 5 candidates -> 1 Gemini call, 20 -> 2 calls', async () => {
    const one = judge({});
    await matchNews(A.thesis, SAMPLE, { callLLM: one });
    assert.strictEqual(one.calls.length, 1);
    const many = Array.from({ length: 20 }, (_, i) => ({ ticker: 'VOO', headline: `Market note number ${i + 1}`, url: `https://example.com/n${i}` }));
    const two = judge({});
    const r = await matchNewsDetailed(B.thesis, many, { callLLM: two });
    assert.strictEqual(two.calls.length, 2);
    assert.strictEqual(r.stats.batches, 2);
  });

  await test('10. primary model fails -> backup model analyzes the batch', async () => {
    Object.assign(process.env, { GEMINI_MODEL: 'primary-m', FALLBACK_GEMINI_MODEL: 'backup-m' });
    try {
      const inner = judge({ [slowing]: { relevance: 'direct', stance: 'challenges', whyItMatters: 'Slower AI orders directly challenge the demand assumption.' } });
      let first = true;
      const llm = async (s, u, o) => { if (first) { first = false; throw mkErr('LLM_RATE_LIMIT', 'LLM HTTP 429: quota'); } return inner(s, u, o); };
      const { matches, stats } = await matchNewsDetailed(A.thesis, SAMPLE, { callLLM: llm });
      assert.deepStrictEqual(inner.calls.map((c) => c.model), ['backup-m']);
      assert.strictEqual(matches[0].model, 'backup-m');
      assert.strictEqual(matches[0].analyzedBy, 'gemini');
      assert.deepStrictEqual(stats.models, ['backup-m']);
    } finally { delete process.env.GEMINI_MODEL; delete process.env.FALLBACK_GEMINI_MODEL; }
  });

  await test('11. both models fail -> conservative fallback (direct only, neutral, unanalyzed)', async () => {
    Object.assign(process.env, { GEMINI_MODEL: 'primary-m', FALLBACK_GEMINI_MODEL: 'backup-m' });
    try {
      const llm = async () => { throw mkErr('LLM_HTTP', 'LLM HTTP 503: unavailable'); };
      const { matches, stats } = await matchNewsDetailed(B.thesis, SAMPLE, { callLLM: llm });
      assert(/both models failed/.test(stats.fallbackReason), stats.fallbackReason);
      assert.deepStrictEqual(matches.map((m) => m.ticker), ['VOO', 'VOO'], 'indirect (ETF-holding) articles are not returned by the fallback');
      assert(matches.every((m) => m.stance === 'neutral' && m.unanalyzed === true && m.assessedStance === null));
    } finally { delete process.env.GEMINI_MODEL; delete process.env.FALLBACK_GEMINI_MODEL; }
    const fixture = await matchNews(await thesis.createThesis('x'), SAMPLE); // no key, unscoped thesis
    assert.deepStrictEqual(fixture, [], 'an unscoped thesis cannot be judged without Gemini');
  });

  await test('12. real llm.js: primary 404 -> backup model over HTTP', async () => {
    const seen = [];
    const srv = http.createServer((q, res) => {
      let b = ''; q.on('data', (d) => (b += d));
      q.on('end', () => {
        const body = JSON.parse(b);
        seen.push(body.model);
        if (body.model === 'mock-primary') { res.statusCode = 404; return res.end('{"error":"model not found"}'); }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ matches: [{ article: 1, assumptionIndex: 0, relevance: 'direct', stance: 'challenges', whyItMatters: 'Slower AI orders directly challenge the AI demand assumption.' }] }) } }] }));
      });
    });
    await new Promise((r) => srv.listen(0, r));
    Object.assign(process.env, { GEMINI_API_KEY: 'test-key', GEMINI_BASE_URL: `http://localhost:${srv.address().port}/v1/`, GEMINI_MODEL: 'mock-primary', FALLBACK_GEMINI_MODEL: 'mock-backup' });
    try {
      const ms = await matchNews(A.thesis, [SAMPLE[0]]);
      assert.deepStrictEqual(seen, ['mock-primary', 'mock-backup']);
      assert.strictEqual(ms[0].stance, 'challenges');
      assert.strictEqual(ms[0].model, 'mock-backup');
    } finally { srv.close(); for (const k of ['GEMINI_API_KEY', 'GEMINI_BASE_URL', 'GEMINI_MODEL', 'FALLBACK_GEMINI_MODEL']) delete process.env[k]; }
  });

  console.log('--- confirmed assumptions and backend compatibility');

  await test('13. matchNews uses the user-confirmed assumption wording; unconfirmed drafts are never matched', async () => {
    const llm = judge({});
    await matchNews(A.thesis, SAMPLE, { callLLM: llm });
    assert(llm.calls[0].user.includes('0. Demand for NVIDIA AI data-center chips keeps growing as cloud companies expand AI infrastructure.'), 'confirmed wording missing from prompt');
    assert(llm.calls[0].user.includes('NVIDIA lowering guidance, or cloud customers cutting AI infrastructure spending.'));
    const edited = editAssumption(A.session, 1, 'NVIDIA keeps winning most AI data-center chip orders from cloud companies.', null, { keepChallenge: true });
    assert.strictEqual(getConfirmedThesis(edited.session), null, 'editing clears the confirmation');
    const pending = await matchNewsDetailed(edited.session.thesisDraft.draft, SAMPLE, { callLLM: llm });
    assert.deepStrictEqual(pending.matches, []);
    assert.strictEqual(pending.stats.reason, 'assumptions_not_confirmed');
    const again = getConfirmedThesis(confirmAssumptions(edited.session).session);
    const llm2 = judge({});
    await matchNews(again, SAMPLE, { callLLM: llm2 });
    assert(llm2.calls[0].user.includes('NVIDIA keeps winning most AI data-center chip orders'), 'new confirmed wording not used');
  });

  await test('14. pipeline compatibility: collectNews() output + plain Contract C thesis via the 2-argument call', async () => {
    const { collectNews } = require('../server/pipeline');
    const news = collectNews(require('../fixtures/seed.sample.json'));
    const fixtureThesis = await thesis.createThesis('anything');
    const res = await matchNews(fixtureThesis, news); // exactly how pipeline.js calls it (no key here)
    assert(Array.isArray(res));
    const llm = judge({ [news[0].headline]: { relevance: 'direct', stance: 'supports', whyItMatters: 'Broad index news is directly about the low-fee index fund assumption.' } });
    const scoped = await matchNewsDetailed(fixtureThesis, news, { callLLM: llm });
    assert.strictEqual(scoped.stats.candidates, news.length, 'unscoped thesis: all items are candidates');
    for (const m of scoped.matches) {
      for (const k of ['ticker', 'headline', 'url', 'assumptionIndex', 'stance', 'whyItMatters']) assert(k in m, `missing ${k}`);
      assert(['supports', 'challenges', 'neutral'].includes(m.stance));
    }
  });

  await test('15. createThesis unchanged; matchNews never loads store/notify/paper code', async () => {
    const t = await thesis.createThesis('anything');
    assert.deepStrictEqual(Object.keys(t).sort(), ['assumptions', 'budget', 'createdAt', 'goal', 'horizonYears', 'id', 'tier'].sort());
    assert.strictEqual(thesis.IS_STUB, false, 'createThesis and matchNews are both real after the merge with main');
    assert.strictEqual(thesis.matchNews.length, 2, 'pipeline-facing arity stays (thesis, newsItems)');
  });


  console.log('--- regression: prefilter for broad ETFs, backup on malformed batches');

  await test('16. small ETF positions and other sectors are filtered out before Gemini (KO, XLE for a VOO thesis)', async () => {
    const llm = judge({});
    const { stats } = await matchNewsDetailed(B.thesis, SAMPLE, { callLLM: llm });
    assert.deepStrictEqual(stats.skipped.sort(), ['KO', 'XLE'], `skipped: ${stats.skipped.join(', ')}`);
    assert.strictEqual(stats.direct, 2, 'two VOO articles');
    assert.strictEqual(stats.viaEtfHolding, 6, 'five NVDA + one AAPL article (large VOO positions, at most indirect)');
    assert(!/Coca-Cola|Oil slips/.test(llm.calls[0].user), 'filtered articles must not be sent to Gemini');
    assert(!thesis._news.NOTABLE_HOLDINGS.VOO.includes('KO'), 'only large positions in the holdings map');
    const both = await confirmedThesis('NVDA, VOO', 'Demand for NVIDIA AI data-center chips keeps growing as cloud companies expand AI infrastructure.', 'NVIDIA lowering guidance, or cloud customers cutting AI infrastructure spending.');
    const r = await matchNewsDetailed(both.thesis, SAMPLE, { callLLM: judge({}) });
    assert.deepStrictEqual(r.stats.skipped.sort(), ['KO', 'XLE'], 'an NVDA + VOO thesis also skips them (this was the "0 skipped" report)');
    assert.strictEqual(r.stats.candidates, 8);
  });

  await test('17. malformed news JSON from the primary model -> backup model analyzes the batch', async () => {
    Object.assign(process.env, { GEMINI_MODEL: 'primary-m', FALLBACK_GEMINI_MODEL: 'backup-m' });
    try {
      const inner = judge({ [slowing]: { relevance: 'direct', stance: 'challenges', whyItMatters: 'Slower AI orders directly challenge the demand assumption.' } });
      const models = [];
      const llm = async (s, u, o) => { models.push(o.model); return o.model === 'primary-m' ? '{"matches": [ {"article": 1, ' : inner(s, u, o); };
      const { matches, stats } = await matchNewsDetailed(A.thesis, SAMPLE, { callLLM: llm });
      assert.deepStrictEqual(models, ['primary-m', 'backup-m']);
      assert.strictEqual(matches[0].stance, 'challenges');
      assert.strictEqual(matches[0].model, 'backup-m');
      assert(/primary-m: malformed JSON/.test(stats.attempts[0]) && stats.attempts[1] === 'backup-m: ok', stats.attempts.join(' | '));
    } finally { delete process.env.GEMINI_MODEL; delete process.env.FALLBACK_GEMINI_MODEL; }
  });


  await test('18. merge routing: THESIS-built theses -> personalized engine; plain Contract C theses -> Taha\'s headline matcher', async () => {
    const plain = { id: 't1', goal: 'Grow savings', budget: { amount: 20, cadence: 'biweekly' }, horizonYears: 10, tier: 'low', assumptions: ['Broad markets grow over ten years', 'Low fees compound over time'], createdAt: '2026-11-15T00:00:00Z' };
    const srv = http.createServer((q, res) => {
      let b = ''; q.on('data', (d) => (b += d));
      q.on('end', () => {
        const sys = JSON.parse(b).messages[0].content;
        const content = /compare news headlines/.test(sys)
          ? JSON.stringify({ matches: [{ n: 1, assumptionIndex: 0, stance: 'challenges', whyItMatters: 'Headline engine reason.' }] })
          : JSON.stringify({ matches: [{ article: 1, assumptionIndex: 0, relevance: 'direct', stance: 'challenges', whyItMatters: 'Slower AI orders directly challenge the AI demand assumption.' }] });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise((r) => srv.listen(0, r));
    Object.assign(process.env, { GEMINI_API_KEY: 'test-key', GEMINI_BASE_URL: `http://localhost:${srv.address().port}/v1/`, GEMINI_MODEL: 'mock' });
    try {
      const p = await matchNews(plain, [SAMPLE[0]]);
      assert.deepStrictEqual(Object.keys(p[0]).sort(), ['assumptionIndex', 'headline', 'stance', 'ticker', 'url', 'whyItMatters'], 'plain thesis -> Taha\'s matcher output, unchanged');
      assert.strictEqual(p[0].whyItMatters, 'Headline engine reason.');
      const mine = await matchNews(A.thesis, [SAMPLE[0]]);
      assert.strictEqual(mine[0].analyzedBy, 'gemini', 'THESIS-built thesis -> personalized engine');
      assert.strictEqual(mine[0].relevance, 'direct');
    } finally { srv.close(); for (const k of ['GEMINI_API_KEY', 'GEMINI_BASE_URL', 'GEMINI_MODEL']) delete process.env[k]; }
  });

  const failed = results.filter(([ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} news matching tests passed`);
  process.exit(failed.length ? 1 : 0);
})();

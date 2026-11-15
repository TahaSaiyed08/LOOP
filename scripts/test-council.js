// Tests server/council.js with llm.callLLM stubbed (instant, offline). Run: npm run test:council
const assert = require('assert');
const os = require('os');
const path = require('path');
process.env.LOOP_DB_FILE = path.join(os.tmpdir(), `loop-council-${process.pid}.json`);
const llm = require('../server/llm');
const council = require('../server/council');

const stock = {
  ticker: 'NVDA', companyName: 'NVIDIA', category: 'large_cap', tier: 'high', price: 900, beta: 1.7,
  dividendYieldPct: 0.03, merPct: null, peRatio: 60, marketCapB: 2200, priceChange5dPct: 4, avgVolume: 4e7,
  insider: { count: 2, execBuyer: true, totalUsd: 500000 },
  news: [{ headline: 'Export limits bite', sentiment: -0.4 }],
  matchScore: 71, scoreBreakdown: { signal: 12, riskFit: 19, cost: 10, quality: 15, news: 15 },
};

const MINI = `### THE CONTRARIAN
Valuation is stretched at a P/E of 60. Export limits could hit sales.
### THE FIRST PRINCIPLES THINKER
Real business.
### THE EXPANSIONIST
AI demand could keep growing. Insider buying signals conviction.
### THE OUTSIDER
Easy to follow.
### THE EXECUTOR
Liquid and fractional shares are available.`;
const CHAIR = `## Where the Council Agrees\nx\n## Overall read\nThe evidence is mixed: strong demand against a rich valuation. You should buy it now.\n## The One Thing to Check First\ny\nTHESIS_STRENGTH: 3`;

(async () => {
  // framing uses Contract A/B fields
  const f = council.frameStock(stock);
  for (const bit of ['NVDA', 'large_cap', '900', '1.7', 'P/E: 60', '71/100', 'signal 12', 'exec buyer: yes', 'Export limits bite']) assert(f.includes(bit), 'frame has ' + bit);
  assert(!/insiderScore|tfsaScore/.test(f));

  // mini: two calls, bull and bear differ, advice sentence stripped
  let calls = 0;
  llm.callLLM = async () => (++calls === 1 ? MINI : CHAIR);
  process.env.COUNCIL_MODE = 'mini';
  const r = await council.councilForStock(stock);
  assert.strictEqual(calls, 2, 'mini = 2 calls');
  assert(r.bullCase.includes('AI demand') && r.bearCase.includes('stretched'));
  assert.notStrictEqual(r.bullCase, r.bearCase);
  assert(r.verdict.includes('evidence is mixed'));
  assert(!/should|buy|recommend/i.test(r.verdict), 'no advice language: ' + r.verdict);

  // failure paths -> null
  llm.callLLM = async () => { throw new Error('boom'); };
  assert.strictEqual(await council.councilForStock(stock), null, 'LLM failure -> null');
  calls = 0; llm.callLLM = async () => (++calls === 1 ? 'no headings here' : CHAIR);
  assert.strictEqual(await council.councilForStock(stock), null, 'unparseable -> null');
  delete process.env.GEMINI_API_KEY;
  llm.callLLM = require('../server/llm.js').callLLM; // (stub still in place; key check is in pipeline)

  // helpers
  assert.strictEqual(council.normalizeMode(), 'mini');
  process.env.COUNCIL_MODE = 'bogus'; assert.strictEqual(council.normalizeMode(), 'mini');
  assert.strictEqual(council.toSentences('A one. B two. C three. D four. E five.', 4), 'A one. B two. C three. D four.');
  assert.strictEqual(council.toSentences('Buy it now.', 2), null);
  console.log('council tests passed');
})().catch((e) => { console.error(e); process.exit(1); });

// Tests server/sentiment.js against a local mock of the Gemini OpenAI-compatible endpoint.
// Takes ~10-15 s because llm.js enforces its 5 s spacing between calls. Run: npm run test:sentiment
const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.LOOP_DB_FILE = path.join(os.tmpdir(), `loop-sent-${process.pid}.json`);
let replies = [];      // queue of reply strings the mock returns
const calls = [];      // prompts received

const srv = http.createServer((q, r) => {
  let b = ''; q.on('data', (d) => (b += d));
  q.on('end', () => {
    const body = JSON.parse(b);
    calls.push(body.messages[1].content);
    const content = replies.shift() ?? '{"scores":[]}';
    r.setHeader('content-type', 'application/json');
    r.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

const mk = () => [
  { ticker: 'VOO', news: [{ headline: 'Fed holds rates', sentiment: null }, { headline: 'Already scored', sentiment: 0.9 }] },
  { ticker: 'BND', news: [{ headline: 'Fed holds rates', sentiment: null }] },
  { ticker: 'NVDA', news: [{ headline: 'Export limits bite', sentiment: null }, { headline: 'Chip demand soars', sentiment: null }] },
];

(async () => {
  await new Promise((r) => srv.listen(0, r));
  Object.assign(process.env, { GEMINI_API_KEY: 'k', GEMINI_BASE_URL: `http://localhost:${srv.address().port}/v1/`, GEMINI_MODEL: 'm' });
  const { applySentiment, parseScores } = require('../server/sentiment');

  // parser
  assert.deepStrictEqual(parseScores('```json\n{"scores":[0.5,-2,1]}\n```', 3), [0.5, -1, 1], 'tolerates fences, clamps to [-1,1]');
  assert.strictEqual(parseScores('{"scores":[0.5]}', 2), null, 'wrong count rejected');
  assert.strictEqual(parseScores('{"scores":["a"]}', 1), null, 'non-numbers rejected');
  assert.strictEqual(parseScores('nope', 1), null);

  // one batched call for all unseen headlines; supplied sentiment untouched
  replies = ['{"scores":[0.2,0.1,-0.6,0.8]}'];
  let stocks = mk();
  let st = await applySentiment(stocks);
  assert.strictEqual(calls.length, 1, 'exactly one LLM call for all tickers');
  assert(calls[0].includes('[VOO] Fed holds rates') && calls[0].includes('[BND] Fed holds rates') && calls[0].includes('[NVDA] Export limits bite'));
  assert(!calls[0].includes('Already scored'), 'pre-scored headline not sent');
  assert.deepStrictEqual(stocks.map((s) => s.news.map((n) => n.sentiment)), [[0.2, 0.9], [0.1], [-0.6, 0.8]]);
  assert.strictEqual(st.scored, 4);

  // second seed with the same headlines: served from cache, zero calls
  stocks = mk();
  st = await applySentiment(stocks);
  assert.strictEqual(calls.length, 1, 'cache hit makes no call');
  assert.strictEqual(st.cached, 4);
  assert.strictEqual(stocks[2].news[0].sentiment, -0.6);

  // malformed reply -> one retry -> still bad -> stays null, no throw
  replies = ['sorry, cannot', 'still no'];
  stocks = [{ ticker: 'XLE', news: [{ headline: 'Oil slips', sentiment: null }] }];
  st = await applySentiment(stocks);
  assert.strictEqual(st.failed, true); assert.strictEqual(stocks[0].news[0].sentiment, null);
  assert.strictEqual(calls.length, 3, 'one retry');

  // no key -> no call, stays null
  delete process.env.GEMINI_API_KEY;
  stocks = [{ ticker: 'XLK', news: [{ headline: 'Chips rally', sentiment: null }] }];
  st = await applySentiment(stocks);
  assert.strictEqual(st.failed, true); assert.strictEqual(stocks[0].news[0].sentiment, null); assert.strictEqual(calls.length, 3);

  console.log('OK: one batched call, pre-scored kept, cache hit, retry then give up, no-key degrades');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exitCode = 1; })
  .finally(() => { srv.close(); try { fs.unlinkSync(process.env.LOOP_DB_FILE); } catch {} });

// Tests server/llm.js model fallback against a local mock. Run: npm run test:llm
require('./test-env'); // never a real database, whatever the shell or .env holds
const assert = require('assert');
const http = require('http');
process.env.LLM_MIN_GAP_MS = '0';
const seen = [];
let gone = new Set();
const srv = http.createServer((q, r) => {
  let b = ''; q.on('data', (d) => (b += d));
  q.on('end', () => {
    const model = JSON.parse(b).model;
    seen.push(model);
    r.setHeader('content-type', 'application/json');
    if (gone.has(model)) { r.statusCode = 404; return r.end(JSON.stringify({ error: { message: `This model models/${model} is no longer available` } })); }
    r.end(JSON.stringify({ choices: [{ message: { content: `ok from ${model}` } }] }));
  });
});
(async () => {
  await new Promise((r) => srv.listen(0, r));
  Object.assign(process.env, { GEMINI_API_KEY: 'k', GEMINI_BASE_URL: `http://localhost:${srv.address().port}/v1/`, GEMINI_MODEL: 'primary' });
  delete process.env.FALLBACK_GEMINI_MODEL;
  const { callLLM } = require('../server/llm');

  gone = new Set(); seen.length = 0;
  assert.strictEqual(await callLLM('s', 'u'), 'ok from primary');
  assert.deepStrictEqual(seen, ['primary'], 'healthy model: one call, no fallback');

  gone = new Set(['primary']); seen.length = 0;
  assert.strictEqual(await callLLM('s', 'u'), 'ok from gemini-3.1-flash-lite');
  assert.deepStrictEqual(seen, ['primary', 'gemini-3.1-flash-lite'], '404 -> default fallback model, once');

  process.env.FALLBACK_GEMINI_MODEL = 'custom-backup'; seen.length = 0;
  assert.strictEqual(await callLLM('s', 'u'), 'ok from custom-backup');
  assert.deepStrictEqual(seen, ['primary', 'custom-backup'], 'FALLBACK_GEMINI_MODEL honoured');

  gone = new Set(['primary', 'custom-backup']); seen.length = 0;
  assert.strictEqual(await callLLM('s', 'u'), null, 'both gone -> null, no throw');
  assert.deepStrictEqual(seen, ['primary', 'custom-backup'], 'exactly one fallback attempt');

  delete process.env.GEMINI_API_KEY;
  await assert.rejects(callLLM('s', 'u'), (e) => e.code === 'NO_API_KEY', 'no key still rejects with NO_API_KEY');
  console.log('OK: llm.js model fallback (404 -> fallback once -> null), custom fallback env, no-key rejection');
  srv.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

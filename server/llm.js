// LLM client for Gemini via its OpenAI-compatible endpoint.
// Replaces the old Nebius client. Config is env only:
//   GEMINI_API_KEY, GEMINI_BASE_URL, GEMINI_MODEL
// Degrades gracefully: with no key, callLLM rejects with err.code === 'NO_API_KEY'
// (callers catch and fall back); it never crashes the process.

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const MIN_GAP_MS = Number(process.env.LLM_MIN_GAP_MS) >= 0 && process.env.LLM_MIN_GAP_MS ? Number(process.env.LLM_MIN_GAP_MS) : 5000; // free tier is roughly 10-15 requests/minute; env override is for tests only

let lastCallAt = 0;
let queue = Promise.resolve();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

async function doRequest(systemPrompt, userPrompt, opts) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw makeError('NO_API_KEY', 'GEMINI_API_KEY is not set');

  let base = process.env.GEMINI_BASE_URL || DEFAULT_BASE_URL;
  if (!base.endsWith('/')) base += '/';
  const body = {
    model: opts.model || process.env.GEMINI_MODEL || DEFAULT_MODEL,
    messages: [
      { role: 'system', content: systemPrompt || '' },
      { role: 'user', content: userPrompt || '' },
    ],
    temperature: opts.temperature ?? 0.4,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.json) body.response_format = { type: 'json_object' };

  const maxAttempts = 2; // one retry on 429/5xx
  for (let attempt = 1; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 45000);
    let res;
    try {
      res = await fetch(base + 'chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (attempt < maxAttempts) { await sleep(MIN_GAP_MS); continue; }
      throw makeError('LLM_NETWORK', `LLM request failed: ${err.message}`);
    }
    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw makeError('LLM_BAD_RESPONSE', 'LLM returned no text');
      return text;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
      await sleep(res.status === 429 ? 15000 : MIN_GAP_MS);
      continue;
    }
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw makeError(res.status === 429 ? 'LLM_RATE_LIMIT' : 'LLM_HTTP', `LLM HTTP ${res.status}: ${detail}`);
  }
}

// callLLM(systemPrompt, userPrompt, opts) -> Promise<string>
// opts: { model, temperature, maxTokens, json, timeoutMs }
// Calls are serialized and spaced MIN_GAP_MS apart, even if callers fire in parallel.
function callLLM(systemPrompt, userPrompt, opts = {}) {
  if (!isConfigured()) return Promise.reject(makeError('NO_API_KEY', 'GEMINI_API_KEY is not set'));
  const run = async () => {
    const wait = lastCallAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await doRequest(systemPrompt, userPrompt, opts);
    } finally {
      lastCallAt = Date.now();
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

module.exports = { callLLM, isConfigured, MIN_GAP_MS };

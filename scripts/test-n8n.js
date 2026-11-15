// Tests the n8n assets without an n8n instance: validates workflow JSON structure, then runs every Code
// node's JavaScript against mocked upstream node outputs and feeds the result through the real backend
// validator and scorer. Run: npm run test:n8n
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const { validateSeed } = require('../server/feed');
const { rankForTier } = require('../server/scoring');

const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'n8n', 'loop-daily.workflow.json'), 'utf8'));
const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));

// ---- 1. structure
assert.strictEqual(Object.keys(byName).length, wf.nodes.length, 'node names unique');
assert.strictEqual(new Set(wf.nodes.map((n) => n.id)).size, wf.nodes.length, 'node ids unique');
for (const n of wf.nodes) assert(n.type && n.typeVersion && Array.isArray(n.position), `${n.name} well-formed`);
for (const [from, c] of Object.entries(wf.connections)) {
  assert(byName[from], `connection source ${from} exists`);
  for (const outs of c.main) for (const t of outs) assert(byName[t.node], `connection target ${t.node} exists`);
}
assert.strictEqual(wf.active, false);
assert.strictEqual(byName['Daily Schedule'].disabled, true, 'cron stays disabled until freeze');
for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) new AsyncFunction('$', '$input', n.parameters.jsCode); // compiles
const raw = JSON.stringify(wf);
assert(!raw.includes('$vars') && !raw.includes('$env'), 'no n8n Variables / env access (not on the Starter plan)');
const http = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
const credName = (n) => Object.values(n.credentials || {})[0] && Object.values(n.credentials)[0].name;
const need = (re, name) => http.filter((n) => re.test(n.name)).forEach((n) => assert.strictEqual(credName(n), name, `${n.name} uses credential "${name}"`));
need(/^Alpaca /, 'LOOP Alpaca'); need(/^Finnhub /, 'LOOP Finnhub'); need(/^SEC /, 'LOOP SEC User-Agent'); need(/^POST /, 'LOOP Webhook Secret');
assert.strictEqual(http.filter((n) => /^SEC /.test(n.name)).length, 3, 'three SEC nodes, all carry the User-Agent credential');
assert(http.every((n) => n.parameters.authentication === 'genericCredentialType'), 'every HTTP node authenticates via a credential');
const httpParams = JSON.stringify(http.map((n) => n.parameters));
assert(!/token=|APCA-API|x-webhook-secret|X-Finnhub-Token/i.test(httpParams), 'no secrets, secret header values or token query params in HTTP node parameters');
assert(!raw.includes('@gmail.com'), 'no personal email baked in');
console.log(`workflow structure OK (${wf.nodes.length} nodes)`);

// ---- 2. run the Code nodes against mocks
const run = async (name, outputs, input) => {
  const $ = (n) => ({ all: () => outputs[n], first: () => outputs[n][0] });
  return new AsyncFunction('$', '$input', byName[name].parameters.jsCode)($, { first: () => input[0], all: () => input });
};
const wrap = (arr) => arr.map((json) => ({ json }));

(async () => {
  const out = {};
  out['Universe'] = await run('Universe', out);
  const universe = out['Universe'].map((i) => i.json);
  assert.strictEqual(universe.length, 60);

  const mkBars = (base, vol) => Array.from({ length: 30 }, (_, i) => ({ t: `2026-10-${String(i + 1).padStart(2, '0')}T04:00:00Z`, c: +(base * (1 + i * 0.003)).toFixed(2), v: vol + i }));
  const bars = { stock: {}, crypto: {} };
  universe.forEach((u, i) => { if (u.ticker !== 'SOL/USD') (u.category === 'crypto' ? bars.crypto : bars.stock)[u.ticker] = mkBars(20 + i * 7, 1e6 * (i + 1)); }); // SOL missing on purpose
  out['Alpaca stock bars'] = wrap([{ bars: bars.stock }]);
  out['Alpaca crypto bars'] = wrap([{ bars: bars.crypto }]);

  out['Stock tickers'] = await run('Stock tickers', out);
  const tickers = out['Stock tickers'].map((i) => i.json.ticker);
  assert.strictEqual(tickers.length, 57); assert(!tickers.some((t) => t.includes('/')));

  out['Finnhub metric'] = wrap(tickers.map((t, i) => (t === 'CLOV' ? { error: 'boom' } : { metric: { beta: 0.8 + (i % 10) / 10, peTTM: 12 + i, marketCapitalization: 5000 + i * 1000, currentDividendYieldTTM: 1.5 } })));
  out['Finnhub news'] = wrap([
    { headline: 'NVIDIA beats estimates', summary: 'NVIDIA reported quarterly revenue above analyst estimates.', related: 'NVDA', source: 'Reuters', url: 'https://example.com/n1', datetime: 1763200000 },
    { headline: 'NVIDIA beats estimates', related: 'NVDA', source: 'Reuters', url: 'https://example.com/n1', datetime: 1763200000 }, // dup
    { headline: 'Berkshire trims bank stakes', related: 'AAPL', source: 'AP', url: 'https://example.com/n3', datetime: 1763200050 }, // noise
    { headline: 'Fed holds rates', related: 'VOO', source: 'AP', url: 'https://example.com/n2', datetime: 1763200100 },
  ]);
  out['SEC tickers'] = wrap([{ 0: { cik_str: 1045810, ticker: 'NVDA' }, 1: { cik_str: 320193, ticker: 'AAPL' }, 2: { cik_str: 200406, ticker: 'JNJ' } }]);
  out['EDGAR targets'] = await run('EDGAR targets', out);
  assert.deepStrictEqual(out['EDGAR targets'].map((i) => i.json.ticker).sort(), ['AAPL', 'JNJ', 'NVDA']);
  assert.strictEqual(out['EDGAR targets'].find((i) => i.json.ticker === 'NVDA').json.cikPadded, '0001045810');

  const today = new Date().toISOString().slice(0, 10);
  const sub = (forms) => ({ filings: { recent: { form: forms.map((f) => f[0]), filingDate: forms.map((f) => f[1]), accessionNumber: forms.map((f, i) => `0001045810-26-00000${i}`), primaryDocument: forms.map(() => 'xslF345X05/wk-form4_1.xml') } } });
  out['SEC submissions'] = wrap(out['EDGAR targets'].map((i) => (i.json.ticker === 'NVDA' ? sub([['4', today], ['8-K', today], ['4', '2020-01-01']]) : { filings: { recent: { form: [], filingDate: [], accessionNumber: [], primaryDocument: [] } } })));
  out['Pick Form 4'] = await run('Pick Form 4', out);
  assert.strictEqual(out['Pick Form 4'].length, 1, 'only the recent Form 4 for NVDA');
  assert(out['Pick Form 4'][0].json.url.startsWith('https://www.sec.gov/Archives/edgar/data/1045810/'), out['Pick Form 4'][0].json.url);
  assert(!out['Pick Form 4'][0].json.url.includes('xsl'), 'raw XML url, not the xsl rendering');

  const xml = `<ownershipDocument><reportingOwner><reportingOwnerRelationship><isOfficer>1</isOfficer><officerTitle>Chief Financial Officer</officerTitle></reportingOwnerRelationship></reportingOwner>
    <nonDerivativeTable><nonDerivativeTransaction><transactionCoding><transactionCode>P</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>1000</value></transactionShares><transactionPricePerShare><value>140.5</value></transactionPricePerShare></transactionAmounts></nonDerivativeTransaction>
    <nonDerivativeTransaction><transactionCoding><transactionCode>S</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>5000</value></transactionShares><transactionPricePerShare><value>141</value></transactionPricePerShare></transactionAmounts></nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>`;
  out['SEC Form 4 XML'] = wrap([{ data: xml }]);

  out['Build Contract A'] = await run('Build Contract A', out);
  assert.strictEqual(out['Build Contract A'].length, 1);
  const payload = out['Build Contract A'][0].json;

  // ---- 3. the payload satisfies the backend and scores
  const clean = validateSeed(JSON.parse(JSON.stringify(payload)));
  assert.strictEqual(clean.rejected.length, 0, JSON.stringify(clean.rejected));
  const t = Object.fromEntries(payload.stocks.map((s) => [s.ticker, s]));
  assert.strictEqual(payload.stocks.length, 59, '60 minus SOL/USD (no bars): skipped, not invented');
  assert(!t['SOL/USD']);
  assert.deepStrictEqual(t.NVDA.insider, { count: 1, execBuyer: true, totalUsd: 140500 }, 'only the P purchase counts, sale ignored');
  assert.deepStrictEqual(t.AAPL.insider, { count: 0, execBuyer: false, totalUsd: 0 });
  assert.strictEqual(t.VOO.insider.count, 0);
  assert.strictEqual(t.VOO.merPct, 0.03); assert.strictEqual(t.NVDA.merPct, null);
  assert.strictEqual(t.VOO.peRatio, null); assert.strictEqual(t.VOO.marketCapB, null);
  assert(t.NVDA.peRatio > 0 && t.NVDA.marketCapB > 0, 'stock gets P/E and cap in billions');
  assert.strictEqual(t.CLOV.beta, null, 'failed Finnhub call -> null, not invented');
  assert.strictEqual(t['BTC/USD'].beta, null); assert(t['BTC/USD'].avgVolume > 0);
  assert.strictEqual(t.NVDA.news[0].summary, 'NVIDIA reported quarterly revenue above analyst estimates.', 'Finnhub summary kept'); assert.strictEqual(t.NVDA.news.length, 1, 'duplicate headline dropped'); assert.strictEqual(t.NVDA.news[0].sentiment, null);
  assert.strictEqual(t.VOO.news[0].headline, 'Fed holds rates'); assert.strictEqual(t.VOO.news[0].summary, null, 'no summary -> null');
  assert.strictEqual(t.AAPL.news.length, 0, 'unrelated headline dropped for a single stock');
  assert(t.VOO.priceChange5dPct > 0 && Number.isFinite(t.VOO.priceChange5dPct));
  const low = rankForTier(clean.stocks, 'low'), high = rankForTier(clean.stocks, 'high');
  assert(low.length > 0 && high.length > 0);
  console.log(`Contract A built: ${payload.stocks.length} tickers, ${low.length} eligible in low, ${high.length} in high; validateSeed rejected 0`);

  // ---- 4. email template node
  const mail = await run('Fill email template', {}, wrap([{ body: { to: 'x@example.com', ticker: 'VOO', headline: 'Fed <script>alert(1)</script> & "rates"', stance: 'challenges', whyItMatters: 'Rates matter', thesisGoal: 'Long-term growth', link: 'https://tfsa-gold-site.onrender.com/#thesis' } }]));
  const m = mail[0].json;
  assert.strictEqual(m.to, 'x@example.com');
  assert(!m.html.includes('<script>') && m.html.includes('&lt;script&gt;') && m.html.includes('&amp;'), 'headline HTML-escaped');
  assert(m.html.includes('href="https://tfsa-gold-site.onrender.com/#thesis"') && !m.html.includes('{{'));
  const bad = (await run('Fill email template', {}, wrap([{ body: { to: 'x@example.com', link: 'javascript:alert(1)' } }])))[0].json.html;
  assert(!bad.includes('javascript:'), 'non-https link neutralised');
  console.log('email template node OK (escaping, https-only link)');
  console.log('\nOK: n8n workflow + Code nodes');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });

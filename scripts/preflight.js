// Pre-demo check against a running server (local or Render). Waits out a cold start, then verifies the
// things that make a demo fail. Exit 1 on FAIL, 0 otherwise (WARNs still need a human look).
//   node scripts/preflight.js https://your-app.onrender.com
const base = (process.argv[2] || process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
const today = new Date().toISOString().slice(0, 10);
let fails = 0, warns = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const warn = (m) => { warns++; console.log(`  WARN  ${m}`); };
const fail = (m) => { fails++; console.log(`  FAIL  ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    try {
      const r = await fetch(base + '/api/health', { signal: AbortSignal.timeout(15000) });
      if (r.ok) { ok(`server up after ${((Date.now() - t0) / 1000).toFixed(1)}s`); return r.json(); }
    } catch { /* still waking */ }
    process.stdout.write('  ...waiting for server (cold start can take ~1 minute)\n');
    await sleep(5000);
  }
  return null;
}

(async () => {
  console.log(`Preflight: ${base}\n\n/api/health`);
  const h = await waitForServer();
  if (!h) { fail('server did not respond within 2 minutes'); return; }
  h.llmConfigured ? ok('llmConfigured') : fail('llmConfigured is false: GEMINI_API_KEY missing, no sentiment and no council text');
  h.alpacaConfigured ? ok('alpacaConfigured') : warn('alpacaConfigured is false: portfolio and buys use fixtures/simulated fills');
  h.thesisIsStub ? warn('thesisIsStub is true: every typed goal returns the same fixture thesis (Vamsi\'s file not wired)') : ok('real thesis engine');
  h.feedRunDate === today ? ok(`feed seeded today (${h.feedRunDate})`) : warn(`feedRunDate is ${h.feedRunDate}, today is ${today} (UTC): feed is stale or missing, /api/stocks may serve FIXTURES`);
  h.sentimentMissing === false ? ok('news sentiment present') : warn(`sentimentMissing is ${h.sentimentMissing}: the news component is a constant`);

  console.log('\n/api/stocks');
  const tops = {};
  for (const tier of ['low', 'medium', 'high']) {
    const r = await fetch(`${base}/api/stocks?tier=${tier}`);
    const rows = await r.json();
    const src = r.headers.get('x-data-source');
    if (!r.ok || !Array.isArray(rows) || !rows.length) { fail(`${tier}: no rows (status ${r.status})`); continue; }
    tops[tier] = rows.map((x) => x.ticker);
    src === 'live' ? ok(`${tier}: ${rows.length} rows, live, top 3 = ${tops[tier].slice(0, 3).join(', ')}`) : warn(`${tier}: serving FIXTURE data (X-Data-Source: ${src}), ${rows.length} rows`);
    if (rows.some((x) => x.scoreBreakdown.riskFit <= 0)) fail(`${tier}: row with riskFit 0`);
    if (rows[0].bullCase === null) warn(`${tier}: rank 1 has no bull/bear/verdict (council has not run or failed): drawer will show no analysis`);
  }
  if (tops.low && tops.medium && tops.high) {
    const j = (t) => tops[t].join();
    j('low') !== j('medium') && j('medium') !== j('high') && j('low') !== j('high') ? ok('tier orderings all differ (the tier-switch demo moment works)') : fail('two tiers have identical ordering');
  }

  console.log('\n/api/paper/portfolio');
  const pr = await fetch(base + '/api/paper/portfolio');
  const p = await pr.json();
  if (!pr.ok || !p.positions || !p.positions.length) fail('portfolio is empty');
  else {
    ok(`${p.positions.length} positions, ${p.trades.length} trades, value $${p.value} (${p.returnPct}%)`);
    const fx = require('../fixtures/portfolio.sample.json');
    JSON.stringify(p) === JSON.stringify(fx)
      ? warn('portfolio is IDENTICAL to the fixture: Alpaca keys missing, ledger empty or Alpaca unreachable (fine for a fallback demo, not live data)')
      : ok('portfolio differs from fixture (live prices or live ledger)');
    console.log(`        "${p.whatIfLine}"`);
  }

  console.log('\n/api/thesis');
  const tr = await fetch(base + '/api/thesis');
  tr.status === 404 ? ok('no thesis saved yet (clean slate: creating one live will fire the email if news challenges it)') : warn('a thesis is already saved: creating one live is fine, but an email may already have been used today');

  console.log(`\n${fails ? 'FAILED' : 'PASSED'}: ${fails} fail, ${warns} warn`);
})().catch((e) => { fail(e.message); }).finally(() => { process.exitCode = fails ? 1 : 0; });

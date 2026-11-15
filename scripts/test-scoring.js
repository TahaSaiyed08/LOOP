// Scores fixtures/seed.sample.json (Contract A inputs) for all three tiers and prints each ordering.
// Also asserts: components in 0-20, sum == matchScore, determinism, tiers actually reorder.
const assert = require('assert');
const { TIERS, rankForTier, scoreStock, isEligible } = require('../server/scoring');
const seed = require('../fixtures/seed.sample.json');

const orders = {};
for (const tier of TIERS) {
  const ranked = rankForTier(seed.stocks, tier);
  orders[tier] = ranked.map((r) => r.stock.ticker);
  console.log(`\n=== ${tier.toUpperCase()} tier (${ranked.length} eligible of ${seed.stocks.length}) ===`);
  for (const r of ranked) {
    const b = r.scoreBreakdown;
    const parts = Object.values(b);
    assert(parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 20), `range ${r.stock.ticker}`);
    assert.strictEqual(parts.reduce((a, c) => a + c, 0), r.matchScore, `sum ${r.stock.ticker}`);
    console.log(
      `${String(r.rank).padStart(2)}. ${r.stock.ticker.padEnd(8)} ${String(r.matchScore).padStart(3)}  ` +
      `sig ${b.signal} risk ${b.riskFit} cost ${b.cost} qual ${b.quality} news ${b.news}  [${r.stock.category}]`
    );
  }
  assert.deepStrictEqual(rankForTier(seed.stocks, tier).map((r) => r.matchScore), ranked.map((r) => r.matchScore), 'deterministic');
}
// Feed is "top 10 or fewer", never padded; no item with riskFit 0 is ever eligible; sanity spread >= 12.
for (const tier of TIERS) {
  const r = rankForTier(seed.stocks, tier);
  assert(r.every((x) => x.scoreBreakdown.riskFit > 0), `${tier}: riskFit 0 must be ineligible`);
  const top = r.slice(0, 10);
  assert(top.length <= 10, `${tier}: at most 10 rows`);
  if (top.length > 1) assert(top[0].matchScore - top[top.length - 1].matchScore >= 12, `${tier}: spread across the list should be >= 12`);
}
// Tiers must differ in ORDER (not just score): compare the top-10 ticker sequences.
const top10 = (t) => orders[t].slice(0, 10).join();
assert.notStrictEqual(top10('low'), top10('medium'), 'low and medium top-10 order should differ');
assert.notStrictEqual(top10('medium'), top10('high'), 'medium and high top-10 order should differ');
assert.notStrictEqual(top10('low'), top10('high'), 'low and high top-10 order should differ');
console.log('\nTop 5 by tier:');
for (const t of TIERS) console.log(`  ${t.padEnd(6)} ${orders[t].slice(0, 5).join(', ')}`);

// Tiebreaker: reversing the input order must not change the output (ties resolve by ticker A-Z).
for (const tier of TIERS) {
  const fwd = rankForTier(seed.stocks, tier).map((r) => r.stock.ticker).join();
  const rev = rankForTier([...seed.stocks].reverse(), tier).map((r) => r.stock.ticker).join();
  assert.strictEqual(fwd, rev, `${tier}: input order changed the ranking`);
}
const twin = (t) => ({ ...seed.stocks.find((x) => x.ticker === 'VOO'), ticker: t });
const tied = rankForTier([twin('ZZZ'), twin('AAA'), twin('MMM')], 'low').map((r) => r.stock.ticker);
assert.deepStrictEqual(tied, ['AAA', 'MMM', 'ZZZ'], 'identical scores must sort A-Z');

// Beta gate: low tier admits large_cap only when beta <= 1.1; medium/high still admit it.
const by = (t) => seed.stocks.find((x) => x.ticker === t);
assert(isEligible('large_cap', 'low', by('JNJ').beta) && isEligible('large_cap', 'low', by('PG').beta), 'JNJ/PG stay in low');
assert(!isEligible('large_cap', 'low', by('NVDA').beta), 'NVDA (beta ~1.75) is out of low');
assert(isEligible('large_cap', 'medium', by('NVDA').beta) && isEligible('large_cap', 'high', by('NVDA').beta), 'NVDA stays in medium/high');
assert(!orders.low.includes('NVDA') && orders.medium.includes('NVDA') && orders.high.includes('NVDA'), 'NVDA placement by tier');
assert(isEligible('large_cap', 'low', 1.1) && !isEligible('large_cap', 'low', 1.11), 'gate boundary at 1.1');

// Signal inputs actually matter: momentum moves it, thin volume pulls ETF/crypto signal down.
const sig = (o, tier = 'medium') => scoreStock({ ...by('VOO'), ...o }, tier).scoreBreakdown.signal;
assert(sig({ priceChange5dPct: 3 }) > sig({ priceChange5dPct: 0 }) && sig({ priceChange5dPct: 0 }) > sig({ priceChange5dPct: -3 }), 'ETF momentum raises signal');
assert(sig({ avgVolume: 20000 }) < sig({ avgVolume: 5000000 }), 'thin volume lowers ETF signal');
const stk = (o) => scoreStock({ ...by('MSFT'), ...o }, 'medium').scoreBreakdown.signal;
assert(stk({ priceChange5dPct: 4 }) > stk({ priceChange5dPct: -4 }), 'stock momentum raises signal');
assert(stk({ insider: { count: 4, execBuyer: true, totalUsd: 800000 } }) > stk({ insider: { count: 0, execBuyer: false, totalUsd: 0 } }), 'insider buying raises stock signal');
assert(sig({ priceChange5dPct: null, avgVolume: null }) >= 0, 'null momentum/volume tolerated');

// why-text is category-aware: no insider talk for funds, no fee talk for single stocks
{
  const { buildFeed } = require('../server/feed');
  const mk = (ticker, category, extra) => ({ ticker, companyName: ticker, category, price: 100, beta: 1.0, dividendYieldPct: 1, priceChange5dPct: 2, avgVolume: 5e6, usListed: true,
    merPct: /etf/.test(category) ? 0.05 : null, peRatio: /etf/.test(category) ? null : 18, marketCapB: /etf/.test(category) ? null : 500, insider: { count: 0, execBuyer: false, totalUsd: 0 }, news: [], ...extra });
  const rows = [];
  for (const tier of ['low', 'medium', 'high']) for (const r of rankForTier([mk('XLK', 'sector_etf'), mk('VOO', 'index_etf'), mk('MSFT', 'large_cap'), mk('NVDA', 'large_cap', { insider: { count: 3, execBuyer: true, totalUsd: 9e5 } })], tier)) rows.push(r);
  for (const r of rows) {
    const etf = /etf/.test(r.stock.category);
    if (etf) assert(!/insider|executive|P\/E|valuation|company/i.test(r.why), `ETF why has stock wording: ${r.stock.ticker} "${r.why}"`);
    else assert(!/fund fees|fund|diversified/i.test(r.why), `stock why has fund wording: ${r.stock.ticker} "${r.why}"`);
    assert(!/\b(buy|sell|recommend|should)\b/i.test(r.why), 'no advice wording');
  }
  // stance fallback from market sentiment when there is no thesis match
  const payload = { stocks: [mk('VOO', 'index_etf', { news: [{ headline: 'a', sentiment: 0.8, url: 'u' }, { headline: 'b', sentiment: -0.7, url: 'u' }, { headline: 'c', sentiment: 0.1, url: 'u' }] })] };
  const tags = buildFeed(payload, 'low')[0].newsTags.map((t) => t.stance);
  assert.deepStrictEqual(tags, ['supports', 'challenges', 'neutral'], 'sentiment maps to stance');
}

{ // Contract A: news summary survives validateSeed
  const { validateSeed } = require('../server/feed');
  const v = validateSeed({ stocks: [{ ticker: 'VOO', category: 'index_etf', price: 1, news: [{ headline: 'h', summary: '  a summary  ' }, { headline: 'g' }] }] });
  assert.strictEqual(v.stocks[0].news[0].summary, 'a summary'); assert.strictEqual(v.stocks[0].news[1].summary, null);
}
console.log('\nOK: components 0-20, sums match, deterministic, riskFit floor, top-10-or-fewer, spread >= 12, tiers reorder, tiebreak, beta gate, signal inputs.');

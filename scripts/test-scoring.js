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
// Spread: rank 1 -> rank 10 spans >= 20 points. (Absolute top score is NOT asserted: samples are not tuned to a target.)
for (const tier of TIERS) {
  const r = rankForTier(seed.stocks, tier);
  assert(r[0].matchScore - r[9].matchScore >= 20, `${tier}: rank1-rank10 span should be >= 20`);
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

console.log('\nOK: components 0-20, sums match, deterministic, span >= 20, tiers reorder, tiebreak, beta gate, signal inputs.');

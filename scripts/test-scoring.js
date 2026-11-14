// Scores fixtures/seed.sample.json (Contract A inputs) for all three tiers and prints each ordering.
// Also asserts: components in 0-20, sum == matchScore, determinism, tiers actually reorder.
const assert = require('assert');
const { TIERS, rankForTier } = require('../server/scoring');
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
// Calibration: best candidate in the high 80s+, rank 1 -> rank 10 spans >= 20 points.
for (const tier of TIERS) {
  const r = rankForTier(seed.stocks, tier);
  assert(r[0].matchScore >= 85, `${tier}: top score ${r[0].matchScore} should be >= 85`);
  assert(r[0].matchScore - r[9].matchScore >= 20, `${tier}: rank1-rank10 span should be >= 20`);
}
// Tiers must differ in ORDER (not just score): compare the top-10 ticker sequences.
const top10 = (t) => orders[t].slice(0, 10).join();
assert.notStrictEqual(top10('low'), top10('medium'), 'low and medium top-10 order should differ');
assert.notStrictEqual(top10('medium'), top10('high'), 'medium and high top-10 order should differ');
assert.notStrictEqual(top10('low'), top10('high'), 'low and high top-10 order should differ');
console.log('\nTop 5 by tier:');
for (const t of TIERS) console.log(`  ${t.padEnd(6)} ${orders[t].slice(0, 5).join(', ')}`);
console.log('\nOK: components 0-20, sums match, deterministic, top >= 85, span >= 20, tiers reorder.');

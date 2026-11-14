// Deterministic, pure match scoring. NO LLM calls, no I/O, no clock, no randomness.
// Input: a Contract A stock object + a tier. Output: Contract B score fields.
//
// Five components, each an integer 0-20, summing to matchScore (0-100):
//   signal  - stocks/REITs: 50% insider activity + 50% 5-day momentum.
//             ETFs/crypto: 5-day momentum, scaled down when dollar volume is thin.
//   riskFit - how close beta is to the tier's target beta
//   cost    - ETF fee (merPct) or stock valuation (P/E), minus a TFSA US-dividend
//             withholding drag (15% of the yield)
//   quality - size/category robustness, plus a small income bonus
//   news    - mean news sentiment, shrunk toward neutral when there are few items
//
// Each component = round(20 * min(1, calibrated * tierWeight)), where
//   calibrated = clamp01((raw - lo) / (hi - lo))   (CALIBRATION: stretches each raw
//   score's realistic range onto 0-1 so the full 0-100 scale is used). Weights differ per tier.
// Missing priceChange5dPct -> neutral momentum; missing avgVolume -> no liquidity penalty.

const TIERS = ['low', 'medium', 'high'];

// Category -> tiers it is eligible for.
const ELIGIBILITY = {
  index_etf: ['low', 'medium'],
  bond_etf: ['low'],
  dividend_etf: ['low', 'medium'],
  reit: ['low', 'medium'],
  large_cap: ['low', 'medium', 'high'],
  sector_etf: ['medium', 'high'],
  thematic_etf: ['medium', 'high'],
  mid_cap: ['medium', 'high'],
  small_cap: ['high'],
  crypto: ['high'],
};

// Extra beta gate: a category is admitted to a tier only if beta <= max.
// The beginner tier screens on volatility, not just company size.
const BETA_GATE = { low: { large_cap: 1.1 } };

// Per-tier weight table (multiplies the 0-1 raw score before capping at 20).
const WEIGHTS = {
  low:    { signal: 0.90, riskFit: 1.25, cost: 1.20, quality: 1.10, news: 0.95 },
  medium: { signal: 1.00, riskFit: 1.10, cost: 1.00, quality: 1.00, news: 1.00 },
  high:   { signal: 1.30, riskFit: 1.00, cost: 1.00, quality: 1.00, news: 1.25 },
};

// Realistic [lo, hi] range of each raw score, stretched onto 0-1 before weighting.
const CALIBRATION = {
  signal:  [0.10, 0.90], // symmetric around neutral 0.5, so neutral momentum = 10/20
  riskFit: [0.00, 1.00],
  cost:    [0.10, 0.92],
  quality: [0.20, 0.88],
  news:    [0.30, 0.80],
};

// Beta each tier is aiming for, and how far off (in beta) drives riskFit to zero.
const RISK_TARGET = {
  low:    { beta: 0.75, tolerance: 0.75 },
  medium: { beta: 1.10, tolerance: 0.80 },
  high:   { beta: 1.80, tolerance: 1.20 },
};

// Used when a stock arrives without a beta.
const DEFAULT_BETA = {
  index_etf: 1.0, bond_etf: 0.1, dividend_etf: 0.8, reit: 0.9, large_cap: 1.0,
  sector_etf: 1.1, thematic_etf: 1.6, mid_cap: 1.3, small_cap: 1.7, crypto: 2.5,
};

// Base robustness of a fund/asset by category (stocks use market cap instead).
const FUND_QUALITY = {
  index_etf: 0.90, bond_etf: 0.80, dividend_etf: 0.80, sector_etf: 0.65,
  thematic_etf: 0.45, crypto: 0.20,
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isStockLike = (cat) => ['large_cap', 'mid_cap', 'small_cap', 'reit'].includes(cat);

// beta is optional: when given (or defaulted by category) it is checked against BETA_GATE.
function isEligible(category, tier, beta) {
  if (!(ELIGIBILITY[category] && ELIGIBILITY[category].includes(tier))) return false;
  const max = BETA_GATE[tier] && BETA_GATE[tier][category];
  if (max === undefined) return true;
  const b = isNum(beta) ? beta : DEFAULT_BETA[category];
  return b <= max;
}

// 5-day move that counts as "strong" (maps to 0 or 1), by how volatile the category is.
const MOMENTUM_SCALE_PCT = { crypto: 12, small_cap: 10, thematic_etf: 7, mid_cap: 7 };

function rawMomentum(s) {
  if (!isNum(s.priceChange5dPct)) return 0.5; // unknown -> neutral
  const scale = MOMENTUM_SCALE_PCT[s.category] || 4;
  return clamp01(0.5 + s.priceChange5dPct / (2 * scale));
}

function rawInsider(s) {
  const ins = s.insider || {};
  const count = isNum(ins.count) ? ins.count : 0;
  const usd = isNum(ins.totalUsd) ? ins.totalUsd : 0;
  if (count <= 0 && !ins.execBuyer) return 0.35; // quiet: slightly below neutral
  return clamp01(0.35 + 0.25 * Math.min(count, 5) / 5 + (ins.execBuyer ? 0.25 : 0) + 0.15 * Math.min(usd / 1e6, 1));
}

// Thin trading pulls signal down: dollar volume >= $50M/day -> 1.0, <= $2M/day -> 0.5 (log scale).
function liquidityFactor(s) {
  if (!isNum(s.avgVolume) || !isNum(s.price) || s.avgVolume <= 0 || s.price <= 0) return 1;
  const dollars = s.avgVolume * s.price;
  const t = clamp01((Math.log10(dollars) - Math.log10(2e6)) / (Math.log10(5e7) - Math.log10(2e6)));
  return 0.5 + 0.5 * t;
}

function rawSignal(s) {
  if (isStockLike(s.category)) return 0.5 * rawInsider(s) + 0.5 * rawMomentum(s);
  return rawMomentum(s) * liquidityFactor(s); // ETFs and crypto: no insider data
}

function rawRiskFit(s, tier) {
  const beta = isNum(s.beta) ? s.beta : (DEFAULT_BETA[s.category] ?? 1.0);
  const t = RISK_TARGET[tier];
  return clamp01(1 - Math.abs(beta - t.beta) / t.tolerance);
}

function rawCost(s) {
  let base;
  if (isNum(s.merPct)) base = clamp01(1 - s.merPct / 0.75); // ETF fee: 0% -> 1, 0.75%+ -> 0
  else if (s.category !== 'reit' && isNum(s.peRatio) && s.peRatio > 0) base = clamp01(1 - (s.peRatio - 15) / 65); // P/E 15 -> 1, 80+ -> 0
  else if (s.category === 'crypto') base = 0.3;
  else base = 0.4; // unknown/negative earnings, or a REIT (P/E is not meaningful for REITs)
  const yieldPct = isNum(s.dividendYieldPct) ? s.dividendYieldPct : 0;
  const withholdingDragPct = 0.15 * yieldPct; // US dividends in a TFSA lose 15% to withholding
  return clamp01(base - Math.min(0.2, withholdingDragPct * 0.25));
}

function rawQuality(s) {
  let base;
  if (isStockLike(s.category)) {
    const cap = isNum(s.marketCapB) ? s.marketCapB : 0;
    base = cap >= 200 ? 1.0 : cap >= 50 ? 0.85 : cap >= 10 ? 0.65 : cap >= 2 ? 0.45 : 0.25;
  } else {
    base = FUND_QUALITY[s.category] ?? 0.4;
  }
  const yieldPct = isNum(s.dividendYieldPct) ? s.dividendYieldPct : 0;
  return clamp01(base * 0.9 + 0.1 * Math.min(yieldPct / 4, 1));
}

function rawNews(s) {
  const items = Array.isArray(s.news) ? s.news.filter((n) => n && isNum(n.sentiment)) : [];
  if (!items.length) return 0.5;
  const avg = items.reduce((a, n) => a + n.sentiment, 0) / items.length; // -1..1
  return clamp01(0.5 + 0.5 * avg * Math.min(1, items.length / 3));
}

const WHY = {
  signal: 'Notable insider activity at the company',
  riskFit: 'Volatility is a close fit for this risk level',
  cost: 'Low cost to hold relative to alternatives',
  quality: 'Large, established holding',
  news: 'Recent news tone is positive',
};

function buildWhy(breakdown) {
  // Highest component wins; fixed key order breaks ties, so it is deterministic.
  let best = 'riskFit';
  for (const k of ['signal', 'riskFit', 'cost', 'quality', 'news']) if (breakdown[k] > breakdown[best]) best = k;
  return WHY[best];
}

// scoreStock(stock, tier) -> { tier, matchScore, scoreBreakdown, why } | null if not eligible
// (wrong category/beta gate for the tier, not US-listed, or riskFit component of 0)
function scoreStock(stock, tier) {
  if (!stock || !TIERS.includes(tier)) return null;
  if (stock.usListed === false) return null; // US-listed universe only
  if (!isEligible(stock.category, tier, stock.beta)) return null;
  const w = WEIGHTS[tier];
  const raw = {
    signal: rawSignal(stock),
    riskFit: rawRiskFit(stock, tier),
    cost: rawCost(stock),
    quality: rawQuality(stock),
    news: rawNews(stock),
  };
  const comp = (k) => {
    const [lo, hi] = CALIBRATION[k];
    return Math.round(20 * Math.min(1, clamp01((raw[k] - lo) / (hi - lo)) * w[k]));
  };
  const scoreBreakdown = {
    signal: comp('signal'),
    riskFit: comp('riskFit'),
    cost: comp('cost'),
    quality: comp('quality'),
    news: comp('news'),
  };
  // Eligibility floor: riskFit of 0 means the volatility is wrong for this tier, whatever else is strong.
  if (scoreBreakdown.riskFit === 0) return null;
  const matchScore = scoreBreakdown.signal + scoreBreakdown.riskFit + scoreBreakdown.cost + scoreBreakdown.quality + scoreBreakdown.news;
  return { tier, matchScore, scoreBreakdown, why: buildWhy(scoreBreakdown) };
}

// rankForTier(stocks, tier) -> eligible stocks scored and sorted (score desc, then ticker A-Z
// as the final deterministic tiebreaker, so input order can never change the output), rank 1..n
function rankForTier(stocks, tier) {
  const scored = [];
  for (const stock of stocks || []) {
    const r = scoreStock(stock, tier);
    if (r) scored.push({ stock, ...r });
  }
  scored.sort((a, b) => b.matchScore - a.matchScore || (a.stock.ticker < b.stock.ticker ? -1 : 1));
  return scored.map((row, i) => ({ rank: i + 1, ...row }));
}

module.exports = { TIERS, ELIGIBILITY, BETA_GATE, WEIGHTS, isEligible, scoreStock, rankForTier };

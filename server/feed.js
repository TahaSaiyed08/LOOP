// Contract A validation and Contract B feed building. Ranking comes ONLY from scoring.js;
// council text (bullCase/bearCase/verdict) is attached afterwards and never affects rank.
const crypto = require('crypto');
const { TIERS, ELIGIBILITY, rankForTier } = require('./scoring');

const MAX_STOCKS = 500;
const SUPPORT_AT = 0.3;
const CHALLENGE_AT = -0.3;
const stanceOf = (sentiment) => (isNum(sentiment) ? (sentiment >= SUPPORT_AT ? 'supports' : sentiment <= CHALLENGE_AT ? 'challenges' : 'neutral') : 'neutral');
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const numOrNull = (x) => (isNum(x) ? x : null);

// validateSeed(body) -> { runDate, stocks, rejected } or throws {status, message}.
// Bad rows are dropped with a reason rather than failing the whole run.
function validateSeed(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.stocks)) {
    const e = new Error('body must be { runDate, stocks: [...] }'); e.status = 400; throw e;
  }
  if (body.stocks.length > MAX_STOCKS) { const e = new Error(`at most ${MAX_STOCKS} stocks per run`); e.status = 413; throw e; }
  const stocks = [];
  const rejected = [];
  const seen = new Set();
  for (const s of body.stocks) {
    const ticker = s && typeof s.ticker === 'string' ? s.ticker.trim().toUpperCase() : '';
    if (!ticker) { rejected.push({ ticker: null, reason: 'missing ticker' }); continue; }
    if (seen.has(ticker)) { rejected.push({ ticker, reason: 'duplicate ticker' }); continue; }
    if (!ELIGIBILITY[s.category]) { rejected.push({ ticker, reason: `unknown category "${s.category}"` }); continue; }
    if (!isNum(s.price) || s.price <= 0) { rejected.push({ ticker, reason: 'price must be a positive number' }); continue; }
    seen.add(ticker);
    const ins = s.insider || {};
    stocks.push({
      ticker,
      companyName: typeof s.companyName === 'string' ? s.companyName : ticker,
      category: s.category,
      price: s.price,
      beta: numOrNull(s.beta),
      dividendYieldPct: numOrNull(s.dividendYieldPct),
      priceChange5dPct: numOrNull(s.priceChange5dPct),
      avgVolume: numOrNull(s.avgVolume),
      usListed: s.usListed !== false,
      merPct: numOrNull(s.merPct),
      peRatio: numOrNull(s.peRatio),
      marketCapB: numOrNull(s.marketCapB),
      insider: { count: isNum(ins.count) ? ins.count : 0, execBuyer: ins.execBuyer === true, totalUsd: isNum(ins.totalUsd) ? ins.totalUsd : 0 },
      news: (Array.isArray(s.news) ? s.news : [])
        .filter((n) => n && typeof n.headline === 'string' && n.headline)
        .slice(0, 10)
        .map((n) => ({ headline: n.headline, summary: typeof n.summary === 'string' && n.summary.trim() ? n.summary.trim().slice(0, 1000) : null, source: n.source || null, url: n.url || null, sentiment: numOrNull(n.sentiment), datetime: n.datetime || null })),
    });
  }
  const runDate = typeof body.runDate === 'string' ? body.runDate : new Date().toISOString().slice(0, 10);
  return { runDate, stocks, rejected };
}

const idOf = (ticker, tier) => crypto.createHash('sha1').update(`${tier}:${ticker}`).digest('hex').slice(0, 6);

// True when no headline in the whole payload has a numeric sentiment.
function sentimentMissing(stocks) {
  return Boolean(stocks && stocks.length) && !stocks.some((s) => (s.news || []).some((n) => isNum(n.sentiment)));
}

// buildFeed(payload, tier, { council, matches }) -> Contract B rows. "Top 10 or fewer": never padded.
//   council: { TICKER: { bullCase, bearCase, verdict } }  (optional, from the council runner)
//   matches: thesis news matches [{ ticker, headline, url, stance, ... }] -> newsTags for that ticker
// Without a thesis match for a ticker, the stance comes from that headline's market sentiment:
// >= SUPPORT_AT supports the candidate, <= CHALLENGE_AT challenges it, anything between (or unscored) is neutral.
function buildFeed(payload, tier, { council = {}, matches = [] } = {}) {
  if (!TIERS.includes(tier)) throw new Error(`bad tier ${tier}`);
  const updatedAt = payload.receivedAt || new Date().toISOString();
  return rankForTier(payload.stocks, tier).slice(0, 10).map((r) => {
    const t = council[r.stock.ticker] || {};
    const mine = matches.filter((m) => m.ticker === r.stock.ticker);
    const newsTags = mine.length
      ? mine.map((m) => ({ headline: m.headline, stance: m.stance, url: m.url }))
      : r.stock.news.slice(0, 3).map((n) => ({ headline: n.headline, stance: stanceOf(n.sentiment), url: n.url }));
    return {
      id: idOf(r.stock.ticker, tier),
      rank: r.rank,
      ticker: r.stock.ticker,
      companyName: r.stock.companyName,
      category: r.stock.category,
      tier,
      matchScore: r.matchScore,
      scoreBreakdown: r.scoreBreakdown,
      why: r.why,
      price: r.stock.price,
      bullCase: t.bullCase ?? null,
      bearCase: t.bearCase ?? null,
      verdict: t.verdict ?? null,
      newsTags,
      updatedAt,
    };
  });
}

module.exports = { validateSeed, buildFeed, sentimentMissing };

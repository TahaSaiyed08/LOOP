// ============================================================================================
// STUB: PLACEHOLDER FOR VAMSI'S REAL IMPLEMENTATION. DO NOT BUILD ON THIS.
// Replace this whole file with Vamsi's server/thesis.js (same two exports, same signatures).
// His prompts live in prompts/thesis.md, also his.
//
// Email trigger rule (Vamsi documents, Taha implements in server/notify.js):
//   any match with stance "challenges" triggers one email, max one per day; the email carries
//   the first challenging match.
// ============================================================================================
const fixture = require('../fixtures/thesis.sample.json');

// createThesis(goalsText) -> Contract C thesis. STUB: returns the fixture thesis for any input.
async function createThesis(goalsText) {
  return { ...fixture, assumptions: [...fixture.assumptions], createdAt: new Date().toISOString() };
}

// matchNews(thesis, newsItems) -> Contract C match array. STUB: no LLM, just tags items by market
// sentiment against assumption 0 so the pipeline and the email branch can be exercised. Neutral dropped.
async function matchNews(thesis, newsItems) {
  const out = [];
  for (const n of (newsItems || []).slice(0, 30)) {
    if (typeof n.sentiment !== 'number' || Math.abs(n.sentiment) < 0.15) continue;
    out.push({
      ticker: n.ticker,
      headline: n.headline,
      url: n.url,
      assumptionIndex: 0,
      stance: n.sentiment > 0 ? 'supports' : 'challenges',
      whyItMatters: '[stub] Placeholder explanation until the real thesis engine is wired in.',
    });
  }
  return out;
}

module.exports = { createThesis, matchNews, IS_STUB: true };

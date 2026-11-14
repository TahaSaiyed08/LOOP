// Generates fixtures/feed.{low,medium,high}.sample.json (+ feed.sample.json = copy of low)
// by running the REAL scorer over fixtures/seed.sample.json, so fixtures match what
// GET /api/stocks produces. Ranking/score/breakdown/why come from scoring.js.
// bullCase / bearCase / verdict are hand-written below (the council needs an API key).
// Run: node scripts/gen-feed-fixtures.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TIERS, rankForTier } = require('../server/scoring');

const dir = path.join(__dirname, '..', 'fixtures');
const seed = JSON.parse(fs.readFileSync(path.join(dir, 'seed.sample.json'), 'utf8'));
const UPDATED_AT = '2026-11-15T14:05:00Z';
const TIER_LABEL = { low: 'Starting out', medium: 'Some knowledge', high: 'Experienced' };

const TEXT = {
  VOO: ['One fund holds roughly 500 of the largest US companies, so a single stumble barely moves it. The 0.03% fee leaves almost all of the return with the investor, which matters over years of small deposits.',
        'It is concentrated in a handful of mega-cap tech names, so it is less diversified than the 500-stock count suggests. A broad US downturn would hit it fully, and it has no bond cushion.',
        'Cost and diversification are hard to beat for a long horizon, but expect normal stock market swings.'],
  VTI: ['It covers large, mid and small US companies in one holding, the widest spread of any simple choice. The 0.03% fee keeps costs negligible.',
        'About three quarters of the fund is large companies, so it behaves much like an S&P 500 fund. It offers no protection outside US stocks.',
        'A simple one-fund holding for a long horizon. It overlaps heavily with VOO, so holding both adds little.'],
  SCHD: ['It screens for companies with long records of paying and growing dividends, which tends to favor financially sturdy businesses. The 0.06% fee is low and the yield gives regular income to reinvest.',
         'Dividend-focused funds can lag in strong growth rallies led by tech. US dividends are also subject to withholding tax in some Canadian account types, which trims the yield.',
         'A steady, income-leaning option with the tradeoff of slower upside in tech-led markets.'],
  VYM: ['It spreads money across about 500 large US companies paying above-average dividends. Holdings lean toward financials, healthcare and consumer staples, which tend to hold up in rough markets.',
        'It has little exposure to technology, so it can trail the overall market during tech-driven rallies. A high yield can also signal a stock under pressure.',
        'A reasonable income-minded holding. It overlaps with SCHD, so picking one is usually enough.'],
  VIG: ['It holds US companies with at least ten years of rising dividends, which favors durable, well-run businesses. The 0.05% fee is low.',
        'The starting yield is small, so it offers little income today. Its top holdings overlap with broad market funds, limiting extra diversification.',
        'A quality-focused long-term holding, with a low current yield as the main tradeoff.'],
  QQQ: ['It tracks the 100 largest non-financial Nasdaq companies, giving direct exposure to the firms driving software, chips and AI. Over long stretches it has outpaced the broader market.',
        'Roughly half the fund sits in a few giant tech names, so a tech selloff hits it harder than a total-market fund. The 0.20% fee is higher than the broad index funds.',
        'Growth-oriented and more volatile than a total-market fund, so it sits between cautious and aggressive profiles.'],
  BND: ['It holds thousands of investment-grade US bonds, which usually move far less than stocks. The 0.03% fee is low and the monthly interest adds a steady return.',
        'When interest rates rise, existing bond prices fall, so it can lose value in a rate-hike cycle. Its long-run return is lower than stocks and may not beat inflation by much.',
        'Mainly a stabilizer: it lowers swings but is not built for fast growth.'],
  JNJ: ['The company sells medicines and medical devices, which people need in any economy, so earnings are steady. It has raised its dividend for over 60 years and carries a top-tier credit rating.',
        'Ongoing talc lawsuits could cost billions in settlements. Its drug patents also expire over time, so growth depends on new products.',
        'A stable single company, though one stock carries more risk than a fund.'],
  PG: ['Tide, Pampers and Gillette sell in good times and bad, giving the company dependable sales. It has paid a rising dividend for nearly 70 years and has strong pricing power.',
       'Growth is slow because its products are already sold almost everywhere. Higher commodity costs and store-brand competition can squeeze profit margins.',
       'A calm, defensive single stock with modest growth compared with a broad fund.'],
  MSFT: ['Its cloud, software and AI products produce large, steadily growing profits, and the balance sheet is among the strongest. It has been a long-term compounder.',
         'The share price already reflects high expectations, so any slowdown in cloud growth could cause a sharp drop. It pays a small dividend, so returns depend on price gains.',
         'Strong business quality, but it is a single stock priced for success.'],
  XLK: ['One fund bundles the biggest US technology companies, including software, chips and hardware. It has benefited from the surge in AI spending.',
        'The top three holdings make up a large share of the fund, so it is far less diversified than a broad index fund. Tech tends to fall hardest when interest rates rise.',
        'A concentrated bet on one sector, suited to those comfortable with larger swings.'],
  XLE: ['It holds the large US oil and gas producers, which pay generous dividends and often rise when inflation does. Energy can balance a portfolio heavy in tech.',
        'Energy company earnings follow oil prices, which swing widely and are hard to predict. Long-term demand worries about fossil fuels add uncertainty.',
        'A cyclical sector fund that can diversify a portfolio but moves with commodity prices.'],
  NVDA: ['It designs the chips that power most AI data centers, and sales and profits have grown very fast. Company insiders have been buying recently, a sign of internal confidence.',
         'The valuation is high, so even good results can disappoint investors. Sales depend on a few large customers, and export limits or new competitors could slow growth.',
         'High growth with high volatility, suited to people who can ride out large price swings.'],
  ETSY: ['The online marketplace has stabilized sales after a rough stretch, and several executives have bought shares in the open market. Its valuation is far below its past peaks.',
         'Competition from larger marketplaces is intense, and shoppers have cut back on discretionary spending. As a mid-sized company, its share price can swing sharply.',
         'A recovery story with real insider support but a bumpy path.'],
  PINS: ['Advertising revenue and user numbers are both growing, and the company is turning consistent profits. Its shoppable-pins strategy gives it a clear path to more ad income.',
         'It competes for ad dollars with much larger platforms, and ad budgets shrink quickly in a slowdown. Some insiders have been selling shares.',
         'A growing mid-sized company with the risk that comes with ad-driven revenue.'],
  ARKK: ['The fund holds high-growth companies in genomics, robotics and fintech, which could grow quickly if their technologies take off. A concentrated, actively managed approach can pay off in strong innovation cycles.',
         'It fell sharply in past downturns and has seen heavy outflows. The 0.75% fee is high, and many holdings are not yet profitable.',
         'A volatile theme fund that has taken large losses in down markets, for experienced investors only.'],
  'BTC/USD': ['Spot Bitcoin funds have drawn steady inflows, and its fixed supply appeals to people who worry about currency debasement. Trading is deep and runs around the clock.',
              'Prices can fall by half or more within months and are driven by sentiment rather than earnings. Rules for crypto are still changing, and there are no cash flows to value it on.',
              'A very volatile asset that has taken large losses in past downturns, for experienced investors only.'],
  OPEN: ['The company buys and resells homes online using pricing software, and it could grow quickly if home sales recover. Lower mortgage rates would help it directly.',
          'It has lost money in most years, and it holds expensive inventory that loses value when home prices fall. High mortgage rates have slowed sales, and the share price swings sharply.',
          'A speculative small company where losses are possible.'],
  PLUG: ['The company makes hydrogen fuel cells and is narrowing its losses as it scales up. A policy push toward clean energy could boost demand.',
         'It has lost money for years and depends on raising more funds, which can dilute current shareholders. Project delays continue to weigh on the shares.',
         'A speculative small company where a full loss of value is possible.'],
};

const stanceOf = (s) => (s > 0.15 ? 'supports' : s < -0.15 ? 'challenges' : 'neutral');
const idOf = (ticker, tier) => crypto.createHash('sha1').update(`${tier}:${ticker}`).digest('hex').slice(0, 6);

function verdictFor(ticker, tier, riskFit) {
  const [, , base] = TEXT[ticker];
  const fit = riskFit >= 15
    ? `A close fit for the ${TIER_LABEL[tier]} profile.`
    : riskFit >= 8
      ? `A moderate fit for the ${TIER_LABEL[tier]} profile.`
      : `A loose fit for the ${TIER_LABEL[tier]} profile because its volatility differs from that risk level.`;
  return `${base} ${fit}`;
}

for (const tier of TIERS) {
  const ranked = rankForTier(seed.stocks, tier).slice(0, 10);
  const rows = ranked.map((r) => {
    const t = TEXT[r.stock.ticker];
    if (!t) throw new Error(`Missing hand-written text for ${r.stock.ticker}`);
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
      bullCase: t[0],
      bearCase: t[1],
      verdict: verdictFor(r.stock.ticker, tier, r.scoreBreakdown.riskFit),
      newsTags: r.stock.news.map((n) => ({ headline: n.headline, stance: stanceOf(n.sentiment), url: n.url })),
      updatedAt: UPDATED_AT,
    };
  });
  fs.writeFileSync(path.join(dir, `feed.${tier}.sample.json`), JSON.stringify(rows, null, 2) + '\n');
  console.log(`wrote feed.${tier}.sample.json:`, rows.map((x) => `${x.ticker}:${x.matchScore}`).join(' '));
}
fs.copyFileSync(path.join(dir, 'feed.low.sample.json'), path.join(dir, 'feed.sample.json'));
console.log('feed.sample.json = copy of feed.low.sample.json');

// SAMPLE articles for local testing of matchNews. NOT real news: headlines and summaries are written for
// testing, and URLs point at example.com. Shaped like server/pipeline.js collectNews() items
// ({ ticker, headline, source, url, sentiment, datetime }), plus an optional `summary`, which real
// Finnhub articles have but the current n8n/backend pipeline does not pass through yet.
const T = '2026-11-15T13:00:00Z';
module.exports = [
  { ticker: 'NVDA', headline: 'Nvidia warns of slowing AI data-center orders', source: 'Sample Wire', url: 'https://example.com/sample/nvidia-slowing-ai-orders', sentiment: -0.6, datetime: T,
    summary: 'SAMPLE: Nvidia said several large cloud customers are delaying data-center GPU orders and lowered its revenue guidance for next quarter, citing slower AI infrastructure spending.' },
  { ticker: 'NVDA', headline: 'Nvidia posts record data-center revenue on AI chip demand', source: 'Sample Wire', url: 'https://example.com/sample/nvidia-record-data-center', sentiment: 0.7, datetime: T,
    summary: 'SAMPLE: Nvidia reported record quarterly data-center revenue as cloud providers kept expanding AI infrastructure, and said demand for its newest chips exceeds supply.' },
  { ticker: 'NVDA', headline: 'Export limits could trim chip sales', source: 'Sample Wire', url: 'https://example.com/sample/export-limits', sentiment: -0.3, datetime: T }, // headline only
  { ticker: 'VOO', headline: 'S&P 500 earnings growth tops forecasts', source: 'Sample Wire', url: 'https://example.com/sample/sp500-earnings', sentiment: 0.4, datetime: T,
    summary: 'SAMPLE: With most S&P 500 companies reporting, quarterly earnings grew faster than analysts expected, with gains spread across most sectors.' },
  { ticker: 'VOO', headline: 'Fed holds rates steady', source: 'Sample Wire', url: 'https://example.com/sample/fed-holds', sentiment: 0.2, datetime: T }, // headline only
  { ticker: 'KO', headline: 'Coca-Cola raises prices in Latin America', source: 'Sample Wire', url: 'https://example.com/sample/coca-cola-prices', sentiment: 0.1, datetime: T }, // unrelated to NVDA; KO is a small (<1%) VOO position, so also filtered for VOO
  { ticker: 'XLE', headline: 'Oil slips as supply outlook improves', source: 'Sample Wire', url: 'https://example.com/sample/oil-slips', sentiment: -0.3, datetime: T }, // unrelated to NVDA and VOO
  { ticker: 'AAPL', headline: 'Apple iPhone sales slip in China', source: 'Sample Wire', url: 'https://example.com/sample/apple-china', sentiment: -0.4, datetime: T,
    summary: 'SAMPLE: Apple said iPhone revenue in China fell from a year earlier amid stronger local competition.' },
  { ticker: 'NVDA', headline: 'Nvidia unveils new networking chip', source: 'Sample Wire', url: null, sentiment: 0.3, datetime: T }, // no URL
  { ticker: 'NVDA', headline: 'Nvidia shares swing after analyst day', source: 'Sample Wire', url: 'javascript:alert(1)', sentiment: 0, datetime: T }, // invalid URL
];

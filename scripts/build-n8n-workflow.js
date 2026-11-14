// Generates n8n/loop-daily.workflow.json (importable skeleton) from n8n/code/*.js and scripts/universe.js.
// Re-run after editing any of those:  node scripts/build-n8n-workflow.js
// Import in n8n: Workflows > Import from file. Then follow the sticky note on the canvas.
const fs = require('fs');
const path = require('path');
const universe = require('./universe');

const root = path.join(__dirname, '..');
const code = (name) => fs.readFileSync(path.join(root, 'n8n', 'code', `${name}.js`), 'utf8');
const UNIVERSE_JSON = JSON.stringify(universe.map(({ ticker, companyName, category, merPct }) => ({ ticker, companyName, category, merPct })));

const nodes = [];
const add = (name, type, typeVersion, position, parameters, extra = {}) => {
  nodes.push({ parameters, id: `n${String(nodes.length + 1).padStart(2, '0')}-${name.toLowerCase().replace(/\W+/g, '-')}`, name, type, typeVersion, position, ...extra });
};
const codeNode = (name, file, position, extra = {}, transform = (s) => s) =>
  add(name, 'n8n-nodes-base.code', 2, position, { jsCode: transform(code(file)) }, extra);

const SEC_UA = '={{ $vars.SEC_USER_AGENT }}'; // SEC returns 403 without a descriptive User-Agent that includes a contact
const alpacaHeaders = {
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'APCA-API-KEY-ID', value: '={{ $vars.ALPACA_KEY_ID }}' },
    { name: 'APCA-API-SECRET-KEY', value: '={{ $vars.ALPACA_SECRET_KEY }}' },
  ] },
};
const secHeaders = { sendHeaders: true, headerParameters: { parameters: [{ name: 'User-Agent', value: SEC_UA }, { name: 'Accept-Encoding', value: 'gzip, deflate' }] } };
const batch = (ms) => ({ batching: { batch: { batchSize: 1, batchInterval: ms } } });
const soft = { onError: 'continueRegularOutput' }; // one bad ticker must not kill the run

// ---- triggers
add('Manual Trigger', 'n8n-nodes-base.manualTrigger', 1, [0, 0], {});
add('Daily Schedule', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 160],
  { rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * *' }] } }, { disabled: true }); // enable LAST (Sunday 3 pm freeze)

// ---- data
codeNode('Universe', 'universe', [260, 80], {}, (s) => s.replace('const UNIVERSE = __UNIVERSE__;', `const UNIVERSE = ${UNIVERSE_JSON};`));
add('Alpaca stock bars', 'n8n-nodes-base.httpRequest', 4.2, [520, 80], {
  method: 'GET', url: 'https://data.alpaca.markets/v2/stocks/bars', ...alpacaHeaders,
  sendQuery: true, queryParameters: { parameters: [
    { name: 'symbols', value: "={{ $('Universe').all().filter(i => i.json.category !== 'crypto').map(i => i.json.ticker).join(',') }}" },
    { name: 'timeframe', value: '1Day' },
    { name: 'start', value: '={{ $now.minus({ days: 45 }).toISODate() }}' },
    { name: 'limit', value: '10000' }, { name: 'feed', value: 'iex' }, { name: 'adjustment', value: 'split' },
  ] }, options: {},
}, { executeOnce: true, retryOnFail: true, maxTries: 3 });
add('Alpaca crypto bars', 'n8n-nodes-base.httpRequest', 4.2, [780, 80], {
  method: 'GET', url: 'https://data.alpaca.markets/v1beta3/crypto/us/bars', ...alpacaHeaders,
  sendQuery: true, queryParameters: { parameters: [
    { name: 'symbols', value: "={{ $('Universe').all().filter(i => i.json.category === 'crypto').map(i => i.json.ticker).join(',') }}" },
    { name: 'timeframe', value: '1Day' },
    { name: 'start', value: '={{ $now.minus({ days: 45 }).toISODate() }}' },
    { name: 'limit', value: '10000' },
  ] }, options: {},
}, { executeOnce: true, retryOnFail: true, maxTries: 3 });
codeNode('Stock tickers', 'stock-tickers', [1040, 80]);
add('Finnhub metric', 'n8n-nodes-base.httpRequest', 4.2, [1300, 80], {
  method: 'GET', url: '=https://finnhub.io/api/v1/stock/metric?symbol={{ $json.ticker }}&metric=all&token={{ $vars.FINNHUB_KEY }}',
  options: batch(1100), // Finnhub free: 60 calls/minute
}, soft);
add('Finnhub news', 'n8n-nodes-base.httpRequest', 4.2, [1560, 80], {
  method: 'GET',
  url: "=https://finnhub.io/api/v1/company-news?symbol={{ $('Stock tickers').item.json.ticker }}&from={{ $now.minus({ days: 3 }).toISODate() }}&to={{ $now.toISODate() }}&token={{ $vars.FINNHUB_KEY }}",
  options: batch(1100),
}, { ...soft, alwaysOutputData: true });
add('SEC tickers', 'n8n-nodes-base.httpRequest', 4.2, [1820, 80], {
  method: 'GET', url: 'https://www.sec.gov/files/company_tickers.json', ...secHeaders, options: {},
}, { executeOnce: true, alwaysOutputData: true });
codeNode('EDGAR targets', 'edgar-targets', [2080, 80], { alwaysOutputData: true });
add('SEC submissions', 'n8n-nodes-base.httpRequest', 4.2, [2340, 80], {
  method: 'GET', url: '=https://data.sec.gov/submissions/CIK{{ $json.cikPadded }}.json', ...secHeaders,
  options: batch(150), // SEC allows 10 requests/second
}, { ...soft, alwaysOutputData: true });
codeNode('Pick Form 4', 'pick-form4', [2600, 80], { alwaysOutputData: true });
add('SEC Form 4 XML', 'n8n-nodes-base.httpRequest', 4.2, [2860, 80], {
  method: 'GET', url: '={{ $json.url }}', ...secHeaders,
  options: { ...batch(150), response: { response: { responseFormat: 'text', outputPropertyName: 'data' } } },
}, { ...soft, alwaysOutputData: true });
codeNode('Build Contract A', 'build-contract-a', [3120, 80]);
add('POST /api/webhook/seed', 'n8n-nodes-base.httpRequest', 4.2, [3380, 80], {
  method: 'POST', url: '={{ $vars.LOOP_BASE_URL }}/api/webhook/seed',
  sendHeaders: true, headerParameters: { parameters: [{ name: 'x-webhook-secret', value: '={{ $vars.INBOUND_WEBHOOK_SECRET }}' }] },
  sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '={{ JSON.stringify($json) }}',
  options: { timeout: 120000 }, // Render free tier can take ~1 minute to wake
}, { retryOnFail: true, maxTries: 3, waitBetweenTries: 20000 });

// ---- notify branch (Contract E): backend -> this webhook -> Gmail
add('Notify Webhook', 'n8n-nodes-base.webhook', 2, [0, 520],
  { httpMethod: 'POST', path: 'loop-notify', responseMode: 'onReceived', options: {} }, { webhookId: '6f1c1d0e-5a52-4b1e-9d36-0c7f7a8e2b11' });
codeNode('Fill email template', 'fill-email-template', [260, 520]);
add('Send Gmail', 'n8n-nodes-base.gmail', 2.1, [520, 520], {
  resource: 'message', operation: 'send', sendTo: '={{ $json.to }}', subject: '={{ $json.subject }}',
  emailType: 'html', message: '={{ $json.html }}', options: {},
}, { credentials: { gmailOAuth2: { id: 'REPLACE_ME', name: 'Gmail account' } } });

add('Setup notes', 'n8n-nodes-base.stickyNote', 1, [0, -360], {
  width: 760, height: 300, content: [
    '## LOOP daily seed: setup',
    '1. Settings > Variables (or replace with credentials): ALPACA_KEY_ID, ALPACA_SECRET_KEY, FINNHUB_KEY, LOOP_BASE_URL (https://your-app.onrender.com, no trailing slash), INBOUND_WEBHOOK_SECRET, SEC_USER_AGENT (e.g. "LOOP Buildathon you@example.com", SEC returns 403 without a contact).',
    '2. Gmail node: pick your Gmail OAuth2 credential.',
    '3. Notify Webhook: copy its PRODUCTION URL into the backend env N8N_NOTIFY_WEBHOOK_URL. Activate the workflow for production URLs to work.',
    '4. Fill email template: paste Dianne\'s email-template.html into TEMPLATE.',
    '5. Develop with the Manual Trigger. The Daily Schedule is DISABLED on purpose: enable it only after the Sunday 3 pm freeze (85 executions on the plan).',
    '6. Never hand-edit Code nodes here: edit n8n/code/*.js in the repo and re-run scripts/build-n8n-workflow.js.',
  ].join('\n'),
});

const link = (from, to) => [from, { main: [[{ node: to, type: 'main', index: 0 }]] }];
const chain = ['Universe', 'Alpaca stock bars', 'Alpaca crypto bars', 'Stock tickers', 'Finnhub metric', 'Finnhub news', 'SEC tickers',
  'EDGAR targets', 'SEC submissions', 'Pick Form 4', 'SEC Form 4 XML', 'Build Contract A', 'POST /api/webhook/seed'];
const connections = Object.fromEntries([
  link('Manual Trigger', 'Universe'), link('Daily Schedule', 'Universe'),
  ...chain.slice(0, -1).map((n, i) => link(n, chain[i + 1])),
  link('Notify Webhook', 'Fill email template'), link('Fill email template', 'Send Gmail'),
]);

const workflow = { name: 'LOOP daily seed', nodes, connections, active: false, settings: { executionOrder: 'v1', timezone: 'America/Toronto' }, pinData: {}, tags: [] };
const out = path.join(root, 'n8n', 'loop-daily.workflow.json');
fs.writeFileSync(out, JSON.stringify(workflow, null, 2) + '\n');
console.log(`Wrote ${path.relative(root, out)}: ${nodes.length} nodes, universe of ${universe.length}`);

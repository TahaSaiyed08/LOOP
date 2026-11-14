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

// Secrets live in n8n CREDENTIALS (Variables are not available on the Starter plan), never in this file.
// Credential ids are placeholders: after import, open each HTTP node and pick the credential by name.
const CRED = {
  alpaca:  { type: 'httpCustomAuth', name: 'LOOP Alpaca' },          // Custom Auth: two headers, so Header Auth cannot hold it
  finnhub: { type: 'httpHeaderAuth', name: 'LOOP Finnhub' },         // Header Auth: X-Finnhub-Token
  sec:     { type: 'httpHeaderAuth', name: 'LOOP SEC User-Agent' },  // Header Auth: User-Agent (SEC returns 403 without a contact)
  webhook: { type: 'httpHeaderAuth', name: 'LOOP Webhook Secret' },  // Header Auth: x-webhook-secret
};
const useCred = (c) => ({
  parameters: { authentication: 'genericCredentialType', genericAuthType: c.type },
  credentials: { [c.type]: { id: 'REPLACE_ME', name: c.name } },
});
const withCred = (c, parameters) => ({ ...useCred(c).parameters, ...parameters });
const credOf = (c) => useCred(c).credentials;
const secHeaders = { sendHeaders: true, headerParameters: { parameters: [{ name: 'Accept-Encoding', value: 'gzip, deflate' }] } };
const batch = (ms) => ({ batching: { batch: { batchSize: 1, batchInterval: ms } } });
const soft = { onError: 'continueRegularOutput' }; // one bad ticker must not kill the run

// ---- triggers
add('Manual Trigger', 'n8n-nodes-base.manualTrigger', 1, [0, 0], {});
add('Daily Schedule', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 160],
  { rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * *' }] } }, { disabled: true }); // enable LAST (Sunday 3 pm freeze)

// ---- data
codeNode('Universe', 'universe', [260, 80], {}, (s) => s.replace('const UNIVERSE = __UNIVERSE__;', `const UNIVERSE = ${UNIVERSE_JSON};`));
add('Alpaca stock bars', 'n8n-nodes-base.httpRequest', 4.2, [520, 80], {
  method: 'GET', url: 'https://data.alpaca.markets/v2/stocks/bars', ...withCred(CRED.alpaca, {}),
  sendQuery: true, queryParameters: { parameters: [
    { name: 'symbols', value: "={{ $('Universe').all().filter(i => i.json.category !== 'crypto').map(i => i.json.ticker).join(',') }}" },
    { name: 'timeframe', value: '1Day' },
    { name: 'start', value: '={{ $now.minus({ days: 45 }).toISODate() }}' },
    { name: 'limit', value: '10000' }, { name: 'feed', value: 'iex' }, { name: 'adjustment', value: 'split' },
  ] }, options: {},
}, { executeOnce: true, retryOnFail: true, maxTries: 3, credentials: credOf(CRED.alpaca) });
add('Alpaca crypto bars', 'n8n-nodes-base.httpRequest', 4.2, [780, 80], {
  method: 'GET', url: 'https://data.alpaca.markets/v1beta3/crypto/us/bars', ...withCred(CRED.alpaca, {}),
  sendQuery: true, queryParameters: { parameters: [
    { name: 'symbols', value: "={{ $('Universe').all().filter(i => i.json.category === 'crypto').map(i => i.json.ticker).join(',') }}" },
    { name: 'timeframe', value: '1Day' },
    { name: 'start', value: '={{ $now.minus({ days: 45 }).toISODate() }}' },
    { name: 'limit', value: '10000' },
  ] }, options: {},
}, { executeOnce: true, retryOnFail: true, maxTries: 3, credentials: credOf(CRED.alpaca) });
codeNode('Stock tickers', 'stock-tickers', [1040, 80]);
add('Finnhub metric', 'n8n-nodes-base.httpRequest', 4.2, [1300, 80], {
  method: 'GET', url: '=https://finnhub.io/api/v1/stock/metric?symbol={{ $json.ticker }}&metric=all', ...withCred(CRED.finnhub, {}),
  options: batch(1100), // Finnhub free: 60 calls/minute
}, { ...soft, credentials: credOf(CRED.finnhub) });
add('Finnhub news', 'n8n-nodes-base.httpRequest', 4.2, [1560, 80], {
  method: 'GET',
  url: "=https://finnhub.io/api/v1/company-news?symbol={{ $('Stock tickers').item.json.ticker }}&from={{ $now.minus({ days: 3 }).toISODate() }}&to={{ $now.toISODate() }}", ...withCred(CRED.finnhub, {}),
  options: batch(1100),
}, { ...soft, alwaysOutputData: true, credentials: credOf(CRED.finnhub) });
add('SEC tickers', 'n8n-nodes-base.httpRequest', 4.2, [1820, 80], {
  method: 'GET', url: 'https://www.sec.gov/files/company_tickers.json', ...withCred(CRED.sec, {}), ...secHeaders, options: {},
}, { executeOnce: true, alwaysOutputData: true, credentials: credOf(CRED.sec) });
codeNode('EDGAR targets', 'edgar-targets', [2080, 80], { alwaysOutputData: true });
add('SEC submissions', 'n8n-nodes-base.httpRequest', 4.2, [2340, 80], {
  method: 'GET', url: '=https://data.sec.gov/submissions/CIK{{ $json.cikPadded }}.json', ...withCred(CRED.sec, {}), ...secHeaders,
  options: batch(150), // SEC allows 10 requests/second
}, { ...soft, alwaysOutputData: true, credentials: credOf(CRED.sec) });
codeNode('Pick Form 4', 'pick-form4', [2600, 80], { alwaysOutputData: true });
add('SEC Form 4 XML', 'n8n-nodes-base.httpRequest', 4.2, [2860, 80], {
  method: 'GET', url: '={{ $json.url }}', ...withCred(CRED.sec, {}), ...secHeaders,
  options: { ...batch(150), response: { response: { responseFormat: 'text', outputPropertyName: 'data' } } },
}, { ...soft, alwaysOutputData: true, credentials: credOf(CRED.sec) });
codeNode('Build Contract A', 'build-contract-a', [3120, 80]);
add('POST /api/webhook/seed', 'n8n-nodes-base.httpRequest', 4.2, [3380, 80], {
  method: 'POST', url: 'https://REPLACE-ME.onrender.com/api/webhook/seed', // edit once after import: your Render URL
  ...withCred(CRED.webhook, {}),
  sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '={{ JSON.stringify($json) }}',
  options: { timeout: 120000 }, // Render free tier can take ~1 minute to wake
}, { retryOnFail: true, maxTries: 3, waitBetweenTries: 20000, credentials: credOf(CRED.webhook) });

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
    '1. Create 5 credentials (Credentials > Create), using these exact names:',
    '   - "LOOP Alpaca" (Custom Auth). JSON: {"headers": {"APCA-API-KEY-ID": "<key id>", "APCA-API-SECRET-KEY": "<secret key>"}}',
    '   - "LOOP Finnhub" (Header Auth). Name: X-Finnhub-Token, Value: <Finnhub key>',
    '   - "LOOP SEC User-Agent" (Header Auth). Name: User-Agent, Value: LOOP Buildathon <your contact email> (SEC returns 403 without a contact)',
    '   - "LOOP Webhook Secret" (Header Auth). Name: x-webhook-secret, Value: <INBOUND_WEBHOOK_SECRET from Render>',
    '   - Gmail OAuth2 (for the Send Gmail node)',
    '2. Open every HTTP Request node and Send Gmail and pick the credential above (imported ids are placeholders).',
    '3. Edit the URL of "POST /api/webhook/seed" to your Render URL.',
    '4. Notify Webhook: copy its PRODUCTION URL into the backend env N8N_NOTIFY_WEBHOOK_URL. Activate the workflow for production URLs to work.',
    '5. Fill email template: paste Dianne\'s email-template.html into TEMPLATE.',
    '6. Develop with the Manual Trigger. The Daily Schedule is DISABLED on purpose: enable it only after the Sunday 3 pm freeze (85 executions on the plan). Warm the Render URL before any live run.',
    '7. Never hand-edit Code nodes here: edit n8n/code/*.js in the repo and re-run scripts/build-n8n-workflow.js.',
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

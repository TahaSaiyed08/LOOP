// LOOP backend entry. Only Taha edits this file.
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const llm = require('./llm');
const alpaca = require('./alpaca');
const paper = require('./paper');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, llmConfigured: llm.isConfigured(), alpacaConfigured: alpaca.hasCredentials() });
});

// Contract D: paper trading
app.post('/api/paper/buy', async (req, res) => {
  const ticker = String((req.body && req.body.ticker) || '').trim().toUpperCase();
  const amountUsd = Number(req.body && req.body.amountUsd);
  if (!/^[A-Z.]{1,6}(\/[A-Z]{3,4})?$/.test(ticker)) return res.status(400).json({ error: 'ticker is required, e.g. "VOO"' });
  if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > 100000) {
    return res.status(400).json({ error: 'amountUsd must be a number between 0 and 100000' });
  }
  try {
    res.json(await paper.buy(ticker, Math.round(amountUsd * 100) / 100));
  } catch (err) {
    console.warn('[paper/buy]', err.message);
    res.status(err.code === 'NO_PRICE' ? 404 : 502).json({ error: err.message });
  }
});

app.get('/api/paper/portfolio', async (req, res) => {
  try {
    res.json(await paper.getPortfolio());
  } catch (err) {
    console.warn('[paper/portfolio] falling back to fixture:', err.message);
    res.json(require('../fixtures/portfolio.sample.json')); // never render empty
  }
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`LOOP server on :${PORT}`));
}
module.exports = app;

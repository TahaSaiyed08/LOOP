// LOOP backend entry. Only Taha edits this file.
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const llm = require('./llm');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, llmConfigured: llm.isConfigured() });
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`LOOP server on :${PORT}`));
}
module.exports = app;

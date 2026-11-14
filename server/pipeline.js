// Daily thesis step: match the day's news against the saved thesis, store matches, maybe email.
// Council explanations are NOT wired yet (council.js has not been delivered); feed text stays null until then.
const store = require('./store');
const thesisEngine = require('./thesis');
const { maybeNotify } = require('./notify');

const MAX_NEWS = 30; // matchNews batches everything into one LLM call, capped

// Prefer headlines for tickers that surface in the tier lists; otherwise newest first.
function collectNews(payload) {
  const items = [];
  for (const s of payload.stocks) for (const n of s.news || []) items.push({ ticker: s.ticker, ...n });
  items.sort((a, b) => String(b.datetime || '').localeCompare(String(a.datetime || '')));
  return items.slice(0, MAX_NEWS);
}

let running = false;

async function refreshThesisMatches() {
  const thesis = store.get('thesis');
  const payload = store.get('feed');
  if (!thesis || !payload || running) return { skipped: true };
  running = true;
  try {
    const news = collectNews(payload);
    const matches = news.length ? await thesisEngine.matchNews(thesis, news) : [];
    store.set('thesisMatches', matches);
    const notified = await maybeNotify(thesis, matches);
    return { matches: matches.length, notified };
  } catch (err) {
    console.warn('[pipeline] thesis match failed:', err.message);
    return { error: err.message };
  } finally {
    running = false;
  }
}

module.exports = { refreshThesisMatches, collectNews };

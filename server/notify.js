// Contract E: POST to N8N_NOTIFY_WEBHOOK_URL on the first "challenges" match, max one per UTC day.
// Recipient comes from NOTIFY_TO_EMAIL (Contract C carries no email). Never throws.
const store = require('./store');

const siteUrl = () => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'https://tfsa-gold-site.onrender.com').replace(/\/$/, '');
const today = () => new Date().toISOString().slice(0, 10);

let inFlight = false;

// maybeNotify(thesis, matches) -> { sent: boolean, reason?: string }
async function maybeNotify(thesis, matches) {
  const first = (matches || []).find((m) => m && m.stance === 'challenges');
  if (!first) return { sent: false, reason: 'no challenging match' };
  const url = process.env.N8N_NOTIFY_WEBHOOK_URL;
  if (!url) return { sent: false, reason: 'N8N_NOTIFY_WEBHOOK_URL not set' };
  const to = process.env.NOTIFY_TO_EMAIL;
  if (!to) return { sent: false, reason: 'NOTIFY_TO_EMAIL not set' };
  if (store.get('notifyLastSentDate') === today()) return { sent: false, reason: 'already sent today' };
  if (inFlight) return { sent: false, reason: 'send in progress' };

  inFlight = true;
  const payload = {
    to,
    ticker: first.ticker,
    headline: first.headline,
    stance: first.stance,
    whyItMatters: first.whyItMatters,
    thesisGoal: thesis.goal,
    link: `${siteUrl()}/#thesis`,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ctrl.signal });
    if (!res.ok) throw new Error(`webhook responded ${res.status}`);
    store.set('notifyLastSentDate', today()); // only after success, so a failed send can retry
    console.log(`[notify] sent challenge email for ${first.ticker}`);
    return { sent: true };
  } catch (err) {
    console.warn('[notify] failed:', err.message);
    return { sent: false, reason: err.message };
  } finally {
    clearTimeout(timer);
    inFlight = false;
  }
}

module.exports = { maybeNotify };

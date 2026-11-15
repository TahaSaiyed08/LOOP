// ============================================================================================
// server/thesis.js (Vamsi). Prompts live in prompts/thesis.md.
//
//   onboardingTurn(message, session, opts)  REAL: intent detection + adaptive onboarding.
//                                           Pure: no store writes, no thesis, no monitoring, no email.
//   createThesis(goalsText)                 STUB: returns the fixture thesis for any input.
//   matchNews(thesis, newsItems, opts)      REAL: Gemini compares news with the thesis's own (user-confirmed)
//                                           assumptions. Same Contract C output; never emails or saves.
//
// IS_STUB stays true until createThesis is real (GET /api/health reports it).
//
// Email trigger rule (Vamsi documents, Taha implements in server/notify.js):
//   any match with stance "challenges" triggers one email, max one per day; the email carries
//   the first challenging match.
// ============================================================================================
const fs = require('fs');
const path = require('path');
const llm = require('./llm');
const fixture = require('../fixtures/thesis.sample.json');

// createThesis(goalsText) -> Contract C thesis. STUB: returns the fixture thesis for any input.
async function createThesis(goalsText) {
  return { ...fixture, assumptions: [...fixture.assumptions], createdAt: new Date().toISOString() };
}

// matchNews(thesis, newsItems, opts) -> Contract C match array
//   [{ ticker, headline, url, assumptionIndex, stance, whyItMatters, ...additive fields }]
// Called by server/pipeline.js with (thesis, news). Implementation: matchNewsDetailed() further down.
async function matchNews(thesis, newsItems, opts = {}) {
  return (await matchNewsDetailed(thesis, newsItems, opts)).matches;
}

// ============================================================================================
// ONBOARDING: onboardingTurn(message, session, opts) -> Promise<result>
//
// The caller keeps the session and passes result.session into the next turn. Shape:
//   session = { history: [{role, content}], profile, askedFields, activeFlow, tickers, lastQuestionField }
//   result  = { intent, reply, displayText, nextQuestion, profile, extractedThisTurn, corrections,
//               tickers, ambiguities, activeFlow, missingFields, readyToProceed, suggestedNextStep,
//               nextSteps [{id,label}], profileJustCompleted, monitoringActivated (always false),
//               source ('gemini'|'fallback'), model, fallbackReason, session }
//   opts    = { callLLM (test override), forceFallback (skip Gemini) }
//
// One callLLM per turn (Gemini via server/llm.js). If GEMINI_MODEL fails with a rate limit, a
// temporary error or an unavailable model, the same prompt is tried once on FALLBACK_GEMINI_MODEL
// (never on auth errors). Only if both fail does the rule-based fallback answer. Whatever comes back is re-validated here
// (enums, anti-guessing, no repeated questions, advice guard), and the same rules run on the
// rule-based fallback used when there is no key, the call fails, or the reply is unusable.
// ============================================================================================
const PROMPT_FILE = path.join(__dirname, '..', 'prompts', 'thesis.md');
let UNIVERSE = [];
try { UNIVERSE = require('../scripts/universe'); } catch { UNIVERSE = []; }

const INTENTS = ['learning', 'goal_exploration', 'investment_discovery', 'monitoring', 'off_topic', 'unclear'];
const FLOW_INTENTS = ['goal_exploration', 'investment_discovery', 'monitoring'];
const PROFILE_FIELDS = ['amount', 'cadence', 'timelineYears', 'currency', 'experience', 'riskComfort', 'purpose'];
const QUESTION_FIELDS = [...PROFILE_FIELDS, 'ticker', 'clarification'];
// What each flow needs before it can be offered its next step. Learning needs nothing; research and
// monitoring never need an amount or risk level.
const REQUIRED = { goal_exploration: ['purpose', 'timelineYears', 'amount', 'cadence', 'riskComfort'], investment_discovery: [], monitoring: ['ticker'] };
// Follow-up questions that make sense in each flow (monitoring never asks for an amount or risk level).
const RELEVANT = { goal_exploration: [...PROFILE_FIELDS, 'ticker'], investment_discovery: ['ticker', 'experience', 'purpose', 'riskComfort'], monitoring: ['ticker', 'experience'] };
const NEXT_STEP = { goal_exploration: 'offer_thesis_draft', investment_discovery: 'show_asset_research', monitoring: 'offer_monitoring_setup' };
const QUESTIONS = {
  purpose: 'What is this money for, for example a home, retirement, education or general long-term growth?',
  timelineYears: 'Roughly how many years from now do you expect to need this money?',
  amount: 'About how much would you like to put in each time (or in total, if it is a one-time amount)?',
  cadence: 'How often would you add money: once, weekly, every two weeks or monthly?',
  riskComfort: 'If your investments dropped 20% in a bad year, how comfortable would you be: low, medium or high?',
  experience: 'How familiar are you with investing: beginner, some experience, or experienced?',
  currency: 'Which currency are you investing in, for example CAD or USD?',
  ticker: 'Which company or fund would you like to research? THESIS covers about 60 US-listed stocks and ETFs.',
};
// Offered (never taken automatically) next steps, as buttons a frontend can render.
const STEP = {
  explore_investments: { id: 'explore_investments', label: 'Explore Investments' },
  create_thesis_draft: { id: 'create_thesis_draft', label: 'Create Thesis Draft' },
  set_up_monitoring: { id: 'set_up_monitoring', label: 'Set Up Monitoring' },
};
const NEXT_STEPS = {
  goal_exploration: [STEP.explore_investments, STEP.create_thesis_draft],
  investment_discovery: [STEP.explore_investments],
  monitoring: [STEP.explore_investments, STEP.set_up_monitoring],
};
const MONITOR_LINE = "Monitoring is available for this, but it hasn't been activated: nothing is being tracked and no alerts will be sent unless you choose to set it up.";
const MONITOR_STATED = /(\bnot|n't|\bnever)\s+(been\s+|yet\s+)?(activated|active|turned on|switched on|set up|being tracked|tracking)\b|nothing is being tracked/i;
// Sentences claiming monitoring is already on ("I'll track NVIDIA for you") are removed: it never is.
const TRACKING_CLAIM = /\b(i('|\s+wi)ll|i am|i'm|we('|\s+wi)ll|we are|we're)\s+(now\s+|start\s+|begin\s+)?(track|monitor|watch|alert|notify)(ing)?\b|\b(is|are)\s+now\s+being\s+(tracked|monitored)\b|\bmonitoring (is|has been) (now )?(on|active|activated|enabled)\b/i;
// ...and so are sentences denying the feature exists ("I do not track assets"): it exists, it is just off.
const TRACKING_DENIAL = /\b(i|we|thesis)\s+(do not|don't|cannot|can't|am not able to|are not able to)\s+(track|monitor|watch|send alerts)/i;
const dropTrackingClaims = (t) => splitSentences(t).filter((x) => !TRACKING_CLAIM.test(x) && !TRACKING_DENIAL.test(x)).join('').trim();
const MAX_MESSAGE = 2000;
const MAX_HISTORY = 20;
const PROMPT_HISTORY = 12;
const SAFE_LINE = "I can't tell you what to buy, sell or hold, but I can help you research it and understand the trade-offs.";

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const emptyProfile = () => Object.fromEntries(PROFILE_FIELDS.map((f) => [f, null]));
// profileDetails keeps what the user literally said where a number alone loses meaning ("2–3 years");
// selection holds explicitly chosen tickers: pending (typed) and confirmed (user said yes).
const createOnboardingSession = () => ({ history: [], profile: emptyProfile(), askedFields: [], activeFlow: null, tickers: [], lastQuestionField: null,
  profileDetails: { timelineText: null }, selection: { pending: [], confirmed: [] }, thesisDraft: null });

// ---------- prompt file ----------
const promptCache = {};
function loadPrompt(name) {
  if (name in promptCache) return promptCache[name];
  let text = null;
  try {
    const src = fs.readFileSync(PROMPT_FILE, 'utf8');
    const m = src.match(new RegExp(`<!--\\s*${name}:start\\s*-->([\\s\\S]*?)<!--\\s*${name}:end\\s*-->`));
    text = m && m[1].trim() ? m[1].trim() : null;
  } catch { text = null; }
  promptCache[name] = text;
  return text;
}

// ---------- value normalizers (shared by both paths) ----------
const toNum = (v) => (isNum(v) ? v : typeof v === 'string' && /^\s*\$?\s*[\d,]+(\.\d+)?\s*$/.test(v) ? Number(v.replace(/[$,\s]/g, '')) : null);
const lookup = (table) => (v) => table[String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')] || null;
const NORMALIZE = {
  amount: (v) => { const n = toNum(v); return n > 0 && n < 1e9 ? Math.round(n * 100) / 100 : null; },
  cadence: lookup({ one_time: 'one_time', once: 'one_time', onetime: 'one_time', lump_sum: 'one_time', weekly: 'weekly', biweekly: 'biweekly', bi_weekly: 'biweekly', fortnightly: 'biweekly', every_two_weeks: 'biweekly', monthly: 'monthly', yearly: 'yearly', annually: 'yearly', annual: 'yearly' }),
  timelineYears: (v) => { const n = toNum(v); return n > 0 && n <= 80 ? Math.round(n * 10) / 10 : null; },
  currency: (v) => { const s = String(v ?? '').trim().toUpperCase(); return /^[A-Z]{3}$/.test(s) && s !== 'NUL' ? s : null; },
  experience: lookup({ beginner: 'beginner', novice: 'beginner', some: 'some', intermediate: 'some', experienced: 'experienced', advanced: 'experienced', expert: 'experienced' }),
  riskComfort: lookup({ low: 'low', medium: 'medium', moderate: 'medium', high: 'high' }),
  purpose: (v) => { if (typeof v !== 'string') return null; const s = v.trim().replace(/\s+/g, ' ').slice(0, 120); return s && s.toLowerCase() !== 'null' ? s : null; },
};

// ---------- message analysis (deterministic evidence used by guards and by the fallback) ----------
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50 };
const NUM_WORD = `\\d+(?:\\.\\d+)?|${Object.keys(NUM_WORDS).join('|')}`;
const hasNumber = (t) => /\d/.test(t) || new RegExp(`\\b(${Object.keys(NUM_WORDS).join('|')}|decade|couple|half)\\b`, 'i').test(t);
const wordOrNum = (s) => (/^\d/.test(s) ? Number(s) : NUM_WORDS[String(s).toLowerCase()] ?? null);

const MULT = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6 };
const MONEY_RE = /(c\$|us\$|\$)\s?(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|m|million)?\b|\b(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|m|million)?\s*(dollars|bucks|usd|cad)\b/gi;
const LOAN_AFTER = /^\s*(?:of\s+)?(?:home\s+)?(mortgage|loan|debt)/i;
const LOAN_BEFORE = /(mortgage|loan|debt|owe)\s*(?:of|is|was|for|about|around|:)?\s*(?:about|around|roughly)?\s*$/i;
const OTHER_BEFORE = /(salary|income|earn|make|paid|price|cost|worth|rent)\s*(?:of|is|was|for|about|around|:)?\s*(?:about|around|roughly)?\s*$/i;
const OTHER_AFTER = /^\s*(?:a|per)\s+year\s+(?:salary|income)|^\s*(salary|income|home|house|condo)\b/i;

function findMoney(text) {
  const out = [];
  for (const m of text.matchAll(MONEY_RE)) {
    const digits = m[2] || m[4];
    const mult = MULT[(m[3] || m[5] || '').toLowerCase()] || 1;
    const value = Number(digits.replace(/,/g, '')) * mult;
    if (!(value > 0)) continue;
    const sym = (m[1] || '').toLowerCase();
    const word = (m[6] || '').toLowerCase();
    const currency = sym === 'c$' || word === 'cad' ? 'CAD' : sym === 'us$' || word === 'usd' ? 'USD' : null;
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 30);
    const loanM = after.match(LOAN_AFTER) || before.match(LOAN_BEFORE);
    const kind = loanM ? 'loan' : OTHER_BEFORE.test(before) || OTHER_AFTER.test(after) ? 'other' : 'investment';
    out.push({ value, currency, kind, loanWord: loanM ? loanM[1].toLowerCase() : null, start: m.index, end: m.index + m[0].length, raw: m[0].trim() });
  }
  return out;
}

function parseCadence(t) {
  if (/\b(every\s+(two|2|other)\s+weeks?|bi-?weekly|fortnight(ly)?)\b/i.test(t)) return 'biweekly';
  if (/\b(weekly|(a|per|each|every)\s+week)\b/i.test(t)) return 'weekly';
  if (/\b(monthly|(a|per|each|every)\s+month)\b/i.test(t)) return 'monthly';
  if (/\b(yearly|annually|(a|per|each|every)\s+year)\b/i.test(t)) return 'yearly';
  if (/\b(one[- ]time|lump[- ]sum|all at once|just once|single deposit)\b/i.test(t)) return 'one_time';
  return null;
}

// Timeline as { years, text, isRange }. A range ("2–3 years", "2 to 3 years") keeps the user's words in
// `text`; `years` is the LOWER bound, the conservative number for risk warnings.
function parseTimeline(t) {
  const N = `(${NUM_WORD})`;
  let m = t.match(new RegExp(`\\b${N}\\s*(?:-|–|—|to|or)\\s*${N}\\s*(?:-|\\s)?\\s*(years?|yrs?|months?)\\b(?!\\s*old)`, 'i'));
  if (m) {
    const a = wordOrNum(m[1]), b = wordOrNum(m[2]);
    if (a && b) {
      const lo = Math.min(a, b);
      return { years: /^m/i.test(m[3]) ? Math.round((lo / 12) * 10) / 10 : lo, text: m[0].trim(), isRange: true };
    }
  }
  const y = parseYears(t);
  if (y == null) return null;
  m = t.match(new RegExp(`\\b(${NUM_WORD})\\s*(?:-|\\s)?\\s*(?:years?|yrs?|months?)\\b|\\b(a|one|two)\\s+decades?\\b`, 'i'));
  return { years: y, text: m ? m[0].trim() : `${y} year${y === 1 ? '' : 's'}`, isRange: false };
}

function parseYears(t) {
  const range = t.match(new RegExp(`\\b(${NUM_WORD})\\s*(?:-|–|—|to|or)\\s*(${NUM_WORD})\\s*(?:-|\\s)?\\s*(years?|yrs?|months?)\\b(?!\\s*old)`, 'i'));
  if (range && wordOrNum(range[1]) && wordOrNum(range[2])) {
    const lo = Math.min(wordOrNum(range[1]), wordOrNum(range[2]));
    return /^m/i.test(range[3]) ? Math.round((lo / 12) * 10) / 10 : lo;
  }
  let m = t.match(new RegExp(`\\b(${NUM_WORD})\\s*(?:-|\\s)?\\s*(?:years?|yrs?)\\b(?!\\s*old)`, 'i'));
  if (m) return wordOrNum(m[1]);
  m = t.match(new RegExp(`\\b(${NUM_WORD})\\s*(?:-|\\s)?\\s*months?\\b`, 'i'));
  if (m && wordOrNum(m[1])) return Math.round((wordOrNum(m[1]) / 12) * 10) / 10;
  if (/\b(a|one)\s+decade\b/i.test(t)) return 10;
  if (/\btwo\s+decades\b/i.test(t)) return 20;
  if (/\b(in|within|for|over)\s+(a|one)\s+year\b/i.test(t)) return 1;
  return null;
}

function parseExperience(t) {
  if (/\b(beginner|new to (investing|this|stocks)|never invested|know nothing|don'?t know (much|anything)|novice|first[- ]time investor)\b/i.test(t)) return 'beginner';
  if (/\b(some experience|a (bit|little) of experience|intermediate|invested a (bit|little))\b/i.test(t)) return 'some';
  if (/\b(experienced|advanced|been investing for|seasoned)\b/i.test(t)) return 'experienced';
  return null;
}

function parseRisk(t) {
  if (/\b(low[- ]risk|risk[- ]averse|can'?t afford to lose|not comfortable with (risk|losses?)|play it safe|conservative|avoid risk|low comfort)\b/i.test(t)) return 'low';
  if (/\b(medium[- ]risk|moderate|some risk|balanced|medium comfort)\b/i.test(t)) return 'medium';
  if (/\b(high[- ]risk|aggressive|comfortable with (risk|losses|volatility)|risk[- ]tolerant|high comfort)\b/i.test(t)) return 'high';
  return null;
}

const PURPOSES = [
  [/\b(down ?payment|first home|(buy|buying|save for|saving for|purchase)\s+(a|my|our)?\s*(home|house|condo|place)|(home|house) (purchase|goal))\b/i, 'buy a home'],
  [/\bretire(ment)?\b/i, 'retirement'],
  [/\b(tuition|university|college|school|education)\b/i, 'education'],
  [/\bemergency (fund|savings)\b/i, 'emergency fund'],
  [/\bwedding\b/i, 'wedding'],
  [/\b(buy|buying|save for|saving for)\s+(a|my)?\s*car\b/i, 'buy a car'],
  [/\b(travel|trip|vacation)\b/i, 'travel'],
  [/\b(passive income|dividend income)\b/i, 'income'],
  [/\b(build(ing)? (long[- ]term )?wealth|grow (my )?(money|wealth|savings)|long[- ]term growth)\b/i, 'build long-term wealth'],
];
const parsePurpose = (t) => { for (const [re, label] of PURPOSES) if (re.test(t)) return label; return null; };

// ---------- tickers ----------
const NAME_ALIASES = {
  AAPL: ['apple'], MSFT: ['microsoft'], GOOGL: ['alphabet', 'google'], AMZN: ['amazon'], NVDA: ['nvidia'],
  JNJ: ['johnson & johnson', 'johnson and johnson'], PG: ['procter & gamble', 'procter and gamble'], KO: ['coca-cola', 'coca cola', 'coke'],
  PEP: ['pepsico', 'pepsi'], JPM: ['jpmorgan', 'jp morgan'], V: ['visa'], WMT: ['walmart'], COST: ['costco'], UNH: ['unitedhealth', 'united health'],
  HD: ['home depot'], MRK: ['merck'], ABBV: ['abbvie'], MCD: ["mcdonald's", 'mcdonalds'], ETSY: ['etsy'], PINS: ['pinterest'], ROKU: ['roku'],
  DKNG: ['draftkings'], FIVE: ['five below'], PLUG: ['plug power'], OPEN: ['opendoor'], CLOV: ['clover health'], RIOT: ['riot platforms'],
  O: ['realty income'], PLD: ['prologis'], AMT: ['american tower'], 'BTC/USD': ['bitcoin'], 'ETH/USD': ['ethereum'], 'SOL/USD': ['solana'],
};
// Symbols that are also ordinary words: only matched in CAPITALS or with a "$" (single letters need "$").
const WORDY = new Set(['O', 'V', 'PG', 'HD', 'KO', 'SHY', 'PINS', 'PLUG', 'RIOT', 'OPEN', 'FIVE', 'COST', 'DIA', 'AMT', 'SOL', 'ETH', 'BTC']);
const NOT_TICKERS = new Set(['I', 'A', 'US', 'USA', 'ETF', 'ETFS', 'USD', 'CAD', 'TFSA', 'RRSP', 'RESP', 'FHSA', 'IRA', 'ROTH', 'AI', 'CEO', 'IPO', 'GDP', 'FED', 'SEC', 'EPS', 'NYSE', 'MER', 'REIT', 'REITS', 'OK', 'TV', 'UK', 'EU', 'IT', 'PE', 'S&P', 'ASAP', 'FAQ', 'LOL', 'IMO']);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ASSETS = UNIVERSE.map((u) => {
  const base = u.ticker.split('/')[0];
  const patterns = [];
  if (base.length === 1) patterns.push(new RegExp(`\\$${esc(base)}\\b`));
  else if (WORDY.has(base)) patterns.push(new RegExp(`(?:\\$|\\b)${esc(base)}\\b`));
  else patterns.push(new RegExp(`(?:\\$|\\b)${esc(base)}\\b`, 'i'));
  for (const a of NAME_ALIASES[u.ticker] || []) patterns.push(new RegExp(`\\b${esc(a)}(?![\\w])`, 'i'));
  return { symbol: u.ticker, base, name: u.companyName, category: u.category, patterns };
});
const bySymbol = new Map(ASSETS.flatMap((a) => [[a.symbol, a], [a.base, a]]));

function detectTickers(text, { capsTokens = false } = {}) {
  const found = [];
  for (const a of ASSETS) {
    let first = Infinity;
    for (const re of a.patterns) { const m = text.match(re); if (m && m.index < first) first = m.index; }
    if (first < Infinity) found.push({ index: first, symbol: a.symbol, name: a.name, supported: true });
  }
  const unknown = [...text.matchAll(/\$([A-Za-z]{1,5})\b/g)].map((m) => ({ index: m.index, sym: m[1].toUpperCase() }));
  if (capsTokens) for (const m of text.matchAll(/\b([A-Z]{2,5})\b/g)) unknown.push({ index: m.index, sym: m[1] });
  for (const u of unknown) {
    if (NOT_TICKERS.has(u.sym) || bySymbol.has(u.sym) || found.some((f) => f.symbol === u.sym)) continue;
    found.push({ index: u.index, symbol: u.sym, name: null, supported: false });
  }
  return found.sort((x, y) => x.index - y.index).map(({ index, ...t }) => t);
}

// Symbols or names the LLM returned -> [{ symbol, name, supported }]
function resolveTickers(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list.slice(0, 10) : []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const up = raw.trim().replace(/^\$/, '').toUpperCase();
    const hit = bySymbol.get(up);
    if (hit) { out.push({ symbol: hit.symbol, name: hit.name, supported: true }); continue; }
    const byName = detectTickers(raw).filter((t) => t.supported);
    if (byName.length) { out.push(byName[0]); continue; }
    if (/^[A-Z.]{1,6}$/.test(up) && !NOT_TICKERS.has(up)) out.push({ symbol: up, name: null, supported: false });
  }
  return out;
}

const MONITOR_RE = /\b(track|tracking|monitor|monitoring|watch|watching|follow|following|keep an eye|alerts?|notify|notifications?|updates? (on|about))\b/i;

function analyzeMessage(text) {
  const money = findMoney(text);
  // Blank out loan/salary/price amounts (plus a few words after) so "a $50k a year salary" is not read as a cadence.
  let cleaned = text;
  for (const m of money.filter((x) => x.kind !== 'investment')) cleaned = cleaned.slice(0, m.start) + ' '.repeat(Math.min(text.length, m.end + 20) - m.start) + cleaned.slice(Math.min(text.length, m.end + 20));
  const invest = money.find((m) => m.kind === 'investment');
  const facts = {
    amount: invest ? invest.value : null,
    cadence: parseCadence(cleaned),
    timelineYears: parseYears(cleaned),
    currency: (invest && invest.currency) || (/\b(canadian dollars|cad)\b/i.test(text) ? 'CAD' : /\b(us dollars|usd|american dollars)\b/i.test(text) ? 'USD' : null),
    experience: parseExperience(text),
    riskComfort: parseRisk(text),
    purpose: parsePurpose(text),
  };
  return {
    money,
    loans: money.filter((m) => m.kind === 'loan'),
    nonInvestmentValues: money.filter((m) => m.kind !== 'investment').map((m) => m.value),
    tickers: detectTickers(text, { capsTokens: MONITOR_RE.test(text) }),
    timeline: parseTimeline(cleaned),
    facts,
  };
}

// ---------- advice guard + one-message display ----------
const splitSentences = (t) => (String(t).match(/[^.!?]+[.!?]*\s*/g) || []).map((s) => s);
const ADVICE_RE = [
  /\b(i|we)\s+(would\s+)?(strongly\s+)?(recommend|suggest|advise)\s+(that\s+you\s+)?(buy|sell|hold|invest|purchase|putting|buying|selling)/i,
  /\byou\s+(should|must|need to|ought to|have to)\s+(definitely\s+)?(buy|sell|hold|invest in|purchase|short|dump|load up)/i,
  /\b(will|is going to)\s+(definitely|surely|certainly)\s+(go up|rise|grow|double|increase|outperform)/i,
];
const PROMISE_RE = /\b(guarantee[ds]?|risk[- ]free|can'?t lose|sure thing)\b/i;
const NEGATED = /\b(no|not|never|nothing|isn'?t|aren'?t|without|can'?t be)\b/i;

function scrubAdvice(text) {
  let replaced = false;
  const out = [];
  for (const s of splitSentences(text)) {
    const bad = ADVICE_RE.some((re) => re.test(s)) || (PROMISE_RE.test(s) && !NEGATED.test(s));
    if (!bad) { out.push(s); continue; }
    if (!replaced) out.push(SAFE_LINE + ' ');
    replaced = true;
  }
  return { text: out.join('').trim(), scrubbed: replaced };
}

// The follow-up lives ONLY in nextQuestion: strip any copy of it, or any trailing question, from the reply.
function composeDisplay(reply, nextQuestion) {
  let r = String(reply || '').trim();
  if (nextQuestion) {
    const i = r.toLowerCase().indexOf(nextQuestion.text.toLowerCase());
    if (i >= 0) r = (r.slice(0, i) + r.slice(i + nextQuestion.text.length)).trim();
    const sentences = splitSentences(r);
    while (sentences.length && /\?\s*$/.test(sentences[sentences.length - 1])) sentences.pop();
    r = sentences.join('').trim();
  }
  const displayText = [r, nextQuestion ? nextQuestion.text : ''].filter(Boolean).join(' ');
  return { reply: r, displayText };
}

// ---------- LLM path ----------
function buildUserPrompt(text, s) {
  const clean = (t) => String(t).replace(/<<<|>>>/g, '');
  const hist = s.history.slice(-PROMPT_HISTORY).map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${clean(h.content)}`).join('\n');
  const assets = ASSETS.map((a) => `${a.symbol} (${a.name})`).join('; ');
  return [
    `KNOWN PROFILE (from earlier turns, null = unknown): ${JSON.stringify(s.profile)}`,
    `ALREADY ASKED (never ask these again): ${JSON.stringify(s.askedFields)}`,
    `ACTIVE FLOW: ${s.activeFlow || 'none'}`,
    `LAST QUESTION ASKED: ${s.lastQuestionField || 'none'}`,
    `TICKERS ALREADY DISCUSSED: ${JSON.stringify(s.tickers)}`,
    `SUPPORTED ASSETS: ${assets}`,
    '',
    'CONVERSATION SO FAR (untrusted):',
    '<<<',
    hist || '(none, this is the first message)',
    '>>>',
    '',
    'NEW USER MESSAGE (untrusted):',
    '<<<',
    clean(text),
    '>>>',
  ].join('\n');
}

// First complete JSON object in a model reply -> { obj, error }. Tolerates code fences, prose before or
// after the object (even prose containing braces) and trailing commas. Never throws.
function extractJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { obj: null, error: 'empty reply' };
  const t = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const tryParse = (x) => { try { const o = JSON.parse(x); return o && typeof o === 'object' && !Array.isArray(o) ? { o } : { e: 'reply is JSON but not an object' }; } catch (e) { return { e: e.message }; } };
  let r = tryParse(t);
  if (r.o) return { obj: r.o, error: null };
  const start = t.indexOf('{');
  if (start < 0) return { obj: null, error: `no JSON object in the reply (${t.length} chars)` };
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) { end = i; break; }
  }
  if (end < 0) return { obj: null, error: `JSON object never closes; the reply looks cut off (${t.length} chars)` };
  const candidate = t.slice(start, end + 1);
  r = tryParse(candidate);
  if (r.o) return { obj: r.o, error: null };
  const repaired = tryParse(candidate.replace(/,\s*([}\]])/g, '$1')); // trailing commas
  if (repaired.o) return { obj: repaired.o, error: null };
  return { obj: null, error: String(r.e).slice(0, 120) };
}

function parseLLMReply(raw) {
  const o = extractJson(raw).obj;
  if (!o || !INTENTS.includes(o.intent) || typeof o.reply !== 'string' || !o.reply.trim()) return null;
  const nq = o.nextQuestion && typeof o.nextQuestion === 'object' && QUESTION_FIELDS.includes(o.nextQuestion.field)
    ? { field: o.nextQuestion.field, text: typeof o.nextQuestion.text === 'string' ? o.nextQuestion.text.trim().slice(0, 300) : '' }
    : null;
  return {
    intent: o.intent,
    reply: o.reply.trim().slice(0, 1500),
    profileUpdates: o.profileUpdates && typeof o.profileUpdates === 'object' ? o.profileUpdates : {},
    tickers: Array.isArray(o.tickers) ? o.tickers : [],
    ambiguities: (Array.isArray(o.ambiguities) ? o.ambiguities : []).filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim().slice(0, 300)).slice(0, 3),
    nextQuestion: nq,
  };
}

// ---------- fallback path (no key / LLM failure) ----------
const FINANCE_RE = /\b(invest\w*|stocks?|etfs?|funds?|bonds?|markets?|dividends?|risk\w*|interest|tfsa|rrsp|fhsa|index|portfolio|compound\w*|sav(e|ing|ings)|money|crypto\w*|bitcoin|mortgage|shares?|returns?|inflation|budget|retire\w*|fees?|mer|expense ratio|diversif\w*|broker\w*|financ\w*|wealth|debt|loan)\b/i;
const GLOSSARY = [
  [/\betfs?\b[\s\S]*\bstocks?\b|\bstocks?\b[\s\S]*\betfs?\b/i, "A stock is a small ownership slice of one company, so its value depends on that single business. An ETF (exchange-traded fund) is a basket that can hold dozens or thousands of stocks or bonds, and you buy it on an exchange just like a stock. Because an ETF spreads money across many holdings, one company having a bad year usually moves it much less than it moves that company's own stock."],
  [/\bindex funds?\b/i, "An index fund tries to match a market index, such as the S&P 500, by holding the same companies in roughly the same proportions. It doesn't try to pick winners, which keeps fees low; your result follows the overall market, ups and downs included."],
  [/\betfs?\b|exchange[- ]traded/i, 'An ETF (exchange-traded fund) is a fund that holds a basket of investments, like stocks or bonds, and trades on an exchange like a single stock. Many ETFs simply follow an index such as the S&P 500, which gives broad diversification for a low yearly fee.'],
  [/\bbonds?\b/i, 'A bond is a loan you make to a government or company: they pay you interest and return your money on a set date. Bonds usually move less than stocks, but they can still lose value, especially when interest rates rise.'],
  [/\bdiversif/i, "Diversification means spreading your money across many different investments so that one bad result doesn't sink everything. Broad funds such as index ETFs are a common way beginners get diversification in a single purchase."],
  [/\bcompound/i, 'Compound growth means your returns start earning returns of their own. Over long periods this snowball effect can matter as much as the amount you start with, which is why time invested is discussed alongside how much you put in.'],
  [/\btfsa\b/i, 'A TFSA (Tax-Free Savings Account) is a Canadian account where investment growth and withdrawals are tax-free, up to a yearly contribution limit. One detail for US investments: dividends from US companies usually have 15% US tax withheld even inside a TFSA.'],
  [/\bdividends?\b/i, "A dividend is a share of a company's profit paid out to shareholders, often every quarter. Not every company pays one and dividends can be cut, so they're income you can hope for, not a promise."],
  [/\b(fees?|expense ratio|mer)\b/i, 'Funds charge a yearly fee called the expense ratio (MER in Canada), taken as a small percentage of what you hold. Small differences add up over many years, which makes fees one of the few things an investor controls.'],
  [/\binflation\b/i, 'Inflation is the general rise in prices over time, so cash slowly buys less. Investing is one way people try to grow money faster than inflation, though it comes with the risk of losses.'],
  [/\b(risk|volatil\w*)\b/i, 'In investing, risk usually means how much and how quickly a value can swing, including the chance of losing money. Higher-risk investments can grow more over long periods but can also drop sharply, so how long you can leave the money invested matters a lot.'],
  [/\b(stocks?|shares?)\b/i, 'A stock (or share) is a small piece of ownership in a company. If the company grows and earns more, the share price can rise and some companies pay dividends; if it struggles, the price can fall, sometimes a lot.'],
  [/\binvest\w*\b/i, "Investing means putting money into assets such as stocks, bonds or funds in the hope that they grow in value or pay income over time. Unlike a savings account, the value can go down as well as up, so investing usually suits money you won't need for several years."],
];
const GLOSSARY_DEFAULT = "That's a good question. Right now I can explain the basics, such as what investing is, stocks versus ETFs, index funds, bonds, diversification, risk, fees, dividends, compound growth and TFSAs.";

function answerForField(field, text) {
  const t = text.trim();
  if (field === 'timelineYears') { const y = parseYears(t); if (y) return y; const m = t.match(new RegExp(`^(?:about|around|maybe|roughly|in)?\\s*(${NUM_WORD})\\s*[.!]?$`, 'i')); return m ? wordOrNum(m[1]) : null; }
  if (field === 'amount') { const m = t.match(/^(?:about|around|maybe|roughly)?\s*\$?\s*(\d[\d,]*(?:\.\d+)?)\s*[.!]?$/i); return m ? Number(m[1].replace(/,/g, '')) : null; }
  if (field === 'cadence') return parseCadence(t) || (/\bonce\b/i.test(t) ? 'one_time' : null);
  if (field === 'riskComfort') { const m = t.match(/\b(low|medium|moderate|high)\b/i); return parseRisk(t) || (m ? NORMALIZE.riskComfort(m[1]) : null); }
  if (field === 'experience') return parseExperience(t) || NORMALIZE.experience(t.replace(/[.!]/g, ''));
  if (field === 'purpose') return parsePurpose(t) || (t.length <= 80 && !/\?\s*$/.test(t) ? t.replace(/^(it'?s |for |to )/i, '').replace(/[.!]+$/, '') : null);
  if (field === 'currency') { const m = t.match(/\b(cad|usd)\b/i); return m ? m[1].toUpperCase() : null; }
  return null;
}

function fallbackIntent(text, ev, facts, s, answeredLast) {
  if (MONITOR_RE.test(text) && (ev.tickers.length || /\b(stocks?|etfs?|funds?|company|companies|shares)\b/i.test(text))) return 'monitoring';
  if (answeredLast) return s.activeFlow || 'goal_exploration';
  const goalSignal = facts.amount != null || facts.timelineYears != null || facts.purpose != null || facts.cadence != null || ev.money.length > 0;
  if (goalSignal && (/\b(i|i'm|im|i've|my|we|our|me|us)\b/i.test(text) || s.activeFlow === 'goal_exploration')) return 'goal_exploration';
  if (ev.tickers.length) return 'investment_discovery';
  if (/\b(which|what)\s+(stocks|etfs|funds|investments)\b|\b(show|list|explore|browse)\b[\s\S]*\b(stocks?|etfs?|funds?)\b|\b(options|ideas)\b[\s\S]*\binvest/i.test(text)) return 'investment_discovery';
  if (FINANCE_RE.test(text)) return /\?\s*$|^(what|how|why|when|is|are|does|do|can|explain|define|tell me)\b/i.test(text) ? 'learning' : 'unclear';
  return /\?\s*$|^(what|how|why|when|who|where)\b/i.test(text) ? 'off_topic' : 'unclear';
}

function fallbackAnalysis(text, s, ev) {
  const facts = { ...ev.facts };
  let answeredLast = false;
  const pending = [s.lastQuestionField, ...s.askedFields].filter((f, i, a) => f && PROFILE_FIELDS.includes(f) && s.profile[f] == null && a.indexOf(f) === i);
  for (const f of pending) {
    if (facts[f] != null) { answeredLast = true; break; }
    const v = answerForField(f, text);
    if (v != null) { facts[f] = v; answeredLast = true; break; }
  }
  const intent = fallbackIntent(text, ev, facts, s, answeredLast);
  // Only keep the facts that make sense for this intent ("what is a down payment?" is not a home goal).
  const keep = intent === 'goal_exploration' ? PROFILE_FIELDS
    : intent === 'monitoring' || intent === 'investment_discovery' ? ['experience', 'riskComfort']
      : ['experience'];
  const profileUpdates = Object.fromEntries(keep.map((f) => [f, facts[f]]));
  let reply = null; // goal replies are written after the merge (they describe what changed)
  if (intent === 'learning') reply = (GLOSSARY.find(([re]) => re.test(text)) || [null, GLOSSARY_DEFAULT])[1];
  else if (intent === 'off_topic') reply = "I'm set up to help with investing education and research, so I can't help much with that. You can ask me about an investing idea, a goal you're saving for, or a company or fund you're curious about.";
  else if (intent === 'unclear') reply = "I'm not sure I followed. You can ask me to explain an investing idea, tell me about a goal you're saving for, or name a company or fund you'd like to research.";
  return { intent, reply, profileUpdates, tickers: [], ambiguities: [], nextQuestion: null };
}

const CADENCE_TEXT = { one_time: 'one time', weekly: 'weekly', biweekly: 'every two weeks', monthly: 'monthly', yearly: 'yearly' };
const fmtMoney = (v, cur) => `${cur === 'CAD' ? 'C$' : '$'}${Number(v).toLocaleString('en-US')}`;
function fmtField(f, v, p) {
  if (v == null) return 'unknown';
  if (f === 'amount') return fmtMoney(v, p.currency);
  if (f === 'cadence') return CADENCE_TEXT[v] || v;
  if (f === 'timelineYears') return `${v} year${v === 1 ? '' : 's'}`;
  return String(v);
}
const LABEL = { amount: 'amount', cadence: 'how often', timelineYears: 'timeline', currency: 'currency', experience: 'experience', riskComfort: 'risk comfort', purpose: 'goal' };

function describeFacts(fields, values, profile, timelineText) {
  const out = [];
  const has = (f) => fields.includes(f);
  if (has('amount')) out.push(`${fmtMoney(values.amount, profile.currency)}${has('cadence') ? ` ${CADENCE_TEXT[values.cadence]}` : ''}`);
  else if (has('cadence')) out.push(`adding money ${CADENCE_TEXT[values.cadence]}`);
  if (has('purpose')) out.push(`goal: ${values.purpose}`);
  if (has('timelineYears')) out.push(`about ${timelineText || fmtField('timelineYears', values.timelineYears)} away`);
  if (has('experience')) out.push(`${values.experience === 'some' ? 'some' : values.experience} experience level`);
  if (has('riskComfort')) out.push(`${values.riskComfort} comfort with risk`);
  if (has('currency')) out.push(`investing in ${values.currency}`);
  return out.join(', ');
}

function completionSummary(profile, timelineText) {
  const p = profile;
  const bits = [`goal: ${p.purpose}`, `${fmtMoney(p.amount, p.currency)} ${CADENCE_TEXT[p.cadence] || p.cadence}`, `timeline: ${timelineText || fmtField('timelineYears', p.timelineYears)}`, `risk comfort: ${p.riskComfort}`];
  if (p.experience) bits.push(`experience: ${p.experience}`);
  if (p.currency) bits.push(`currency: ${p.currency}`);
  return `Here's your profile so far: ${bits.join(' · ')}. When you're ready, you can choose Explore Investments to browse research candidates, or Create Thesis Draft to turn this into a thesis you can review. Nothing is created or monitored until you choose.`;
}

function fallbackReplyFor(intent, ctx) {
  const { profile, extracted, corrections, tickers, text, loans } = ctx;
  const named = (t) => (t.name ? `${t.name} (${t.symbol})` : t.symbol);
  if (intent === 'goal_exploration') {
    const parts = [];
    if (corrections.length) parts.push(`Updated: ${corrections.map((c) => `${LABEL[c.field]} ${fmtField(c.field, c.from, profile)} → ${fmtField(c.field, c.to, profile)}`).join(', ')}.`);
    const fresh = Object.keys(extracted).filter((f) => !corrections.some((c) => c.field === f));
    if (fresh.length) parts.push(`${corrections.length ? 'Also noted' : 'Got it'}: ${describeFacts(fresh, extracted, profile, ctx.timelineText)}.`);
    if (!parts.length) parts.push('Thanks, that helps me understand your goal.');
    if (/\bhow much (should|do|would|could) i\b|\bwhat should i (buy|invest)/i.test(text)) parts.push('How much to invest is your decision; I can help you see what to weigh, such as your timeline and how you feel about ups and downs.');
    return parts.join(' ');
  }
  if (intent === 'monitoring' || intent === 'investment_discovery') {
    const sup = tickers.filter((t) => t.supported);
    const uns = tickers.filter((t) => !t.supported);
    const parts = [];
    if (sup.length) parts.push(`I can help you research ${sup.map(named).join(' and ')}, as education rather than advice.`);
    if (uns.length) parts.push(`${uns.map((t) => t.symbol).join(', ')} ${uns.length > 1 ? "aren't" : "isn't"} in the set of about 60 US stocks and ETFs THESIS covers right now.`);
    if (!tickers.length) parts.push(intent === 'monitoring' ? 'Sure, I can help you research a company or fund.' : 'THESIS covers about 60 US-listed stocks and ETFs, from broad index and bond funds to individual companies, which you can explore as research candidates.');
    return parts.join(' ');
  }
  return 'Thanks.';
}

// ---------- shared finalization ----------
function normalizeSession(s) {
  const base = createOnboardingSession();
  if (!s || typeof s !== 'object') return base;
  const profile = emptyProfile();
  for (const f of PROFILE_FIELDS) profile[f] = s.profile ? NORMALIZE[f](s.profile[f]) : null;
  return {
    history: (Array.isArray(s.history) ? s.history : []).filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string').slice(-MAX_HISTORY),
    profile,
    askedFields: (Array.isArray(s.askedFields) ? s.askedFields : []).filter((x) => typeof x === 'string'),
    activeFlow: FLOW_INTENTS.includes(s.activeFlow) ? s.activeFlow : null,
    tickers: (Array.isArray(s.tickers) ? s.tickers : []).filter((x) => typeof x === 'string'),
    lastQuestionField: typeof s.lastQuestionField === 'string' ? s.lastQuestionField : null,
    profileDetails: { timelineText: s.profileDetails && typeof s.profileDetails.timelineText === 'string' ? s.profileDetails.timelineText.slice(0, 60) : null },
    selection: {
      pending: cleanSymbols(s.selection && s.selection.pending),
      confirmed: cleanSymbols(s.selection && s.selection.confirmed),
    },
    thesisDraft: normalizeThesisDraft(s.thesisDraft),
  };
}
// The draft under review: { draft, status: 'proposed'|'confirmed', confirmedAt, revision }.
function normalizeThesisDraft(td) {
  if (!td || typeof td !== 'object' || !td.draft || typeof td.draft !== 'object' || !Array.isArray(td.draft.assumptionDetails)) return null;
  const status = td.status === 'confirmed' ? 'confirmed' : 'proposed';
  return { draft: td.draft, status, confirmedAt: status === 'confirmed' && typeof td.confirmedAt === 'string' ? td.confirmedAt : null, revision: Number.isInteger(td.revision) ? td.revision : 1 };
}
// Only symbols from scripts/universe.js survive, deduped, max 5.
function cleanSymbols(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && bySymbol.has(x)).map((x) => bySymbol.get(x).symbol))].slice(0, 5);
}

function missingFor(flow, profile, tickers) {
  if (!flow) return [];
  return REQUIRED[flow].filter((f) => (f === 'ticker' ? !tickers.some((t) => bySymbol.has(t)) : profile[f] == null));
}

// A question may be asked at most twice (the second time only after the user moved on without answering);
// never-asked fields come first; a clarification is asked once.
const MAX_ASKS = 2;
const REASK_PREFIX = 'Coming back to an earlier question: ';
const timesAsked = (asked, key) => asked.filter((k) => k === key).length;
function chooseQuestion({ proposed, intent, flow, missing, profile, tickers, asked, ambiguities }) {
  const fresh = (key) => !asked.includes(key);
  const askable = (key) => timesAsked(asked, key) < MAX_ASKS;
  const phrase = (key, text) => (fresh(key) ? text : REASK_PREFIX + text.charAt(0).toLowerCase() + text.slice(1));
  if (ambiguities.length) {
    const key = `clarification:${ambiguities[0].toLowerCase().replace(/[^a-z0-9$]+/g, ' ').trim().slice(0, 60)}`;
    if (fresh(key)) {
      const text = proposed && proposed.field === 'clarification' && proposed.text ? proposed.text : `Just to check: ${ambiguities[0].replace(/[.?]*$/, '')}. Which one do you mean?`;
      return { field: 'clarification', text, key };
    }
  }
  const onTopic = FLOW_INTENTS.includes(intent);
  if (!onTopic && !flow) return null; // pure learning / off-topic: don't push onboarding questions
  if (proposed && proposed.field !== 'clarification' && (!flow || RELEVANT[flow].includes(proposed.field))) {
    const f = proposed.field;
    const known = f === 'ticker' ? tickers.some((t) => bySymbol.has(t)) : profile[f] != null;
    if (!known && askable(f)) return { field: f, text: phrase(f, proposed.text || QUESTIONS[f]), key: f };
  }
  if (!onTopic) return null; // a side question mid-flow: answer it, don't add a new onboarding question
  const f = missing.find(fresh) || missing.find(askable);
  return f ? { field: f, text: phrase(f, QUESTIONS[f]), key: f } : null;
}

function finalize(text, s, parsed, ev, source, fallbackReason, model) {
  const intent = parsed.intent;
  const activeFlow = FLOW_INTENTS.includes(intent) ? intent : s.activeFlow;

  // Merge: a value the user states this turn replaces the old one (a correction); nulls never erase.
  const profile = { ...s.profile };
  const extracted = {};
  const corrections = [];
  for (const f of PROFILE_FIELDS) {
    const v = NORMALIZE[f]((parsed.profileUpdates || {})[f]);
    if (v == null) continue;
    if ((f === 'amount' || f === 'timelineYears') && !hasNumber(text)) continue; // anti-guessing: no number, no number field
    if (f === 'amount' && ev.nonInvestmentValues.includes(v)) continue; // a mortgage/salary/price is not an investment amount
    if (profile[f] === v) continue;
    if (profile[f] != null) corrections.push({ field: f, from: profile[f], to: v });
    profile[f] = v;
    extracted[f] = v;
  }

  // A stated range ("2–3 years") is stored as its lower bound plus the user's own words.
  const tl = ev.timeline;
  if (tl && tl.isRange && (activeFlow === 'goal_exploration' || 'timelineYears' in extracted)) {
    const before = s.profile.timelineYears;
    const ci = corrections.findIndex((x) => x.field === 'timelineYears');
    if (ci >= 0) corrections.splice(ci, 1);
    profile.timelineYears = tl.years;
    if (before !== tl.years) { extracted.timelineYears = tl.years; if (before != null) corrections.push({ field: 'timelineYears', from: before, to: tl.years }); }
    else delete extracted.timelineYears;
  }
  let timelineText = s.profileDetails.timelineText;
  if ('timelineYears' in extracted) timelineText = tl && tl.years === extracted.timelineYears ? tl.text : `${extracted.timelineYears} year${extracted.timelineYears === 1 ? '' : 's'}`;

  const ambiguities = [...parsed.ambiguities];
  if (ev.loans.length && !ambiguities.some((a) => /mortgage|loan|debt/i.test(a))) {
    ambiguities.push(`the ${ev.loans[0].raw} ${ev.loans[0].loanWord} could be a loan you plan to take, a loan you already have, or the price of the home you want`);
  }

  const seen = new Set();
  const tickers = [...resolveTickers(parsed.tickers), ...ev.tickers].filter((t) => !seen.has(t.symbol) && seen.add(t.symbol));
  const sessionTickers = [...new Set([...s.tickers, ...tickers.filter((t) => t.supported).map((t) => t.symbol)])];

  const missing = missingFor(activeFlow, profile, sessionTickers);
  const wasComplete = s.activeFlow === 'goal_exploration' && missingFor('goal_exploration', s.profile, s.tickers).length === 0;
  const goalComplete = activeFlow === 'goal_exploration' && missing.length === 0 && !ambiguities.length;
  // Show the summary when the profile becomes complete, or when a complete profile is corrected.
  const profileJustCompleted = goalComplete && (!wasComplete || corrections.length > 0);
  let nq = chooseQuestion({ proposed: parsed.nextQuestion, intent, flow: activeFlow, missing, profile, tickers: sessionTickers, asked: s.askedFields, ambiguities });
  if (nq && nq.field === 'clarification' && !nq.text.trim().endsWith('?')) nq.text = nq.text.trim() + '?';
  if (profileJustCompleted && nq && nq.field !== 'clarification') nq = null; // offer next steps instead of more questions

  let reply = parsed.reply != null ? parsed.reply : fallbackReplyFor(intent, { profile, extracted, corrections, tickers, text, loans: ev.loans, timelineText });
  reply = scrubAdvice(reply).text;
  reply = dropTrackingClaims(reply);
  if (intent === 'monitoring' && tickers.some((t) => t.supported) && !MONITOR_STATED.test(reply)) reply = `${reply.trim()} ${MONITOR_LINE}`;
  if (profileJustCompleted) reply = `${reply.trim()} ${completionSummary(profile, timelineText)}`;
  const nextQuestion = nq ? { field: nq.field, text: nq.text } : null;
  const shown = composeDisplay(reply, nextQuestion);

  const pendingClarification = Boolean(nextQuestion && nextQuestion.field === 'clarification');
  const readyToProceed = missing.length === 0 && !pendingClarification;
  const session = {
    history: [...s.history, { role: 'user', content: text }, { role: 'assistant', content: shown.displayText }].slice(-MAX_HISTORY),
    profile,
    askedFields: nq ? [...s.askedFields, nq.key] : s.askedFields,
    activeFlow,
    tickers: sessionTickers,
    lastQuestionField: nextQuestion ? nextQuestion.field : null,
    profileDetails: { timelineText },
    selection: s.selection,
  };
  return {
    intent,
    reply: shown.reply,
    displayText: shown.displayText,
    nextQuestion,
    profile,
    profileDetails: { timelineText },
    extractedThisTurn: extracted,
    corrections,
    tickers,
    ambiguities,
    activeFlow: activeFlow || null,
    missingFields: missing,
    readyToProceed,
    suggestedNextStep: readyToProceed && activeFlow ? NEXT_STEP[activeFlow] : 'none',
    nextSteps: readyToProceed && activeFlow ? NEXT_STEPS[activeFlow].map((x) => ({ ...x })) : [],
    profileJustCompleted,
    monitoringActivated: false, // never: monitoring is an explicit opt-in feature that does not exist yet
    source,
    model: model || null,
    fallbackReason,
    session,
  };
}

// ============================================================================================
// EXPLORATION, EXPLICIT SELECTION, THESIS DRAFT (Vamsi)
//
//   exploreInvestments(session, opts)  -> categories explained against the profile + every selectable ticker
//   selectAssets(input, session)       -> parse 1-5 tickers the USER typed (universe only); pending, not confirmed
//   confirmSelection(session)          -> explicit second step: pending -> confirmed
//   createThesisDraft(session, opts)   -> personalized draft (superset of Contract C); never saved/monitored/traded
//
// All pure: they take the onboarding session and return an updated one. Gemini writes only the prose
// (intro, goal sentence, assumptions, extra risks); everything numeric, the selection and the risk notes
// are deterministic. `tier` is an internal compatibility field for Contract C, never a suitability rating.
// ============================================================================================
const crypto = require('crypto');
const { TIERS } = require('./scoring');

const MAX_SELECTION = 5;
const DRAFT_REQUIRED = ['purpose', 'amount', 'cadence', 'timelineYears'];
const VOL_RANK = { lower: 1, medium: 2, higher: 3, 'very high': 4 };
// Hand-written so it is accurate, free and works offline. Fixed teaching order (broad -> narrow -> speculative); not a ranking.
const CATEGORY_INFO = [
  { id: 'index_etf', name: 'Broad-market ETFs', volatility: 'medium', risk: 'Market risk',
    plain: 'One fund that holds hundreds or thousands of companies, often by following an index like the S&P 500. You get a slice of the whole market in a single purchase, usually for a low yearly fee.',
    behaves: 'It moves with the overall stock market. Over long periods markets have grown, but they have also fallen 20-50% in bad stretches, sometimes staying down for several years.' },
  { id: 'bond_etf', name: 'Bond ETFs', volatility: 'lower', risk: 'Interest-rate risk',
    plain: 'Funds that hold many bonds, which are loans to governments or companies that pay interest.',
    behaves: 'They usually swing less than stock funds, but they can still lose value, especially when interest rates rise quickly, as they did in 2022.' },
  { id: 'dividend_etf', name: 'Dividend ETFs', volatility: 'medium', risk: 'Dividend and market risk',
    plain: 'Funds that focus on companies paying regular dividends (a share of their profits).',
    behaves: 'They are still stock funds, so they rise and fall with the market, and dividends can be cut. US dividends usually have 15% US tax withheld, even inside a TFSA.' },
  { id: 'large_cap', name: 'Individual large-company stocks', volatility: 'higher', risk: 'Single-company risk',
    plain: 'A share of one big, established company.',
    behaves: 'Your result depends on a single business, so one bad earnings report, lawsuit or product miss can move the price far more than a broad fund.' },
  { id: 'sector_etf', name: 'Sector ETFs', volatility: 'higher', risk: 'Sector concentration',
    plain: 'Funds that hold companies from one industry, such as technology, energy or health care.',
    behaves: 'More concentrated than a broad-market fund: when that one industry has a bad stretch, the whole fund tends to fall together.' },
  { id: 'reit', name: 'REITs (real estate companies)', volatility: 'higher', risk: 'Interest-rate and property risk',
    plain: 'Companies that own and rent out real estate, such as warehouses, cell towers or shops, and pay out most of their income as dividends.',
    behaves: 'They are sensitive to interest rates and property markets, and their prices can fall when rates rise.' },
  { id: 'mid_cap', name: 'Mid-size company stocks', volatility: 'higher', risk: 'Single-company risk',
    plain: 'Shares of individual companies that are smaller than the giants but already established.',
    behaves: 'Single-company risk plus bigger swings than large companies, in both directions.' },
  { id: 'thematic_etf', name: 'Thematic ETFs', volatility: 'higher', risk: 'Theme risk',
    plain: 'Funds built around a trend, such as clean energy, robotics or semiconductors.',
    behaves: 'They can rise fast while a theme is popular and fall hard when interest fades; some have dropped more than 50% from their peaks.' },
  { id: 'small_cap', name: 'Small-company stocks', volatility: 'very high', risk: 'Small-company risk',
    plain: 'Shares of small, often younger companies.',
    behaves: 'They can move very sharply, including large and lasting losses, and some small companies fail entirely.' },
  { id: 'crypto', name: 'Crypto', volatility: 'very high', risk: 'Crypto volatility',
    plain: 'Digital assets such as Bitcoin. They are not companies and have no earnings or dividends.',
    behaves: 'Prices can rise or fall by large amounts within days, and drops of 50% or more have happened several times.' },
];
const CATEGORY_BY_ID = Object.fromEntries(CATEGORY_INFO.map((c) => [c.id, c]));
// Educational context only: not part of scripts/universe.js, so never selectable.
const CASH_LIKE = { id: 'cash_like', name: 'Savings accounts and GICs (context only, not selectable)', volatility: 'lower', selectable: false,
  plain: "High-interest savings accounts and GICs aren't market investments and aren't in THESIS's research universe, but people often compare them with investing when money is needed within a few years.",
  behaves: "They don't swing like markets. A GIC locks money for a set term at a fixed rate, and both can trail inflation." };

const SAFE_CLAIM = /\b(is|are|be|remains?|stays?)\s+(a\s+|an\s+)?(very\s+|completely\s+|totally\s+|relatively\s+|fairly\s+)?(safe|safer|safest|risk[- ]free|secure)\b|\bsafe (investment|bet|choice|option|haven|pick)s?\b|\b(can'?t|cannot|won'?t) lose\b/i;
const dropSafeClaims = (t) => splitSentences(t).filter((x) => !(SAFE_CLAIM.test(x) && !NEGATED.test(x))).join('').trim();
function cleanLLMText(t, max) {
  if (typeof t !== 'string' || !t.trim()) return null;
  const out = dropSafeClaims(dropTrackingClaims(scrubAdvice(t.trim().replace(/\s+/g, ' ')).text));
  return out ? out.slice(0, max) : null;
}
const assetInfo = (sym) => { const a = bySymbol.get(sym); return { symbol: a.symbol, name: a.name, category: a.category }; };
const timelineOf = (p, text) => text || (p.timelineYears != null ? fmtField('timelineYears', p.timelineYears) : null);

function horizonNoteFor(p, text) {
  const t = timelineOf(p, text);
  if (p.timelineYears == null) return "You haven't said when you'll need this money. The shorter that is, the more these price swings matter.";
  if (p.timelineYears < 3) return `You mentioned ${t}. Over a period that short, stock and ETF prices can drop and stay down for longer than that. None of the stocks or ETFs here are safe from losses, and that matters more the sooner you need the money.`;
  if (p.timelineYears < 5) return `With ${t}, a market downturn could still be underway when you need the money; broad stock markets have taken several years to recover from past drops.`;
  return null;
}

function fitNoteFor(cat, p, text) {
  const notes = [];
  const r = VOL_RANK[cat.volatility];
  const t = timelineOf(p, text);
  if (p.timelineYears != null && p.timelineYears < 3 && r >= 2) notes.push(`Over ${t}, this can fall and may not recover before you need the money.`);
  else if (p.timelineYears != null && p.timelineYears < 3) notes.push(`Over ${t}, swings are usually smaller than stocks, but losses are still possible.`);
  else if (p.timelineYears != null && p.timelineYears < 5 && r >= 3) notes.push(`${t[0].toUpperCase() + t.slice(1)} is short for something this volatile; past losses have taken years to recover.`);
  if (p.riskComfort === 'low' && r >= 3) notes.push('Its swings are typically larger than the low comfort with risk you described.');
  if (p.experience === 'beginner' && r === 4) notes.push('This is usually considered a speculative, advanced area.');
  return notes.join(' ') || null;
}

// ---------- shared Gemini call for the JSON prompts below ----------
const parseJsonObject = (raw) => extractJson(raw).obj;

async function askGemini(name, user, opts = {}) {
  const call = opts.callLLM || llm.callLLM;
  const configured = opts.callLLM ? true : llm.isConfigured();
  const system = loadPrompt(name);
  let reason = null;
  if (opts.forceFallback) reason = 'offline mode requested';
  else if (!system) reason = `${name} prompt missing from prompts/thesis.md`;
  else if (!configured) reason = 'GEMINI_API_KEY not set';
  if (reason) return { json: null, model: null, reason, attempts: [] };
  try {
    const out = await callJsonWithModelFallback(call, system, user, { json: true, temperature: opts.temperature ?? 0.3, timeoutMs: 45000 }, parseJsonObject);
    if (!out.value) {
      reason = `Gemini reply was not valid JSON [${out.attempts.join('; ')}]`;
      console.warn(`[${name}] using fallback: ${reason}`);
    }
    return { json: out.value, model: out.model, reason, attempts: out.attempts };
  } catch (err) {
    const tried = err.attempts && err.attempts.length > 1 ? `both models failed [${err.attempts.join('; ')}]` : `Gemini call failed (${err.code || 'ERROR'})`;
    reason = `${tried}: ${String(err.message).replace(/\s+/g, ' ').slice(0, 160)}`;
    console.warn(`[${name}] using fallback: ${reason}`);
    return { json: null, model: null, reason, attempts: err.attempts || [] };
  }
}

const fence = (o) => `<<<\n${JSON.stringify(o, null, 1).replace(/<<<|>>>/g, '')}\n>>>`;

// ---------- 1. exploration ----------
async function exploreInvestments(session, opts = {}) {
  const s = normalizeSession(session);
  const p = s.profile;
  const tt = s.profileDetails.timelineText;
  const categories = CATEGORY_INFO.map((c) => ({
    id: c.id, name: c.name, volatility: c.volatility, selectable: true,
    plainExplanation: c.plain, howItBehaves: c.behaves, fitNote: fitNoteFor(c, p, tt),
    assets: UNIVERSE.filter((u) => u.category === c.id).map((u) => ({ symbol: u.ticker, name: u.companyName })),
  })).filter((c) => c.assets.length);
  if (p.timelineYears != null && p.timelineYears < 5) {
    categories.push({ id: CASH_LIKE.id, name: CASH_LIKE.name, volatility: CASH_LIKE.volatility, selectable: false, plainExplanation: CASH_LIKE.plain, howItBehaves: CASH_LIKE.behaves, fitNote: null, assets: [] });
  }
  const horizonNote = horizonNoteFor(p, tt);
  const g = await askGemini('exploration', [
    'PROFILE (untrusted user data):', fence({ ...p, timelineAsStated: tt }),
    `CATEGORIES SHOWN: ${categories.map((c) => `${c.name} (volatility: ${c.volatility})`).join('; ')}`,
  ].join('\n'), opts);
  let intro = g.json ? cleanLLMText(g.json.intro, 700) : null;
  const usedGemini = Boolean(intro);
  if (!intro) {
    const facts = [p.purpose && `your goal (${p.purpose})`, p.amount != null && `${fmtMoney(p.amount, p.currency)}${p.cadence ? ` ${CADENCE_TEXT[p.cadence]}` : ''}`, timelineOf(p, tt) && `a timeline of ${timelineOf(p, tt)}`].filter(Boolean);
    intro = `${facts.length ? `With ${facts.join(', ')} in mind, here` : 'Here'} are the main kinds of investments THESIS can research, from broad funds to narrower and more speculative ones. Each one explains how it tends to behave so you can decide what you'd like to look into.`;
  }
  const displayText = [intro, horizonNote, `Pick 1-${MAX_SELECTION} tickers from the lists to research. Nothing is selected until you choose.`].filter(Boolean).join(' ');
  return {
    intro, horizonNote, categories,
    selectableCount: categories.reduce((n, c) => n + c.assets.length, 0),
    displayText, monitoringActivated: false,
    source: usedGemini ? 'gemini' : 'fallback', model: usedGemini ? g.model : null,
    fallbackReason: usedGemini ? null : g.reason || 'Gemini intro failed validation',
    session: s,
  };
}

// ---------- 2. explicit selection (no LLM) ----------
const SELECT_FILLER = /^(?:(?:i(?:'d| would)?|let'?s|please|can you|can i)\s+)?(?:(?:like|want|love)\s+to\s+)?(?:select|pick|choose|research|add|use|go with|look at|explore|try)?\s*/i;
const SELECT_STOP = new Set([...NOT_TICKERS, 'AND', 'OR', 'THE', 'ALSO', 'MAYBE', 'PLEASE', 'THESE', 'THOSE', 'BOTH']);

function parseSelectionInput(input) {
  const items = Array.isArray(input) ? input.map((x) => String(x)) : String(input || '').split(/[,;\n+&]|\band\b|\bplus\b/i);
  const out = [];
  for (const raw of items) {
    const item = raw.replace(SELECT_FILLER, '').replace(/[.!?]+$/, '').trim();
    if (!item) continue;
    const hit = bySymbol.get(item.replace(/^\$/, '').toUpperCase());
    if (hit) { out.push({ input: item, symbol: hit.symbol, supported: true }); continue; }
    const named = detectTickers(item).filter((t) => t.supported);
    const words = item.split(/\s+/);
    if (words.length === 1 && !named.length) {
      const up = item.replace(/^\$/, '').toUpperCase();
      if (/^[A-Z.\/]{1,9}$/.test(up) && !SELECT_STOP.has(up)) out.push({ input: item, symbol: up, supported: false });
      else out.push({ input: item, symbol: null, supported: false });
      continue;
    }
    // Several words ("VOO QQQ SPY bitcoin"): supported symbols/names, plus CAPITALISED or $-prefixed unknown symbols.
    let any = named.length > 0;
    for (const t of named) out.push({ input: item, symbol: t.symbol, supported: true });
    for (const w of words) {
      const bare = w.replace(/^\$/, '').replace(/[^A-Za-z.\/]/g, '');
      const h = bySymbol.get(bare.toUpperCase());
      if (h) { if (!named.some((t) => t.symbol === h.symbol)) { out.push({ input: w, symbol: h.symbol, supported: true }); any = true; } continue; }
      if ((/^\$[A-Za-z]{1,5}$/.test(w) || /^[A-Z]{2,5}$/.test(bare)) && bare.length && !SELECT_STOP.has(bare.toUpperCase()) && !named.some((t) => new RegExp(`\\b${bare}\\b`, 'i').test(t.name))) {
        out.push({ input: w, symbol: bare.toUpperCase(), supported: false }); any = true;
      }
    }
    if (!any) out.push({ input: item, symbol: null, supported: false });
  }
  return out;
}

const listAssets = (xs) => xs.map((a) => `${a.symbol} (${a.name})`).join(', ');

function selectAssets(input, session) {
  const s = normalizeSession(session);
  const selected = [];
  const duplicates = [];
  const overLimit = [];
  const unsupported = [];
  const unmatched = [];
  for (const x of parseSelectionInput(input)) {
    if (x.supported) {
      if (selected.some((a) => a.symbol === x.symbol) || overLimit.includes(x.symbol)) { if (!duplicates.includes(x.symbol)) duplicates.push(x.symbol); continue; }
      if (selected.length >= MAX_SELECTION) { overLimit.push(x.symbol); continue; }
      selected.push(assetInfo(x.symbol));
    } else if (x.symbol) { if (!unsupported.includes(x.symbol)) unsupported.push(x.symbol); }
    else unmatched.push(x.input);
  }
  const parts = [];
  if (selected.length) parts.push(`Selected for research: ${listAssets(selected)}.`);
  if (unsupported.length) parts.push(`Not supported: ${unsupported.join(', ')} ${unsupported.length > 1 ? "aren't" : "isn't"} among the ~${ASSETS.length} US stocks and ETFs THESIS covers, so ${unsupported.length > 1 ? 'they' : 'it'} can't be selected.`);
  if (overLimit.length) parts.push(`You can research up to ${MAX_SELECTION} at a time, so ${overLimit.join(', ')} ${overLimit.length > 1 ? 'were' : 'was'} left out. Choose again if you'd prefer a different ${MAX_SELECTION}.`);
  if (unmatched.length) parts.push(`I couldn't match ${unmatched.map((u) => `"${u}"`).join(', ')} to a supported ticker.`);
  if (selected.length) parts.push(`Confirm ${selected.length === 1 ? 'this one' : `these ${selected.length}`}? (yes / change)`);
  else parts.push(`Nothing was selected. Type 1-${MAX_SELECTION} supported tickers or company names, for example "VOO, NVIDIA".`);
  // A new valid choice replaces the pending one and clears any earlier confirmation; an empty one changes nothing.
  const next = selected.length ? { ...s, selection: { pending: selected.map((a) => a.symbol), confirmed: [] } } : s;
  return { ok: selected.length > 0, selected, unsupported, unmatched, overLimit, duplicates, needsConfirmation: selected.length > 0, confirmed: false, displayText: parts.join(' '), session: next };
}

function confirmSelection(session) {
  const s = normalizeSession(session);
  if (!s.selection.pending.length) {
    return { ok: false, reason: 'nothing_pending', confirmed: s.selection.confirmed.map(assetInfo), displayText: `There's nothing new to confirm. Type 1-${MAX_SELECTION} supported tickers first.`, session: s };
  }
  const confirmed = [...s.selection.pending];
  return {
    ok: true, confirmed: confirmed.map(assetInfo),
    displayText: `Confirmed for research: ${listAssets(confirmed.map(assetInfo))}. This only chooses what your draft is about; nothing is bought, saved or monitored.`,
    session: { ...s, selection: { pending: [], confirmed } },
  };
}

// ---------- 3. thesis draft ----------
// Internal compatibility value for Contract C (`tier` must be low|medium|high). Not a suitability rating.
function internalTier(p) {
  const y = p.timelineYears;
  if (p.riskComfort == null || p.riskComfort === 'low' || (y != null && y < 3)) return 'low';
  if (p.riskComfort === 'high' && y >= 5) return 'high';
  return 'medium';
}

const shortName = (a) => (a.category === 'sector_etf' ? a.name.replace(/\s*Select Sector SPDR Fund$/i, '') : a.category === 'thematic_etf' ? a.name.replace(/^(iShares|Global X|ARK)\s+/i, '').replace(/\s+ETF$/i, '') : a.name);
// One asset-specific, monitorable assumption per asset (used only when Gemini gives fewer than 2 valid ones).
function templateAssumption(a, horizonText) {
  const n = `${a.name} (${a.symbol})`;
  const T = {
    index_etf: [`The companies held by ${n} keep growing their combined earnings, so the broad US market holds up over ${horizonText}.`, 'Reports of falling S&P 500 earnings, a US recession, or a market decline of 20% or more.'],
    bond_etf: [`Interest rates stay stable or fall, so the bonds held by ${n} keep their value.`, 'Central bank rate hikes, inflation coming in higher than expected, or rising bond yields.'],
    dividend_etf: [`The companies in ${n} keep paying, and gradually raising, their dividends.`, 'Dividend cuts or profit warnings from large holdings, or a recession hitting company earnings.'],
    sector_etf: [`The ${shortName(a)} sector held by ${n} keeps growing its earnings at least as fast as the overall market.`, `Weak earnings, new regulation or falling demand across the ${shortName(a)} sector.`],
    reit: [`${n} keeps its properties rented and its dividend covered by its income, even as interest rates move.`, 'Rising interest rates, falling occupancy, or a dividend cut.'],
    thematic_etf: [`Demand and company growth behind the "${shortName(a)}" theme of ${n} stay strong.`, 'Slowing demand, new regulation, or investors moving away from the theme.'],
    crypto: [`${n} keeps attracting users and investor demand without a major regulatory setback.`, 'Regulatory crackdowns, exchange failures or hacks, or a sharp fall in crypto trading demand.'],
  };
  const [text, challenge] = T[a.category] || [`${n} keeps growing revenue and profits in its core business.`, `Missed earnings, lowered guidance, lawsuits or regulatory action involving ${a.name}.`];
  return { text, tickers: [a.symbol], whatWouldChallengeIt: challenge, origin: 'template' };
}
function horizonAssumption(assets, horizonText) {
  const syms = assets.map((a) => a.symbol);
  return { text: `${syms.join(' and ')} ${syms.length > 1 ? 'do' : 'does'} not suffer a large, lasting drop within your timeline of ${horizonText}.`, tickers: syms,
    whatWouldChallengeIt: `A broad market decline of 20% or more, or a sharp fall in ${syms.join('/')}, as the time you need the money gets closer.`, origin: 'template' };
}

function validateDraftJson(json, assets) {
  const syms = new Set(assets.map((a) => a.symbol));
  const tickersIn = (list, text) => {
    let t = (Array.isArray(list) ? list : []).map((x) => bySymbol.get(String(x).replace(/^\$/, '').toUpperCase())).filter(Boolean).map((x) => x.symbol).filter((x) => syms.has(x));
    if (!t.length && text) t = detectTickers(text).filter((x) => x.supported && syms.has(x.symbol)).map((x) => x.symbol);
    return [...new Set(t)];
  };
  const mentionsUnselected = (text) => detectTickers(text || '').some((x) => x.supported && !syms.has(x.symbol));
  const seen = new Set();
  const dropped = []; // why Gemini assumptions were rejected (shown in diagnostics, never the raw reply)
  const drop = (i, why) => { dropped.push(`assumption ${i + 1}: ${why}`); return null; };
  const assumptions = (Array.isArray(json.assumptions) ? json.assumptions : []).map((a, i) => {
    if (!a || typeof a !== 'object') return drop(i, 'not an object');
    const text = cleanLLMText(a.text, 280);
    const challenge = cleanLLMText(a.whatWouldChallengeIt, 280);
    if (!text || text.length < 15) return drop(i, typeof a.text === 'string' && a.text.trim() ? 'removed by the advice/safety filter or too short' : 'missing text');
    if (!challenge || challenge.length < 10) return drop(i, 'missing "whatWouldChallengeIt" evidence');
    if (mentionsUnselected(text)) return drop(i, `mentions tickers you did not select (${detectTickers(text).filter((x) => x.supported && !syms.has(x.symbol)).map((x) => x.symbol).join(', ')})`);
    const tickers = tickersIn(a.tickers, text);
    if (!tickers.length) return drop(i, 'not tied to a selected asset');
    const key = text.toLowerCase();
    if (seen.has(key)) return drop(i, 'duplicate');
    seen.add(key);
    return { text, tickers, whatWouldChallengeIt: challenge, origin: 'gemini' };
  }).filter(Boolean);
  if (assumptions.length > 4) dropped.push(`${assumptions.length - 4} extra assumption(s) beyond the maximum of 4`);
  assumptions.splice(4);
  if (!Array.isArray(json.assumptions)) dropped.push('reply had no "assumptions" array');
  const risks = (Array.isArray(json.risks) ? json.risks : []).map((r) => {
    if (!r || typeof r !== 'object') return null;
    const title = cleanLLMText(r.title, 80);
    const explanation = cleanLLMText(r.explanation, 400);
    if (!title || !explanation || mentionsUnselected(explanation)) return null;
    return { title, explanation };
  }).filter(Boolean).slice(0, 3);
  const goal = cleanLLMText(json.goal, 220);
  return { goal: goal && !mentionsUnselected(goal) ? goal : null, assumptions, risks, dropped };
}

function deterministicRisks(p, assets, horizonNote) {
  const risks = [];
  for (const cat of [...new Set(assets.map((a) => a.category))]) {
    const c = CATEGORY_BY_ID[cat];
    if (c) risks.push({ title: c.risk, explanation: `${assets.filter((a) => a.category === cat).map((a) => a.symbol).join(', ')}: ${c.behaves}` });
  }
  if (p.timelineYears < 5 && horizonNote) risks.push({ title: 'Short time horizon', explanation: horizonNote });
  const single = assets.filter((a) => ['large_cap', 'mid_cap', 'small_cap'].includes(a.category));
  if (assets.length === 1 || single.length === assets.length) {
    risks.push({ title: 'Concentration', explanation: `This draft covers ${assets.length === 1 ? 'a single holding' : 'only individual companies'}, so ${assets.length === 1 ? 'its' : 'their'} results swing more than a broad fund's; one company's news can move the price a lot.` });
  }
  if (p.riskComfort == null) risks.push({ title: 'Risk comfort not stated', explanation: "You haven't said how you'd feel about losses, so this draft treats your situation cautiously." });
  return risks;
}

const capFirst = (t) => t.charAt(0).toUpperCase() + t.slice(1);

function formatDraft(d) {
  const p = d.profileSnapshot;
  const lines = [
    'THESIS DRAFT (not saved, not monitored)',
    `Goal: ${d.goal}`,
    `Contributions: ${fmtMoney(d.budget.amount, p.currency)} ${CADENCE_TEXT[d.budget.cadence] || d.budget.cadence} · Horizon: ${d.horizon.text} · Experience: ${p.experience || 'not stated'} · Risk comfort: ${p.riskComfort || 'not stated'}`,
    `Researching: ${listAssets(d.selectedAssets)}`,
    `Assumptions to watch (${d.assumptionStatus === 'confirmed' ? 'confirmed by you' : 'proposed, not confirmed yet'}):`,
    ...d.assumptionDetails.flatMap((a) => [`  ${a.index + 1}. ${a.text} [${a.tickers.join(', ')}]`, `     Could be challenged by: ${a.whatWouldChallengeIt}`]),
    'Risks and uncertainties:',
    ...d.risks.map((r) => `  - ${r.title}: ${r.explanation}`),
    d.disclaimer,
  ];
  return lines.join('\n');
}

async function createThesisDraft(session, opts = {}) {
  const s = normalizeSession(session);
  const p = s.profile;
  const base = { ok: false, saved: false, monitoringActivated: false, draft: null, source: null, model: null, fallbackReason: null, missingFields: [], session: s };
  const missing = DRAFT_REQUIRED.filter((f) => p[f] == null);
  if (missing.length) {
    return { ...base, reason: 'missing_profile', missingFields: missing, displayText: `Before I can draft a thesis I still need your ${missing.map((f) => LABEL[f]).join(', ')}. ${QUESTIONS[missing[0]]}` };
  }
  if (!s.selection.confirmed.length) {
    const pend = s.selection.pending;
    return { ...base, reason: 'selection_not_confirmed', displayText: pend.length
      ? `You picked ${pend.join(', ')} but haven't confirmed ${pend.length > 1 ? 'them' : 'it'} yet. Type yes to confirm, or type different tickers.`
      : `First choose 1-${MAX_SELECTION} supported stocks or ETFs to research (Explore Investments shows the list), then confirm them.` };
  }

  const assets = s.selection.confirmed.map(assetInfo);
  const horizon = { years: p.timelineYears, text: timelineOf(p, s.profileDetails.timelineText) };
  const horizonNote = horizonNoteFor(p, s.profileDetails.timelineText);
  const g = await askGemini('draft', draftPrompt(p, horizon.text, assets), opts);
  const v = g.json ? validateDraftJson(g.json, assets) : { goal: null, assumptions: [], risks: [], dropped: [] };

  // 2-4 assumptions: Gemini's valid ones first; only if fewer than 2, top up with asset-specific templates.
  const details = [...v.assumptions];
  for (const a of assets) {
    if (details.length >= 2) break;
    if (!details.some((d) => d.tickers.includes(a.symbol))) details.push(templateAssumption(a, horizon.text));
  }
  if (details.length < 2) details.push(horizonAssumption(assets, horizon.text));
  if (!g.json) { // no Gemini at all: one template per asset, up to 4
    for (const a of assets) if (details.length < 4 && !details.some((d) => d.tickers.includes(a.symbol))) details.push(templateAssumption(a, horizon.text));
  }

  const risks = [];
  const fixed = deterministicRisks(p, assets, horizonNote);
  const hasHorizon = fixed.some((r) => r.title === 'Short time horizon');
  // Gemini's extra risks are kept unless they repeat a fixed one (same title, or another take on the short horizon).
  const extra = v.risks.filter((r) => !(hasHorizon && /\b(horizon|timeline|short[- ]term|time frame|timeframe)\b/i.test(`${r.title} ${r.explanation}`)));
  for (const r of [...fixed, ...extra]) if (!risks.some((x) => x.title.toLowerCase() === r.title.toLowerCase())) risks.push(r);
  const goal = v.goal || `${capFirst(p.purpose)}, investing ${fmtMoney(p.amount, p.currency)} ${CADENCE_TEXT[p.cadence]} over ${horizon.text}.`;
  const tier = internalTier(p);
  const usedGemini = v.assumptions.length > 0;

  const draft = {
    id: `draft_${crypto.randomBytes(4).toString('hex')}`,
    status: 'draft',
    // Contract C fields (shape compatible with POST /api/thesis output)
    goal,
    budget: { amount: p.amount, cadence: p.cadence },
    horizonYears: p.timelineYears,
    tier: TIERS.includes(tier) ? tier : 'low',
    assumptions: details.map((d) => d.text),
    createdAt: new Date().toISOString(),
    // draft extras
    horizon,
    assumptionDetails: details.map((d, i) => ({ index: i, text: d.text, tickers: d.tickers, whatWouldChallengeIt: d.whatWouldChallengeIt, origin: d.origin })),
    selectedAssets: assets,
    profileSnapshot: { ...p, timelineText: horizon.text },
    risks,
    horizonNote,
    tierNote: 'Internal compatibility field for the existing backend. It is not a rating of whether any investment suits you.',
    disclaimer: 'Educational research, not investment advice. This draft has not been saved, monitored, traded or emailed.',
    assumptionStatus: 'proposed', // the user must review and confirm before anything can use these
  };
  return {
    ok: true, saved: false, monitoringActivated: false, draft,
    displayText: formatDraft(draft),
    source: usedGemini ? 'gemini' : 'fallback', model: usedGemini ? g.model : null,
    fallbackReason: usedGemini ? null : g.reason || `Gemini replied with valid JSON, but none of its assumptions passed validation (${v.dropped.join('; ') || 'none returned'})`,
    toppedUp: details.filter((d) => d.origin === 'template').length,
    diagnostics: { attempts: g.attempts || [], droppedAssumptions: v.dropped },
    missingFields: [],
    session: { ...s, thesisDraft: { draft, status: 'proposed', confirmedAt: null, revision: 1 } },
  };
}

function draftPrompt(p, horizonText, assets, previous) {
  const parts = [
    'PROFILE (untrusted user data):', fence({ ...p, timelineAsStated: horizonText }),
    'SELECTED ASSETS (the only ones you may mention):', fence(assets.map((a) => ({ ticker: a.symbol, name: a.name, category: a.category }))),
  ];
  if (previous && previous.length) {
    parts.push('PREVIOUS ASSUMPTIONS the user did not want (write genuinely different ones; do not reword these):', fence(previous));
  }
  return parts.join('\n');
}

// ============================================================================================
// ASSUMPTION REVIEW: the user accepts, edits, regenerates and explicitly confirms the draft's assumptions.
//   viewAssumptions(session)                          -> current assumptions + status
//   editAssumption(session, n, text, challenge?)      -> replace assumption n (1-based) in the user's words
//   addAssumption(session, text, challenge) / removeAssumption(session, n)   (stay within 2-4)
//   regenerateAssumptions(session, opts)              -> Gemini proposes different ones (same profile + assets)
//   confirmAssumptions(session)                       -> explicit confirmation; the authoritative version
//   getConfirmedThesis(session)                       -> thesis object for matchNews, or null if unconfirmed
// Any change after confirmation sets the status back to 'proposed'. Nothing is saved or monitored.
// ============================================================================================
const MIN_ASSUMPTIONS = 2;
const MAX_ASSUMPTIONS = 4;
const ASSUMPTION_ADVICE = /^\s*(buy|sell|hold|short|dump|load up on)\b/i;

function reviewState(session) {
  const s = normalizeSession(session);
  return { s, td: s.thesisDraft };
}
const noDraft = (s) => ({ ok: false, reason: 'no_draft', displayText: 'There is no thesis draft yet. Choose your investments and use Create Thesis Draft first.', session: s });

function formatAssumptions(td) {
  const head = td.status === 'confirmed' ? 'Confirmed assumptions (these are what news will be compared against):' : 'Proposed assumptions (not confirmed yet):';
  const lines = [head];
  td.draft.assumptionDetails.forEach((a, i) => {
    lines.push(`  ${i + 1}. ${a.text} [${a.tickers.join(', ')}]${a.origin === 'user' ? ' (your wording)' : ''}`);
    lines.push(`     Could be challenged by: ${a.whatWouldChallengeIt}`);
  });
  lines.push(`Researching: ${listAssets(td.draft.selectedAssets)}`);
  return lines.join('\n');
}

function withAssumptions(s, td, details, note) {
  const draft = {
    ...td.draft,
    assumptions: details.map((d) => d.text),
    assumptionDetails: details.map((d, i) => ({ index: i, text: d.text, tickers: d.tickers, whatWouldChallengeIt: d.whatWouldChallengeIt, origin: d.origin })),
    assumptionStatus: 'proposed',
  };
  const next = { draft, status: 'proposed', confirmedAt: null, revision: td.revision + 1 };
  const wasConfirmed = td.status === 'confirmed';
  const msg = [note, wasConfirmed ? 'Your earlier confirmation was cleared because the assumptions changed; confirm again when you are happy with them.' : 'Confirm the assumptions when you are happy with them.'].filter(Boolean).join(' ');
  return { ok: true, status: 'proposed', confirmationCleared: wasConfirmed, assumptions: draft.assumptionDetails, displayText: `${msg}\n${formatAssumptions(next)}`, session: { ...s, thesisDraft: next } };
}

// Validates an assumption written by the user. Keeps it tied to the selected assets and free of advice.
function validateUserAssumption(text, challenge, assets, { fallbackTickers = [], fallbackChallenge = null, others = [] } = {}) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  const fail = (error) => ({ ok: false, error });
  if (t.length < 15 || t.split(' ').length < 4) return fail('Write the assumption as a full sentence (at least 4 words) describing something that has to stay true.');
  if (t.length > 280) return fail('Keep the assumption under 280 characters.');
  const adviceLike = (x) => ASSUMPTION_ADVICE.test(x) || scrubAdvice(x).scrubbed || dropSafeClaims(x) !== x.trim() || TRACKING_CLAIM.test(x);
  if (adviceLike(t)) return fail("Assumptions describe what has to stay true about your investments. They can't tell anyone to buy, sell or hold, promise returns, or call anything safe.");
  const syms = new Set(assets.map((a) => a.symbol));
  const mentioned = detectTickers(t, { capsTokens: true });
  const outside = mentioned.filter((m) => !syms.has(m.symbol));
  if (outside.length) return fail(`${outside.map((m) => m.symbol).join(', ')} ${outside.length > 1 ? "aren't" : "isn't"} one of this thesis's selected investments (${[...syms].join(', ')}).`);
  let tickers = mentioned.filter((m) => syms.has(m.symbol)).map((m) => m.symbol);
  if (!tickers.length) tickers = fallbackTickers.filter((x) => syms.has(x));
  if (!tickers.length) return fail(`Say which of your selected investments this is about (${[...syms].join(', ')}).`);
  let c = challenge == null || String(challenge).trim() === '' ? fallbackChallenge : String(challenge).trim().replace(/\s+/g, ' ');
  if (!c) return fail('Add what future news would challenge this assumption, so it can be monitored.');
  if (c.length < 10 || c.length > 280) return fail('Describe the challenging evidence in 10-280 characters.');
  if (adviceLike(c)) return fail("The challenge evidence can't include buy/sell/hold advice or promises.");
  if (others.some((o) => o.text.toLowerCase() === t.toLowerCase())) return fail('That assumption is already in the list.');
  return { ok: true, value: { text: t, tickers: [...new Set(tickers)], whatWouldChallengeIt: c, origin: 'user' }, keptChallenge: c === fallbackChallenge };
}

function viewAssumptions(session) {
  const { s, td } = reviewState(session);
  if (!td) return noDraft(s);
  return { ok: true, status: td.status, assumptions: td.draft.assumptionDetails, selectedAssets: td.draft.selectedAssets, displayText: formatAssumptions(td), session: s };
}

// editAssumption(session, n, text, challenge, { keepChallenge })
// New wording needs an explicit decision about its "could be challenged by" criteria: pass new `challenge`
// text, or `{ keepChallenge: true }` to retain the current criteria. Without either, nothing changes and the
// result asks for the decision (reason 'challenge_decision_needed'); suggestChallenge() can propose criteria.
function editAssumption(session, number, text, challenge, opts = {}) {
  const { s, td } = reviewState(session);
  if (!td) return noDraft(s);
  const list = td.draft.assumptionDetails;
  const i = Number(number) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= list.length) return { ok: false, reason: 'bad_index', displayText: `Choose an assumption number from 1 to ${list.length}.`, session: s };
  const cur = list[i];
  const others = list.filter((_, j) => j !== i);
  const hasNew = challenge != null && String(challenge).trim() !== '';
  if (!hasNew && !opts.keepChallenge) {
    // check the wording first, so text problems are reported before asking about the criteria
    const pre = validateUserAssumption(text, cur.whatWouldChallengeIt, td.draft.selectedAssets, { fallbackTickers: cur.tickers, others });
    if (!pre.ok) return { ok: false, reason: 'invalid_assumption', displayText: pre.error, session: s };
    return { ok: false, reason: 'challenge_decision_needed', needsChallengeDecision: true, assumptionNumber: i + 1, currentChallenge: cur.whatWouldChallengeIt,
      displayText: `The new wording may need different "could be challenged by" criteria. Current criteria: "${cur.whatWouldChallengeIt}". Give new criteria, or explicitly keep the current ones.`, session: s };
  }
  const v = validateUserAssumption(text, hasNew ? challenge : null, td.draft.selectedAssets, { fallbackTickers: cur.tickers, fallbackChallenge: hasNew ? null : cur.whatWouldChallengeIt, others });
  if (!v.ok) return { ok: false, reason: 'invalid_assumption', displayText: v.error, session: s };
  const details = list.map((d, j) => (j === i ? v.value : d));
  const r = withAssumptions(s, td, details, `Updated assumption ${i + 1}${hasNew ? ' and its challenge criteria' : '; you chose to keep its current challenge criteria'}.`);
  return { ...r, challengeKept: !hasNew };
}

// Change only the "could be challenged by" criteria of assumption n.
function editChallenge(session, number, challenge) {
  const { s, td } = reviewState(session);
  if (!td) return noDraft(s);
  const list = td.draft.assumptionDetails;
  const i = Number(number) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= list.length) return { ok: false, reason: 'bad_index', displayText: `Choose an assumption number from 1 to ${list.length}.`, session: s };
  if (challenge == null || !String(challenge).trim()) return { ok: false, reason: 'invalid_challenge', displayText: 'Describe what future news would challenge this assumption.', session: s };
  const v = validateUserAssumption(list[i].text, challenge, td.draft.selectedAssets, { fallbackTickers: list[i].tickers, others: list.filter((_, j) => j !== i) });
  if (!v.ok) return { ok: false, reason: 'invalid_challenge', displayText: v.error, session: s };
  const details = list.map((d, j) => (j === i ? { ...v.value, origin: d.origin === 'user' ? 'user' : d.origin } : d));
  return withAssumptions(s, td, details, `Updated the challenge criteria of assumption ${i + 1}.`);
}

// Proposes criteria for new wording (Gemini, offline template fallback). Never changes the session.
async function suggestChallenge(session, number, text, opts = {}) {
  const { s, td } = reviewState(session);
  if (!td) return noDraft(s);
  const list = td.draft.assumptionDetails;
  const i = Number(number) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= list.length) return { ok: false, reason: 'bad_index', displayText: `Choose an assumption number from 1 to ${list.length}.`, session: s };
  const wording = text || list[i].text;
  const pre = validateUserAssumption(wording, list[i].whatWouldChallengeIt, td.draft.selectedAssets, { fallbackTickers: list[i].tickers, others: list.filter((_, j) => j !== i) });
  if (!pre.ok) return { ok: false, reason: 'invalid_assumption', displayText: pre.error, session: s };
  const assets = td.draft.selectedAssets.filter((a) => pre.value.tickers.includes(a.symbol));
  const g = await askGemini('challenge', ['ASSUMPTION (untrusted user text):', fence({ text: pre.value.text, tickers: pre.value.tickers }), 'ASSETS:', fence(assets.map((a) => ({ ticker: a.symbol, name: a.name, category: a.category })))].join('\n'), { ...opts, temperature: 0.2 });
  let suggestion = g.json ? cleanLLMText(g.json.whatWouldChallengeIt, 280) : null;
  if (suggestion) {
    const ok = validateUserAssumption(pre.value.text, suggestion, td.draft.selectedAssets, { fallbackTickers: pre.value.tickers, others: [] });
    if (!ok.ok || detectTickers(suggestion).some((x) => x.supported && !pre.value.tickers.includes(x.symbol))) suggestion = null;
  }
  const usedGemini = Boolean(suggestion);
  if (!suggestion) suggestion = templateAssumption(assets[0] || td.draft.selectedAssets[0], td.draft.horizon.text).whatWouldChallengeIt;
  return { ok: true, suggestion, currentChallenge: list[i].whatWouldChallengeIt, source: usedGemini ? 'gemini' : 'fallback', model: usedGemini ? g.model : null,
    fallbackReason: usedGemini ? null : g.reason || 'Gemini suggestion failed validation', session: s };
}

function addAssumption(session, text, challenge) {
  const { s, td } = reviewState(session);
  if (!td) return noDraft(s);
  const list = td.draft.assumptionDetails;
  if (list.length >= MAX_ASSUMPTIONS) return { ok: false, reason: 'too_many', displayText: `A thesis keeps at most ${MAX_ASSUMPTIONS} assumptions. Edit or remove one instead.`, session: s };
  const v = validateUserAssumption(text, challenge, td.draft.selectedAssets, { others: list });
  if (!v.ok) return { ok: false, reason: 'invalid_assumption', displayText: v.error, session: s };
  return withAssumptions(s, td, [...list, v.value], `Added assumption ${list.length + 1}.`);
}

function removeAssumption(session, number) {
  const { s, td } = reviewState(session);
  if (!td) return noDraft(s);
  const list = td.draft.assumptionDetails;
  const i = Number(number) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= list.length) return { ok: false, reason: 'bad_index', displayText: `Choose an assumption number from 1 to ${list.length}.`, session: s };
  if (list.length <= MIN_ASSUMPTIONS) return { ok: false, reason: 'too_few', displayText: `A thesis needs at least ${MIN_ASSUMPTIONS} assumptions. Edit this one instead of removing it.`, session: s };
  return withAssumptions(s, td, list.filter((_, j) => j !== i), `Removed assumption ${i + 1}.`);
}

async function regenerateAssumptions(session, opts = {}) {
  const { s, td } = reviewState(session);
  if (!td) return noDraft(s);
  const d = td.draft;
  const p = { ...d.profileSnapshot };
  delete p.timelineText;
  const previous = d.assumptionDetails.map((a) => a.text);
  const g = await askGemini('draft', draftPrompt(p, d.horizon.text, d.selectedAssets, previous), { ...opts, temperature: 0.7 });
  const v = g.json ? validateDraftJson(g.json, d.selectedAssets) : { assumptions: [] };
  const fresh = v.assumptions.filter((a) => !previous.some((x) => x.toLowerCase() === a.text.toLowerCase()));
  if (fresh.length < MIN_ASSUMPTIONS) {
    return { ok: false, reason: 'regeneration_failed', source: g.json ? 'gemini' : 'fallback', model: g.model, fallbackReason: g.reason || 'Gemini did not return 2 new valid assumptions',
      displayText: "I couldn't generate new assumptions right now, so your current ones are unchanged. You can edit them in your own words instead.", session: s };
  }
  const r = withAssumptions(s, td, fresh.slice(0, MAX_ASSUMPTIONS), 'Here are new proposed assumptions for the same investments and profile.');
  return { ...r, source: 'gemini', model: g.model, fallbackReason: null };
}

function confirmAssumptions(session) {
  const { s, td } = reviewState(session);
  if (!td) return noDraft(s);
  const list = td.draft.assumptionDetails;
  const syms = new Set(td.draft.selectedAssets.map((a) => a.symbol));
  const problems = [];
  if (list.length < MIN_ASSUMPTIONS || list.length > MAX_ASSUMPTIONS) problems.push(`keep between ${MIN_ASSUMPTIONS} and ${MAX_ASSUMPTIONS} assumptions`);
  list.forEach((a, i) => {
    if (!a.tickers.length || !a.tickers.every((t) => syms.has(t))) problems.push(`assumption ${i + 1} must be about your selected investments`);
    if (!a.whatWouldChallengeIt) problems.push(`assumption ${i + 1} needs what would challenge it`);
  });
  if (problems.length) return { ok: false, reason: 'invalid_assumptions', displayText: `Not confirmed yet: ${problems.join('; ')}.`, session: s };
  if (td.status === 'confirmed') return { ok: true, status: 'confirmed', alreadyConfirmed: true, thesis: confirmedThesisFrom(td), displayText: 'These assumptions are already confirmed.', session: s };
  const next = { ...td, draft: { ...td.draft, assumptionStatus: 'confirmed' }, status: 'confirmed', confirmedAt: new Date().toISOString() };
  return {
    ok: true, status: 'confirmed', thesis: confirmedThesisFrom(next),
    displayText: `Confirmed. These ${list.length} assumptions are now the version future news will be compared against. Nothing has been saved, monitored or emailed.\n${formatAssumptions(next)}`,
    session: { ...s, thesisDraft: next },
  };
}

function confirmedThesisFrom(td) {
  const d = td.draft;
  return { ...d, assumptions: d.assumptionDetails.map((a) => a.text), assumptionStatus: 'confirmed', assumptionsConfirmedAt: td.confirmedAt, status: 'draft' };
}
function getConfirmedThesis(session) {
  const { td } = reviewState(session);
  return td && td.status === 'confirmed' ? confirmedThesisFrom(td) : null;
}

// ============================================================================================
// NEWS MATCHING: matchNewsDetailed(thesis, newsItems, opts) -> { matches, stats }
//
// 1. Scope: tickers from selectedAssets + assumptionDetails + tickers named in assumptions. A draft whose
//    assumptions are not confirmed is never matched. A plain Contract C thesis with no tickers is "unscoped".
// 2. Prefilter (no LLM): article ticker in the thesis -> direct; article ticker is a notable holding of a
//    selected ETF -> etf_holding (always indirect); anything else is skipped.
// 3. Gemini, batched (<= NEWS_BATCH articles per call), primary -> backup model.
// 4. Server rules: ticker/headline/url always copied from the article (never from Gemini); url kept only
//    if http(s); indirect -> neutral; headline-only evidence -> neutral (Gemini's view kept in
//    assessedStance) because Taha's notify code emails on any "challenges"; advice scrubbed.
// 5. Both models fail -> conservative: direct articles only, neutral, unanalyzed. Never "challenges".
// matchNews never sends email, saves or monitors anything: it only returns data.
// ============================================================================================
const NEWS_BATCH = 15;
const MAX_NEWS_INPUT = 40;
const STANCES = ['supports', 'challenges', 'neutral'];
const MIN_SUMMARY = 40;
// UNVERIFIED context, hand-entered from general knowledge (like the MER values). Only LARGE positions
// (roughly 3%+ of the fund) are listed: company news about a small position (e.g. Coca-Cola inside VOO) is
// treated as unrelated and filtered out before Gemini. Anything that does pass is at most "indirect".
const MEGA5 = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL'];
const NOTABLE_HOLDINGS = {
  VOO: MEGA5, IVV: MEGA5, VTI: MEGA5, SCHB: MEGA5, ITOT: MEGA5, QQQ: MEGA5,
  DIA: ['UNH', 'MSFT', 'HD', 'JPM', 'V', 'MCD', 'AAPL', 'AMZN'],
  XLK: ['AAPL', 'MSFT', 'NVDA'], XLY: ['AMZN', 'HD', 'MCD'], XLV: ['UNH', 'JNJ', 'ABBV', 'MRK'], XLF: ['JPM', 'V'],
  SOXX: ['NVDA'], BOTZ: ['NVDA'],
  SCHD: ['ABBV', 'KO', 'PEP', 'HD', 'MRK'], VYM: ['JPM', 'ABBV', 'JNJ', 'PG', 'HD'],
  VIG: ['MSFT', 'AAPL', 'JPM', 'UNH', 'V'], DGRO: ['MSFT', 'AAPL', 'JPM', 'JNJ', 'ABBV'], HDV: ['JNJ', 'ABBV', 'MRK', 'PG', 'KO', 'PEP'],
};

function safeUrl(u) {
  if (typeof u !== 'string' || !u.trim() || u.length > 2000) return null;
  try { const x = new URL(u.trim()); return x.protocol === 'https:' || x.protocol === 'http:' ? u.trim() : null; } catch { return null; }
}
const lowerFirst = (t) => t.charAt(0).toLowerCase() + t.slice(1);

function thesisScope(thesis) {
  const fromDetails = Array.isArray(thesis.assumptionDetails) && thesis.assumptionDetails.length;
  const raw = fromDetails ? thesis.assumptionDetails : (Array.isArray(thesis.assumptions) ? thesis.assumptions.map((t) => ({ text: t })) : []);
  const assumptions = raw
    .filter((a) => a && typeof a.text === 'string' && a.text.trim())
    .slice(0, 6)
    .map((a) => ({
      text: a.text.trim().slice(0, 300),
      tickers: [...new Set([...cleanSymbols(a.tickers), ...detectTickers(a.text).filter((t) => t.supported).map((t) => t.symbol)])],
      whatWouldChallengeIt: typeof a.whatWouldChallengeIt === 'string' ? a.whatWouldChallengeIt.slice(0, 300) : null,
    }));
  const selected = (Array.isArray(thesis.selectedAssets) ? thesis.selectedAssets : []).map((a) => (a && bySymbol.get(String(a.symbol || a))) || null).filter(Boolean);
  const tickers = new Set([...selected.map((a) => a.symbol), ...assumptions.flatMap((a) => a.tickers)]);
  return {
    goal: typeof thesis.goal === 'string' ? thesis.goal.slice(0, 300) : null,
    assumptions,
    assets: [...tickers].map(assetInfo),
    tickers,
    scoped: tickers.size > 0,
  };
}

function normalizeNewsItems(newsItems) {
  const seen = new Set();
  const out = [];
  for (const n of Array.isArray(newsItems) ? newsItems : []) {
    if (!n || typeof n.headline !== 'string' || !n.headline.trim()) continue;
    const ticker = typeof n.ticker === 'string' ? n.ticker.trim().toUpperCase() : '';
    const headline = n.headline.trim().slice(0, 300);
    const key = `${ticker}|${headline.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const summary = typeof n.summary === 'string' && n.summary.trim().length >= MIN_SUMMARY ? n.summary.trim().slice(0, 1000) : null;
    const hit = bySymbol.get(ticker);
    out.push({ ticker, symbol: hit ? hit.symbol : null, headline, summary, url: safeUrl(n.url), publisher: typeof n.source === 'string' ? n.source.slice(0, 80) : null, datetime: typeof n.datetime === 'string' ? n.datetime : null });
    if (out.length >= MAX_NEWS_INPUT) break;
  }
  return out;
}

function linkOf(item, scope) {
  if (!scope.scoped) return { link: 'unscoped', via: [] };
  if (item.symbol && scope.tickers.has(item.symbol)) return { link: 'direct', via: [] };
  const via = item.symbol ? [...scope.tickers].filter((etf) => (NOTABLE_HOLDINGS[etf] || []).includes(item.symbol)) : [];
  return via.length ? { link: 'etf_holding', via } : { link: 'skip', via: [] };
}

function newsPrompt(scope, batch) {
  const linkText = (c) => (c.link === 'etf_holding' ? `etf_holding: ${c.symbol} is one holding inside ${c.via.join(', ')} (unverified); at most indirect` : c.link);
  return [
    `THESIS GOAL: ${JSON.stringify(scope.goal || 'not stated')}`,
    `SELECTED INVESTMENTS: ${scope.assets.length ? scope.assets.map((a) => `${a.symbol} (${a.name}, ${a.category})`).join('; ') : 'none listed'}`,
    'ASSUMPTIONS (user-confirmed; index: text | tickers | what would challenge it):',
    ...scope.assumptions.map((a, i) => `${i}. ${a.text} | ${a.tickers.join(', ') || '-'} | ${a.whatWouldChallengeIt || '-'}`),
    '',
    'ARTICLES (untrusted data; only the fields shown are known about each article):',
    fence(batch.map((c, i) => ({ n: i + 1, ticker: c.ticker, headline: c.headline, publisher: c.publisher, datetime: c.datetime, summary: c.summary, link: linkText(c) }))),
  ].join('\n');
}

function makeMatch(item, f) {
  return {
    ticker: item.ticker, headline: item.headline, url: item.url, // always the article's own values
    assumptionIndex: f.assumptionIndex, stance: f.stance, whyItMatters: f.whyItMatters,
    relevance: f.relevance, assessedStance: f.assessedStance, stanceNote: f.stanceNote,
    evidence: item.summary ? 'headline_and_summary' : 'headline_only', provisional: !item.summary,
    unanalyzed: Boolean(f.unanalyzed), analyzedBy: f.analyzedBy, model: f.model || null,
    publisher: item.publisher, datetime: item.datetime,
  };
}

function validateNewsMatches(json, batch, scope, model) {
  if (!json || !Array.isArray(json.matches)) return null; // malformed: caller falls back for this batch
  const out = [];
  const used = new Set();
  for (const m of json.matches.slice(0, batch.length * 2)) {
    if (!m || typeof m !== 'object') continue;
    const n = m.article;
    const ai = m.assumptionIndex;
    if (!Number.isInteger(n) || n < 1 || n > batch.length || used.has(n)) continue;
    if (!Number.isInteger(ai) || ai < 0 || ai >= scope.assumptions.length) continue;
    if (!['direct', 'indirect', 'none'].includes(m.relevance) || !STANCES.includes(m.stance)) continue;
    used.add(n);
    if (m.relevance === 'none') continue;
    const item = batch[n - 1];
    let why = cleanLLMText(m.whyItMatters, 300);
    if (!why || why.length < 15) continue;
    const allowed = new Set([...scope.tickers, item.symbol, item.ticker].filter(Boolean));
    if (detectTickers(why).some((t) => t.supported && !allowed.has(t.symbol))) continue; // no relevance claims about other assets
    if (otherTickerTokens(why, allowed, item).length) continue; // nor about tickers outside the universe (e.g. "TSLA")
    const relevance = item.link === 'etf_holding' ? 'indirect' : m.relevance;
    let stance = m.stance;
    let stanceNote = null;
    if (relevance === 'indirect' && stance !== 'neutral') { stance = 'neutral'; stanceNote = 'indirect'; }
    else if (!item.summary && stance !== 'neutral') { stance = 'neutral'; stanceNote = 'headline_only'; }
    if (relevance === 'indirect' && !/\b(limited|indirect)/i.test(why)) why = `Limited, indirect relevance: ${lowerFirst(why)}`;
    if (!item.summary && !/headline/i.test(why)) why = `Based on the headline alone (provisional): ${lowerFirst(why)}`;
    out.push(makeMatch(item, { assumptionIndex: ai, stance, assessedStance: m.stance, stanceNote, relevance, whyItMatters: why.slice(0, 360), analyzedBy: 'gemini', model }));
  }
  return out;
}

// Capitalised ticker-like words that are neither the thesis's/article's tickers nor common acronyms.
const NEWS_ACRONYMS = new Set([...NOT_TICKERS, 'GPU', 'GPUS', 'CPU', 'CPUS', 'AI', 'EPS', 'GDP', 'CEO', 'CFO', 'IPO', 'FED', 'SEC', 'FDA', 'FTC', 'DOJ', 'LLM', 'ESG', 'ETF', 'ETFS', 'USD', 'CAD', 'US', 'USA', 'UK', 'EU', 'IT', 'TV', 'OK', 'Q', 'YOY', 'API', 'CEOS', 'AND', 'OR', 'THE', 'NASDAQ', 'NYSE', 'DOW']);
function otherTickerTokens(text, allowed, item) {
  const words = new Set(`${item.headline} ${item.summary || ''}`.toUpperCase().split(/[^A-Z]+/));
  return [...String(text).matchAll(/\$?\b([A-Z]{2,5})\b/g)].map((m) => m[1]).filter((w) => !allowed.has(w) && !NEWS_ACRONYMS.has(w) && !words.has(w) && !bySymbol.has(w));
}

function conservativeMatches(batch, scope) {
  return batch.filter((c) => c.link === 'direct').map((c) => {
    const ai = Math.max(0, scope.assumptions.findIndex((a) => a.tickers.includes(c.symbol)));
    return makeMatch(c, {
      assumptionIndex: ai, stance: 'neutral', assessedStance: null, stanceNote: 'unanalyzed', relevance: 'direct', unanalyzed: true, analyzedBy: 'fallback',
      whyItMatters: `Not analyzed: this article is about ${c.ticker}, which this thesis covers. AI analysis was unavailable, so no stance is given.`,
    });
  });
}

const STANCE_ORDER = { challenges: 0, supports: 1, neutral: 2 };
async function matchNewsDetailed(thesis, newsItems, opts = {}) {
  const stats = { received: Array.isArray(newsItems) ? newsItems.length : 0, usable: 0, candidates: 0, direct: 0, viaEtfHolding: 0, unscoped: 0, skippedUnrelated: 0, skipped: [], batches: 0, analyzedBy: 'none', models: [], attempts: [], fallbackReason: null, reason: null };
  const done = (matches) => ({ matches, stats });
  if (!thesis || typeof thesis !== 'object') { stats.reason = 'no_thesis'; return done([]); }
  if (thesis.assumptionStatus && thesis.assumptionStatus !== 'confirmed') { stats.reason = 'assumptions_not_confirmed'; return done([]); }
  const scope = thesisScope(thesis);
  if (!scope.assumptions.length) { stats.reason = 'no_assumptions'; return done([]); }
  const items = normalizeNewsItems(newsItems);
  stats.usable = items.length;
  const candidates = [];
  for (const it of items) {
    const l = linkOf(it, scope);
    if (l.link === 'skip') { stats.skippedUnrelated++; stats.skipped.push(it.ticker || '(no ticker)'); continue; }
    if (l.link === 'direct') stats.direct++; else if (l.link === 'etf_holding') stats.viaEtfHolding++; else stats.unscoped++;
    candidates.push({ ...it, ...l });
  }
  stats.candidates = candidates.length;
  if (!candidates.length) { stats.reason = 'no_relevant_articles'; return done([]); }

  const matches = [];
  const by = new Set();
  for (let i = 0; i < candidates.length; i += NEWS_BATCH) {
    const batch = candidates.slice(i, i + NEWS_BATCH);
    stats.batches++;
    const g = await askGemini('news', newsPrompt(scope, batch), { ...opts, temperature: 0.1 });
    const valid = g.json ? validateNewsMatches(g.json, batch, scope, g.model) : null;
    stats.attempts.push(...(g.attempts || []));
    if (valid) { matches.push(...valid); by.add('gemini'); if (g.model && !stats.models.includes(g.model)) stats.models.push(g.model); continue; }
    stats.fallbackReason = g.reason || 'Gemini news output was malformed';
    if (g.json) console.warn(`[news] using fallback: ${stats.fallbackReason}`);
    matches.push(...conservativeMatches(batch, scope));
    by.add('fallback');
  }
  stats.analyzedBy = by.size > 1 ? 'mixed' : [...by][0] || 'none';
  matches.sort((a, b) => STANCE_ORDER[a.stance] - STANCE_ORDER[b.stance] || (a.relevance === 'direct' ? 0 : 1) - (b.relevance === 'direct' ? 0 : 1) || Number(a.unanalyzed) - Number(b.unanalyzed));
  return done(matches);
}

// Which llm.js errors are worth retrying on the backup model. llm.js puts the HTTP status in the
// message ("LLM HTTP 404: ..."), so it is parsed from there. Auth/permission problems never retry.
function isModelFallbackWorthy(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  const status = Number((msg.match(/LLM HTTP (\d{3})/) || [])[1]) || null;
  if (err.code === 'NO_API_KEY' || status === 401 || status === 403 || /api[_ ]?key|permission|unauthori[sz]ed|forbidden/i.test(msg)) return false;
  if (['LLM_RATE_LIMIT', 'LLM_NETWORK', 'LLM_BAD_RESPONSE'].includes(err.code)) return true;
  if (status === 404 || status === 408 || status === 429 || (status >= 500 && status <= 599)) return true;
  return status === 400 && /model|not found|unsupported|not supported/i.test(msg);
}

// Primary model, then FALLBACK_GEMINI_MODEL once on a fallback-worthy error. Returns { text, model } or throws
// the last error, with err.attempts listing what was tried.
async function callWithModelFallback(call, system, user, opts) {
  const primary = process.env.GEMINI_MODEL || null; // null = llm.js picks its default
  const backup = (process.env.FALLBACK_GEMINI_MODEL || '').trim() || null;
  const attempts = [];
  try {
    const text = await call(system, user, { ...opts, ...(primary ? { model: primary } : {}) });
    return { text, model: primary || 'default' };
  } catch (err) {
    attempts.push(`${primary || 'default'}: ${err.code || 'ERROR'}`);
    if (!backup || backup === primary || !isModelFallbackWorthy(err)) { err.attempts = attempts; throw err; }
    console.warn(`[thesis] ${primary || 'default model'} failed (${err.code || 'ERROR'}); trying ${backup}`);
    try {
      const text = await call(system, user, { ...opts, model: backup });
      return { text, model: backup, attempts };
    } catch (err2) {
      attempts.push(`${backup}: ${err2.code || 'ERROR'}`);
      err2.attempts = attempts;
      throw err2;
    }
  }
}

// Like callWithModelFallback, but a reply that `parse` rejects (malformed JSON or wrong shape) also gets one
// retry on FALLBACK_GEMINI_MODEL. Returns { value, model, attempts }; value null if no model produced a usable
// reply. `attempts` is a non-sensitive log ("model: ok" / "model: malformed JSON (...)" / "model: LLM_HTTP").
async function callJsonWithModelFallback(call, system, user, opts, parse) {
  const backup = (process.env.FALLBACK_GEMINI_MODEL || '').trim() || null;
  const describe = (text) => { const x = extractJson(text); return x.error ? `malformed JSON (${x.error})` : 'JSON in the wrong shape'; };
  const out = await callWithModelFallback(call, system, user, opts); // throws if every model errored
  const attempts = [...(out.attempts || [])];
  const value = parse(out.text);
  if (value) { attempts.push(`${out.model}: ok`); return { value, model: out.model, attempts }; }
  attempts.push(`${out.model}: ${describe(out.text)}`);
  if (!backup || out.model === backup) return { value: null, model: out.model, attempts };
  console.warn(`[thesis] ${out.model} returned an unusable reply; trying ${backup}`);
  try {
    const text = await call(system, user, { ...opts, model: backup });
    const v2 = parse(text);
    attempts.push(`${backup}: ${v2 ? 'ok' : describe(text)}`);
    return { value: v2 || null, model: v2 ? backup : out.model, attempts };
  } catch (err) {
    attempts.push(`${backup}: ${err.code || 'ERROR'}`);
    return { value: null, model: out.model, attempts };
  }
}

async function onboardingTurn(message, session, opts = {}) {
  const text = typeof message === 'string' ? message.trim().slice(0, MAX_MESSAGE) : '';
  const s = normalizeSession(session);
  if (!text) {
    const empty = { intent: 'unclear', reply: 'Type a question or tell me what you would like to do.', profileUpdates: {}, tickers: [], ambiguities: [], nextQuestion: null };
    const r = finalize('', s, empty, analyzeMessage(''), 'fallback', 'empty message');
    r.session = s; // an empty message does not change the conversation
    return r;
  }
  const ev = analyzeMessage(text);
  const call = opts.callLLM || llm.callLLM;
  const configured = opts.callLLM ? true : llm.isConfigured();
  const system = loadPrompt('onboarding');
  let parsed = null;
  let fallbackReason = null;
  let model = null;
  if (opts.forceFallback) fallbackReason = 'offline mode requested';
  else if (!system) fallbackReason = 'onboarding prompt missing from prompts/thesis.md';
  else if (!configured) fallbackReason = 'GEMINI_API_KEY not set';
  else {
    try {
      const out = await callJsonWithModelFallback(call, system, buildUserPrompt(text, s), { json: true, temperature: 0.2, timeoutMs: 30000 }, parseLLMReply);
      model = out.model;
      parsed = out.value;
      if (!parsed) fallbackReason = `Gemini reply was not valid JSON in the expected shape [${out.attempts.join('; ')}]`;
    } catch (err) {
      const tried = err.attempts && err.attempts.length > 1 ? `both models failed [${err.attempts.join('; ')}]` : `Gemini call failed (${err.code || 'ERROR'})`;
      fallbackReason = `${tried}: ${String(err.message).replace(/\s+/g, ' ').slice(0, 160)}`;
    }
    if (fallbackReason) console.warn(`[onboarding] using fallback: ${fallbackReason}`);
  }
  if (parsed) return finalize(text, s, parsed, ev, 'gemini', null, model);
  return finalize(text, s, fallbackAnalysis(text, s, ev), ev, 'fallback', fallbackReason);
}

module.exports = {
  createThesis,
  matchNews,
  IS_STUB: true,
  onboardingTurn,
  createOnboardingSession,
  exploreInvestments,
  selectAssets,
  confirmSelection,
  createThesisDraft,
  formatDraft,
  viewAssumptions,
  editAssumption,
  editChallenge,
  suggestChallenge,
  addAssumption,
  removeAssumption,
  regenerateAssumptions,
  confirmAssumptions,
  getConfirmedThesis,
  matchNewsDetailed,
  // exposed for scripts/test-thesis-draft.js
  _news: { thesisScope, normalizeNewsItems, linkOf, validateNewsMatches, safeUrl, NOTABLE_HOLDINGS, NEWS_BATCH },
  _draft: { validateUserAssumption, parseSelectionInput, validateDraftJson, internalTier, horizonNoteFor, templateAssumption, dropSafeClaims, CATEGORY_INFO, MAX_SELECTION },
  // exposed for scripts/test-onboarding.js
  _onboarding: { extractJson, callJsonWithModelFallback, isModelFallbackWorthy, callWithModelFallback, parseLLMReply, scrubAdvice, composeDisplay, detectTickers, analyzeMessage, buildUserPrompt, loadPrompt },
};

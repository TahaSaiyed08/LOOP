// ============================================================================================
// server/thesis.js (Vamsi). Prompts live in prompts/thesis.md.
//
//   onboardingTurn(message, session, opts)  REAL: intent detection + adaptive onboarding.
//                                           Pure: no store writes, no thesis, no monitoring, no email.
//   createThesis(goalsText)                 STUB: returns the fixture thesis for any input.
//   matchNews(thesis, newsItems)            STUB: tags items by market sentiment against assumption 0.
//
// IS_STUB stays true until createThesis/matchNews are real (GET /api/health reports it).
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
const createOnboardingSession = () => ({ history: [], profile: emptyProfile(), askedFields: [], activeFlow: null, tickers: [], lastQuestionField: null });

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

function parseYears(t) {
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
  return { symbol: u.ticker, base, name: u.companyName, patterns };
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

function parseLLMReply(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o;
  try { o = JSON.parse(m[0]); } catch { return null; }
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

function describeFacts(fields, values, profile) {
  const out = [];
  const has = (f) => fields.includes(f);
  if (has('amount')) out.push(`${fmtMoney(values.amount, profile.currency)}${has('cadence') ? ` ${CADENCE_TEXT[values.cadence]}` : ''}`);
  else if (has('cadence')) out.push(`adding money ${CADENCE_TEXT[values.cadence]}`);
  if (has('purpose')) out.push(`goal: ${values.purpose}`);
  if (has('timelineYears')) out.push(`about ${fmtField('timelineYears', values.timelineYears)} away`);
  if (has('experience')) out.push(`${values.experience === 'some' ? 'some' : values.experience} experience level`);
  if (has('riskComfort')) out.push(`${values.riskComfort} comfort with risk`);
  if (has('currency')) out.push(`investing in ${values.currency}`);
  return out.join(', ');
}

function completionSummary(profile) {
  const p = profile;
  const bits = [`goal: ${p.purpose}`, `${fmtMoney(p.amount, p.currency)} ${CADENCE_TEXT[p.cadence] || p.cadence}`, `timeline: ${fmtField('timelineYears', p.timelineYears)}`, `risk comfort: ${p.riskComfort}`];
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
    if (fresh.length) parts.push(`${corrections.length ? 'Also noted' : 'Got it'}: ${describeFacts(fresh, extracted, profile)}.`);
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
  };
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

  let reply = parsed.reply != null ? parsed.reply : fallbackReplyFor(intent, { profile, extracted, corrections, tickers, text, loans: ev.loans });
  reply = scrubAdvice(reply).text;
  reply = dropTrackingClaims(reply);
  if (intent === 'monitoring' && tickers.some((t) => t.supported) && !MONITOR_STATED.test(reply)) reply = `${reply.trim()} ${MONITOR_LINE}`;
  if (profileJustCompleted) reply = `${reply.trim()} ${completionSummary(profile)}`;
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
  };
  return {
    intent,
    reply: shown.reply,
    displayText: shown.displayText,
    nextQuestion,
    profile,
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
    console.warn(`[onboarding] ${primary || 'default model'} failed (${err.code || 'ERROR'}); trying ${backup}`);
    try {
      const text = await call(system, user, { ...opts, model: backup });
      return { text, model: backup };
    } catch (err2) {
      attempts.push(`${backup}: ${err2.code || 'ERROR'}`);
      err2.attempts = attempts;
      throw err2;
    }
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
      const out = await callWithModelFallback(call, system, buildUserPrompt(text, s), { json: true, temperature: 0.2, timeoutMs: 30000 });
      model = out.model;
      parsed = parseLLMReply(out.text);
      if (!parsed) fallbackReason = `Gemini reply was not valid JSON in the expected shape (${model})`;
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
  // exposed for scripts/test-onboarding.js
  _onboarding: { isModelFallbackWorthy, callWithModelFallback, parseLLMReply, scrubAdvice, composeDisplay, detectTickers, analyzeMessage, buildUserPrompt, loadPrompt },
};

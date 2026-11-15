// Interactive demo of thesisChat (server/thesis.js): ask your own questions about a confirmed thesis.
//   npm run demo:chat                 real Gemini (GEMINI_MODEL, backup FALLBACK_GEMINI_MODEL) from .env
//   npm run demo:chat -- --offline    deterministic fallback only (no API calls)
// Two sample theses (NVDA and VOO) are built through the real flow; their evidence is SAMPLE news
// (scripts/sample-news.js, not real news) matched by matchNewsDetailed. Nothing is saved, monitored,
// emailed or traded; history lives only in this process.
//
// Commands: /news  list this thesis's matched articles     /open N  investigate article N
//           /general  back to general chat                  /switch  switch thesis (separate history)
//           /thesis  show the thesis                         /history  show this conversation   /quit
require('dotenv').config();
const readline = require('readline');
const T = require('../server/thesis');
const llm = require('../server/llm');
const SAMPLE = require('./sample-news');

const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);
const STANCE = { challenges: '31', supports: '32', neutral: '33' };
// Demo-only labelling: every article here is a made-up SAMPLE (scripts/sample-news.js), never real news.
const HYPO = 'HYPOTHETICAL SAMPLE';
const SAMPLE_HEADLINES = new Set(SAMPLE.map((n) => n.headline));
const isSample = (x) => Boolean(x && SAMPLE_HEADLINES.has(x.title || x.headline));
const hypoTag = (x) => (isSample(x) ? c('35', `[${HYPO}] `) : '');
// The chat sees the label too: publisher becomes "Sample Wire (hypothetical example, not real news)".
const asHypothetical = (m) => (isSample(m) ? { ...m, publisher: `${m.publisher || 'Sample'} (hypothetical example, not real news)` } : m);

const nulls = { amount: null, cadence: null, timelineYears: null, currency: null, experience: null, riskComfort: null, purpose: null };
async function buildThesis(symbols, text, challenge) {
  let s = T.createOnboardingSession();
  s.profile = { ...nulls, amount: 50, cadence: 'monthly', timelineYears: 5, experience: 'beginner', riskComfort: 'medium', purpose: 'build long-term wealth' };
  s = T.confirmSelection(T.selectAssets(symbols, s).session).session;
  s = (await T.createThesisDraft(s, { forceFallback: true })).session;
  s = T.editAssumption(s, 1, text, challenge).session;
  return T.getConfirmedThesis(T.confirmAssumptions(s).session);
}

function printThesis(t) {
  console.log(bold(`Thesis ${t.id}: ${t.selectedAssets.map((a) => a.symbol).join(', ')}`) + dim(` · ${t.goal}`));
  t.assumptionDetails.forEach((a, i) => console.log(dim(`  ${i + 1}. ${a.text}\n     what would challenge it: ${a.whatWouldChallengeIt || '-'}`)));
}
function printNews(matches) {
  if (!matches.length) { console.log('  No matched articles for this thesis.'); return; }
  matches.forEach((m, i) => console.log(`  ${bold(i + 1)}. ${hypoTag(m)}${c(STANCE[m.stance], m.stance)} ${m.ticker} · ${m.headline} ${dim(`(${m.evidence}${m.unanalyzed ? ', not analysed' : ''})`)}`));
}
function printAnswer(r) {
  if (!r.ok) { console.log(c('31', `  [${r.error.code}] ${r.error.message}`)); return; }
  const tag = r.source === 'gemini' ? c('32', `gemini ${r.model}`) : c('33', `fallback: ${r.fallbackReason}`);
  console.log(dim(`  [${r.mode} · ${tag}${r.removedClaims ? ` · ${r.removedClaims} unsupported claim(s) removed` : ''}${r.droppedCitations ? ` · ${r.droppedCitations} invalid citation(s) dropped` : ''}]`));
  for (const s of r.segments) {
    const marks = s.citations.length ? ` ${s.citations.map((n) => `[${n}]`).join('')}` : '';
    console.log(`  ${s.text}${c('36', marks)}${dim(`  (${s.basis})`)}`);
  }
  for (const ci of r.citations) console.log(c('36', `  [${ci.id}] `) + hypoTag(ci) + c('36', `${ci.title} · ${ci.publisher || 'unknown publisher'} · ${ci.url || 'no valid URL'}`) + dim(` · ${ci.evidence}`));
  if (r.insufficientEvidence) console.log(dim('  (limited evidence for this answer)'));
  if (r.followUps.length) console.log(dim(`  You could ask: ${r.followUps.join(' | ')}`));
  console.log(dim(`  ${r.disclaimer}`));
}

async function main() {
  const offline = process.argv.includes('--offline');
  const mode = offline ? 'FALLBACK (forced with --offline)'
    : llm.isConfigured() ? `REAL GEMINI (model ${process.env.GEMINI_MODEL || 'default'}${process.env.FALLBACK_GEMINI_MODEL ? `, backup ${process.env.FALLBACK_GEMINI_MODEL}` : ''})` : 'FALLBACK (no GEMINI_API_KEY)';
  console.log(bold('THESIS research chat demo') + dim('  ·  SAMPLE articles, not real news  ·  Educational research, not investment advice.'));
  console.log(`Mode: ${bold(mode)}`);
  const opts = { forceFallback: offline };
  const theses = [
    await buildThesis('NVDA', 'Demand for NVIDIA AI data-center chips keeps growing as cloud companies expand AI infrastructure.', 'NVIDIA lowering guidance, or cloud customers cutting AI infrastructure spending.'),
    await buildThesis('VOO', 'Earnings of the S&P 500 companies held in VOO stay resilient over the next five years.', 'Falling S&P 500 earnings, profit warnings across sectors, or a US recession.'),
  ];
  console.log(dim('Matching SAMPLE news to both theses...'));
  const state = [];
  for (const t of theses) state.push({ thesis: t, matches: (await T.matchNewsDetailed(t, SAMPLE, opts)).matches, history: [], focus: null });
  let cur = 0;
  const show = () => { console.log(''); printThesis(state[cur].thesis); console.log(dim('Commands: /news /open N /general /switch /thesis /history /quit')); };
  show();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => rl.setPrompt(`\n${state[cur].focus != null ? `[${isSample(state[cur].matches[state[cur].focus]) ? 'hypothetical ' : ''}article ${state[cur].focus + 1}] ` : ''}you> `) || rl.prompt();
  prompt();
  // Lines are handled strictly one after another (pasted or piped input would otherwise race the answers).
  let queue = Promise.resolve();
  rl.on('line', (line) => { queue = queue.then(() => handle(line)); });
  async function handle(line) {
    const q = line.trim();
    const st = state[cur];
    try {
      if (!q) { /* nothing */ } else if (q === '/quit' || q === '/exit') { rl.close(); return; }
      else if (q === '/news') printNews(st.matches);
      else if (q === '/thesis') printThesis(st.thesis);
      else if (q === '/general') { st.focus = null; console.log('  General thesis chat.'); }
      else if (q === '/switch') { cur = (cur + 1) % state.length; show(); }
      else if (q === '/history') st.history.forEach((h) => console.log(`  ${bold(h.role)}: ${h.content.replace(/\n+/g, ' ')}`));
      else if (/^\/open\s+\d+$/.test(q)) {
        const n = Number(q.split(/\s+/)[1]) - 1;
        if (!st.matches[n]) console.log('  No such article; see /news.');
        else { st.focus = n; console.log(`  Investigating ${hypoTag(st.matches[n])}${st.matches[n].headline}${isSample(st.matches[n]) ? dim(' (made-up article for this demo, not real news)') : ''}`); }
      } else if (q.startsWith('/')) console.log('  Unknown command.');
      else {
        const r = await T.thesisChat(st.thesis, st.history, q, { evidence: st.matches.map(asHypothetical), focus: st.focus }, opts);
        if (r.ok) st.history = r.history;
        printAnswer(r);
      }
    } catch (err) { console.log(c('31', `  error: ${err.message}`)); }
    prompt();
  }
  rl.on('close', () => { queue.then(() => { console.log(dim('\nNothing was saved, monitored or emailed.')); process.exit(0); }); });
}

main().catch((err) => { console.error(err); process.exit(1); });

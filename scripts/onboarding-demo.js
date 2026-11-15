// Interactive demo of the THESIS engine in server/thesis.js, all in one session:
//   onboarding chat -> Explore Investments -> select 1-5 tickers -> confirm -> Create Thesis Draft
//   -> review / edit / regenerate assumptions -> confirm assumptions -> match SAMPLE news (/news)
//   npm run demo:onboarding                uses real Gemini if GEMINI_API_KEY is in .env
//   npm run demo:onboarding -- --offline   forces the rule-based fallback
// Everything lives in memory for this session only. Nothing is saved, monitored, traded or emailed.
require('dotenv').config();
const readline = require('readline');
const { onboardingTurn, createOnboardingSession, exploreInvestments, selectAssets, confirmSelection, createThesisDraft,
  viewAssumptions, editAssumption, editChallenge, suggestChallenge, addAssumption, removeAssumption, regenerateAssumptions, confirmAssumptions, getConfirmedThesis, matchNewsDetailed } = require('../server/thesis');
const { printMatches } = require('./demo-news-matching');
const SAMPLE_NEWS = require('./sample-news');
const llm = require('../server/llm');

const offline = process.argv.includes('--offline');
const opts = { forceFallback: offline };
const tty = process.stdin.isTTY;
const c = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);

const mode = offline ? 'FALLBACK (forced with --offline)'
  : llm.isConfigured() ? `REAL GEMINI (model ${process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite'}${process.env.FALLBACK_GEMINI_MODEL ? `, backup ${process.env.FALLBACK_GEMINI_MODEL}` : ''}); offline rules if Gemini fails`
    : 'FALLBACK (no GEMINI_API_KEY in .env)';

console.log(bold('THESIS demo') + dim('  ·  Educational research, not investment advice.'));
console.log(`Mode: ${bold(mode)}`);
console.log(dim('Chat to set up your profile, then type "Explore Investments" or "Create Thesis Draft".'));
console.log(dim('Commands: /explore  /select <tickers>  /confirm  /draft  /selection  /profile  /json  /reset  /quit'));
console.log(dim('Assumptions: /assumptions  /edit-assumption N [text | criteria|keep]  /edit-challenge N criteria  /add-assumption text | criteria'));
console.log(dim('             /remove-assumption N  /regenerate-assumptions  /confirm-assumptions  /news (match SAMPLE news)'));
console.log(dim('Each Gemini call is spaced 5 s apart (free-tier limit), so replies can take a few seconds.\n'));

let session = createOnboardingSession();
let showJson = false;
let step = 'chat';          // chat | selecting | confirming | editing | editing_challenge
let editing = null;         // { n, text } while an assumption edit is in progress
let draftRequested = false; // user asked for a draft before choosing assets

const say = (t) => console.log(`${c('36', 'thesis>')} ${t}`);
const tagOf = (r) => (r.source === 'gemini' ? c('32', `gemini ${r.model}`) : c('33', `fallback: ${r.fallbackReason}`));
const json = (r) => { if (showJson) { const { session: _s, ...rest } = r; console.log(dim(JSON.stringify(rest, null, 2))); } };

function fmtProfile(p) {
  const known = Object.entries(p).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`);
  const tt = session.profileDetails && session.profileDetails.timelineText;
  return (known.length ? known.join(' · ') : '(nothing yet)') + (tt ? ` · timeline as stated: "${tt}"` : '');
}

function printTurn(r) {
  say(r.displayText);
  const bits = [`intent: ${r.intent}`];
  if (r.activeFlow) bits.push(`flow: ${r.activeFlow}`);
  bits.push(`ready: ${r.readyToProceed ? 'yes' : 'no'}`);
  if (r.missingFields.length) bits.push(`missing: ${r.missingFields.join(', ')}`);
  console.log(dim(`   [${tagOf(r)}${dim(' · ' + bits.join(' · '))}]`));
  console.log(dim(`   profile: ${fmtProfile(r.profile)}`));
  if (r.nextSteps.length) console.log(`   ${bold('next steps:')} ${r.nextSteps.map((x) => `[ ${x.label} ]`).join('  ')}  ${dim('(type one; nothing happens automatically)')}`);
  if (r.corrections.length) console.log(dim(`   corrected: ${r.corrections.map((x) => `${x.field} ${x.from} → ${x.to}`).join(', ')}`));
  if (r.tickers.length) console.log(dim(`   assets: ${r.tickers.map((t) => `${t.symbol}${t.supported ? '' : ' (not supported)'}`).join(', ')}  ·  monitoring activated: ${r.monitoringActivated}`));
  if (r.ambiguities.length) console.log(dim(`   ambiguous: ${r.ambiguities.join(' | ')}`));
  json(r);
  console.log('');
}

async function doExplore() {
  const r = await exploreInvestments(session, opts);
  session = r.session;
  say(r.intro);
  console.log(dim(`   [${tagOf(r)}]`));
  if (r.horizonNote) console.log(`\n   ${c('33', '⚠')} ${r.horizonNote}`);
  for (const cat of r.categories) {
    console.log(`\n   ${bold(cat.name)} ${dim(`· volatility: ${cat.volatility}`)}`);
    console.log(`     ${cat.plainExplanation}`);
    console.log(dim(`     ${cat.howItBehaves}`));
    if (cat.fitNote) console.log(`     ${c('33', 'For you:')} ${cat.fitNote}`);
    console.log(cat.selectable ? `     ${c('36', 'Selectable:')} ${cat.assets.map((a) => a.symbol).join(', ')}` : dim('     (context only; not selectable in THESIS)'));
  }
  json(r);
  console.log(`\n   ${bold(`Type 1-5 tickers or company names to research`)} ${dim('(e.g. "VOO, NVIDIA"). Nothing is selected until you choose.')}\n`);
  step = 'selecting';
}

function doSelect(input) {
  const r = selectAssets(input, session);
  session = r.session;
  say(r.displayText);
  json(r);
  console.log('');
  step = r.ok ? 'confirming' : 'selecting';
}

async function doConfirm() {
  const r = confirmSelection(session);
  session = r.session;
  say(r.displayText);
  console.log('');
  if (!r.ok) { step = 'selecting'; return; }
  step = 'chat';
  if (draftRequested) await doDraft();
  else console.log(`   ${bold('next steps:')} [ Create Thesis Draft ]  ${dim('or /select to change your choice')}\n`);
}

async function doDraft() {
  draftRequested = true;
  const r = await createThesisDraft(session, opts);
  if (!r.ok) {
    say(r.displayText);
    console.log('');
    if (r.reason === 'selection_not_confirmed') step = session.selection.pending.length ? 'confirming' : 'selecting';
    if (r.reason === 'selection_not_confirmed' && !session.selection.pending.length) {
      console.log(dim(`   Selectable: run /explore for explanations, or type tickers now.\n`));
    }
    return;
  }
  draftRequested = false;
  console.log('');
  for (const line of r.displayText.split('\n')) {
    console.log(/^(THESIS DRAFT|Assumptions to watch|Risks and uncertainties)/.test(line) ? `   ${bold(line)}` : `   ${line}`);
  }
  console.log(dim(`\n   [${tagOf(r)} · saved: ${r.saved} · monitoring activated: ${r.monitoringActivated}${r.toppedUp ? ` · ${r.toppedUp} assumption(s) from asset templates` : ''}]`));
  json(r);
  session = r.session;
  console.log(`\n   ${bold('Review the assumptions:')} /confirm-assumptions to accept, /edit-assumption N to rewrite one, /regenerate-assumptions for new ones.\n`);
}

function showReview(r, extra) {
  r.displayText.split('\n').forEach((line, i) => console.log(/^(Proposed|Confirmed) assumptions/.test(line) ? `   ${bold(line)}` : i === 0 ? `${c('36', 'thesis>')} ${line}` : `   ${line}`));
  if (extra) console.log(dim(`   ${extra}`));
  json(r);
  console.log('');
}

// "/edit-assumption 2" (asks for the text), "/edit-assumption 2 New text" (asks about the criteria),
// "/edit-assumption 2 New text | new criteria" or "/edit-assumption 2 New text | keep"
async function startEdit(arg) {
  const m = arg.match(/^(\d+)\s*(.*)$/);
  if (!m) { say('Usage: /edit-assumption N [new text | new criteria or keep]\n'); return; }
  const n = Number(m[1]);
  const [text, crit] = m[2].split('|').map((x) => x && x.trim());
  if (text && crit) { applyEdit(n, text, /^keep$/i.test(crit) ? { keep: true } : { criteria: crit }); return; }
  const v = viewAssumptions(session);
  if (!v.ok) { say(v.displayText + '\n'); return; }
  const cur = v.assumptions[n - 1];
  if (!cur) { say(`Choose an assumption number from 1 to ${v.assumptions.length}.\n`); return; }
  editing = { n };
  if (text) { await askCriteria(text); return; }
  step = 'editing';
  say(`Current: ${cur.text}\n   Type the new wording for assumption ${n}:`);
}
// After new wording: show current vs suggested criteria and require an explicit choice.
async function askCriteria(text) {
  const r = await suggestChallenge(session, editing.n, text, opts);
  if (!r.ok) { say(r.displayText + '\n'); step = 'chat'; editing = null; return; }
  Object.assign(editing, { text, suggestion: r.suggestion, current: r.currentChallenge });
  step = 'editing_challenge';
  say('This new wording may need different "could be challenged by" criteria.');
  console.log(`   current:   ${r.currentChallenge}`);
  console.log(`   suggested: ${r.suggestion} ${dim(`[${tagOf(r)}]`)}`);
  console.log(`   ${bold("Type 'use' for the suggestion, 'keep' for the current criteria, or write your own.")}`);
}
function applyEdit(n, text, choice) {
  const r = choice.keep ? editAssumption(session, n, text, null, { keepChallenge: true }) : editAssumption(session, n, text, choice.criteria);
  if (r.reason === 'challenge_decision_needed') { say(r.displayText + '\n'); return; }
  session = r.session;
  showReview(r);
}

async function doNews() {
  const t = getConfirmedThesis(session);
  if (!t) {
    say(session.thesisDraft ? 'Confirm your assumptions first (/confirm-assumptions); news is only compared against confirmed assumptions.\n' : 'Create a thesis draft and confirm its assumptions first.\n');
    return;
  }
  say(`Matching ${SAMPLE_NEWS.length} SAMPLE articles (not real news) against your confirmed thesis. Nothing is saved, monitored or emailed.`);
  printMatches(t, await matchNewsDetailed(t, SAMPLE_NEWS, opts));
  console.log('');
}

const isExplore = (l) => /^\/explore$|^(explore( investments)?|1)$/i.test(l);
const isDraft = (l) => /^\/draft$|^(create( a)?( thesis)? draft|create thesis|2)$/i.test(l);
const isYes = (l) => /^(\/confirm|y|yes|yep|yeah|confirm|ok|okay|sure)\b[.!]?$/i.test(l);
const isNo = (l) => /^(n|no|nope|change|change them|different)\b[.!]?$/i.test(l);
const looksLikeChat = (l) => /\?\s*$/.test(l) || l.split(/\s+/).length > 7;

(async () => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
  const prompt = () => tty && rl.prompt();
  rl.setPrompt(c('35', 'you> '));
  prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (!tty && line) console.log(`${c('35', 'you>')} ${line}`); // piped input: echo so the transcript reads naturally
    if (!line && step !== 'editing_challenge') { prompt(); continue; }
    if (line === '/quit' || line === '/exit') break;
    try {
      if (line === '/json') { showJson = !showJson; console.log(dim(`full JSON ${showJson ? 'on' : 'off'}\n`)); }
      else if (line === '/profile') console.log(dim(`profile: ${fmtProfile(session.profile)}  ·  asked: ${session.askedFields.join(', ') || '-'}\n`));
      else if (line === '/selection') console.log(dim(`pending: ${session.selection.pending.join(', ') || '-'}  ·  confirmed: ${session.selection.confirmed.join(', ') || '-'}\n`));
      else if (line === '/reset') { session = createOnboardingSession(); step = 'chat'; draftRequested = false; editing = null; console.log(dim('conversation cleared\n')); }
      else if (step === 'editing') await askCriteria(line);
      else if (step === 'editing_challenge') {
        if (!line) console.log(`   ${bold("Type 'use', 'keep', or write your own criteria.")}`); // no silent default
        else {
          const choice = /^(use|use it|suggested|yes|y)$/i.test(line) ? { criteria: editing.suggestion } : /^keep$/i.test(line) ? { keep: true } : { criteria: line };
          step = 'chat'; applyEdit(editing.n, editing.text, choice); editing = null;
        }
      }
      else if (line.startsWith('/edit-challenge')) { const m = line.slice('/edit-challenge'.length).trim().match(/^(\d+)\s+(.+)$/); const r = m ? editChallenge(session, Number(m[1]), m[2]) : { displayText: 'Usage: /edit-challenge N new criteria', session }; session = r.session; showReview(r); }
      else if (line === '/assumptions') showReview(viewAssumptions(session));
      else if (line.startsWith('/edit-assumption')) await startEdit(line.slice('/edit-assumption'.length).trim());
      else if (line.startsWith('/add-assumption')) { const [t, ch] = line.slice('/add-assumption'.length).split('|').map((x) => x.trim()); const r = addAssumption(session, t, ch); session = r.session; showReview(r); }
      else if (line.startsWith('/remove-assumption')) { const r = removeAssumption(session, line.slice('/remove-assumption'.length).trim()); session = r.session; showReview(r); }
      else if (line === '/regenerate-assumptions') { const r = await regenerateAssumptions(session, opts); session = r.session; showReview(r, r.ok ? `[gemini ${r.model}]` : `[${r.fallbackReason}]`); }
      else if (line === '/confirm-assumptions') { const r = confirmAssumptions(session); session = r.session; showReview(r); if (r.ok) console.log(`   ${bold('next:')} /news to compare SAMPLE news with these confirmed assumptions\n`); }
      else if (line === '/news') await doNews();
      else if (isExplore(line)) await doExplore();
      else if (isDraft(line)) await doDraft();
      else if (line.startsWith('/select ')) doSelect(line.slice(8));
      else if (line === '/confirm' || (step === 'confirming' && isYes(line))) await doConfirm();
      else if (step === 'confirming' && isNo(line)) { step = 'selecting'; say('No problem. Type the 1-5 tickers you would like instead.\n'); }
      else if ((step === 'selecting' || step === 'confirming') && !looksLikeChat(line)) doSelect(line);
      else {
        const r = await onboardingTurn(line, session, opts);
        session = r.session;
        printTurn(r);
      }
    } catch (err) {
      console.log(c('31', `error: ${err.message}\n`)); // should not happen: the engine never throws on LLM failure
    }
    prompt();
  }
  rl.close();
  console.log(dim('bye'));
})();

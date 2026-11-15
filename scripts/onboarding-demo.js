// Interactive demo of the THESIS engine in server/thesis.js, all in one session:
//   onboarding chat -> Explore Investments -> select 1-5 tickers -> confirm -> Create Thesis Draft
//   npm run demo:onboarding                uses real Gemini if GEMINI_API_KEY is in .env
//   npm run demo:onboarding -- --offline   forces the rule-based fallback
// Everything lives in memory for this session only. Nothing is saved, monitored, traded or emailed.
require('dotenv').config();
const readline = require('readline');
const { onboardingTurn, createOnboardingSession, exploreInvestments, selectAssets, confirmSelection, createThesisDraft } = require('../server/thesis');
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
console.log(dim('Each Gemini call is spaced 5 s apart (free-tier limit), so replies can take a few seconds.\n'));

let session = createOnboardingSession();
let showJson = false;
let step = 'chat';          // chat | selecting | confirming
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
    if (!line) { prompt(); continue; }
    if (line === '/quit' || line === '/exit') break;
    try {
      if (line === '/json') { showJson = !showJson; console.log(dim(`full JSON ${showJson ? 'on' : 'off'}\n`)); }
      else if (line === '/profile') console.log(dim(`profile: ${fmtProfile(session.profile)}  ·  asked: ${session.askedFields.join(', ') || '-'}\n`));
      else if (line === '/selection') console.log(dim(`pending: ${session.selection.pending.join(', ') || '-'}  ·  confirmed: ${session.selection.confirmed.join(', ') || '-'}\n`));
      else if (line === '/reset') { session = createOnboardingSession(); step = 'chat'; draftRequested = false; console.log(dim('conversation cleared\n')); }
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

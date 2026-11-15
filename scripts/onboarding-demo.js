// Interactive demo of the onboarding engine (server/thesis.js onboardingTurn).
//   npm run demo:onboarding            uses real Gemini if GEMINI_API_KEY is in .env
//   npm run demo:onboarding -- --offline   forces the rule-based fallback
// Conversation history lives in memory for this session only. Nothing is saved, no thesis is
// created, nothing is monitored and no email is sent.
require('dotenv').config();
const readline = require('readline');
const { onboardingTurn, createOnboardingSession } = require('../server/thesis');
const llm = require('../server/llm');

const offline = process.argv.includes('--offline');
const tty = process.stdin.isTTY;
const c = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('2', s);

const mode = offline ? 'FALLBACK (forced with --offline)'
  : llm.isConfigured() ? `REAL GEMINI (model ${process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite'}${process.env.FALLBACK_GEMINI_MODEL ? `, backup ${process.env.FALLBACK_GEMINI_MODEL}` : ''}); offline rules if Gemini fails`
    : 'FALLBACK (no GEMINI_API_KEY in .env)';

console.log(c('1', 'THESIS onboarding demo') + dim('  ·  Educational research, not investment advice.'));
console.log(`Mode: ${c('1', mode)}`);
console.log(dim('Type a message. Commands: /json (toggle full result)  /profile  /reset  /quit'));
console.log(dim('Each Gemini call is spaced 5 s apart (free-tier limit), so replies can take a few seconds.\n'));

let session = createOnboardingSession();
let showJson = false;

function fmtProfile(p) {
  const known = Object.entries(p).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`);
  return known.length ? known.join(' · ') : '(nothing yet)';
}

function printTurn(r) {
  console.log(`${c('36', 'thesis>')} ${r.displayText}`);
  const tag = r.source === 'gemini' ? c('32', `gemini ${r.model}`) : c('33', `fallback: ${r.fallbackReason}`);
  const bits = [`intent: ${r.intent}`];
  if (r.activeFlow) bits.push(`flow: ${r.activeFlow}`);
  bits.push(`ready: ${r.readyToProceed ? 'yes' : 'no'}`);
  if (r.missingFields.length) bits.push(`missing: ${r.missingFields.join(', ')}`);
  console.log(dim(`   [${tag}${dim(' · ' + bits.join(' · '))}]`));
  console.log(dim(`   profile: ${fmtProfile(r.profile)}`));
  if (r.nextSteps.length) console.log(`   ${c('1', 'next steps:')} ${r.nextSteps.map((x) => `[ ${x.label} ]`).join('  ')}  ${dim('(offered only; nothing happens automatically)')}`);
  if (r.corrections.length) console.log(dim(`   corrected: ${r.corrections.map((x) => `${x.field} ${x.from} → ${x.to}`).join(', ')}`));
  if (r.tickers.length) console.log(dim(`   assets: ${r.tickers.map((t) => `${t.symbol}${t.supported ? '' : ' (not supported)'}`).join(', ')}  ·  monitoring activated: ${r.monitoringActivated}`));
  if (r.ambiguities.length) console.log(dim(`   ambiguous: ${r.ambiguities.join(' | ')}`));
  if (showJson) { const { session: _s, ...rest } = r; console.log(dim(JSON.stringify(rest, null, 2))); }
  console.log('');
}

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
    if (line === '/json') { showJson = !showJson; console.log(dim(`full JSON ${showJson ? 'on' : 'off'}\n`)); prompt(); continue; }
    if (line === '/profile') { console.log(dim(`profile: ${fmtProfile(session.profile)}  ·  asked: ${session.askedFields.join(', ') || '-'}\n`)); prompt(); continue; }
    if (line === '/reset') { session = createOnboardingSession(); console.log(dim('conversation cleared\n')); prompt(); continue; }
    try {
      const r = await onboardingTurn(line, session, { forceFallback: offline });
      session = r.session;
      printTurn(r);
    } catch (err) {
      console.log(c('31', `error: ${err.message}\n`)); // should not happen: onboardingTurn never throws on LLM failure
    }
    prompt();
  }
  rl.close();
  console.log(dim('bye'));
})();

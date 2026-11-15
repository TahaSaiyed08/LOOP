// Demo: the same SAMPLE news matched against two different user-confirmed theses.
//   npm run demo:news                 real Gemini (GEMINI_MODEL, backup FALLBACK_GEMINI_MODEL) from .env
//   npm run demo:news -- --offline    conservative fallback only (no API calls)
// The theses are built through the real flow (select -> draft -> edit -> confirm assumptions), with the
// draft step offline so the assumptions are exactly the ones shown. Nothing is saved, monitored or emailed.
require('dotenv').config();
const { createOnboardingSession, selectAssets, confirmSelection, createThesisDraft, editAssumption, confirmAssumptions, getConfirmedThesis, matchNewsDetailed } = require('../server/thesis');
const llm = require('../server/llm');
const SAMPLE = require('./sample-news');

const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);
const STANCE_COLOR = { challenges: '31', supports: '32', neutral: '33' };

function printMatches(thesis, { matches, stats }, indent = '   ') {
  const by = stats.analyzedBy === 'gemini' ? c('32', `gemini ${stats.models.join(', ')}`) : stats.analyzedBy === 'none' ? 'none' : c('33', `${stats.analyzedBy}: ${stats.fallbackReason}`);
  const sent = [stats.direct && `${stats.direct} direct`, stats.viaEtfHolding && `${stats.viaEtfHolding} via a large ETF holding (at most indirect)`, stats.unscoped && `${stats.unscoped} unscoped`].filter(Boolean).join(', ');
  console.log(dim(`${indent}${stats.usable} articles · ${stats.skippedUnrelated} skipped as unrelated before Gemini${stats.skipped.length ? ` (${stats.skipped.join(', ')})` : ''} · ${stats.candidates} sent in ${stats.batches} batch(es)${sent ? `: ${sent}` : ''} · analysed by: `) + by);
  if (stats.reason) console.log(dim(`${indent}(${stats.reason})`));
  if (!matches.length) { console.log(`${indent}No matches.`); return; }
  for (const m of matches) {
    const a = thesis.assumptions[m.assumptionIndex];
    const note = m.stanceNote === 'headline_only' ? ` (assessed ${m.assessedStance}; shown as neutral: headline only, provisional)`
      : m.stanceNote === 'indirect' ? ` (assessed ${m.assessedStance}; shown as neutral: indirect relevance)`
        : m.stanceNote === 'unanalyzed' ? ' (not analysed: AI unavailable)' : '';
    console.log(`${indent}${c(STANCE_COLOR[m.stance], m.stance.toUpperCase())}${dim(note)}  ${bold(m.ticker)} · ${m.headline}`);
    console.log(dim(`${indent}  relevance: ${m.relevance} · evidence: ${m.evidence} · source: ${m.url || 'none (missing or invalid URL)'} · by: ${m.analyzedBy}${m.model ? ` ${m.model}` : ''}`));
    console.log(`${indent}  assumption ${m.assumptionIndex + 1}: ${dim(a)}`);
    console.log(`${indent}  why it matters: ${m.whyItMatters}`);
  }
}

const nulls = { amount: null, cadence: null, timelineYears: null, currency: null, experience: null, riskComfort: null, purpose: null };
async function buildThesis(symbols, text, challenge) {
  let s = createOnboardingSession();
  s.profile = { ...nulls, amount: 50, cadence: 'monthly', timelineYears: 5, experience: 'beginner', riskComfort: 'medium', purpose: 'build long-term wealth' };
  s = confirmSelection(selectAssets(symbols, s).session).session;
  s = (await createThesisDraft(s, { forceFallback: true })).session;
  s = editAssumption(s, 1, text, challenge).session;
  return getConfirmedThesis(confirmAssumptions(s).session);
}

async function main() {
  const offline = process.argv.includes('--offline');
  const mode = offline ? 'FALLBACK (forced with --offline)'
    : llm.isConfigured() ? `REAL GEMINI (model ${process.env.GEMINI_MODEL || 'default'}${process.env.FALLBACK_GEMINI_MODEL ? `, backup ${process.env.FALLBACK_GEMINI_MODEL}` : ''})` : 'FALLBACK (no GEMINI_API_KEY)';
  console.log(bold('THESIS news-to-thesis matching demo') + dim('  ·  SAMPLE articles, not real news  ·  Educational research, not investment advice.'));
  console.log(`Mode: ${bold(mode)}\n`);
  const theses = [
    ['Thesis A', await buildThesis('NVDA', 'Demand for NVIDIA AI data-center chips keeps growing as cloud companies expand AI infrastructure.', 'NVIDIA lowering guidance, or cloud customers cutting AI infrastructure spending.')],
    ['Thesis B', await buildThesis('VOO', 'Earnings of the S&P 500 companies held in VOO stay resilient over the next five years.', 'Falling S&P 500 earnings, profit warnings across sectors, or a US recession.')],
  ];
  for (const [label, t] of theses) {
    console.log(bold(`${label}: ${t.selectedAssets.map((a) => a.symbol).join(', ')}`) + dim(` · assumptions ${t.assumptionStatus}`));
    t.assumptions.forEach((a, i) => console.log(dim(`   ${i + 1}. ${a}`)));
    printMatches(t, await matchNewsDetailed(t, SAMPLE, { forceFallback: offline }));
    console.log('');
  }
  console.log(dim('Nothing was saved, monitored or emailed. matchNews only returns data; the pipeline decides what to do with it.'));
}

if (require.main === module) main();
module.exports = { printMatches };

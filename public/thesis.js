const THESIS_URL = '/api/thesis';

function thesisProfileTheme(value) {
  const tier = String(value || '').toLowerCase();
  if (tier === 'medium' || tier === 'intermediate') return 'medium';
  if (tier === 'high' || tier === 'advanced') return 'high';
  return 'low';
}

try { document.body.dataset.profile = thesisProfileTheme(localStorage.getItem('tier')); } catch (error) { document.body.dataset.profile = 'low'; }

// The project uses USD for both portfolio and thesis amounts.
const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
});
const cadenceLabels = new Map([
  ['weekly', 'every week'],
  ['biweekly', 'every two weeks'],
  ['monthly', 'every month'],
  ['one_time', 'one time'],
]);

const horizon = new Intl.NumberFormat('en-US', { style: 'unit', unit: 'year', unitDisplay: 'long' });

// Real matches from the backend (Contract C match shape). Empty until a seed has been matched to the thesis.
async function renderThesisNews(assumptions) {
  const list = document.getElementById('thesis-news');
  const empty = document.getElementById('news-empty');
  let matches = [];
  try {
    const response = await fetch('/api/thesis/news');
    if (response.ok) matches = await response.json();
  } catch (error) {
    console.error(error);
  }
  if (!Array.isArray(matches) || matches.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const news of matches) {
    const assumption = assumptions[news.assumptionIndex];

    const item = document.createElement('li');
    const heading = document.createElement('div');
    heading.className = 'thesis-news-heading';

    const ticker = document.createElement('strong');
    ticker.textContent = news.ticker;

    const headline = document.createElement('a');
    if (/^https?:\/\//i.test(String(news.url || ''))) headline.href = news.url;
    headline.textContent = news.headline;

    const stance = document.createElement('span');
    stance.className = 'thesis-chip';
    stance.dataset.stance = news.stance;
    stance.textContent = ({ supports: '▲ ', challenges: '▼ ', neutral: '● ' }[news.stance] ?? '') + news.stance;

    const explanation = document.createElement('p');
    explanation.textContent = `Why it matters: ${news.whyItMatters}`;

    heading.append(ticker, headline, stance);
    item.append(heading, explanation);
    if (assumption !== undefined) {
      const related = document.createElement('p');
      related.textContent = `Assumption: ${assumption}`;
      item.append(related);
    }
    list.append(item);
  }
}

async function loadThesis() {
  const status = document.getElementById('thesis-status');
  status.hidden = false;
  for (const id of ['thesis-error-box', 'thesis-empty', 'thesis-data', 'news-empty']) document.getElementById(id).hidden = true;
  document.getElementById('thesis-assumptions').replaceChildren();
  document.getElementById('thesis-news').replaceChildren();
  try {
    const response = await fetch(THESIS_URL);
    if (response.status === 204 || (response.status === 404 && THESIS_URL === '/api/thesis')) {
      document.getElementById('thesis-empty').hidden = false;
      return;
    }
    if (!response.ok) throw new Error(`Thesis request failed (${response.status})`);
    const thesis = await response.json();
    if (thesis === null) {
      document.getElementById('thesis-empty').hidden = false;
      return;
    }

    if (
      typeof thesis?.goal !== 'string' ||
      !Number.isFinite(thesis.budget?.amount) ||
      typeof thesis.budget.cadence !== 'string' ||
      typeof thesis.tier !== 'string' ||
      !Number.isFinite(thesis.horizonYears) ||
      !Array.isArray(thesis.assumptions) ||
      !thesis.assumptions.every((assumption) => typeof assumption === 'string')
    ) {
      throw new Error('Invalid thesis data');
    }

    document.getElementById('thesis-goal').textContent = thesis.goal;
    // A budget or horizon of 0 means the user did not state one; say so rather than show $0.
    document.getElementById('thesis-budget').textContent = thesis.budget.amount > 0
      ? `${currency.format(thesis.budget.amount)} USD ${cadenceLabels.get(thesis.budget.cadence) ?? thesis.budget.cadence}`
      : 'Not stated';
    const tier = document.getElementById('thesis-tier');
    tier.textContent = thesis.tier;
    tier.dataset.tier = thesis.tier;
    document.getElementById('thesis-horizon').textContent = thesis.horizonYears > 0 ? horizon.format(thesis.horizonYears) : 'Not stated';

    document.getElementById('assumptions-empty').hidden = thesis.assumptions.length > 0;
    const checklist = document.getElementById('thesis-assumptions');
    for (const assumption of thesis.assumptions) {
      const item = document.createElement('li');
      const check = document.createElement('span');
      check.setAttribute('aria-hidden', 'true');
      check.textContent = '✓';
      item.append(check, assumption);
      checklist.append(item);
    }

    await renderThesisNews(thesis.assumptions);
    document.getElementById('thesis-data').hidden = false;
  } catch (error) {
    console.error(error);
    document.getElementById('thesis-error').textContent = `Could not load your investment thesis (${error.message}).`;
    document.getElementById('thesis-error-box').hidden = false;
  } finally {
    status.hidden = true;
  }
}

document.getElementById('thesis-retry').addEventListener('click', loadThesis);
document.getElementById('thesis-start').addEventListener('click', () => {
  try { localStorage.removeItem('thesis'); } catch (error) { /* storage unavailable: setup still opens if it has no saved thesis */ }
});
loadThesis();

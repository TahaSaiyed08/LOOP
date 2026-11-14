const THESIS_URL = 'fixtures/thesis.sample.json'; // Taha swaps to '/api/thesis' at integration

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
]);

const RECENT_NEWS = [
  {
    ticker: 'VOO',
    headline: 'Vanguard S&P 500 ETF',
    url: 'https://investor.vanguard.com/investment-products/etfs/profile/voo',
    assumptionIndex: 0,
    stance: 'supports',
    whyItMatters: 'One broad fund can spread a small recurring deposit across many companies.',
  },
  {
    ticker: 'ARKK',
    headline: 'ARK Innovation ETF',
    url: 'https://www.ark-funds.com/funds/arkk',
    assumptionIndex: 1,
    stance: 'neutral',
    whyItMatters: 'A fund profile gives a point of comparison for fees without settling the ten-year return question.',
  },
  {
    ticker: 'VOO',
    headline: 'S&P 500 index overview',
    url: 'https://www.spglobal.com/spdji/en/indices/equity/sp-500/',
    assumptionIndex: 0,
    stance: 'challenges',
    whyItMatters: 'Market-cap weighting can leave a broad index heavily exposed to its largest companies.',
  },
];

const horizon = new Intl.NumberFormat('en-US', { style: 'unit', unit: 'year', unitDisplay: 'long' });

function renderThesisNews(assumptions) {
  const list = document.getElementById('thesis-news');
  for (const news of RECENT_NEWS) {
    const assumption = assumptions[news.assumptionIndex];

    const item = document.createElement('li');
    const heading = document.createElement('div');
    heading.className = 'thesis-news-heading';

    const ticker = document.createElement('strong');
    ticker.textContent = news.ticker;

    const headline = document.createElement('a');
    headline.href = news.url;
    headline.textContent = news.headline;

    const stance = document.createElement('span');
    stance.className = 'thesis-chip';
    stance.dataset.stance = news.stance;
    stance.textContent = news.stance;

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
    document.getElementById('thesis-budget').textContent =
      `${currency.format(thesis.budget.amount)} USD ${cadenceLabels.get(thesis.budget.cadence) ?? thesis.budget.cadence}`;
    const tier = document.getElementById('thesis-tier');
    tier.textContent = thesis.tier;
    tier.dataset.tier = thesis.tier;
    document.getElementById('thesis-horizon').textContent = horizon.format(thesis.horizonYears);

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

    renderThesisNews(thesis.assumptions);
    document.getElementById('thesis-data').hidden = false;
  } catch (error) {
    console.error(error);
    document.getElementById('thesis-error').textContent = 'Could not load your investment thesis. Refresh to try again.';
  } finally {
    status.hidden = true;
  }
}

loadThesis();

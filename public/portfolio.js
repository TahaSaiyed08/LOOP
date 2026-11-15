const PORTFOLIO_URL = '/api/paper/portfolio';

const currencyOptions = { style: 'currency', currency: 'USD' };
const percentOptions = { style: 'percent', maximumFractionDigits: 2 };
const currency = new Intl.NumberFormat('en-US', currencyOptions);
const signedCurrency = new Intl.NumberFormat('en-US', { ...currencyOptions, signDisplay: 'exceptZero' });
const signedPercent = new Intl.NumberFormat('en-US', { ...percentOptions, signDisplay: 'exceptZero' });
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 });

function renderChange(element, value, formatter) {
  // Intl percent formatting expects a fraction. The payload uses percentage points.
  const displayValue = formatter === signedPercent ? value / 100 : value;
  element.textContent = formatter.format(displayValue);
  if (value > 0) element.classList.add('is-positive');
  if (value < 0) element.classList.add('is-negative');
}

function tickerRow(symbol) {
  const row = document.createElement('tr');
  const ticker = document.createElement('th');
  ticker.scope = 'row';
  ticker.textContent = symbol;
  row.append(ticker);
  return row;
}

function renderPosition(position) {
  const row = tickerRow(position.ticker);

  for (const value of [
    number.format(position.qty),
    currency.format(position.entryPrice),
    currency.format(position.currentPrice),
  ]) {
    row.insertCell().textContent = value;
  }

  renderChange(row.insertCell(), position.plUsd, signedCurrency);
  renderChange(row.insertCell(), position.plPct, signedPercent);
  return row;
}

function validatePortfolio(portfolio) {
  if (
    !portfolio ||
    !Number.isFinite(portfolio.value) ||
    !Number.isFinite(portfolio.returnPct) ||
    typeof portfolio.whatIfLine !== 'string' ||
    !Array.isArray(portfolio.positions) ||
    !portfolio.positions.every((position) =>
      position &&
      typeof position.ticker === 'string' &&
      [position.qty, position.entryPrice, position.currentPrice, position.plUsd, position.plPct].every(Number.isFinite)
    )
  ) {
    throw new Error('Invalid portfolio data');
  }
}

async function loadPortfolio() {
  const status = document.getElementById('portfolio-status');
  try {
    const response = await fetch(PORTFOLIO_URL);
    if (!response.ok) throw new Error(`Portfolio request failed (${response.status})`);
    const portfolio = await response.json();
    validatePortfolio(portfolio);

    document.getElementById('portfolio-value').textContent = currency.format(portfolio.value);
    renderChange(document.getElementById('portfolio-return'), portfolio.returnPct, signedPercent);
    document.getElementById('portfolio-count').textContent = number.format(portfolio.positions.length);
    document.getElementById('portfolio-what-if').textContent = portfolio.whatIfLine;

    document.getElementById('portfolio-rows').append(...portfolio.positions.map(renderPosition));
    document.getElementById('portfolio-empty').hidden = portfolio.positions.length > 0;
    document.getElementById('portfolio-table').hidden = portfolio.positions.length === 0;
    document.getElementById('portfolio-data').hidden = false;
  } catch (error) {
    console.error(error);
    document.getElementById('portfolio-error').textContent = 'Could not load your paper portfolio. Refresh to try again.';
  } finally {
    status.hidden = true;
  }
}

loadPortfolio();

function initializePortfolioAvatar(button) {
  const figure = button.querySelector('.portfolio-avatar-figure');
  const coins = button.querySelectorAll('.portfolio-avatar-coin');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const trajectories = [
    [-24, -22], [-13, -34], [0, -39], [13, -34], [24, -22],
  ];
  let effects = [];

  button.addEventListener('click', () => {
    effects.forEach((effect) => effect.cancel());
    const still = reducedMotion.matches;

    effects = Array.from(coins, (coin, index) => {
      const [x, y] = trajectories[index];
      const peak = `translate(${x}px, ${y}px)`;
      return coin.animate(still ? [
        { opacity: 1, transform: peak },
        { opacity: 1, transform: peak },
      ] : [
        { opacity: 0, transform: 'translate(0, 0) scale(0.6)' },
        { opacity: 1, transform: `${peak} rotate(${x}deg)`, offset: 0.55 },
        { opacity: 0, transform: `translate(${x}px, ${y + 15}px) rotate(${x * 2}deg)` },
      ], { duration: still ? 230 : 520, easing: 'ease-out' });
    });

    if (!still) {
      effects.push(figure.animate([
        { transform: 'translateY(0)' },
        { transform: 'translateY(-12px)', offset: 0.44 },
        { transform: 'translateY(0)' },
      ], { duration: 380, easing: 'ease-in-out' }));
    }
  });

  reducedMotion.addEventListener('change', () => {
    effects.forEach((effect) => effect.cancel());
  });
}

initializePortfolioAvatar(document.querySelector('.portfolio-avatar'));

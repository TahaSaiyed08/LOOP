const PORTFOLIO_URL = 'fixtures/portfolio.sample.json'; // Taha swaps to '/api/paper/portfolio'

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

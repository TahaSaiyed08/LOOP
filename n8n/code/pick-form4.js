// n8n Code node "Pick Form 4": from each company's recent filings, keep Form 4s from the last 30 days
// (newest 4) and emit one item per filing with the URL of its raw XML.
const targets = $('EDGAR targets').all();
const subs = $('SEC submissions').all(); // 1:1 with targets, same order
const cutoff = Date.now() - 30 * 86400000;
const out = [];

subs.forEach((s, idx) => {
  const t = targets[idx] && targets[idx].json;
  const recent = s.json && s.json.filings && s.json.filings.recent;
  if (!t || !recent || !Array.isArray(recent.form)) return;
  let kept = 0;
  for (let k = 0; k < recent.form.length && kept < 4; k++) {
    if (recent.form[k] !== '4') continue;
    if (new Date(recent.filingDate[k]).getTime() < cutoff) continue;
    const acc = String(recent.accessionNumber[k]).replace(/-/g, '');
    const doc = String(recent.primaryDocument[k]).replace(/^xsl[^/]*\//, ''); // raw XML, not the HTML rendering
    out.push({ json: { ticker: t.ticker, filingDate: recent.filingDate[k], url: `https://www.sec.gov/Archives/edgar/data/${Number(t.cik)}/${acc}/${doc}` } });
    kept++;
  }
});
return out; // may be empty: the node has "Always Output Data" on so the run continues

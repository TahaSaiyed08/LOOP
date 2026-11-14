// n8n Code node "Fill email template": renders Contract E fields into the email HTML.
// >>> Replace TEMPLATE with the contents of Dianne's email-template.html (it uses {{ticker}}-style placeholders). <<<
// The one below is a TEMPORARY placeholder so the branch works before her file arrives.
const TEMPLATE = `<div style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif;color:#1a1a1a">
<h2>A development affects your thesis</h2>
<p><strong>{{ticker}}</strong>: {{headline}}</p>
<p><strong>Why it matters:</strong> {{whyItMatters}}</p>
<p>Your goal: <em>{{thesisGoal}}</em></p>
<p><a href="{{link}}" style="background:#1f6feb;color:#fff;padding:10px 16px;text-decoration:none;border-radius:6px">View on your thesis</a></p>
<p style="font-size:12px;color:#666">Educational research, not investment advice.</p></div>`;

const body = $input.first().json.body || $input.first().json; // Webhook node nests the POST body under `body`
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeLink = /^https:\/\//i.test(body.link || '') ? body.link : '#';

const html = TEMPLATE.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => (key === 'link' ? esc(safeLink) : esc(body[key])));
return [{ json: { to: body.to, subject: `A development affects your thesis: ${body.ticker || ''}`.trim(), html } }];

// Inspect and verify the THESIS tables in the database chosen by LOOP_DB=postgres + PGSCHEMA (TigerData).
// Reads only: everything runs in a READ ONLY transaction (the connection's CREATE SCHEMA IF NOT EXISTS is a
// no-op once the schema exists). Prints no credentials or host. Never runs in automated tests.
//
//   npm run db:inspect                       tables, row counts, foreign keys, latest theses / evidence / chats
//   npm run db:verify                        + relationship checks; exits 1 on any violation
//   npm run db:inspect -- --snapshot F       also save every row's primary key + content hash to F (JSON)
//   npm run db:inspect -- --compare F        fail if any row in snapshot F is gone; report changed rows
//
// Relationship checks (--verify): chat messages belong to their conversation's thesis and user; the
// conversation's thesis belongs to that user; message seq is 1..n with non-decreasing times and user/assistant
// pairs; every citation resolves to a stored match OF THE SAME THESIS whose article is the cited article (and
// URL); an investigation's match belongs to its thesis; matches, checks, notifications, sessions and events
// point to the right thesis / article / user; notification status agrees with its timestamps.
require('dotenv').config();
const fs = require('fs');

if (process.env.LOOP_TEST === '1') { console.error('db-inspect refuses to run in a test (LOOP_TEST=1).'); process.exit(1); }
if (String(process.env.LOOP_DB || '').trim().toLowerCase() !== 'postgres') { console.error('db-inspect needs LOOP_DB=postgres (use npm run db:inspect).'); process.exit(1); }

const { connectPostgres, redact } = require('../server/persistence/db');

const args = process.argv.slice(2);
const VERIFY = args.includes('--verify');
const argAfter = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const SNAPSHOT = argAfter('--snapshot');
const COMPARE = argAfter('--compare');

const TABLES = {
  schema_migrations: 'version', kv_store: 'key', users: 'user_id', onboarding_sessions: 'session_id', session_events: 'event_id',
  theses: 'thesis_id', news_articles: 'article_id', thesis_article_checks: "thesis_id || '|' || article_id || '|' || assumption_version",
  thesis_matches: 'match_id', notifications: 'notification_id', chat_conversations: 'conversation_id', chat_messages: 'message_id',
};

const { CHECKS } = require('../server/persistence/checks');

const line = (s = '') => console.log(s);
const iso = (d) => (d ? new Date(d).toISOString() : '-');

async function main() {
  const db = await connectPostgres(String(process.env.DATABASE_URL || '').trim());
  let failures = 0;
  try {
    await db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION READ ONLY');
      const q = async (sql, p) => (await tx.query(sql, p)).rows;
      const [{ cs, ver }] = await q('SELECT current_schema() AS cs, version() AS ver');
      line(`backend: postgres (${ver.split(' on ')[0]}) | schema: ${cs} | TLS: ${process.env.PGSSLROOTCERT ? 'pinned CA, verified' : 'default'}`);
      line(`migrations: ${(await q('SELECT name, applied_at FROM schema_migrations ORDER BY version')).map((r) => `${r.name} @ ${iso(r.applied_at)}`).join(', ') || 'none'}`);

      line('\ntables (row counts):');
      const present = new Set((await q('SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()')).map((r) => r.table_name));
      for (const t of Object.keys(TABLES)) line(`  ${t.padEnd(22)} ${present.has(t) ? (await q(`SELECT count(*)::int AS n FROM ${t}`))[0].n : 'MISSING'}`);
      const pub = await q(`SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`);
      line(`  public schema (untouched by THESIS): ${pub.map((r) => `${r.table_name}${r.table_type === 'VIEW' ? ' (view)' : ''}`).join(', ') || 'empty'}`);

      const fks = await q(`SELECT conrelid::regclass::text AS tbl, confrelid::regclass::text AS ref, pg_get_constraintdef(oid) AS def
        FROM pg_constraint WHERE contype = 'f' AND connamespace = current_schema()::regnamespace ORDER BY 1, 2`);
      line(`\nforeign keys (${fks.length}):`);
      for (const f of fks) line(`  ${f.tbl} -> ${f.ref}: ${f.def.replace(/^FOREIGN KEY /, '')}`);

      line('\nlatest theses:');
      for (const r of await q(`SELECT t.thesis_id, t.user_id, t.origin, t.goal, t.monitoring_status, jsonb_array_length(t.assumptions) AS na, t.selected_assets, t.created_at, t.confirmed_at,
          (SELECT count(*)::int FROM thesis_matches m WHERE m.thesis_id = t.thesis_id) AS matches,
          (SELECT count(*)::int FROM chat_conversations c WHERE c.thesis_id = t.thesis_id) AS convs
          FROM theses t ORDER BY t.created_at DESC LIMIT 8`)) {
        line(`  ${r.thesis_id} user=${r.user_id} ${r.origin}/${r.monitoring_status} assumptions=${r.na} assets=${JSON.stringify(r.selected_assets).slice(0, 60)} matches=${r.matches} chats=${r.convs} created=${iso(r.created_at)}`);
        line(`    goal: ${String(r.goal || '').slice(0, 100)}`);
      }
      line('\nlatest evidence (match -> article):');
      for (const r of await q(`SELECT m.match_id, m.thesis_id, m.stance, m.assumption_index, m.analyzed_by, m.assessed_at, a.article_id, a.ticker, a.headline, a.publisher, a.published_at, a.ingested_at, a.seen_count
          FROM thesis_matches m JOIN news_articles a USING (article_id) ORDER BY m.assessed_at DESC LIMIT 8`)) {
        line(`  ${r.match_id} thesis=${r.thesis_id} ${r.stance} A${r.assumption_index + 1} by=${r.analyzed_by} assessed=${iso(r.assessed_at)}`);
        line(`    ${r.article_id} ${r.ticker} "${String(r.headline).slice(0, 70)}" (${r.publisher || '-'}) published=${iso(r.published_at)} ingested=${iso(r.ingested_at)} seen=${r.seen_count}`);
      }
      line('\nnotifications:');
      for (const r of await q('SELECT notification_id, thesis_id, match_id, status, attempts, reason, created_at, sent_at FROM notifications ORDER BY created_at DESC LIMIT 8')) {
        line(`  ${r.notification_id} thesis=${r.thesis_id} match=${r.match_id} ${r.status} attempts=${r.attempts} ${r.reason || ''} created=${iso(r.created_at)} sent=${iso(r.sent_at)}`);
      }
      line('\nlatest conversations:');
      for (const r of await q(`SELECT c.conversation_id, c.thesis_id, c.user_id, c.mode, c.match_id, c.title, c.created_at, c.updated_at,
          (SELECT count(*)::int FROM chat_messages m WHERE m.conversation_id = c.conversation_id) AS n,
          (SELECT coalesce(sum(jsonb_array_length(citations)), 0)::int FROM chat_messages m WHERE m.conversation_id = c.conversation_id) AS cits
          FROM chat_conversations c ORDER BY c.updated_at DESC LIMIT 8`)) {
        line(`  ${r.conversation_id} thesis=${r.thesis_id} ${r.mode}${r.match_id ? ` on ${r.match_id}` : ''} messages=${r.n} citations=${r.cits} ${iso(r.created_at)} .. ${iso(r.updated_at)}`);
        line(`    "${String(r.title || '').slice(0, 80)}"`);
      }

      if (VERIFY) {
        line('\nrelationship checks:');
        for (const [name, sql] of Object.entries(CHECKS)) {
          const bad = await q(sql);
          if (bad.length) failures++;
          line(`  ${bad.length ? 'FAIL' : 'ok  '}  ${name}${bad.length ? `  (${bad.length}: ${bad.slice(0, 3).map((r) => Object.values(r)[0]).join(', ')})` : ''}`);
        }
        const [{ n: links }] = await q(`SELECT count(*)::int AS n FROM chat_messages m, jsonb_array_elements(m.citations) c`);
        line(`  (${links} citation link(s) checked)`);
      }

      if (SNAPSHOT || COMPARE) {
        const snap = {};
        for (const [t, pk] of Object.entries(TABLES)) {
          if (!present.has(t)) continue;
          snap[t] = Object.fromEntries((await q(`SELECT (${pk})::text AS k, md5(x::text) AS h FROM ${t} x`)).map((r) => [r.k, r.h]));
        }
        if (COMPARE) {
          const old = JSON.parse(fs.readFileSync(COMPARE, 'utf8'));
          line(`\ncompare with snapshot ${COMPARE}:`);
          for (const [t, rows] of Object.entries(old)) {
            const now = snap[t] || {};
            const missing = Object.keys(rows).filter((k) => !(k in now));
            const changed = Object.keys(rows).filter((k) => k in now && now[k] !== rows[k]);
            const added = Object.keys(now).filter((k) => !(k in rows)).length;
            if (missing.length) failures++;
            line(`  ${missing.length ? 'FAIL' : 'ok  '}  ${t.padEnd(22)} kept ${Object.keys(rows).length - missing.length}/${Object.keys(rows).length}, changed ${changed.length}, added ${added}${missing.length ? `, MISSING ${missing.slice(0, 3).join(', ')}` : ''}`);
          }
        }
        if (SNAPSHOT) { fs.writeFileSync(SNAPSHOT, JSON.stringify(snap)); line(`\nsnapshot saved: ${SNAPSHOT}`); }
      }
    });
  } finally {
    await db.close();
  }
  if (VERIFY || COMPARE) line(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(`db-inspect failed: ${redact(err.message)}`); process.exit(1); });

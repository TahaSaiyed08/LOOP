// Database adapters behind one small interface, so the rest of the code never cares which one is used:
//   { kind, query(text, params) -> { rows, rowCount }, exec(sql), transaction(async (tx) => ...), close() }
//   tx has the same query/exec. A transaction commits when the callback resolves and rolls back if it throws.
//
//   postgres  TigerData / any PostgreSQL through `pg` (connection pool, TLS).
//   pglite    PostgreSQL compiled to WebAssembly, in this process (@electric-sql/pglite, a dev dependency):
//             automated tests (in memory) and optional local development (a folder on disk). Never production.
//
// Error messages that leave this module are redacted: no connection string, user, password or host.
const fs = require('fs');
const path = require('path');

function redact(message, url = process.env.DATABASE_URL) {
  let m = String(message == null ? '' : message);
  m = m.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, 'postgres://<redacted>');
  if (url) {
    try {
      const u = new URL(url);
      for (const secret of [url, u.password, u.username && `${u.username}@`, u.hostname]) {
        if (secret && secret.length > 2) m = m.split(secret).join('<redacted>');
      }
    } catch { /* not a URL: the generic rule above still applies */ }
  }
  return m;
}

// TLS. TigerData signs with its own private CA (ca.timescale.com), which Node does not trust by default:
//   PGSSLROOTCERT=certs/timescale-ca.pem  pin that CA. Certificate AND hostname are verified; the sslmode/ssl*
//                                         params are stripped from the URL (pg lets them override `ssl`).
// Without PGSSLROOTCERT: a URL with sslmode decides; otherwise TLS is required and the certificate verified
// against Node's public roots (PGSSL_REJECT_UNAUTHORIZED=false only for a self-signed dev DB).
const URL_SSL_PARAMS = ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat'];
function rootCertPath() {
  const p = String(process.env.PGSSLROOTCERT || '').trim();
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.resolve(__dirname, '..', '..', p); // relative to the project root
}
function sslOption(url) {
  const caPath = rootCertPath();
  if (caPath) {
    let ca;
    try { ca = fs.readFileSync(caPath, 'utf8'); } catch { throw new Error(`PGSSLROOTCERT: cannot read the CA file ${path.basename(caPath)}`); }
    if (!/-----BEGIN CERTIFICATE-----/.test(ca)) throw new Error(`PGSSLROOTCERT: ${path.basename(caPath)} is not a PEM certificate`);
    return { ca, rejectUnauthorized: true };
  }
  if (/[?&]sslmode=/i.test(url)) return undefined;
  return { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' };
}
function connectionString(url) {
  if (!rootCertPath()) return url;
  try {
    const u = new URL(url);
    for (const k of URL_SSL_PARAMS) u.searchParams.delete(k);
    return u.toString();
  } catch { return url; }
}

// Schema isolation. PGSCHEMA is REQUIRED with LOOP_DB=postgres: every table lives in that schema and nothing
// can ever resolve to another one (no fallback to public). The search_path is a connection STARTUP parameter
// (`options`), applied by the server during the handshake: no async per-connection setup, so no race.
// Every pooled client is also checked once (current_schema() must equal PGSCHEMA) before its first use;
// a mismatch destroys the client and throws SCHEMA_MISMATCH.
const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;
function schemaName() {
  const s = String(process.env.PGSCHEMA || '').trim();
  if (!s) throw schemaError('PGSCHEMA is not set: LOOP_DB=postgres needs an explicit schema (e.g. PGSCHEMA=thesis_dev); refusing to use the default search path');
  if (!SCHEMA_RE.test(s) || s.startsWith('pg_')) throw schemaError('PGSCHEMA must be a lowercase identifier (letters, digits, underscore) and not a system schema');
  return s;
}
function schemaError(message) { const e = new Error(message); e.code = 'SCHEMA_MISMATCH'; return e; }

// Automated tests (LOOP_TEST=1, set by scripts/test-env.js) may only reach a PostgreSQL on this machine, never
// TigerData or any other remote host. Checked before any network activity; the message names no host.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function assertTestSafe(url) {
  if (process.env.LOOP_TEST !== '1') return;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* unparsable: refused below */ }
  if (!LOOPBACK.has(host) && !/^127\./.test(host)) {
    throw new Error('refused: a test run (LOOP_TEST=1) may not connect to a non-local PostgreSQL database');
  }
}

async function connectPostgres(url) {
  assertTestSafe(url);
  const schema = schemaName();
  let Pool;
  try { ({ Pool } = require('pg')); } catch { throw new Error('the "pg" package is not installed (run npm install)'); }
  const pool = new Pool({
    connectionString: connectionString(url),
    ssl: sslOption(url),
    options: `-c search_path=${schema}`, // validated identifier; startup parameter, see above
    max: Number(process.env.PGPOOL_MAX) || 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS) || 10000,
    application_name: 'thesis-loop',
  });
  pool.on('error', (err) => console.error('[storage] idle database connection error:', redact(err.message, url)));

  const verified = new WeakSet();
  // Check out a client whose current_schema() is PGSCHEMA (checked once per physical connection).
  async function checkout() {
    const client = await pool.connect();
    if (verified.has(client)) return client;
    let actual;
    try { actual = (await client.query('SELECT current_schema() AS s')).rows[0].s; } catch (err) { client.release(err); throw err; }
    if (actual !== schema) {
      const e = schemaError(`database connection is not using schema ${schema} (current schema: ${actual == null ? 'none' : actual}); refusing to continue`);
      client.release(e); // destroys it: never returned to the pool
      throw e;
    }
    verified.add(client);
    return client;
  }
  async function withClient(fn) {
    const client = await checkout();
    try { return await fn(client); } finally { client.release(); }
  }

  try {
    // The schema must exist before current_schema() can report it (search_path names a missing schema -> NULL).
    // Additive and idempotent; runs on a raw client, nothing else is created outside the schema.
    const c = await pool.connect();
    try { await c.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`); } finally { c.release(); }
    await withClient((client) => client.query('SELECT 1'));
  } catch (err) {
    await pool.end().catch(() => {});
    if (err && err.code === 'SCHEMA_MISMATCH') throw err;
    throw new Error(`could not connect to the PostgreSQL database: ${redact(err.message, url)}`);
  }
  return {
    kind: 'postgres',
    schema,
    query: (text, params) => withClient((client) => client.query(text, params)),
    exec: (sql) => withClient((client) => client.query(sql)),
    async transaction(fn) {
      const client = await checkout();
      try {
        await client.query('BEGIN');
        const out = await fn({ query: (t, p) => client.query(t, p), exec: (sql) => client.query(sql) });
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

const pgliteResult = (r) => ({ rows: r.rows, rowCount: r.affectedRows || r.rows.length });

// dataDir: a folder to persist into, or null/undefined for a throwaway in-memory database.
async function connectPglite(dataDir) {
  let PGlite;
  try { ({ PGlite } = await import('@electric-sql/pglite')); } catch { throw new Error('LOOP_DB=pglite needs the dev dependency @electric-sql/pglite (run npm install)'); }
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  const wrap = (q) => ({ query: (t, p) => q.query(t, p).then(pgliteResult), exec: (sql) => q.exec(sql) });
  return {
    kind: 'pglite',
    ...wrap(pg),
    transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))),
    close: () => pg.close(),
  };
}

module.exports = { connectPostgres, connectPglite, redact, sslOption, connectionString, schemaName };

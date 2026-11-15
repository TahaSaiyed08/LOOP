// Tiny key/value store behind a SYNCHRONOUS get/set (feed, council, sentimentCache, thesis, thesisMatches,
// notifyLastSentDate, paperLedger).
//
// JSON mode (default, LOOP_DB unset or "json"): data/db.json, exactly as before. Keeps working in memory if
// the disk is read-only (e.g. Render free tier restarts wipe it; callers must tolerate empty state).
//
// Database mode (LOOP_DB=postgres|pglite, see server/persistence): init() loads every kv_store row into the
// in-memory cache before the server listens, so get() stays synchronous. set() updates the cache at once and
// queues a durable upsert (latest value per key wins). A failed write is retried with backoff and reported
// loudly and in /api/health; it never switches to JSON. flush() waits for pending writes (used on shutdown).
// Data that the API reports as "saved" (sessions, theses, chat) does not go through here: those routes await
// their own database transactions (server/persistence/repo.js).
const fs = require('fs');
const path = require('path');
const persistence = require('./persistence');
const { redact } = require('./persistence/db');

const FILE = process.env.LOOP_DB_FILE || path.join(__dirname, '..', 'data', 'db.json');
let cache = null;
let db = null; // set by init() in database mode
let backend = 'json';
const pending = new Map();
let draining = null;
let retryTimer = null;
let failures = 0;
let lastError = null;
let lastWriteAt = null;

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { cache = {}; }
  return cache;
}

function get(key, fallback = null) {
  const data = load();
  return key in data ? data[key] : fallback;
}

function set(key, value) {
  const data = load();
  data[key] = value;
  if (db) { pending.set(key, value); schedule(); return value; }
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.warn('[store] could not persist to disk, keeping in memory:', err.message);
  }
  return value;
}

const UPSERT = `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2::jsonb, now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;

// Writes everything pending once. Failed keys stay pending (unless a newer value arrived) and a retry is
// scheduled; the returned promise rejects with the first error so flush() callers know.
async function drainOnce() {
  const batch = [...pending.entries()];
  pending.clear();
  let firstError = null;
  for (const [key, value] of batch) {
    try {
      await db.query(UPSERT, [key, JSON.stringify(value === undefined ? null : value)]);
      lastWriteAt = new Date().toISOString();
    } catch (err) {
      if (!pending.has(key)) pending.set(key, value);
      if (!firstError) firstError = err;
    }
  }
  if (firstError) {
    failures++;
    lastError = redact(firstError.message);
    console.error(`[store] ERROR: could not save ${pending.size} key(s) to the ${backend} database (attempt ${failures}): ${lastError}. Data is kept in memory and retried.`);
    if (!retryTimer) {
      retryTimer = setTimeout(() => { retryTimer = null; schedule(); }, Math.min(30000, 500 * 2 ** Math.min(failures, 6)));
      if (retryTimer.unref) retryTimer.unref();
    }
    throw firstError;
  }
  failures = 0;
  lastError = null;
}

function schedule() {
  if (draining || !db) return draining;
  draining = (async () => {
    try { while (pending.size) await drainOnce(); } finally { draining = null; }
  })();
  draining.catch(() => {}); // background writes: failures are logged above and retried
  return draining;
}

// Resolves when nothing is pending; rejects if a write failed (the data stays queued for retry).
async function flush() {
  if (!db) return;
  if (draining) await draining;
  if (pending.size) await schedule();
}

// Database mode: connect (or use opts.db), migrate, load kv_store into the cache. JSON mode: no-op.
// Optional STORE_IMPORT_JSON=true copies data/db.json into an EMPTY kv_store once (the file is only read).
async function init(opts = {}) {
  const st = opts.db ? await persistence.useDb(opts.db) : await persistence.init();
  if (!st.db) { backend = 'json'; db = null; return health(); }
  db = st.db;
  backend = st.backend;
  const rows = (await db.query('SELECT key, value FROM kv_store')).rows;
  cache = {};
  for (const r of rows) cache[r.key] = r.value;
  if (!rows.length && process.env.STORE_IMPORT_JSON === 'true') {
    let imported = {};
    try { imported = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { imported = {}; }
    for (const [k, v] of Object.entries(imported)) { cache[k] = v; pending.set(k, v); }
    await flush();
    console.log(`[store] imported ${Object.keys(imported).length} key(s) from ${path.basename(FILE)} into the database (the file was not changed)`);
  }
  return health();
}

function health() {
  const schema = persistence.health().schema;
  return { backend, ...(schema ? { schema } : {}), ...(db ? { pendingWrites: pending.size, lastError, lastWriteAt } : {}), relational: persistence.isEnabled() };
}

// Tests only: forget the cache and database binding (simulates a fresh process).
function _resetForTests() {
  cache = null; db = null; backend = 'json'; pending.clear(); draining = null; failures = 0; lastError = null; lastWriteAt = null;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
}

module.exports = { get, set, init, flush, health, _resetForTests };

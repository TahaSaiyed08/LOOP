// Which storage the server uses, chosen explicitly with LOOP_DB (default json):
//   LOOP_DB=json      data/db.json only (the original behaviour). /api/v2 routes answer 503.
//   LOOP_DB=postgres  TigerData/PostgreSQL at DATABASE_URL. Migrations run at boot. If the database cannot be
//                     reached the server does NOT fall back to JSON: init() rejects and index.js exits.
//   LOOP_DB=pglite    in-process PostgreSQL in LOOP_PGLITE_DIR (default data/pglite), for local development
//                     and the demo script; tests use an in-memory one through useDb().
// DATABASE_URL alone never switches storage on, so a developer .env cannot silently point local runs or
// tests at the real database.
const path = require('path');
const { connectPostgres, connectPglite, redact } = require('./db');
const { migrate } = require('./migrate');

const DEMO_USER_ID = 'usr_demo'; // the single user behind the legacy single-thesis routes
let state = { backend: 'json', db: null, migrations: [], error: null };

function chosenBackend() {
  const mode = String(process.env.LOOP_DB || '').trim().toLowerCase();
  if (!mode || mode === 'json') return 'json';
  if (mode === 'postgres' || mode === 'pglite') return mode;
  throw new Error(`LOOP_DB must be "json", "postgres" or "pglite" (got "${mode}")`);
}

async function ensureDemoUser(db) {
  await db.query(`INSERT INTO users (user_id, display_name) VALUES ($1, 'Demo user') ON CONFLICT (user_id) DO NOTHING`, [DEMO_USER_ID]);
}

async function init() {
  const backend = chosenBackend();
  if (backend === 'json') {
    if (String(process.env.DATABASE_URL || '').trim()) console.log('[storage] DATABASE_URL is set, but LOOP_DB is not "postgres": using JSON file storage (data/db.json).');
    state = { backend, db: null, migrations: [], error: null };
    return state;
  }
  let db;
  try {
    if (backend === 'postgres') {
      const url = String(process.env.DATABASE_URL || '').trim();
      if (!url) throw new Error('LOOP_DB=postgres but DATABASE_URL is not set');
      db = await connectPostgres(url);
    } else {
      db = await connectPglite(process.env.LOOP_PGLITE_DIR || path.join(__dirname, '..', '..', 'data', 'pglite'));
    }
    const migrations = await migrate(db);
    await ensureDemoUser(db);
    state = { backend, db, migrations, error: null };
    console.log(`[storage] ${backend} ready${db.schema ? ` (schema ${db.schema})` : ''}${migrations.length ? ` (applied ${migrations.join(', ')})` : ''}`);
    return state;
  } catch (err) {
    if (db) await db.close().catch(() => {});
    state = { backend, db: null, migrations: [], error: redact(err.message) };
    const e = new Error(`${backend} storage unavailable: ${redact(err.message)}`);
    e.code = 'STORAGE_UNAVAILABLE';
    throw e;
  }
}

// Tests: run everything on an already-open adapter (e.g. in-memory PGlite), migrated here.
async function useDb(db, backend = db.kind || 'pglite') {
  const migrations = await migrate(db);
  await ensureDemoUser(db);
  state = { backend, db, migrations, error: null };
  return state;
}

const isEnabled = () => Boolean(state.db);
function getDb() {
  if (!state.db) { const e = new Error('persistence is not configured'); e.code = 'PERSISTENCE_DISABLED'; throw e; }
  return state.db;
}
const backend = () => state.backend;
const health = () => ({ backend: state.backend, relational: Boolean(state.db), ...(state.db && state.db.schema ? { schema: state.db.schema } : {}), error: state.error });
async function close() {
  const db = state.db;
  state = { backend: 'json', db: null, migrations: [], error: null };
  if (db) await db.close();
}

module.exports = { init, useDb, isEnabled, getDb, backend, health, close, chosenBackend, DEMO_USER_ID, redact };

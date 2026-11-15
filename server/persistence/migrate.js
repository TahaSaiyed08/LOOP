// Schema migrations: server/persistence/migrations/NNN_name.sql, applied in order, each exactly once, inside
// one transaction holding a Postgres advisory lock (two servers booting together cannot both migrate).
// Migrations are additive; this runner never drops or truncates anything.
//   node server/persistence/migrate.js      (npm run db:migrate): migrate the database chosen by LOOP_DB
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'migrations');
const LOCK_KEY = 4815162342; // arbitrary, fixed: "thesis migrations"

function migrationFiles() {
  return fs.readdirSync(DIR).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort()
    .map((f) => ({ version: Number(f.slice(0, 3)), name: f, sql: fs.readFileSync(path.join(DIR, f), 'utf8') }));
}

// -> [names applied now] ([] when already up to date)
async function migrate(db) {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await tx.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await tx.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    const applied = [];
    for (const m of migrationFiles()) {
      if (done.has(m.version)) continue;
      await tx.exec(m.sql);
      await tx.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
      applied.push(m.name);
    }
    return applied;
  });
}

module.exports = { migrate, migrationFiles };

if (require.main === module) {
  require('dotenv').config();
  const persistence = require('./index');
  persistence.init({ migrateOnly: true })
    .then((st) => { console.log(`[storage] ${st.backend}: ${st.migrations && st.migrations.length ? `applied ${st.migrations.join(', ')}` : 'schema already up to date'}`); return persistence.close(); })
    .catch((err) => { console.error(`[storage] migration failed: ${err.message}`); process.exit(1); });
}

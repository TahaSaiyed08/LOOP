// Loaded FIRST by every scripts/test-*.js (scripts/test-isolation.js checks this). Automated tests must never
// reach a real database, whatever the shell or .env holds:
//   - LOOP_DB, DATABASE_URL and the import/pglite settings are blanked. They are set to '' (not deleted), so
//     dotenv (which never overrides a key that is already set) cannot refill them from a real .env, and
//     spawned servers that inherit process.env stay on JSON storage too.
//   - LOOP_TEST=1 makes server/persistence/db.js refuse any PostgreSQL host that is not this machine, as a
//     second line of defence for a test that sets LOOP_DB=postgres on purpose (e.g. an unreachable localhost).
for (const k of ['LOOP_DB', 'DATABASE_URL', 'STORE_IMPORT_JSON', 'LOOP_PGLITE_DIR', 'PGSCHEMA', 'PGSSLROOTCERT']) process.env[k] = '';
process.env.LOOP_TEST = '1';

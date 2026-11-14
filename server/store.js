// Tiny JSON-file key/value store (data/db.json). Keeps working in memory if the disk is read-only
// (e.g. Render free tier restarts wipe it; callers must tolerate empty state).
const fs = require('fs');
const path = require('path');

const FILE = process.env.LOOP_DB_FILE || path.join(__dirname, '..', 'data', 'db.json');
let cache = null;

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { cache = {}; }
  return cache;
}

function get(key, fallback = null) {
  const db = load();
  return key in db ? db[key] : fallback;
}

function set(key, value) {
  const db = load();
  db[key] = value;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.warn('[store] could not persist to disk, keeping in memory:', err.message);
  }
  return value;
}

module.exports = { get, set };

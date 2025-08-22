const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'data', 'monitor.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`CREATE TABLE IF NOT EXISTS pulses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineId TEXT,
  ts INTEGER,
  pulses INTEGER,
  duration INTEGER
);
CREATE TABLE IF NOT EXISTS status_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineId TEXT,
  state TEXT,
  ts INTEGER
);
CREATE TABLE IF NOT EXISTS ingest_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER,
  payload TEXT,
  error TEXT
);`);

module.exports = db;

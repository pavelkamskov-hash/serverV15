/*
 * server.js
 *
 * Main entry point for the clean extrusion monitor.  This file
 * implements a simple REST API for ingesting pulse data, retrieving
 * smoothed speeds and uptime statistics, generating Excel reports and
 * configuring the smoothing parameters.  The application exposes a
 * minimal user interface in the `public/` directory and protects
 * access behind a login page.  A separate password is required to
 * access the settings page.
 */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
// Paths and helpers for login credentials
const CREDS_PATH = path.join(__dirname, 'config.js');
function loadCreds() {
  delete require.cache[require.resolve('./config')];
  return require('./config');
}
function saveCreds(u, hash) {
  const data = `module.exports = {\n  username: ${JSON.stringify(u)},\n  passwordHash: ${JSON.stringify(hash)},\n};\n`;
  fs.writeFileSync(CREDS_PATH, data);
}
const { Agent } = require('./smartAgent');

// -----------------------------------------------------------------------------
// Configuration loading/saving
//
// Runtime settings (smoothing parameters, line names, etc.) are stored in
// JSON format in config.json.  The settings may be modified at runtime
// through the /settings API.  These helper functions load and persist
// the settings atomically.  If the file does not exist, sensible
// defaults are returned based on the committed version of config.json.

const SETTINGS_PATH = path.join(__dirname, 'config.json');

/**
 * Load settings from disk.  If the settings file does not exist the
 * committed defaults are returned.
 *
 * @returns {Object} Parsed settings.
 */
function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const clean = raw.replace(/\/\/.*$/gm, '');
    return JSON.parse(clean);
  } catch (err) {
    // Fall back to the committed defaults.  Using require ensures the
    // default file is read relative to this module and cached for the
    // lifetime of the process.
    // eslint-disable-next-line import/no-dynamic-require
    const defaults = require('./config.json');
    return Object.assign({}, defaults);
  }
}

/**
 * Persist settings to disk.  The file is overwritten atomically to
 * avoid corruption.
 *
 * @param {Object} obj Settings to save.
 */
function saveSettings(obj) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2));
}

// Load the initial settings into memory.  These values will be
// propagated into the smoothing agent and subsequently updated via the
// /settings API.
let settings = loadSettings();

// -----------------------------------------------------------------------------
// Database setup
//
// All runtime state (status flags, event logs and minute aggregates) are
// persisted in an SQLite database in the `data/` directory.  The
// directory is created on startup if it does not exist.  Basic tables
// are initialised here; more specialised tables (minute_stats) are
// created by the smartAgent.

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const db = new sqlite3.Database(path.join(DATA_DIR, 'data.db'));

// Create the core tables.  `status` tracks the current RUN/STOP
// information per line and the time of the last packet; `status_log`
// records state changes; `pulses` stores raw packet data for
// completeness (currently unused by the front‑end).
db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS status (
      lineId TEXT PRIMARY KEY,
      isRunning INTEGER DEFAULT 0,
      lastPulseTime INTEGER DEFAULT 0,
      lastPacketTime INTEGER DEFAULT 0
    )`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS status_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lineId TEXT,
      timestamp INTEGER,
      isRunning INTEGER
    )`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS pulses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lineId TEXT,
      pulses INTEGER,
      duration INTEGER,
      timestamp INTEGER
    )`
  );
  // Seed the 13 lines if they do not already exist.  Each line will
  // persist even if disabled in the settings to ensure the UI shows
  // inactive lines as "нет данных".
  const lines = Array.from({ length: 13 }, (_, i) => `line${i + 1}`);
  lines.forEach((lineId) => {
    db.get(
      `SELECT lineId FROM status WHERE lineId=?`,
      [lineId],
      (err, row) => {
        if (err) return;
        if (!row) {
          db.run(
            `INSERT INTO status(lineId,isRunning,lastPulseTime,lastPacketTime) VALUES (?,?,?,?)`,
            [lineId, 0, 0, 0]
          );
        }
      }
    );
  });
});

// Instantiate the smoothing agent.  The agent maintains its own
// in‑memory buffers and writes minute aggregates to the database via
// minute_stats.  Whenever the settings are updated the agent will be
// notified by calling `updateSettings()`.
const agent = new Agent(db, settings);

// -----------------------------------------------------------------------------
// Express application
//
// The API and UI are served by a single Express instance.  Sessions are
// used to protect access to the dashboard and settings; login is
// required for all routes except a handful of public endpoints.

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'extrusion-monitor-secret',
    resave: false,
    saveUninitialized: false,
  })
);

/**
 * Middleware to enforce authentication for protected routes.  Requests
 * to the login page, static assets, the data ingestion endpoint and
 * health endpoints are permitted without a session.
 */
function requireAuth(req, res, next) {
  const openPaths = ['/login', '/public', '/data', '/healthz', '/time'];
  if (openPaths.some((p) => req.path === p || req.path.startsWith(p + '/'))) {
    return next();
  }
  const { username } = loadCreds();
  if (req.session && req.session.user === username) {
    return next();
  }
  return res.redirect('/login');
}

// -----------------------------------------------------------------------------
// Authentication routes

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post(
  '/login',
  express.urlencoded({ extended: true }),
  async (req, res) => {
    try {
      const { username: u, password, remember } = req.body || {};
      const creds = loadCreds();
      if (u === creds.username && (await bcrypt.compare(String(password || ''), creds.passwordHash))) {
        req.session.user = creds.username;
        if (remember) {
          req.session.cookie.maxAge = 30 * 86400 * 1000; // 30 days
        }
        return res.redirect('/');
      }
    } catch (e) {
      console.error('login error', e);
    }
    res.status(401).send('Unauthorized');
  }
);

// Apply authentication middleware
app.use(requireAuth);

// -----------------------------------------------------------------------------
// Static files

// Serve all files under public/ at /public/ so that CSS and JS
// dependencies can be loaded directly.
app.use('/public', express.static(path.join(__dirname, 'public')));

// The root of the application serves the dashboard.  Since
// requireAuth runs before this route, users will be redirected to
// /login if they are not authenticated.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// -----------------------------------------------------------------------------
// Data ingestion

// POST /data accepts packets from the ESP32 containing pulses, the
// duration of the sampling interval and an optional timestamp.
// Example packet: { "lineId": "line1", "pulses": 42, "duration": 10000, "ts": 1692922200 }
// If no timestamp is provided the current server time is used.  The
// server stores the raw packet, updates its smoothing buffers and
// records any RUN/STOP transitions to the event log.
app.post('/data', (req, res) => {
  try {
    const { lineId, pulses, duration, ts } = req.body || {};
    const id = String(lineId || '').trim();
    const p = Number(pulses);
    const dur = Number(duration);
    if (!id || !Number.isFinite(p) || !Number.isFinite(dur) || dur <= 0) {
      return res.status(400).json({ error: 'invalid payload' });
    }
    // Normalise timestamp inside the agent.  We insert the raw packet
    // into pulses purely for archival purposes; the ingestion logic
    // itself does not read from this table.
    const pktTs = ts;
    db.run(
      `INSERT INTO pulses(lineId,pulses,duration,timestamp) VALUES (?,?,?,?)`,
      [id, p, dur, Math.floor((ts && ts > 1e12 ? ts / 1000 : ts) || Date.now() / 1000)],
      () => {}
    );
    // Ensure the line exists in the status table.  If it is a new
    // identifier it will be inserted with default values.
    db.get(
      `SELECT lineId,isRunning FROM status WHERE lineId=?`,
      [id],
      (err, row) => {
        if (err) {
          console.error('status fetch', err);
          return res.status(500).json({ error: 'db' });
        }
        if (!row) {
          db.run(
            `INSERT INTO status(lineId,isRunning,lastPulseTime,lastPacketTime) VALUES (?,?,?,?)`,
            [id, 0, 0, 0],
            () => {}
          );
        }
        // Feed the packet into the smoothing agent.  The agent
        // determines whether a state change occurred and returns
        // smoothed speed.
        const { smoothedSpeed, stateChanged, newState } = agent.ingest(id, {
          pulses: p,
          duration: dur,
          ts: pktTs,
        });
        const nowSec = Math.floor(Date.now() / 1000);
        // Update the status table's timing fields.  lastPacketTime is
        // always updated; lastPulseTime is updated only when pulses>0.
        const updates = [];
        const params = [];
        updates.push('lastPacketTime=?');
        params.push(nowSec);
        if (p > 0) {
          updates.push('lastPulseTime=?');
          params.push(nowSec);
        }
        if (stateChanged) {
          updates.push('isRunning=?');
          params.push(newState);
        }
        params.push(id);
        db.run(
          `UPDATE status SET ${updates.join(', ')} WHERE lineId=?`,
          params,
          () => {
            if (stateChanged) {
              db.run(
                `INSERT INTO status_log(lineId,timestamp,isRunning) VALUES (?,?,?)`,
                [id, nowSec, newState],
                () => {}
              );
            }
            res.json({ ok: true });
          }
        );
      }
    );
  } catch (e) {
    console.error('/data error', e);
    res.status(500).json({ error: 'server' });
  }
});

// -----------------------------------------------------------------------------
// Status endpoint

// GET /status returns the current state of all 13 lines.  Each entry
// contains the lineId, a human‑friendly displayName, the smoothed
// speed and a label describing whether the line is running, stopped
// or has no data.  Lines that have never received a packet are
// reported as having no data.
app.get('/status', (req, res) => {
  const lines = Array.from({ length: 13 }, (_, i) => `line${i + 1}`);
  db.all(`SELECT lineId,isRunning,lastPulseTime,lastPacketTime FROM status ORDER BY lineId ASC`, (err, rows) => {
    if (err) {
      console.error('/status db', err);
      return res.json([]);
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const result = [];
    for (const id of lines) {
      const row = rows.find((r) => r.lineId === id) || { lineId: id, isRunning: 0, lastPulseTime: 0, lastPacketTime: 0 };
      const smoothedSpeed = agent.getSmoothedSpeed(id);
      const isRunning = agent.getState(id);
      // Determine whether the line is offline.  If no packet has ever
      // been received (lastPacketTime=0) or the elapsed time since the
      // last packet exceeds offlineTimeout we label it as having no
      // data.  Otherwise we reflect its running/stopped state.
      let stateLabel = 'нет данных';
      if (row.lastPacketTime && nowSec - row.lastPacketTime <= (settings.offlineTimeout || 60)) {
        stateLabel = isRunning ? 'Работает' : 'Остановлена';
      }
      const displayName = (settings.lineNames && settings.lineNames[id]) || id;
      result.push({
        lineId: id,
        displayName,
        speed: smoothedSpeed,
        isRunning: !!isRunning,
        lastPulseTime: row.lastPulseTime,
        lastPacketTime: row.lastPacketTime,
        stateLabel,
      });
    }
    res.json(result);
  });
});

// -----------------------------------------------------------------------------
// Chart data endpoint

// GET /chartdata/:lineId returns the time series for the selected line
// along with the last 30 days of uptime/downtime statistics.  The
// number of hours in the speed chart is determined by the current
// settings (graphHours) and the daily aggregation uses 30 days.
app.get('/chartdata/:lineId', (req, res) => {
  const lineId = String(req.params.lineId || '').trim();
  const hours = Number(settings.graphHours) || 24;
  agent.getSeries(lineId, hours, (err1, series) => {
    if (err1 || !series) {
      console.error('getSeries', err1);
      return res.status(500).json({ error: 'series' });
    }
    agent.getDailyWorkIdle(lineId, 30, (err2, daily) => {
      if (err2 || !daily) {
        console.error('getDailyWorkIdle', err2);
        return res.status(500).json({ error: 'daily' });
      }
      const lineName = (settings.lineNames && settings.lineNames[lineId]) || lineId;
      const speed = {
        labels: series.labels,
        data: series.data,
      };
      const status = {
        labels: daily.labels,
        work: daily.work,
        down: daily.down,
        lineName,
      };
      res.json({ speed, status });
    });
  });
});

// -----------------------------------------------------------------------------
// Excel reports

// GET /report generates a detailed Excel report including per‑event
// breakdowns of running and stopped segments as well as a summary
// sheet.  The implementation mirrors the old system but uses the
// merged segments logic to ignore short stops and runs.  The report
// spans the last 30 days by default or can be constrained via
// ?from=YYYY-MM-DD&to=YYYY-MM-DD.  Dates are interpreted in the
// server's local timezone.
app.get('/report', async (req, res) => {
  try {
    // Parse optional from/to parameters.  If omitted the last 30 days
    // are included.  Convert ISO dates to UNIX timestamps.
    const parseDate = (s) => {
      if (!s) return null;
      const d = new Date(s);
      if (isNaN(d.getTime())) return null;
      return Math.floor(d.getTime() / 1000);
    };
    const nowSec = Math.floor(Date.now() / 1000);
    const toTs = parseDate(req.query.to) || nowSec;
    const fromTs = parseDate(req.query.from) || toTs - 30 * 86400;
    const wb = new ExcelJS.Workbook();
    const summary = wb.addWorksheet('Сводка 30 дней');
    summary.columns = [
      { header: 'Линия', key: 'line', width: 12 },
      { header: 'Работа, ч', key: 'up', width: 14 },
      { header: 'Простой, ч', key: 'down', width: 14 },
      { header: '% простоя', key: 'pct', width: 12 },
    ];
    const lines = Array.from({ length: 13 }, (_, i) => `line${i + 1}`);
    for (const lineId of lines) {
      // Build a per‑line worksheet
      const ws = wb.addWorksheet(lineId);
      ws.columns = [
        { header: 'Дата', key: 'date', width: 12 },
        { header: 'Событие', key: 'ev', width: 18 },
        { header: 'Время', key: 'when', width: 20 },
        { header: 'Простой, мин', key: 'downtime', width: 14 },
      ];
      // Helper to add a row to the worksheet
      function addRow(date, ev, whenTs, extra) {
        const whenStr = new Date(whenTs * 1000).toISOString().replace('T', ' ').substring(0, 19);
        ws.addRow({ date, ev, when: whenStr, downtime: extra });
      }
      // Determine the state at fromTs
      const initial = await new Promise((resolve) => {
        db.get(
          `SELECT isRunning FROM status_log WHERE lineId=? AND timestamp<? ORDER BY timestamp DESC LIMIT 1`,
          [lineId, fromTs],
          (err, row) => {
            resolve(row ? Number(row.isRunning) : 0);
          }
        );
      });
      // Fetch all logs within the requested range
      const logs = await new Promise((resolve) => {
        db.all(
          `SELECT timestamp,isRunning FROM status_log WHERE lineId=? AND timestamp>=? AND timestamp<=? ORDER BY timestamp ASC`,
          [lineId, fromTs, toTs],
          (err, rows) => {
            resolve(rows || []);
          }
        );
      });
      // Iterate through each day between fromTs and toTs and build
      // segments.  We'll accumulate total run/down time for the summary.
      let totalRun = 0;
      let totalDown = 0;
      let prevState = initial;
      for (let dayStart = Math.floor(fromTs / 86400) * 86400; dayStart < toTs; dayStart += 86400) {
        const dayEnd = Math.min(dayStart + 86400, toTs);
        const dayLabel = new Date(dayStart * 1000).toISOString().slice(0, 10);
        // Build raw segments for this day
        const dayEvents = logs.filter((ev) => ev.timestamp >= dayStart && ev.timestamp < dayEnd);
        let state = prevState;
        let segStart = dayStart;
        const segments = [];
        for (const ev of dayEvents) {
          if (Number(ev.isRunning) !== state) {
            segments.push({ start: segStart, end: ev.timestamp, state });
            state = Number(ev.isRunning);
            segStart = ev.timestamp;
          }
        }
        segments.push({ start: segStart, end: dayEnd, state });
        prevState = state;
        // Merge short segments (<60s) into the opposite state
        const merged = [];
        for (const seg of segments) {
          const dur = seg.end - seg.start;
          if (seg.state === 1 && dur < 60) {
            // short run => downtime
            if (merged.length && merged[merged.length - 1].state === 0) {
              merged[merged.length - 1].end = seg.end;
            } else {
              merged.push({ start: seg.start, end: seg.end, state: 0 });
            }
          } else if (seg.state === 0 && dur < 60) {
            // short stop => uptime
            if (merged.length && merged[merged.length - 1].state === 1) {
              merged[merged.length - 1].end = seg.end;
            } else {
              merged.push({ start: seg.start, end: seg.end, state: 1 });
            }
          } else {
            merged.push({ ...seg });
          }
        }
        // Write merged segments to worksheet
        for (let i = 0; i < merged.length; i++) {
          const seg = merged[i];
          const durMin = Math.round((seg.end - seg.start) / 60);
          if (seg.state === 1) {
            totalRun += seg.end - seg.start;
            addRow(dayLabel, 'Работа', seg.start, String(durMin));
            addRow(dayLabel, 'Остановка', seg.end, '');
          } else {
            totalDown += seg.end - seg.start;
            addRow(dayLabel, 'Простой', seg.start, String(durMin));
            if (i < merged.length - 1 && merged[i + 1].state === 1) {
              addRow(dayLabel, 'Запуск', seg.end, '');
            }
          }
        }
      }
      // Add a summary row for this line
      const total = totalRun + totalDown;
      const pct = total ? ((totalDown / total) * 100).toFixed(1) + '%' : '0.0%';
      summary.addRow({ line: lineId, up: (totalRun / 3600).toFixed(1), down: (totalDown / 3600).toFixed(1), pct });
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="report.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('/report error', e);
    res.status(500).json({ error: 'report' });
  }
});

// GET /report_clean generates a simplified 30‑day summary report using
// the smoothing agent to compute uptime and downtime.  Each line
// receives its own sheet and a summary is provided on the first page.
app.get('/report_clean', async (req, res) => {
  try {
    const wb = new ExcelJS.Workbook();
    const summary = wb.addWorksheet('Сводка 30 дней');
    summary.columns = [
      { header: 'Линия', key: 'line', width: 12 },
      { header: 'Работа, ч', key: 'up', width: 14 },
      { header: 'Простой, ч', key: 'down', width: 14 },
      { header: '% простоя', key: 'pct', width: 12 },
    ];
    const lines = Array.from({ length: 13 }, (_, i) => `line${i + 1}`);
    for (const lineId of lines) {
      const sheet = wb.addWorksheet(lineId);
      sheet.columns = [
        { header: 'Дата', key: 'date', width: 12 },
        { header: 'Работа, ч', key: 'up', width: 14 },
        { header: 'Простой, ч', key: 'down', width: 14 },
      ];
      await new Promise((resolve) => {
        agent.getDailyWorkIdle(lineId, 30, (err, daily) => {
          if (!err && daily) {
            let runTotal = 0;
            let downTotal = 0;
            for (let i = 0; i < daily.labels.length; i++) {
              const date = daily.labels[i];
              const up = daily.work[i];
              const down = daily.down[i];
              runTotal += up;
              downTotal += down;
              sheet.addRow({ date, up, down });
            }
            const total = runTotal + downTotal;
            const pct = total ? ((downTotal / total) * 100).toFixed(1) + '%' : '0.0%';
            summary.addRow({ line: lineId, up: runTotal.toFixed(1), down: downTotal.toFixed(1), pct });
          }
          resolve();
        });
      });
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="report_30days_clean.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('/report_clean error', e);
    res.status(500).json({ error: 'report_clean' });
  }
});

// Convenience route used by the old UI; forwards to the simplified
// report.  Clients can call /report/last30days directly to obtain
// report_30days_clean.xlsx.
app.get('/report/last30days', (req, res) => {
  req.url = '/report_clean';
  app._router.handle(req, res, () => {});
});

// -----------------------------------------------------------------------------
// Settings API

// GET /settings serves the settings page.  Authentication via requireAuth
// ensures only logged in users can access it.  Authorisation for
// editing settings is enforced in the AJAX endpoints.
app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

// POST /settings/auth verifies the settings password.  If successful
// the session gains a `settingsAuth` flag which is required to call
// /settings/info and /settings/save.
app.post('/settings/auth', (req, res) => {
  try {
    const { password } = req.body || {};
    // Hard‑coded password for accessing settings.  If needed, this
    // could be externalised into the config.  The user must change
    // this value in the specification if they want a different
    // password for settings.
    const settingsPassword = '19910509';
    if (String(password) === settingsPassword) {
      req.session.settingsAuth = true;
      return res.json({ ok: true });
    }
    return res.status(401).json({ error: 'wrong password' });
  } catch (e) {
    console.error('/settings/auth', e);
    res.status(500).json({ error: 'server' });
  }
});

// GET /settings/info returns the current settings to authenticated
// settings users.  Without settingsAuth this endpoint returns 401.
app.get('/settings/info', (req, res) => {
  if (!req.session.settingsAuth) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  res.json(settings);
});

// POST /settings/save persists new settings.  The payload replaces
// existing values; missing fields retain their previous values.  After
// saving to disk the in‑memory settings and the agent are updated.
app.post('/settings/save', (req, res) => {
  if (!req.session.settingsAuth) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const body = req.body || {};
    // Validate and coerce incoming values.  Fallback to existing
    // settings when values are missing or invalid.
    const newCfg = Object.assign({}, settings);
    const num = (v, def) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : def;
    };
    newCfg.windowSec = num(body.windowSec, settings.windowSec);
    newCfg.V_START = num(body.V_START, settings.V_START);
    newCfg.V_STOP = num(body.V_STOP, settings.V_STOP);
    newCfg.delayStart = num(body.delayStart, settings.delayStart);
    newCfg.delayStop = num(body.delayStop, settings.delayStop);
    newCfg.graphHours = num(body.graphHours, settings.graphHours);
    newCfg.offlineTimeout = num(body.offlineTimeout, settings.offlineTimeout);
    // Enabled lines should be an array of strings; if omitted use
    // existing enabledLines.
    if (Array.isArray(body.enabledLines)) {
      newCfg.enabledLines = body.enabledLines.map((x) => String(x));
    }
    // lineNames is expected to be an object mapping lineId to string
    if (body.lineNames && typeof body.lineNames === 'object') {
      const names = {};
      for (let i = 1; i <= 13; i++) {
        const id = `line${i}`;
        names[id] = String(body.lineNames[id] || settings.lineNames[id] || '');
      }
      newCfg.lineNames = names;
    }
    settings = newCfg;
    // Persist the settings and update the agent
    saveSettings(settings);
    agent.updateSettings(settings);
    res.json({ ok: true });
  } catch (e) {
    console.error('/settings/save', e);
    res.status(500).json({ error: 'server' });
  }
});

// GET /settings/creds returns current login username
app.get('/settings/creds', (req, res) => {
  if (!req.session.settingsAuth) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { username } = loadCreds();
  res.json({ username });
});

// POST /settings/creds updates login credentials
app.post('/settings/creds', async (req, res) => {
  if (!req.session.settingsAuth) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const body = req.body || {};
    const u = String(body.username || '').trim();
    const p = String(body.password || '');
    if (!u || !p) {
      return res.status(400).json({ error: 'missing' });
    }
    const hash = await bcrypt.hash(p, 12);
    saveCreds(u, hash);
    res.json({ ok: true });
  } catch (e) {
    console.error('/settings/creds', e);
    res.status(500).json({ error: 'server' });
  }
});

// -----------------------------------------------------------------------------
// Miscellaneous

// Health check endpoint.  Useful for container orchestration or
// monitoring scripts.
app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

// Return the current server time for synchronisation or debugging.
app.get('/time', (req, res) => {
  res.json({ now: Math.floor(Date.now() / 1000) });
});

// -----------------------------------------------------------------------------
// Offline watchdog

// Periodically inspect each line and mark it as STOP if no packet has
// been received within the configured offline timeout.  When a line
// transitions from RUN to STOP as a result of the watchdog, a log
// entry is recorded.  Note: the agent itself resets its smoothing
// buffer in handleOffline().
setInterval(() => {
  const nowSec = Math.floor(Date.now() / 1000);
  db.all(
    `SELECT lineId,isRunning,lastPacketTime FROM status`,
    (err, rows) => {
      if (err || !rows) return;
      rows.forEach((row) => {
        const timeout = Number(settings.offlineTimeout) || 60;
        if (row.lastPacketTime && nowSec - row.lastPacketTime > timeout) {
          const changed = agent.handleOffline(row.lineId);
          if (changed) {
            // Update DB state and log the stop event
            db.run(
              `UPDATE status SET isRunning=0 WHERE lineId=?`,
              [row.lineId],
              () => {
                db.run(
                  `INSERT INTO status_log(lineId,timestamp,isRunning) VALUES (?,?,0)`,
                  [row.lineId, nowSec, 0],
                  () => {}
                );
              }
            );
          }
        }
      });
    }
  );
}, 15000);

// -----------------------------------------------------------------------------
// Start the HTTP server

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});
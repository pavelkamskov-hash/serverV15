Here’s a ready-to-paste Codex prompt (in English) that instructs it to generate the entire project from scratch, including all files, code, config, and Docker setup. It’s designed for an offline-friendly, Node.js + Express + SQLite stack, with a smart analysis agent, authentication, reports, and a simple static frontend.

Prompt for Codex

Goal: Generate a complete, runnable project (from scratch) for monitoring 13 production lines using ESP32 pulse telemetry. The system must ingest data, compute smoothed speed (cm/min) and RUN/STOP state (with hysteresis and delays), visualize 24–48h speed and 30-day run/downtime, and export Excel reports. Everything runs locally on Windows (trial via Docker/WSL2) and does not require internet at runtime.

Stack & constraints:

Node.js LTS (>=18), CommonJS modules.

Express, express-session, bcryptjs, better-sqlite3 (or sqlite3 if you prefer async), exceljs, ajv for JSON validation, ws or Server-Sent Events (SSE) for live updates, uuid (if needed).

No CDN. Put any small JS/CSS under public/. Avoid heavy chart libs; implement lightweight charts with Canvas/SVG in public/js/charts.js.

Timezone is fixed to UTC+04:00 via process.env.TZ = 'Etc/GMT-4' and explicit formatting.

Authentication: site login (/login) with bcrypt; settings page additionally guarded by a settings password 19910509.

Always render 13 lines (line1 → line13). Lines auto-activate when first data arrives; otherwise show “no data”.

Clean file tree; ship everything needed to run locally.

Deliverables (output format)

Output the project as multiple files, each in its own fenced code block with the file path as the info string. Example format:

// FILE: package.json
{...}

// FILE: server.js
<code>

// FILE: public/index.html
<code>


Do this for every file you create.

Project structure (create all of these)
package.json
Dockerfile
docker-compose.yml
README.md

server.js                 # Express app bootstrap
db.js                     # SQLite init, PRAGMAs, migrations
smartAgent.js             # smoothing window, hysteresis, delays, watchdog
auth.js                   # login/session, settings-guard middleware
routes/
  ingest.js               # /data, /heartbeat
  api.js                  # /status, /chartdata/:id, /report, /report_clean, /time
  settings.js             # /settings (GET UI page), /settings/auth, /settings/save
  diag.js                 # /healthz, /readyz, /diagnostics (JSON)
  users.js                # (optional) list users/roles (stub OK)
public/
  index.html              # 13 lines panel; live speeds & statuses
  charts.html             # 24/48h speed + 30d run/stop charts
  settings.html           # read/write settings (guarded)
  login.html              # login form
  granulation.html        # placeholder page
  css/styles.css
  js/app.js               # shared UI helpers & auth flows
  js/api.js               # fetch helpers
  js/charts.js            # minimal Canvas/SVG charting (line + stacked bars)
  vendor/README.txt       # note: no CDN; explain offline usage
config.json               # default settings, users, lines, devices
data/                     # SQLite database lives here (mounted in Docker)

Functional requirements (implement exactly)
1) ESP32 → Server ingestion

POST /data accepts either a single object or a batch array:

{
  "deviceId": "esp32-10",
  "lineId": "line10",
  "packetId": 102394,             // required for idempotency
  "pulses": 25,                    // integer, 1 pulse = 1 cm (fixed)
  "duration": 10000,               // ms
  "ts": 1692922200000,             // epoch ms (server will normalize if missing)
  "fw": "1.2.3"                    // optional
}


If offline, ESP32 buffers and sends { batch: [...] }. Process in ts ascending order.

Validate payload with Ajv. On schema error: 400 + log to ingest_errors.

Idempotency: enforce unique (deviceId, packetId); ignore duplicates.

Record both ts_device and recv_ts_server; compute skew_sec = (ts_device - recv_ts_server)/1000.

POST /heartbeat: { deviceId, lineId, ts } to refresh connectivity without pulses.

2) SmartAgent (smartAgent.js)

Input: per-line stream of {pulses, duration_ms, ts}.

Speed (cm/min): (pulses / duration_ms) * 60000.

Smoothing: sliding window windowSec (default 60s). Implement as rolling sums over the window (sum pulses / sum duration) to get a weighted average.

RUN/STOP with hysteresis:

thresholds: V_START (above → RUN), V_STOP (below → STOP),

delays: delayStart, delayStop in seconds; state changes only if speed has stayed beyond threshold for the full delay interval.

Watchdog: if no packets for a line for offlineTimeout (e.g., 60s), force a STOP event.

No “comb/flip-flop”: changes only after sustained conditions; ignore spikes < delay.

Per-line overrides: Support optional agent.perLineOverrides[lineId].

3) Database (SQLite, WAL mode)

Enable WAL and sane PRAGMAs: journal_mode=WAL, synchronous=NORMAL, foreign_keys=ON.

Tables (create all; include indexes):

CREATE TABLE IF NOT EXISTS status(
  lineId TEXT PRIMARY KEY,
  isRunning INTEGER NOT NULL,
  lastPulseTime INTEGER,
  lastPacketTime INTEGER,
  smoothedSpeed REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS status_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineId TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  isRunning INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_status_log_line_ts ON status_log(lineId, timestamp);

CREATE TABLE IF NOT EXISTS pulses(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deviceId TEXT,
  lineId TEXT NOT NULL,
  packetId INTEGER NOT NULL,
  pulses INTEGER NOT NULL,
  duration INTEGER NOT NULL,
  ts_device INTEGER,
  ts_server INTEGER,
  fw TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pulses_device_packet ON pulses(deviceId, packetId);
CREATE INDEX IF NOT EXISTS idx_pulses_line_ts ON pulses(lineId, ts_device);

CREATE TABLE IF NOT EXISTS minute_stats(
  lineId TEXT NOT NULL,
  ts INTEGER NOT NULL,         -- bucket start (minute)
  speed REAL NOT NULL,
  PRIMARY KEY(lineId, ts)
);
CREATE INDEX IF NOT EXISTS idx_minute_stats_line_ts ON minute_stats(lineId, ts);

CREATE TABLE IF NOT EXISTS devices(
  deviceId TEXT PRIMARY KEY,
  lineId TEXT NOT NULL,
  token TEXT,
  lastSeen INTEGER,
  fw TEXT
);

CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT, action TEXT, ts INTEGER, metadata TEXT
);

CREATE TABLE IF NOT EXISTS downtime_reasons(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineId TEXT, start INTEGER, end INTEGER,
  code TEXT, comment TEXT, user TEXT
);

CREATE TABLE IF NOT EXISTS ingest_errors(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER, deviceId TEXT, payload TEXT, error TEXT
);


Nightly maintenance endpoints (admin-only): POST /api/maintenance/vacuum, POST /api/maintenance/rebuild-minute-stats?from=...&to=...&lineId=....

4) Settings (config.json; hot-reload)

Example default:

{
  "auth": {
    "users": [{ "username": "zavod", "passHash": null }],  // on first login, hash and persist
    "settingsPassword": "19910509",
    "roles": { "zavod": "manager" }
  },
  "agent": {
    "windowSec": 60,
    "V_START": 0.5,
    "V_STOP": 0.3,
    "delayStart": 30,
    "delayStop": 30,
    "offlineTimeout": 60,
    "perLineOverrides": {}
  },
  "ui": { "theme": "dark", "graphHours": 24, "locale": "en" },
  "lines": {
    "line01": { "name": "Line 1", "enabled": true,  "product": "" },
    "line02": { "name": "Line 2", "enabled": true,  "product": "" },
    "line03": { "name": "Line 3", "enabled": true,  "product": "" },
    "line04": { "name": "Line 4", "enabled": true,  "product": "" },
    "line05": { "name": "Line 5", "enabled": true,  "product": "" },
    "line06": { "name": "Line 6", "enabled": true,  "product": "" },
    "line07": { "name": "Line 7", "enabled": true,  "product": "" },
    "line08": { "name": "Line 8", "enabled": true,  "product": "" },
    "line09": { "name": "Line 9", "enabled": true,  "product": "" },
    "line10": { "name": "Line 10", "enabled": true, "product": "" },
    "line11": { "name": "Line 11", "enabled": true, "product": "" },
    "line12": { "name": "Line 12", "enabled": true, "product": "" },
    "line13": { "name": "Line 13", "enabled": true, "product": "" }
  },
  "devices": {
    "esp32-10": { "lineId": "line10", "token": "CHANGE_ME" }
  },
  "shifts": [],
  "plannedDowntime": []
}


/settings page: read/write JSON fields above (with role check), but do not require restarting. Persist to config.json, broadcast changes to agent.

5) Authentication & authorization

/login (GET/POST): session cookie; bcrypt compare. If passHash is null, accept plaintext password once, hash with bcrypt, persist to config.json.

/logout (GET) ends session.

Route guard middleware: login required for all pages except /data, /heartbeat, /healthz, /readyz, /time, /settings/auth, /login, /logout, /favicon.ico, and static assets.

/settings requires a second step: POST /settings/auth with password 19910509 stored in config.json (can be hashed later); then allow read/write.

audit_log every settings change and report generation (user, timestamp, diff).

6) API routes (implement all)

POST /data: ingest (see §1).

POST /heartbeat: update device lastSeen.

GET /status: always return 13 lines ≙ [{ lineId, name, isRunning, speed, lastPacketTime, online, product }]. Lines without data: isRunning=null, speed=null, online=false.

GET /chartdata/:lineId:

Top chart: minute labels for the past graphHours (24 or 48) in UTC+04:00 (YYYY-MM-DD HH:mm) and smoothed speeds (no zero padding). Hide outliers > 3×P95 in UI only.

Bottom chart: 30-day RUN/STOP bars from status_log, with segments < 60s merged; tooltips include startStr, endStr, durMin, and state.

GET /report?from=YYYY-MM-DD&to=YYYY-MM-DD (default last 30 days):

Excel with a “Summary 30 days” sheet (per line: RUN hours, STOP hours, % util).

13 per-line sheets: chronological “Start/Stop” events with HH:mm and (if set) product.

GET /report_clean?from=...&to=...: compact CSV/Excel with daily RUN/STOP hours per line.

GET /time: returns server time and TZ.

GET /healthz: basic OK.

GET /readyz: DB/file permissions check, WAL status, disk free.

GET /diagnostics (HTML) + GET /api/diagnostics (JSON): versions, WAL on/off, free disk, last backup timestamp, lag, ingest error counts, device lastSeen, and buttons to run maintenance.

7) Frontend (static)

index.html: left column of 13 lines (always visible). Show name, status color (RUN/STOP/No Data), smoothed speed, connectivity icon, product badge; mini sparkline (last 60 min).

charts.html: top: 24/48h line chart of speed (Canvas/SVG), bottom: 30-day stacked bar RUN/STOP with hover tooltips. Buttons: 6h/12h/24h/48h zoom; “Download PNG”, “CSV”.

settings.html: read/write settings (with secondary auth). Tabs: Agent, Lines, Devices, Shifts/Planned downtime, Backups. Display current TZ.

login.html: username/password form.

granulation.html: keep as placeholder.

Use SSE or WS for live /status updates at ~5s.

8) Reports (exceljs)

Include header with: TZ (UTC+04:00), generation timestamp, agent parameters.

Conditional formatting: green for RUN hours, red for STOP.

Add link to audit_log and the requesting username.

9) Diagnostics & Maintenance

Endpoint to backup DB to backups/monitor_YYYYMMDD.sqlite3 (keep last 30).

Nightly jobs (via simple setInterval schedulers): VACUUM, REINDEX, rotate logs. Expose buttons in /diagnostics.

Show WAL status, ingest error count (24h), and lastSeen per device.

10) Docker & WSL2

Dockerfile and docker-compose.yml:

Mount ./data:/app/data (DB), ./config.json:/app/config.json (bind), ./backups:/app/backups.

TZ=Etc/GMT-4 in environment.

Healthcheck for Express.

Expose port 3000 (access at http://localhost:3000 or http://192.168.1.245:3000 in LAN).

Non-functional requirements

Code should be clean and commented.

No crashes on malformed input (log to ingest_errors).

All timestamps stored as epoch ms; all formatting in UTC+04:00.

Unit of measure is fixed: 1 pulse = 1 cm.

Default 13 lines are always returned even if no data received.

Keep UI snappy; do not block on long queries (use indexes).

All settings changes are hot-applied (no restart).

Extras (create stubs if time is short)

/api/downtime-reasons to attach a reason to a STOP interval (store in downtime_reasons), and show in tooltips/report.

/api/devices to list/register devices and tokens.

Webhook config /hooks (post events to local URL) — stub OK.

Role model (viewer/operator/manager/admin) — minimal middleware stubs OK.

README.md must include

Prereqs (Node/Docker/WSL2), how to run with Docker and without.

Windows Firewall note (open 3000/TCP for local subnet).

First login steps (hash bootstrap), secondary settings password, how to change passwords.

Example ESP32 payloads and curl commands.

How to enable WAL and where DB files live.

Backup/restore steps.

Acceptance checks

Sending sample /data updates speed and status; RUN/STOP flips only after sustained thresholds + delays.

/status returns 13 lines always; lines with no data show null speed and No Data.

/chartdata/:id returns minute buckets and 30-day events with merged <60s segments.

/report generates an Excel with a summary and 13 sheets.

/login works; /settings prompts for secondary password; edits persist to config.json and are applied live.

/diagnostics shows WAL, disk, last backup, and maintenance actions work.

Docker build up -d runs and serves on 3000.

Now generate the full project with all files and code, using one fenced block per file as described above.

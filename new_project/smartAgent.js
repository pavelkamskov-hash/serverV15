/*
 * smartAgent.js
 *
 * A lightweight smoothing and state detection module for the extrusion
 * monitoring system.  It ingests pulse packets from the ESP32, applies
 * a sliding‑window average to compute a smoothed speed and determines
 * whether each line is running or stopped using configurable thresholds
 * and delays.  The agent also produces minute‑level speed aggregates
 * for charting and exposes helper methods to compute daily uptime and
 * downtime from the recorded event log.
 */

const sqlite3 = require('sqlite3').verbose();

class Agent {
  /**
   * Construct a new Agent.
   *
   * @param {sqlite3.Database} db          SQLite connection used to
   *                                       persist minute aggregates.
   * @param {Object} settings              Initial smoothing and state
   *                                       detection parameters.
   */
  constructor(db, settings) {
    this.db = db;
    // Copy settings so that subsequent updates don't mutate the
    // originally passed object.
    this.settings = Object.assign({}, settings);
    // Per‑line state.  Each key stores an object with the following
    // fields:
    //   messages: array of recent packets { pulses, duration, ts }
    //   lastPacket: timestamp of the most recent packet (seconds)
    //   lastState: 1 for RUN, 0 for STOP
    //   holdStart: timestamp when we began counting towards a RUN change
    //   holdStop:  timestamp when we began counting towards a STOP change
    //   smoothedSpeed: latest computed smoothed speed (cm/min)
    this.lines = {};
    // Map used to accumulate per‑minute speed aggregates before they are
    // flushed to disk.  Keys are `${lineId}_${minuteTs}` and values
    // contain { sum, count }.
    this.minuteMap = {};
    // Create the minute_stats table for storing per‑minute speeds.  We
    // avoid creating this table inside ingest() to minimise the cost on
    // the critical path.
    this.db.serialize(() => {
      this.db.run(
        `CREATE TABLE IF NOT EXISTS minute_stats (
          lineId TEXT,
          ts INTEGER,
          speed REAL,
          PRIMARY KEY(lineId, ts)
        )`
      );
    });
    // Periodically flush stale minute aggregates to the database.  The
    // flush interval is deliberately short so that charts show recent
    // values without significant lag.
    setInterval(() => this.flushMinuteData(), 10000);
  }

  /**
   * Update the smoothing and state detection parameters at runtime.  The
   * provided object replaces the existing settings; any missing
   * properties retain their previous values.
   *
   * @param {Object} newSettings Updated settings.
   */
  updateSettings(newSettings) {
    this.settings = Object.assign({}, this.settings, newSettings || {});
  }

  /**
   * Ingest a single pulse packet.  The caller is responsible for
   * persisting raw packet data and updating the status table.  This
   * method updates the internal smoothing buffer, computes the
   * smoothed speed and determines whether the line has transitioned
   * between RUN and STOP.  It returns information about the new state
   * so that the caller can update the database accordingly.
   *
   * @param {String} lineId Identifier of the monitored line.
   * @param {Object} pkt    Packet with fields:
   *   pulses   {Number}  Number of pulses counted in the sampling period.
   *   duration {Number}  Duration of the sampling period in milliseconds.
   *   ts       {Number}  Optional UNIX timestamp in seconds; if omitted
   *                      the current time is used.
   * @returns {Object} { smoothedSpeed, stateChanged, newState }
   */
  ingest(lineId, pkt) {
    const pulses = Number(pkt.pulses) || 0;
    const durationMs = Number(pkt.duration) || 0;
    // Normalize timestamp: accept seconds or milliseconds.  When a
    // millisecond epoch is provided the value will exceed 1e12.
    let ts = Number(pkt.ts);
    if (!ts || isNaN(ts)) ts = Math.floor(Date.now() / 1000);
    else if (ts > 1e12) ts = Math.floor(ts / 1000);
    const line = this.lines[lineId] || {
      messages: [],
      lastPacket: ts,
      lastState: 0,
      holdStart: 0,
      holdStop: 0,
      smoothedSpeed: 0,
    };
    this.lines[lineId] = line;
    // Append the new packet and prune old entries outside the sliding
    // window.  We keep the raw pulses and durations in order to
    // compute a weighted average later on.
    line.messages.push({ pulses, duration: durationMs, ts });
    line.lastPacket = ts;
    const windowSec = Number(this.settings.windowSec) || 60;
    const cutoff = ts - windowSec;
    line.messages = line.messages.filter(m => m.ts >= cutoff);
    // Compute the weighted average speed.  The speed for a single
    // packet is (pulses / durationMs) * 60000 = cm/min (since 1 pulse
    // equals 1 cm).  To average over the window we sum all pulses and
    // durations and apply the same formula.
    let sumPulses = 0;
    let sumDuration = 0;
    for (const m of line.messages) {
      sumPulses += m.pulses;
      sumDuration += m.duration;
    }
    let smoothedSpeed = 0;
    if (sumDuration > 0) {
      smoothedSpeed = (sumPulses / (sumDuration / 1000)) * 60;
    }
    line.smoothedSpeed = smoothedSpeed;
    // State detection.  We implement a simple hysteresis: when the
    // smoothed speed rises above V_START and remains there for
    // delayStart seconds the line is considered running.  When the
    // smoothed speed falls below V_STOP and remains there for
    // delayStop seconds it is considered stopped.  When in either
    // state, the opposing hold timer is reset if the speed crosses
    // back over the opposite threshold.
    const V_START = Number(this.settings.V_START) || 0.5;
    const V_STOP = Number(this.settings.V_STOP) || 0.3;
    const delayStart = Number(this.settings.delayStart) || 30;
    const delayStop = Number(this.settings.delayStop) || 30;
    let newState = line.lastState;
    if (line.lastState === 1) {
      // Currently running; look for stop condition.
      if (smoothedSpeed <= V_STOP) {
        if (!line.holdStop) line.holdStop = ts;
        if (ts - line.holdStop >= delayStop) {
          newState = 0;
          line.holdStop = 0;
          line.holdStart = 0;
        }
      } else {
        // Speed recovered; reset stop hold timer.
        line.holdStop = 0;
      }
    } else {
      // Currently stopped; look for run condition.
      if (smoothedSpeed >= V_START) {
        if (!line.holdStart) line.holdStart = ts;
        if (ts - line.holdStart >= delayStart) {
          newState = 1;
          line.holdStart = 0;
          line.holdStop = 0;
        }
      } else {
        // Speed dropped; reset run hold timer.
        line.holdStart = 0;
      }
    }
    const stateChanged = newState !== line.lastState;
    line.lastState = newState;
    // Aggregate the smoothed speed per minute.  We maintain a map of
    // aggregates keyed by `${lineId}_${minuteTs}`.  The minute
    // timestamp is truncated to the start of the minute.  Each entry
    // accumulates the smoothed speed and a sample count.  Later a
    // periodic flush writes these entries to minute_stats.
    const minuteTs = Math.floor(ts / 60) * 60;
    const mapKey = `${lineId}_${minuteTs}`;
    const entry = this.minuteMap[mapKey] || { sum: 0, count: 0 };
    entry.sum += smoothedSpeed;
    entry.count += 1;
    this.minuteMap[mapKey] = entry;
    return { smoothedSpeed, stateChanged, newState };
  }

  /**
   * Flush stale minute aggregates to the database.  Aggregates older
   * than one minute ago are written to minute_stats and removed from
   * the in‑memory map.  This method is invoked periodically by a
   * timer set up in the constructor.
   */
  flushMinuteData() {
    const now = Math.floor(Date.now() / 1000);
    const currentMinute = Math.floor(now / 60) * 60;
    const keys = Object.keys(this.minuteMap);
    for (const key of keys) {
      const [lineId, tsStr] = key.split('_');
      const minuteTs = parseInt(tsStr, 10);
      // Only flush minutes older than the most recent complete minute.
      if (minuteTs < currentMinute) {
        const entry = this.minuteMap[key];
        const avg = entry.count > 0 ? entry.sum / entry.count : 0;
        this.db.run(
          `INSERT OR REPLACE INTO minute_stats(lineId, ts, speed) VALUES (?,?,?)`,
          [lineId, minuteTs, avg],
          () => {}
        );
        delete this.minuteMap[key];
      }
    }
  }

  /**
   * Reset a line when no packets have arrived for the configured
   * offlineTimeout.  The smoothing buffer is cleared, the speed is
   * reset to zero and the state transitions to STOP.  The caller is
   * responsible for updating the database if a state change occurs.
   *
   * @param {String} lineId Identifier of the line to reset.
   * @returns {Boolean} True if the line transitioned from RUN to STOP.
   */
  handleOffline(lineId) {
    const line = this.lines[lineId];
    if (!line) return false;
    let changed = false;
    // Clear the smoothing buffer and timers.
    line.messages = [];
    line.smoothedSpeed = 0;
    line.holdStart = 0;
    line.holdStop = 0;
    if (line.lastState === 1) {
      line.lastState = 0;
      changed = true;
    }
    return changed;
  }

  /**
   * Retrieve the latest smoothed speed for a line.  If no data has been
   * received the speed is zero.
   *
   * @param {String} lineId Identifier of the line.
   * @returns {Number} Smoothed speed (cm/min).
   */
  getSmoothedSpeed(lineId) {
    const line = this.lines[lineId];
    return line ? line.smoothedSpeed : 0;
  }

  /**
   * Retrieve the last known state for a line.  1 represents RUN and 0
   * represents STOP.
   *
   * @param {String} lineId Identifier of the line.
   * @returns {Number} The current state.
   */
  getState(lineId) {
    const line = this.lines[lineId];
    return line ? line.lastState : 0;
  }

  /**
   * Fetch a time series of smoothed speeds for the given number of
   * hours.  The method reads from the minute_stats table and fills in
   * missing minutes with null values so that Chart.js draws gaps.
   *
   * @param {String} lineId Identifier of the line.
   * @param {Number} hours  Number of hours of history to return.
   * @param {Function} cb   Callback (err, { labels, data }).
   */
  getSeries(lineId, hours, cb) {
    const now = Math.floor(Date.now() / 1000);
    const toMinute = Math.floor(now / 60) * 60;
    const fromMinute = toMinute - hours * 3600;
    this.db.all(
      `SELECT ts, speed FROM minute_stats WHERE lineId=? AND ts>=? AND ts<=? ORDER BY ts ASC`,
      [lineId, fromMinute, toMinute],
      (err, rows) => {
        if (err) return cb(err);
        const map = {};
        for (const r of rows) {
          map[r.ts] = r.speed;
        }
        const labels = [];
        const data = [];
        for (let t = fromMinute; t <= toMinute; t += 60) {
          labels.push(new Date(t * 1000).toISOString());
          if (map.hasOwnProperty(t)) data.push(map[t]);
          else data.push(null);
        }
        cb(null, { labels, data });
      }
    );
  }

  /**
   * Compute daily uptime and downtime for a line.  The algorithm uses
   * the status_log table to determine RUN/STOP segments and merges
   * segments shorter than 60 seconds into the opposite state.  The
   * returned arrays contain one entry per day, starting from the most
   * recent day and going back `days` days.  All durations are
   * expressed in hours with one decimal place.
   *
   * @param {String} lineId Identifier of the line.
   * @param {Number} days   Number of days to return (e.g. 30).
   * @param {Function} cb   Callback (err, { labels, work, down }).
   */
  getDailyWorkIdle(lineId, days, cb) {
    const nowSec = Math.floor(Date.now() / 1000);
    const to = nowSec;
    const from = to - days * 86400;
    // Fetch logs for the relevant period and the last state before the
    // period to determine the initial state.
    this.db.all(
      `SELECT timestamp, isRunning FROM status_log WHERE lineId=? AND timestamp>=? AND timestamp<=? ORDER BY timestamp ASC`,
      [lineId, from, to],
      (err, rows) => {
        if (err) return cb(err);
        this.db.get(
          `SELECT isRunning FROM status_log WHERE lineId=? AND timestamp<? ORDER BY timestamp DESC LIMIT 1`,
          [lineId, from],
          (err2, lastRow) => {
            if (err2) return cb(err2);
            let initialState = lastRow ? Number(lastRow.isRunning) : 0;
            const labels = [];
            const work = [];
            const down = [];
            const eventsByDay = [];
            // We'll iterate from the oldest day to the most recent so
            // that the resulting arrays line up with ascending dates.
            for (let d = days - 1; d >= 0; d--) {
              const dayStart = Math.floor((to - d * 86400) / 86400) * 86400;
              const dayEnd = dayStart + 86400;
              const dayLogs = rows.filter(r => r.timestamp >= dayStart && r.timestamp < dayEnd);
              // Build raw segments within this day.
              let segState = initialState;
              let segStart = dayStart;
              const segments = [];
              for (const ev of dayLogs) {
                if (Number(ev.isRunning) !== segState) {
                  segments.push({ start: segStart, end: ev.timestamp, state: segState });
                  segState = Number(ev.isRunning);
                  segStart = ev.timestamp;
                }
              }
              segments.push({ start: segStart, end: dayEnd, state: segState });
              // Update initialState for the next iteration (previous day)
              initialState = segments.length > 0 ? segments[segments.length - 1].state : initialState;
              // Merge short segments (<60 seconds).  Runs shorter than
              // 60 seconds are treated as downtime; stops shorter than
              // 60 seconds are treated as uptime.
              const merged = [];
              for (const seg of segments) {
                const dur = seg.end - seg.start;
                if (seg.state === 1 && dur < 60) {
                  // Short run; merge into downtime
                  if (merged.length && merged[merged.length - 1].state === 0) {
                    merged[merged.length - 1].end = seg.end;
                  } else {
                    merged.push({ start: seg.start, end: seg.end, state: 0 });
                  }
                } else if (seg.state === 0 && dur < 60) {
                  // Short stop; merge into uptime
                  if (merged.length && merged[merged.length - 1].state === 1) {
                    merged[merged.length - 1].end = seg.end;
                  } else {
                    merged.push({ start: seg.start, end: seg.end, state: 1 });
                  }
                } else {
                  merged.push({ ...seg });
                }
              }
              // Sum up durations and collect downtime segments for tooltips
              let runSec = 0;
              let downSec = 0;
              const dayEvents = [];
              for (const seg of merged) {
                const duration = seg.end - seg.start;
                if (seg.state === 1) {
                  runSec += duration;
                } else {
                  downSec += duration;
                  dayEvents.push({ start: seg.start, end: seg.end });
                }
              }
              labels.push(new Date(dayStart * 1000).toISOString().slice(0, 10));
              work.push(parseFloat((runSec / 3600).toFixed(1)));
              down.push(parseFloat((downSec / 3600).toFixed(1)));
              eventsByDay.push(dayEvents);
            }
            cb(null, { labels, work, down, events: eventsByDay });
          }
        );
      }
    );
  }
}

module.exports = { Agent };
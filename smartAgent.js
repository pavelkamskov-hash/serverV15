const fs = require('fs');
const config = JSON.parse(fs.readFileSync('./config.json'));
const db = require('./db');

class SmartAgent {
  constructor(cfg) {
    this.cfg = cfg.agent;
    this.lines = {};
    Object.keys(cfg.lines).forEach(id => {
      this.lines[id] = {
        name: cfg.lines[id],
        state: 'NO_DATA',
        window: [],
        sumPulses: 0,
        sumDuration: 0,
        lastTs: null,
        pending: null,
        pendingTs: null
      };
    });
  }

  handlePacket(pkt) {
    const line = this.lines[pkt.lineId];
    if (!line) return;
    const now = pkt.ts || Date.now();
    line.window.push({ ts: now, pulses: pkt.pulses, duration: pkt.duration });
    line.sumPulses += pkt.pulses;
    line.sumDuration += pkt.duration;
    while (line.window.length && now - line.window[0].ts > this.cfg.windowSec * 1000) {
      const old = line.window.shift();
      line.sumPulses -= old.pulses;
      line.sumDuration -= old.duration;
    }
    line.speed = line.sumDuration ? (line.sumPulses / line.sumDuration) * 60000 : 0;
    line.lastTs = now;
    this._updateState(line, now);
    db.prepare('INSERT INTO pulses(lineId, ts, pulses, duration) VALUES(?,?,?,?)').run(pkt.lineId, now, pkt.pulses, pkt.duration);
  }

  _updateState(line, now) {
    const { V_START, V_STOP, delayStart, delayStop } = this.cfg;
    if (line.state === 'RUN') {
      if (line.speed < V_STOP) {
        if (line.pending !== 'STOP') {
          line.pending = 'STOP';
          line.pendingTs = now;
        } else if (now - line.pendingTs > delayStop * 1000) {
          line.state = 'STOP';
          line.pending = null;
          db.prepare('INSERT INTO status_log(lineId, state, ts) VALUES(?,?,?)').run(this._lineId(line), 'STOP', now);
        }
      } else {
        line.pending = null;
      }
    } else {
      if (line.speed > V_START) {
        if (line.pending !== 'RUN') {
          line.pending = 'RUN';
          line.pendingTs = now;
        } else if (now - line.pendingTs > delayStart * 1000) {
          line.state = 'RUN';
          line.pending = null;
          db.prepare('INSERT INTO status_log(lineId, state, ts) VALUES(?,?,?)').run(this._lineId(line), 'RUN', now);
        }
      } else {
        line.pending = null;
      }
    }
  }

  _lineId(lineObj) {
    return Object.keys(this.lines).find(k => this.lines[k] === lineObj);
  }

  getStatus() {
    const out = [];
    const now = Date.now();
    Object.keys(this.lines).forEach(id => {
      const line = this.lines[id];
      if (line.lastTs && now - line.lastTs > this.cfg.offlineTimeout * 1000 && line.state !== 'STOP') {
        line.state = 'STOP';
        db.prepare('INSERT INTO status_log(lineId, state, ts) VALUES(?,?,?)').run(id, 'STOP', now);
      }
      out.push({
        id,
        name: line.name,
        speed: line.lastTs ? Math.round(line.speed * 100) / 100 : null,
        state: line.state
      });
    });
    return out;
  }
}

module.exports = new SmartAgent(config);

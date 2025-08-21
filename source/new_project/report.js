const ExcelJS = require('exceljs');

// Helper formatting utilities
const pad = (n) => String(n).padStart(2, '0');
function formatDate(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function formatTime(ts) {
  const d = new Date(ts * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Generate an Excel workbook summarising run/stop events for the
 * specified time range.  A summary sheet is included followed by a sheet
 * per line with individual events.
 *
 * @param {sqlite3.Database} db Database handle
 * @param {Object} settings Runtime settings containing products
 * @param {number} fromTs Start of range (unix seconds)
 * @param {number} toTs End of range (unix seconds)
 * @returns {Promise<ExcelJS.Workbook>} Workbook instance
 */
async function generateReport(db, settings, fromTs, toTs) {
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
    const ws = wb.addWorksheet(lineId);
    ws.columns = [
      { header: 'Дата', key: 'date', width: 12 },
      { header: 'Событие', key: 'event', width: 18 },
      { header: 'Время', key: 'time', width: 12 },
      { header: 'Изделие', key: 'product', width: 20 },
    ];
    const product = (settings.products && settings.products[lineId]) || '';

    const initial = await new Promise((resolve) => {
      db.get(
        `SELECT isRunning FROM status_log WHERE lineId=? AND timestamp<? ORDER BY timestamp DESC LIMIT 1`,
        [lineId, fromTs],
        (err, row) => resolve(row ? Number(row.isRunning) : 0)
      );
    });

    const logs = await new Promise((resolve) => {
      db.all(
        `SELECT timestamp,isRunning FROM status_log WHERE lineId=? AND timestamp>=? AND timestamp<=? ORDER BY timestamp ASC`,
        [lineId, fromTs, toTs],
        (err, rows) => resolve(rows || [])
      );
    });

    let totalRun = 0;
    let totalDown = 0;
    let prevState = initial;

    for (let dayStart = Math.floor(fromTs / 86400) * 86400; dayStart < toTs; dayStart += 86400) {
      const dayEnd = Math.min(dayStart + 86400, toTs);
      const actualStart = Math.max(dayStart, fromTs);
      const actualEnd = Math.min(dayEnd, toTs);
      const dayEvents = logs.filter((ev) => ev.timestamp >= actualStart && ev.timestamp < actualEnd);

      let state = prevState;
      let segStart = actualStart;
      const segments = [];
      for (const ev of dayEvents) {
        if (Number(ev.isRunning) !== state) {
          segments.push({ start: segStart, end: ev.timestamp, state });
          state = Number(ev.isRunning);
          segStart = ev.timestamp;
        }
      }
      segments.push({ start: segStart, end: actualEnd, state });
      prevState = state;

      const merged = [];
      for (const seg of segments) {
        const dur = seg.end - seg.start;
        if (seg.state === 1 && dur < 60) {
          if (merged.length && merged[merged.length - 1].state === 0) {
            merged[merged.length - 1].end = seg.end;
          } else {
            merged.push({ start: seg.start, end: seg.end, state: 0 });
          }
        } else if (seg.state === 0 && dur < 60) {
          if (merged.length && merged[merged.length - 1].state === 1) {
            merged[merged.length - 1].end = seg.end;
          } else {
            merged.push({ start: seg.start, end: seg.end, state: 1 });
          }
        } else {
          merged.push({ ...seg });
        }
      }

      for (const seg of merged) {
        if (seg.state === 1) totalRun += seg.end - seg.start;
        else totalDown += seg.end - seg.start;
        if (seg.start > actualStart) {
          ws.addRow({
            date: formatDate(seg.start),
            event: seg.state === 1 ? 'Запуск' : 'Остановка',
            time: formatTime(seg.start),
            product,
          });
        }
      }
    }

    const total = totalRun + totalDown;
    const pct = total ? ((totalDown / total) * 100).toFixed(1) + '%' : '0.0%';
    summary.addRow({
      line: lineId,
      up: (totalRun / 3600).toFixed(1),
      down: (totalDown / 3600).toFixed(1),
      pct,
    });
  }

  return wb;
}

module.exports = { generateReport };

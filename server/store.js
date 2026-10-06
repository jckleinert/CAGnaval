'use strict';
/*
 * Storage for stage 1 (practice mode): plain JSON files.
 *   data/runs/<week>/<runId>.json   one file per finished run, with every move
 *   data/weeks/<week>.json          the ranking of that week
 * Good enough while no money is involved. Before real tickets this must move
 * to a real database.
 */
const fs = require('fs');
const path = require('path');

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CACHED_WEEKS = 8;

class Store {
  constructor(cfg) {
    this.cfg = cfg;
    this.dir = cfg.DATA_DIR;
    this.weeks = new Map();   // week id -> { players } (players has no prototype: keys come from outside)
    this.dirty = new Set();
    this.timer = null;
    fs.mkdirSync(path.join(this.dir, 'runs'), { recursive: true });
    fs.mkdirSync(path.join(this.dir, 'weeks'), { recursive: true });
  }

  /* Id of the week a moment belongs to: the UTC date its week started. */
  weekId(ts) {
    const shifted = new Date(ts - this.cfg.WEEK_START_HOUR * 3600000);
    const back = (shifted.getUTCDay() - this.cfg.WEEK_START_DOW + 7) % 7;
    const start = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - back));
    return start.toISOString().slice(0, 10);
  }

  _write(file, data) {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }

  /* Returns the week's data. With create = false a week that has no file yet is not kept in memory. */
  _week(week, create) {
    if (!WEEK_RE.test(week)) return { players: Object.create(null) };
    if (this.weeks.has(week)) return this.weeks.get(week);
    const data = { players: Object.create(null) };
    let found = false;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dir, 'weeks', week + '.json'), 'utf8'));
      if (raw && raw.players && typeof raw.players === 'object') { Object.assign(data.players, raw.players); found = true; }
    } catch (e) { /* no file yet */ }
    if (found || create) {
      if (this.weeks.size >= MAX_CACHED_WEEKS) {
        for (const k of this.weeks.keys()) { if (!this.dirty.has(k)) { this.weeks.delete(k); break; } }
      }
      this.weeks.set(week, data);
    }
    return data;
  }

  saveRun(record) {
    const dir = path.join(this.dir, 'runs', record.week);
    fs.mkdirSync(dir, { recursive: true });
    this._write(path.join(dir, record.id + '.json'), record);
  }

  loadRun(week, id) {
    if (!WEEK_RE.test(week) || !/^[a-f0-9]{24}$/.test(id)) return null;
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'runs', week, id + '.json'), 'utf8')); } catch (e) { return null; }
  }

  /* key: a fingerprint of the player id (never the id itself). The file is written a moment later, in one go. */
  addScore(week, key, name, kcal, at) {
    const w = this._week(week, true);
    const p = w.players[key] || (w.players[key] = { name: name, total: 0, best: 0, runs: 0, last: 0 });
    p.name = name; p.total += kcal; p.best = Math.max(p.best, kcal); p.runs += 1; p.last = at;
    this.dirty.add(week);
    if (!this.timer) { this.timer = setTimeout(() => this.flush(), 1500); this.timer.unref(); }
  }

  /* Writes pending rankings to disk. Called on a timer and when the server stops. */
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    for (const week of this.dirty) {
      try { this._write(path.join(this.dir, 'weeks', week + '.json'), this.weeks.get(week)); } catch (e) { console.error('could not save week', week, e.message); }
    }
    this.dirty.clear();
  }

  leaderboard(week) {
    const players = this._week(week, false).players;
    return Object.keys(players)
      .map((key) => ({ key, name: players[key].name, total: players[key].total, best: players[key].best, runs: players[key].runs }))
      .sort((a, b) => b.total - a.total || b.best - a.best || (a.key < b.key ? -1 : 1));
  }
}

module.exports = Store;

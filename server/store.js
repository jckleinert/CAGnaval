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
      if (raw && Number.isInteger(raw.tickets)) data.tickets = raw.tickets;
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
  /*
   * kcal: what the run adds to the Total (calories x tickets for a paid run).
   * single: the run's calories as if played with one ticket, for the Best run ranking (defaults to kcal).
   */
  addScore(week, key, name, kcal, at, addr, single) {
    const w = this._week(week, true);
    const p = w.players[key] || (w.players[key] = { name: name, total: 0, best: 0, bestAt: 0, runs: 0, last: 0 });
    p.name = name; p.total += kcal; p.runs += 1; p.last = at;
    if (addr) p.addr = addr;                                   // wallet that gets this row's share of the pool
    const one = single === undefined ? kcal : single;
    if (one > p.best) { p.best = one; p.bestAt = at; }         // who got there first wins a tie
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

  /*
   * The Best run of a week counts one ticket. Rows saved before that rule may hold a run
   * multiplied by its tickets: rebuild them from the saved runs (each keeps its own calories).
   */
  fixBest(week, keyOf) {
    const dir = path.join(this.dir, 'runs', week);
    let files = [];
    try { files = fs.readdirSync(dir); } catch (e) { return 0; }
    const best = Object.create(null);
    for (const f of files) {
      let r; try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
      if (!r || !r.result || !r.result.counted || !(r.result.kcal > 0) || !r.player) continue;
      const k = keyOf(r.player.id), b = best[k];
      if (!b || r.result.kcal > b.kcal || (r.result.kcal === b.kcal && r.endedAt < b.at)) best[k] = { kcal: r.result.kcal, at: r.endedAt };
    }
    const w = this._week(week, false);
    let fixed = 0;
    for (const k of Object.keys(w.players)) {
      const p = w.players[k], b = best[k];
      if (b && p.best > b.kcal) { p.best = b.kcal; p.bestAt = b.at; fixed++; }
    }
    if (fixed) { this.dirty.add(week); this.flush(); }
    return fixed;
  }

  /* Tickets spent in paid runs of a week: the base of the weekly prize estimate. */
  addTickets(week, n) {
    const w = this._week(week, true);
    w.tickets = (w.tickets || 0) + n;
    this.dirty.add(week);
    if (!this.timer) { this.timer = setTimeout(() => this.flush(), 1500); this.timer.unref(); }
  }
  weekTickets(week) { return this._week(week, false).tickets || 0; }
  /* The total of one player in a week (key = playerKey), or 0. */
  weekTotal(week, key) { const p = this._week(week, false).players[key]; return p ? p.total : 0; }

  /* Player names tied to wallets: chosen once, unique (ignoring upper/lower case). */
  _profiles() {
    if (!this.profiles) {
      try { this.profiles = JSON.parse(fs.readFileSync(path.join(this.dir, 'profiles.json'), 'utf8')); } catch (e) { this.profiles = {}; }
    }
    return this.profiles;
  }
  profile(addr) { const p = this._profiles(); return Object.prototype.hasOwnProperty.call(p, addr) ? p[addr] : null; }
  nameTaken(name, addr) {
    const p = this._profiles(), low = name.toLowerCase();
    return Object.keys(p).some((a) => a !== addr && p[a].name.toLowerCase() === low);
  }
  setProfile(addr, name, at) {
    this._profiles()[addr] = { name, at };
    this._write(path.join(this.dir, 'profiles.json'), this.profiles);
  }

  /* Paid runs already used for a game session, so a run is never played twice. */
  _runKey(id) { return (this.cfg.GAME_CONTRACT || '').toLowerCase() + ':' + id; }
  chainRun(id) {
    id = this._runKey(id);
    if (!this.chainRuns) {
      try { this.chainRuns = JSON.parse(fs.readFileSync(path.join(this.dir, 'chain-runs.json'), 'utf8')); } catch (e) { this.chainRuns = {}; }
    }
    return Object.prototype.hasOwnProperty.call(this.chainRuns, id) ? this.chainRuns[id] : null;
  }
  setChainRun(id, value) {
    this.chainRun(id);
    id = this._runKey(id);
    this.chainRuns[id] = value;
    this._write(path.join(this.dir, 'chain-runs.json'), this.chainRuns);
  }

  /* Two rankings of the same week: by = 'total' (all the calories of all runs) or 'best' (the best single run). */
  leaderboard(week, by) {
    const players = this._week(week, false).players;
    const rows = Object.keys(players)
      .map((key) => ({ key, name: players[key].name, total: players[key].total, best: players[key].best, bestAt: players[key].bestAt || 0, runs: players[key].runs, addr: players[key].addr || null }));
    const tie = (a, b) => (a.key < b.key ? -1 : 1);
    if (by === 'best') return rows.sort((a, b) => b.best - a.best || a.bestAt - b.bestAt || b.total - a.total || tie(a, b));
    return rows.sort((a, b) => b.total - a.total || b.best - a.best || tie(a, b));
  }
}

module.exports = Store;

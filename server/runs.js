'use strict';
/*
 * The referee. For every run it keeps its own copy of the game, fed with the
 * moves the page sends, so the score is always the referee's, never the page's.
 *
 * What it enforces:
 *  - the page only learns two foods ahead (the one to drop and the next)
 *  - moves arrive in order, each one legal in the referee's own game
 *  - the game clock of a move cannot be ahead of real time (no fast-forward)
 *  - no more than TURN_WALL_MS of real time between moves (no pausing to think)
 *  - every drop carries a fingerprint of the page's game; a mismatch means the
 *    two games drifted apart, and it is recorded with the drop where it happened
 */
const crypto = require('crypto');
const Sim = require('../shared/sim.js');
const pieces = require('./pieces.js');

const R = Sim.RULES;
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

/* Milliseconds that never jump backwards, anchored to the real date when the server started. */
const bootWall = Date.now(), bootMono = process.hrtime.bigint();
function steadyNow() { return bootWall + Number((process.hrtime.bigint() - bootMono) / 1000000n); }

class RunError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function cleanPlayer(p) {
  if (!p || typeof p.id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(p.id)) throw new RunError(400, 'bad-player');
  let name = typeof p.name === 'string' ? p.name : '';
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return { id: p.id, name: name || 'Player' };
}
/* Fingerprint of a player id: what rankings are keyed by, so ids are never stored there or published. */
function playerKey(id) { return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 32); }

class RunManager {
  constructor(cfg, store, now) {
    this.cfg = cfg;
    this.store = store;
    this.now = now || steadyNow;
    this.active = new Map();     // runId -> live run
    this.byPlayer = new Map();   // player id -> runId of the run in progress
    this.done = new Map();       // runId -> final result (recent runs, for repeated finish calls)
  }

  create(playerIn, meta) {
    const player = cleanPlayer(playerIn);
    const ip = String((meta && meta.ip) || '');
    if (this.active.size >= this.cfg.MAX_ACTIVE_RUNS) throw new RunError(503, 'busy');
    if (ip) {
      let mine = 0;
      for (const r of this.active.values()) if (r.ip === ip && r.player.id !== player.id) mine++;
      if (mine >= this.cfg.MAX_ACTIVE_PER_IP) throw new RunError(429, 'too-many-runs');
    }
    const previous = this.byPlayer.get(player.id);
    if (previous && this.active.has(previous)) this._expire(this.active.get(previous), 'replaced');

    const t = this.now();
    const secret = pieces.newSecret();
    const run = {
      id: crypto.randomBytes(12).toString('hex'),
      player, createdAt: t, lastAt: t,
      secret, commit: pieces.commitOf(secret),
      pub: crypto.randomBytes(4).readUInt32BE(0),
      gold: pieces.goldPlan(secret, this.cfg),
      events: [], lastReply: null, mismatchAt: 0, ip,
      ua: String((meta && meta.ua) || '').slice(0, 200)
    };
    run.sim = new Sim({ pub: run.pub });
    for (let k = 1; k <= R.MAX_FOODS; k++) run.sim.setPiece(k, pieces.pieceAt(secret, run.gold, k));
    this.active.set(run.id, run);
    this.byPlayer.set(player.id, run.id);
    return {
      runId: run.id, pub: run.pub, commit: run.commit,
      pieces: [this._reveal(run, 1), this._reveal(run, 2)],
      rulesVersion: R.VERSION
    };
  }

  /* What the page may know about the k-th food. Read from the referee's game, so a Swap is reflected. */
  _reveal(run, k) {
    const p = k <= R.MAX_FOODS ? run.sim.pieces[k] : null;
    return p ? { lv: p.lv, gold: p.gold } : null;
  }

  _get(runId) {
    const run = this.active.get(runId);
    if (!run) throw new RunError(this.done.has(runId) ? 409 : 404, this.done.has(runId) ? 'run-finished' : 'run-not-found');
    return run;
  }

  /* Checks shared by every message of a run, then moves the referee's game forward to `step`. */
  _advance(run, body, maxAhead) {
    const t = this.now();
    if (!isInt(body.step) || body.step < run.sim.step) throw new RunError(400, 'bad-step');
    if (body.step > run.sim.step + maxAhead) { this._finalize(run, 'invalid', 'step-too-far'); throw new RunError(422, 'step-too-far'); }
    const wall = t - run.createdAt, game = body.step * R.STEP_MS;
    // The game clock may not run ahead of real time (1% covers a device clock that runs slightly fast)...
    if (game > wall * 1.01 + this.cfg.AHEAD_SLACK_MS) { this._finalize(run, 'invalid', 'too-fast'); throw new RunError(422, 'too-fast'); }
    // ...nor fall far behind it: a paused game clock would be free thinking time. The run just ends there.
    if (wall - game > this.cfg.MAX_LAG_MS) { this._expire(run, 'too-slow'); throw new RunError(410, 'run-expired'); }
    if (t - run.lastAt > this.cfg.TURN_WALL_MS) { this._expire(run, 'timeout'); throw new RunError(410, 'run-expired'); }
    while (run.sim.step < body.step && !run.sim.over) run.sim.tick();
    return t;
  }

  /* A drop or a power-up. */
  event(runId, body) {
    const run = this._get(runId);
    const seq = run.events.length + 1;
    const kind = body.type === 'drop' ? 'drop' : body.type === 'power' ? 'power' : null;
    if (!kind) throw new RunError(400, 'bad-type');
    // The page repeats a message if it got no answer: reply again instead of applying it twice.
    if (body.seq === seq - 1 && run.lastReply) {
      const last = run.events[seq - 2];
      if (last && last.step === body.step && last.t === kind && (kind === 'drop' ? last.x === body.x : last.p === body.power)) return run.lastReply;
    }
    if (body.seq !== seq) throw new RunError(409, 'out-of-order');

    const t = this._advance(run, body, R.DROP_STEPS + R.READY_STEPS + 2);
    const sim = run.sim;
    if (sim.over || sim.step !== body.step) { this._finalize(run, 'invalid', 'move-after-end'); throw new RunError(422, 'move-after-end'); }

    if (isInt(body.h) && !run.mismatchAt && (body.h >>> 0) !== sim.hash()) run.mismatchAt = seq;

    let reply;
    if (kind === 'drop') {
      if (!sim.drop(body.x)) { this._finalize(run, 'invalid', 'illegal-drop'); throw new RunError(422, 'illegal-move'); }
      run.events.push({ t: 'drop', x: body.x, step: body.step, at: t, h: isInt(body.h) ? body.h >>> 0 : null });
      reply = { ok: true, k: sim.dropped + 2, piece: this._reveal(run, sim.dropped + 2), sync: !run.mismatchAt };
    } else {
      if (['shake', 'swap', 'sweep'].indexOf(body.power) < 0 || !sim.power(body.power)) {
        this._finalize(run, 'invalid', 'illegal-power'); throw new RunError(422, 'illegal-move');
      }
      run.events.push({ t: 'power', p: body.power, step: body.step, at: t });
      // After a Swap the two visible foods changed places: send them again.
      reply = { ok: true, k: sim.dropped + 1, pieces: [this._reveal(run, sim.dropped + 1), this._reveal(run, sim.dropped + 2)], sync: !run.mismatchAt };
    }
    run.lastAt = t;
    run.lastReply = reply;
    return reply;
  }

  /* The page says the run ended (reason 'over') or the player left it (reason 'quit'). */
  finish(runId, body) {
    if (this.done.has(runId)) return this.done.get(runId);
    const run = this._get(runId);
    const reason = body.reason === 'quit' ? 'quit' : 'over';
    this._advance(run, body, R.DROP_STEPS + R.READY_STEPS + R.SETTLE_STEPS + 2);
    const sim = run.sim;
    const sameEnd = reason === 'quit' ? !sim.over : (sim.over && sim.overStep === body.step);
    const verified = sameEnd && !run.mismatchAt && body.kcal === sim.kcal;
    return this._finalize(run, 'finished', reason, { verified, clientKcal: isInt(body.kcal) ? body.kcal : null });
  }

  /* Close runs whose player went away. Called on a timer. */
  sweep() {
    const t = this.now();
    for (const run of Array.from(this.active.values())) {
      if (t - run.lastAt > this.cfg.TURN_WALL_MS + 5000) this._expire(run, 'timeout');
    }
    if (this.done.size > 2000) { // keep memory bounded
      const drop = this.done.size - 1500; let i = 0;
      for (const k of this.done.keys()) { if (i++ >= drop) break; this.done.delete(k); }
    }
  }

  /* An abandoned run: let the jar settle for a moment, then keep the calories made so far. */
  _expire(run, reason) {
    for (let i = 0; i < R.SETTLE_STEPS && !run.sim.over; i++) run.sim.tick();
    return this._finalize(run, 'expired', reason);
  }

  _finalize(run, status, reason, extra) {
    const sim = run.sim, t = this.now();
    // A broken rule after the two games drifted apart is a sync problem, not cheating.
    if (status === 'invalid' && run.mismatchAt) status = 'desync';
    const counted = status === 'finished' || status === 'expired';
    const goldMerged = sim.gold === 'merged';
    const result = {
      runId: run.id, status, reason,
      kcal: sim.kcal, dropped: sim.dropped, maxLv: sim.maxLv, steps: sim.step,
      overReason: sim.overReason,
      verified: !!(extra && extra.verified),
      sync: !run.mismatchAt, mismatchAt: run.mismatchAt || null,
      counted,
      gold: { appeared: sim.gold !== 'none', merged: goldMerged, mult: goldMerged && run.gold ? run.gold.mult : null },
      commit: run.commit, secret: run.secret,
      week: this.store.weekId(t)   // a run counts for the week in which it ends
    };
    this.active.delete(run.id);
    if (this.byPlayer.get(run.player.id) === run.id) this.byPlayer.delete(run.player.id);
    this.done.set(run.id, result);
    try {
      // A run without a single move is not worth a file or a ranking row.
      if (run.events.length) this.store.saveRun({
        id: run.id, week: result.week, player: run.player, createdAt: run.createdAt, endedAt: t,
        rulesVersion: R.VERSION, pub: run.pub, secret: run.secret, commit: run.commit, goldPlan: run.gold,
        events: run.events, clientKcal: extra ? extra.clientKcal : null, ua: run.ua, result
      });
      if (counted && sim.kcal > 0) this.store.addScore(result.week, playerKey(run.player.id), run.player.name, sim.kcal, t);
    } catch (e) { console.error('could not save run', run.id, e.message); }
    run.sim = null;
    return result;
  }

  leaderboard(week, limit, playerId) {
    const w = week || this.store.weekId(this.now());
    const rows = this.store.leaderboard(w);
    const me = playerId ? playerKey(playerId) : null;
    let mine = null;
    const top = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], you = r.key === me;
      if (i >= (limit || 50) && !you) continue;
      const row = { rank: i + 1, name: r.name, total: r.total, best: r.best, runs: r.runs, you };
      if (you) mine = row;
      if (i < (limit || 50)) top.push(row);
    }
    return { week: w, top, you: mine };
  }

  /*
   * Plays a stored run again from its list of moves and returns the result.
   * Used to audit a run after the fact (for example after a restart, or to
   * double check a big prize). It does not look at the clock, only at the moves.
   */
  static replay(record) {
    const sim = new Sim({ pub: record.pub });
    for (let k = 1; k <= R.MAX_FOODS; k++) sim.setPiece(k, pieces.pieceAt(record.secret, record.goldPlan, k));
    for (const ev of record.events) {
      while (sim.step < ev.step && !sim.over) sim.tick();
      if (sim.over || sim.step !== ev.step) return { ok: false, why: 'move-after-end', kcal: sim.kcal };
      const ok = ev.t === 'drop' ? sim.drop(ev.x) : sim.power(ev.p);
      if (!ok) return { ok: false, why: 'illegal-move', kcal: sim.kcal };
    }
    while (sim.step < record.result.steps && !sim.over) sim.tick();
    return { ok: true, kcal: sim.kcal, dropped: sim.dropped, steps: sim.step, goldMerged: sim.gold === 'merged', overReason: sim.overReason };
  }
}

module.exports = { RunManager, RunError, cleanPlayer, playerKey, steadyNow };

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Sim = require('../shared/sim.js');
const Store = require('../server/store.js');
const baseCfg = require('../server/config.js');
const pieces = require('../server/pieces.js');
const { RunManager, RunError } = require('../server/runs.js');
const R = Sim.RULES;

function setup(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cagnaval-'));
  const cfg = Object.assign({}, baseCfg, { DATA_DIR: dir }, extra || {});
  const clock = { t: Date.UTC(2026, 9, 6, 12, 0, 0) };
  const store = new Store(cfg);
  const mgr = new RunManager(cfg, store, () => clock.t);
  return { cfg, clock, store, mgr, dir };
}
const PLAYER = { id: 'player_0001', name: 'Tester' };

/* A page that plays honestly: its own game, real-time clock, moves sent in order. */
function Page(env, player) {
  const start = env.mgr.create(player || PLAYER, { ua: 'test' });
  const sim = new Sim({ pub: start.pub });
  sim.setPiece(1, start.pieces[0]); sim.setPiece(2, start.pieces[1]);
  const page = {
    start, sim, seq: 0,
    tick(n) { for (let i = 0; i < (n || 1) && !sim.over; i++) { sim.tick(); env.clock.t += R.STEP_MS; } },
    waitReady() { while (!sim.canDrop() && !sim.over) page.tick(); },
    drop(x, tamper) {
      const msg = Object.assign({ type: 'drop', seq: ++page.seq, step: sim.step, x, h: sim.hash() }, tamper || {});
      assert.ok(sim.drop(x));
      const reply = env.mgr.event(start.runId, msg);
      if (reply.piece) sim.setPiece(reply.k, reply.piece);
      return reply;
    },
    power(type) {
      const msg = { type: 'power', seq: ++page.seq, step: sim.step, power: type, h: sim.hash() };
      assert.ok(sim.power(type));
      const reply = env.mgr.event(start.runId, msg);
      reply.pieces.forEach((p, i) => { if (p) sim.setPiece(reply.k + i, p); });
      return reply;
    },
    playAll(seed, maxDrops) {
      const rnd = Sim.rng32(seed);
      while (!sim.over && sim.dropped < (maxDrops || R.MAX_FOODS)) {
        page.waitReady(); if (sim.over) break;
        page.tick(10 + Math.floor(rnd() * 60)); if (sim.over || !sim.canDrop()) continue;
        page.drop(Math.floor(rnd() * (R.W + 1)));
      }
      while (!sim.over && sim.dropped >= R.MAX_FOODS) page.tick();
    },
    finish(extra) { return env.mgr.finish(start.runId, Object.assign({ step: sim.over ? sim.overStep : sim.step, kcal: sim.kcal, reason: sim.over ? 'over' : 'quit' }, extra || {})); }
  };
  return page;
}

test('an honest full run is verified and counted in the ranking', () => {
  const env = setup();
  const page = Page(env);
  page.playAll(11);
  assert.strictEqual(page.sim.over, true);
  const res = page.finish();
  assert.strictEqual(res.status, 'finished');
  assert.strictEqual(res.verified, true);
  assert.strictEqual(res.sync, true);
  assert.strictEqual(res.kcal, page.sim.kcal);
  assert.strictEqual(pieces.commitOf(res.secret), page.start.commit, 'the secret revealed at the end matches the fingerprint given at the start');
  const board = env.mgr.leaderboard('', 10, PLAYER.id);
  assert.strictEqual(board.top.length, 1);
  assert.strictEqual(board.top[0].total, res.kcal);
  assert.strictEqual(board.top[0].you, true);
  assert.strictEqual(board.top[0].id, undefined, 'player ids are never published');
});

test('the start of a run reveals only two foods and no secret', () => {
  const env = setup();
  const start = env.mgr.create(PLAYER, {});
  assert.strictEqual(start.pieces.length, 2);
  assert.strictEqual(start.secret, undefined);
  assert.strictEqual(start.gold, undefined);
});

test('a stored run can be replayed from its moves and gives the same score', () => {
  const env = setup();
  const page = Page(env);
  page.playAll(5, 50);
  const res = page.finish();
  const record = env.store.loadRun(res.week, res.runId);
  const again = RunManager.replay(record);
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.kcal, res.kcal);
  assert.strictEqual(record.events.length, 50);
});

test('a score sent by the page is ignored when it differs from the referee', () => {
  const env = setup();
  const page = Page(env);
  page.playAll(3, 30);
  const res = page.finish({ kcal: 999999 });
  assert.strictEqual(res.verified, false);
  assert.strictEqual(res.kcal, page.sim.kcal);
});

test('a game that runs faster than real time is rejected', () => {
  const env = setup();
  const page = Page(env);
  page.drop(100);
  page.sim.tick = ((orig) => function () { orig.call(page.sim); })(page.sim.tick); // tick without moving the clock
  for (let i = 0; i < 400; i++) page.sim.tick();
  assert.throws(() => page.drop(200), (e) => e instanceof RunError && e.code === 'too-fast');
  assert.strictEqual(env.mgr.active.size, 0);
  assert.strictEqual(env.mgr.leaderboard('', 10).top.length, 0, 'an invalid run is not counted');
});

test('waiting too long between moves ends the run', () => {
  const env = setup();
  const page = Page(env);
  page.drop(100);
  page.waitReady();
  env.clock.t += env.cfg.TURN_WALL_MS + 1000;
  assert.throws(() => page.drop(200), (e) => e.code === 'run-expired');
  const res = env.mgr.finish(page.start.runId, {});
  assert.strictEqual(res.status, 'expired');
});

test('a repeated message is answered again without being applied twice', () => {
  const env = setup();
  const page = Page(env);
  const msg = { type: 'drop', seq: 1, step: page.sim.step, x: 150, h: page.sim.hash() };
  const a = env.mgr.event(page.start.runId, msg);
  const b = env.mgr.event(page.start.runId, msg);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(env.mgr.active.get(page.start.runId).events.length, 1);
});

test('messages out of order are refused', () => {
  const env = setup();
  const page = Page(env);
  assert.throws(() => env.mgr.event(page.start.runId, { type: 'drop', seq: 3, step: 0, x: 150 }), (e) => e.code === 'out-of-order');
});

test('an illegal move ends the run and is not counted', () => {
  const env = setup();
  const page = Page(env);
  page.drop(100);
  // the next food is not ready yet
  assert.throws(() => env.mgr.event(page.start.runId, { type: 'drop', seq: 2, step: page.sim.step, x: 100 }), (e) => e.code === 'illegal-move');
  assert.strictEqual(env.mgr.finish(page.start.runId, {}).status, 'invalid');
});

test('a fingerprint mismatch is recorded with the move where it happened', () => {
  const env = setup();
  const page = Page(env);
  page.drop(100); page.waitReady();
  const reply = page.drop(200, { h: 12345 });
  assert.strictEqual(reply.sync, false);
  page.waitReady();
  const res = page.finish();
  assert.strictEqual(res.mismatchAt, 2);
  assert.strictEqual(res.verified, false);
});

test('power-ups keep the page and the referee in step', () => {
  const env = setup();
  const page = Page(env);
  for (let i = 0; i < 6; i++) { page.waitReady(); page.tick(20); page.drop(40 + i * 55); }
  page.waitReady();
  page.power('swap'); page.tick(5);
  page.power('shake'); page.tick(30);
  // Sweep only applies while there is a candy or a cookie in the jar, and the foods of a run are
  // random: on the runs where none is left, the page must not send it at all.
  if (page.sim.foods.some((b) => b.food.lv <= 1 && !b.food.gold)) page.power('sweep');
  else assert.strictEqual(page.sim.power('sweep'), false);
  for (let i = 0; i < 10; i++) { page.waitReady(); page.tick(15); assert.strictEqual(page.drop(30 + i * 30).sync, true); }
  const res = page.finish();
  assert.strictEqual(res.verified, true);
  assert.throws(() => env.mgr.event(page.start.runId, { type: 'power', seq: 99, step: 0, power: 'swap' }), (e) => e.code === 'run-finished');
});

test('starting a new run closes the previous one of the same player', () => {
  const env = setup();
  const first = Page(env);
  first.drop(100);
  Page(env);
  assert.strictEqual(env.mgr.active.size, 1);
  assert.strictEqual(env.mgr.finish(first.start.runId, {}).status, 'expired');
});

test('abandoned runs are closed by the sweeper', () => {
  const env = setup();
  const page = Page(env);
  page.drop(100);
  env.clock.t += env.cfg.TURN_WALL_MS + 6000;
  env.mgr.sweep();
  assert.strictEqual(env.mgr.active.size, 0);
  assert.strictEqual(env.mgr.finish(page.start.runId, {}).status, 'expired');
});

test('golden food: odds, position and prize table match the design', () => {
  assert.strictEqual(pieces.BONUS.reduce((a, b) => a + b[1], 0), 100);
  const cfg = Object.assign({}, baseCfg);
  let withGold = 0, sum = 0; const N = 40000;
  for (let i = 0; i < N; i++) {
    const g = pieces.goldPlan(pieces.newSecret(), cfg);
    if (!g) continue;
    withGold++; sum += g.mult;
    assert.ok(g.at >= cfg.GOLD_FROM && g.at <= cfg.GOLD_TO);
    assert.strictEqual(g.lv, pieces.GOLD_LEVEL);   // always the onigiri
  }
  assert.ok(Math.abs(withGold / N - 0.125) < 0.01, 'share of runs with a golden food: ' + withGold / N);
  assert.ok(Math.abs(sum / withGold - 1.8) < 0.15, 'average multiplier: ' + sum / withGold);
});

test('weeks start on the configured day and hour (UTC)', () => {
  const env = setup({ WEEK_START_DOW: 1, WEEK_START_HOUR: 0 });
  assert.strictEqual(env.store.weekId(Date.UTC(2026, 9, 5, 0, 0, 0)), '2026-10-05');   // Monday 00:00
  assert.strictEqual(env.store.weekId(Date.UTC(2026, 9, 4, 23, 59, 0)), '2026-09-28'); // Sunday night
  const thu = setup({ WEEK_START_DOW: 4, WEEK_START_HOUR: 16 });
  assert.strictEqual(thu.store.weekId(Date.UTC(2026, 9, 8, 15, 59, 0)), '2026-10-01');
  assert.strictEqual(thu.store.weekId(Date.UTC(2026, 9, 8, 16, 0, 0)), '2026-10-08');
});

test('player names are cleaned before they reach the ranking', () => {
  const env = setup();
  const page = Page(env, { id: 'player_0002', name: '  <b>Kenji</b>\n the  great and long name ' });
  for (let i = 0; i < 16; i++) { page.waitReady(); page.drop(100); }
  page.tick(120);
  assert.ok(page.finish().kcal > 0);
  const name = env.mgr.leaderboard('', 10).top[0].name;
  assert.ok(!/[<>\n]/.test(name) && name.length <= 16, name);
  assert.throws(() => env.mgr.create({ id: 'x', name: 'a' }, {}), (e) => e.code === 'bad-player');
});

test('two rankings: total of all runs (with the number of runs) and best single run', () => {
  const env = setup();
  const week = env.store.weekId(env.clock.t);
  // Ana plays many small runs, Beto one big run, Caro reaches Beto's best later.
  env.store.addScore(week, 'ana', 'Ana', 3000, 1); env.store.addScore(week, 'ana', 'Ana', 3000, 2); env.store.addScore(week, 'ana', 'Ana', 3000, 3);
  env.store.addScore(week, 'beto', 'Beto', 8000, 4);
  env.store.addScore(week, 'caro', 'Caro', 8000, 9); env.store.addScore(week, 'caro', 'Caro', 100, 10);
  const total = env.mgr.leaderboard(week, 10, '', 'total');
  assert.strictEqual(total.by, 'total');
  assert.deepStrictEqual(total.top.map((r) => [r.name, r.total, r.runs]), [['Ana', 9000, 3], ['Caro', 8100, 2], ['Beto', 8000, 1]]);
  const best = env.mgr.leaderboard(week, 10, '', 'best');
  assert.strictEqual(best.by, 'best');
  assert.deepStrictEqual(best.top.map((r) => [r.name, r.best]), [['Beto', 8000], ['Caro', 8000], ['Ana', 3000]], 'a tie goes to whoever got there first');
  assert.strictEqual(env.mgr.leaderboard(week, 10, '', 'nonsense').by, 'total');
});

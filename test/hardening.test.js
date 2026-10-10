'use strict';
/* Tests for problems found in review: each one failed before its fix. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const Sim = require('../shared/sim.js');
const Store = require('../server/store.js');
const baseCfg = require('../server/config.js');
const { RunManager } = require('../server/runs.js');
const { createApp } = require('../server/index.js');
const R = Sim.RULES;

function setup(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cagnaval-h-'));
  const cfg = Object.assign({}, baseCfg, { DATA_DIR: dir }, extra || {});
  const clock = { t: Date.UTC(2026, 9, 6, 12, 0, 0) };
  const store = new Store(cfg);
  return { cfg, clock, store, dir, mgr: new RunManager(cfg, store, () => clock.t) };
}
/* Plays a few honest moves and finishes. Returns the result. */
function quickRun(env, player, drops) {
  const start = env.mgr.create(player, { ip: '1.1.1.1' });
  const sim = new Sim({ pub: start.pub });
  sim.setPiece(1, start.pieces[0]); sim.setPiece(2, start.pieces[1]);
  const tick = (n) => { for (let i = 0; i < n; i++) { sim.tick(); env.clock.t += R.STEP_MS; } };
  for (let i = 0; i < drops; i++) {
    while (!sim.canDrop()) tick(1);
    const msg = { type: 'drop', seq: i + 1, step: sim.step, x: 180, h: sim.hash() };
    sim.drop(180);
    const reply = env.mgr.event(start.runId, msg);
    if (reply.piece) sim.setPiece(reply.k, reply.piece);
  }
  tick(200);
  return env.mgr.finish(start.runId, { step: sim.step, kcal: sim.kcal, reason: 'quit' });
}
function get(port, pathname, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('a malformed request line does not take the server down', async () => {
  const app = createApp({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cagnaval-h-')) });
  await new Promise((r) => app.server.listen(0, r));
  const port = app.server.address().port;
  for (const target of ['//', 'http://[', '//a:b:c/x']) {
    await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => s.write('GET ' + target + ' HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      s.on('data', () => {}); s.on('close', resolve); s.on('error', resolve);
    });
  }
  const health = await get(port, '/api/health');
  assert.strictEqual(health.status, 200);
  await new Promise((r) => app.server.close(r));
});

test('odd player ids cannot damage the ranking or the server', () => {
  const env = setup();
  for (const id of ['__proto__', 'constructor', 'toString_', 'hasOwnProperty']) {
    const res = quickRun(env, { id, name: 'Evil' }, 16);
    assert.strictEqual(res.status, 'finished', id);
    assert.ok(res.kcal > 0, id);
  }
  assert.strictEqual({}.name, undefined);
  assert.strictEqual({}.total, undefined);
  const board = env.mgr.leaderboard('', 10, '__proto__');
  assert.ok(board.top.length >= 1);
  assert.ok(board.top.every((r) => Number.isFinite(r.total)));
});

test('the game clock cannot be paused to gain thinking time', () => {
  const env = setup();
  const start = env.mgr.create({ id: 'player_slow', name: 'Slow' }, {});
  const sim = new Sim({ pub: start.pub });
  sim.setPiece(1, start.pieces[0]); sim.setPiece(2, start.pieces[1]);
  sim.drop(100);
  env.mgr.event(start.runId, { type: 'drop', seq: 1, step: 0, x: 100 });
  while (!sim.canDrop()) sim.tick();   // half a second of game clock...
  env.clock.t += 24000;                // ...but 24 seconds of real time
  assert.throws(() => env.mgr.event(start.runId, { type: 'drop', seq: 2, step: sim.step, x: 100 }), (e) => e.code === 'run-expired');
  assert.strictEqual(env.mgr.finish(start.runId, {}).status, 'expired');
});

test('runs without a move leave no file and no ranking row', () => {
  const env = setup();
  for (let i = 0; i < 20; i++) env.mgr.create({ id: 'flood_player_' + i, name: 'F' }, { ip: '2.2.2.' + i });
  env.clock.t += env.cfg.TURN_WALL_MS + 6000;
  env.mgr.sweep();
  env.store.flush();
  assert.strictEqual(env.mgr.active.size, 0);
  assert.deepStrictEqual(fs.readdirSync(path.join(env.dir, 'runs')), []);
  assert.strictEqual(env.mgr.leaderboard('', 10).top.length, 0);
});

test('runs in progress are limited in total and per visitor address', () => {
  const env = setup({ MAX_ACTIVE_RUNS: 5, MAX_ACTIVE_PER_IP: 2 });
  env.mgr.create({ id: 'same_ip_0001', name: 'A' }, { ip: '3.3.3.3' });
  env.mgr.create({ id: 'same_ip_0002', name: 'B' }, { ip: '3.3.3.3' });
  assert.throws(() => env.mgr.create({ id: 'same_ip_0003', name: 'C' }, { ip: '3.3.3.3' }), (e) => e.code === 'too-many-runs');
  env.mgr.create({ id: 'same_ip_0001', name: 'A' }, { ip: '3.3.3.3' }); // the same player starting again is fine
  for (let i = 0; i < 3; i++) env.mgr.create({ id: 'other_ip_000' + i, name: 'D' }, { ip: '4.4.4.' + i });
  assert.throws(() => env.mgr.create({ id: 'other_ip_0009', name: 'E' }, { ip: '5.5.5.5' }), (e) => e.code === 'busy');
});

test('a run counts for the week in which it ends', () => {
  const env = setup({ WEEK_START_DOW: 1, WEEK_START_HOUR: 0 });
  env.clock.t = Date.UTC(2026, 9, 11, 23, 59, 58);   // Sunday, two seconds before the new week
  const res = quickRun(env, { id: 'player_late', name: 'Late' }, 3);
  assert.strictEqual(res.week, '2026-10-12');
  assert.strictEqual(env.mgr.leaderboard('2026-10-05', 10).top.length, 0);
});

test('the ranking tells a player their position even outside the top', () => {
  const env = setup();
  for (let i = 0; i < 4; i++) assert.ok(quickRun(env, { id: 'ranked_player_' + i, name: 'P' + i }, 16 + i * 4).kcal > 0);
  const board = env.mgr.leaderboard('', 2, 'ranked_player_0');
  assert.strictEqual(board.top.length, 2);
  assert.ok(board.you && board.you.rank >= 1);
});

test('asking for many different weeks does not grow the memory', () => {
  const env = setup();
  for (let i = 0; i < 500; i++) env.mgr.leaderboard('20' + String(10 + (i % 80)) + '-01-' + String(1 + (i % 27)).padStart(2, '0'), 10);
  assert.ok(env.store.weeks.size <= 8);
});

test('behind a proxy, the rate limit uses the address the proxy adds', async () => {
  const app = createApp({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cagnaval-h-')), TRUST_PROXY: true, RATE_LIMIT_PER_MIN: 3 });
  await new Promise((r) => app.server.listen(0, r));
  const port = app.server.address().port;
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await get(port, '/api/health', { 'X-Forwarded-For': 'spoofed-' + i + ', 9.9.9.9' })).status);
  assert.deepStrictEqual(codes, [200, 200, 200, 429, 429, 429]);
  await new Promise((r) => app.server.close(r));
});

test('the ranking says when the week closes: 7 days after it started, at the configured hour', () => {
  const env = setup({ WEEK_START_DOW: 1, WEEK_START_HOUR: 3 });
  const b = env.mgr.leaderboard('', 10);
  assert.strictEqual(b.endsAt, Date.parse(b.week + 'T03:00:00Z') + 7 * 24 * 3600000);
  assert.ok(b.endsAt > env.clock.t && b.endsAt - env.clock.t <= 7 * 24 * 3600000);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { ethers } = require('ethers');
const Sim = require('../shared/sim.js');
const Store = require('../server/store.js');
const baseCfg = require('../server/config.js');
const { RunManager } = require('../server/runs.js');
const { goldPrize, splitPool, weekNumberOf, weekIdOf } = require('../server/chain.js');
const { Auth } = require('../server/auth.js');
const { createApp } = require('../server/index.js');
const R = Sim.RULES;
const RON = (n) => ethers.parseEther(String(n));

test('golden prize: multiplier x tickets x ticket value (cap / 21), never above the cap', () => {
  const cap = RON(105);                       // 21 x 5 RON
  assert.strictEqual(goldPrize(1, 1, cap), RON(5));
  assert.strictEqual(goldPrize(0.5, 1, cap), RON(2.5));
  assert.strictEqual(goldPrize(3, 2, cap), RON(30));
  assert.strictEqual(goldPrize(21, 5, cap), RON(525));
  assert.strictEqual(goldPrize(21, 1, RON(1)), RON(1), 'test cap of 1 RON: the 21x prize is the whole cap');
});

test('weekly pool is split by calories, rounded down, wallets without calories left out', () => {
  const s = splitPool(RON(100), [{ addr: '0xa', total: 300 }, { addr: '0xb', total: 100 }, { addr: null, total: 50 }, { addr: '0xc', total: 0 }]);
  assert.deepStrictEqual(s.map((x) => [x.addr, x.amount]), [['0xa', RON(75)], ['0xb', RON(25)]]);
  assert.deepStrictEqual(splitPool(0n, [{ addr: '0xa', total: 3 }]), []);
  const odd = splitPool(10n, [{ addr: '0xa', total: 1 }, { addr: '0xb', total: 2 }]);
  assert.ok(odd.reduce((a, x) => a + x.amount, 0n) <= 10n);
});

test('contract week numbers match the ranking weeks (Monday 00:00 UTC)', () => {
  const n = weekNumberOf('2026-10-05');
  assert.strictEqual(weekIdOf(n), '2026-10-05');
  assert.strictEqual(weekIdOf(n + 1), '2026-10-12');
  assert.strictEqual(new Date(weekIdOf(n) + 'T00:00:00Z').getUTCDay(), 1);
});

test('wallet sign-in: only the wallet owner gets a token, codes work once', async () => {
  const auth = new Auth('secret');
  const w = ethers.Wallet.createRandom();
  const msg = auth.nonce(w.address);
  const s = auth.login(w.address, await w.signMessage(msg));
  assert.ok(s && s.address === w.address.toLowerCase());
  assert.strictEqual(auth.check(s.token), w.address.toLowerCase());
  assert.strictEqual(auth.login(w.address, await w.signMessage(msg)), null, 'the code is used up');
  const other = ethers.Wallet.createRandom();
  const msg2 = auth.nonce(w.address);
  assert.strictEqual(auth.login(w.address, await other.signMessage(msg2)), null, 'someone else cannot sign for this wallet');
  assert.strictEqual(auth.check(s.token.slice(0, -1) + (s.token.endsWith('a') ? 'b' : 'a')), null, 'a changed token is refused');
  assert.strictEqual(new Auth('other').check(s.token), null);
});

function setup(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cagnaval-'));
  const cfg = Object.assign({}, baseCfg, { DATA_DIR: dir, PAID_ONLY: true }, extra || {});
  const clock = { t: Date.UTC(2026, 9, 6, 12, 0, 0) };
  const store = new Store(cfg);
  const mgr = new RunManager(cfg, store, () => clock.t);
  return { cfg, clock, store, mgr, dir };
}
function play(env, start, seed) {
  const sim = new Sim({ pub: start.pub });
  sim.setPiece(1, start.pieces[0]); sim.setPiece(2, start.pieces[1]);
  const rnd = Sim.rng32(seed); let seq = 0;
  const tick = (n) => { for (let i = 0; i < n && !sim.over; i++) { sim.tick(); env.clock.t += R.STEP_MS; } };
  while (!sim.over && sim.dropped < R.MAX_FOODS) {
    while (!sim.canDrop() && !sim.over) tick(1);
    if (sim.over) break;
    tick(10 + Math.floor(rnd() * 60)); if (sim.over || !sim.canDrop()) continue;
    const x = Math.floor(rnd() * (R.W + 1));
    const msg = { type: 'drop', seq: ++seq, step: sim.step, x, h: sim.hash() };
    sim.drop(x);
    const reply = env.mgr.event(start.runId, msg);
    if (reply.piece) sim.setPiece(reply.k, reply.piece);
  }
  while (!sim.over && sim.dropped >= R.MAX_FOODS) tick(1);
  return env.mgr.finish(start.runId, { step: sim.over ? sim.overStep : sim.step, kcal: sim.kcal, reason: sim.over ? 'over' : 'quit' });
}

test('paid run: calories x tickets in the ranking with the wallet, settled once at the end', () => {
  const env = setup({ GOLD_ODDS: 1 });
  const settled = [];
  env.mgr.onPaid = (run, res) => settled.push([run.chain.runId, res.goldWei]);
  const addr = '0x' + '1'.repeat(40);
  const start = env.mgr.create({ id: addr, name: 'Payer' }, { chain: { runId: '7', tickets: 3, cap: RON(105).toString() } });
  assert.strictEqual(start.tickets, 3);
  assert.deepStrictEqual(env.store.chainRun('7').status, 'playing');
  const res = play(env, start, 5);
  assert.strictEqual(res.status, 'finished');
  assert.strictEqual(res.score, res.kcal * 3);
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0][0], '7');
  const expected = res.gold.merged ? goldPrize(res.gold.mult, 3, RON(105)).toString() : '0';
  assert.strictEqual(settled[0][1], expected);
  assert.strictEqual(env.store.chainRun('7').status, 'done');
  const rows = env.store.leaderboard(res.week, 'total');
  assert.strictEqual(rows[0].total, res.kcal * 3);
  assert.strictEqual(rows[0].addr, addr);
  const pub = env.mgr.leaderboard(res.week, 10, addr);
  assert.strictEqual(pub.top[0].addr, undefined, 'wallets are not published in the ranking');
});

test('with the blockchain on, practice runs do not enter the ranking', () => {
  const env = setup();
  const start = env.mgr.create({ id: 'player_0001', name: 'Free' }, {});
  const res = play(env, start, 9);
  assert.ok(res.kcal > 0);
  assert.strictEqual(env.store.leaderboard(res.week, 'total').length, 0);
});

function request(port, method, url, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, token ? { Authorization: 'Bearer ' + token } : {}) }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(s || '{}') }));
    });
    req.on('error', reject); req.end(data);
  });
}

test('paid run over HTTP: sign in, start from the tickets transaction, never twice, only the owner', async () => {
  const w = ethers.Wallet.createRandom();
  const me = w.address.toLowerCase();
  const fake = {
    enabled: true, jobs: [], referee: '0x' + '2'.repeat(40), settledCalls: [],
    async runFromTx(h) { return h.endsWith('1') ? { runId: '11' } : h.endsWith('2') ? { runId: '12' } : { error: 'no-run-in-tx' }; },
    async getRun(id) { return { player: id === '11' ? me : '0x' + '3'.repeat(40), tickets: 2, week: 0, settled: false, cap: RON(1).toString() }; },
    settle(id, g) { this.settledCalls.push([id, g]); },
    async info() { return { contract: '0x' + '4'.repeat(40), cap: RON(1).toString(), maxTickets: 5 }; }
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cagnaval-'));
  const app = createApp({ DATA_DIR: dir, chain: fake, REFEREE_KEY: '0x' + '5'.repeat(64), NO_CLOSER: true });
  await new Promise((r) => app.server.listen(0, r));
  const port = app.server.address().port;
  try {
    const n = await request(port, 'POST', '/api/auth/nonce', { address: w.address });
    assert.strictEqual(n.status, 200);
    const login = await request(port, 'POST', '/api/auth', { address: w.address, signature: await w.signMessage(n.body.message) });
    assert.strictEqual(login.status, 200);
    const token = login.body.token;
    const tx1 = '0x' + 'a'.repeat(63) + '1', tx2 = '0x' + 'a'.repeat(63) + '2';
    assert.strictEqual((await request(port, 'POST', '/api/runs', { txHash: tx1, player: { name: 'X' } })).status, 401, 'needs sign-in');
    const ok = await request(port, 'POST', '/api/runs', { txHash: tx1, player: { name: 'Payer' } }, token);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.tickets, 2);
    assert.strictEqual(ok.body.chainRun, '11');
    const again = await request(port, 'POST', '/api/runs', { txHash: tx1, player: { name: 'Payer' } }, token);
    assert.strictEqual(again.status, 409, 'a paid run is played once');
    const notMine = await request(port, 'POST', '/api/runs', { txHash: tx2, player: { name: 'Payer' } }, token);
    assert.strictEqual(notMine.status, 403, 'someone else\'s run cannot be played');
    const quit = await request(port, 'POST', '/api/runs/' + ok.body.runId + '/finish', { step: 0, kcal: 0, reason: 'quit' });
    assert.strictEqual(quit.status, 200);
    assert.deepStrictEqual(fake.settledCalls, [['11', '0']], 'the run is closed on the chain even when the player leaves');
  } finally { app.server.close(); }
});

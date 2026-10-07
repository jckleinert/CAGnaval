'use strict';
const test = require('node:test');
const assert = require('node:assert');
const detMath = require('../shared/detmath.js');
const Sim = require('../shared/sim.js');
const R = Sim.RULES;

/* A scripted player: same seed, same moves. */
function play(seed, maxDrops) {
  const rnd = Sim.rng32(seed), sim = new Sim({ pub: seed });
  const piece = () => ({ lv: Math.floor(rnd() * R.SPAWN_LEVELS), gold: false });
  sim.setPiece(1, piece()); sim.setPiece(2, piece());
  const trace = []; let wait = 20 + Math.floor(rnd() * 100);
  while (!sim.over && sim.dropped < (maxDrops || R.MAX_FOODS)) {
    if (sim.canDrop() && sim.step - sim.turnStart >= wait) {
      trace.push(sim.hash());
      assert.ok(sim.drop(Math.floor(rnd() * (R.W + 1))));
      if (sim.dropped + 1 <= R.MAX_FOODS) sim.setPiece(sim.dropped + 1, piece());
      wait = 20 + Math.floor(rnd() * 100);
      if (sim.dropped === 15) sim.power('shake');
      if (sim.dropped === 25) sim.power('swap');
      if (sim.dropped === 35) sim.power('sweep');
    }
    sim.tick();
  }
  return { sim, trace };
}

test('deterministic sin and cos match Math to the last bits', () => {
  let worst = 0;
  for (let i = -20000; i <= 20000; i++) {
    const x = i * 0.0371;
    worst = Math.max(worst, Math.abs(detMath.sin(x) - Math.sin(x)), Math.abs(detMath.cos(x) - Math.cos(x)));
  }
  assert.ok(worst < 1e-15, 'worst error ' + worst);
});

test('non-deterministic Math functions are blocked inside the simulation', () => {
  assert.throws(() => detMath.pow(2, 0.5), /Non-deterministic/);
  assert.throws(() => detMath.random(), /Non-deterministic/);
  assert.throws(() => detMath.atan2(1, 1), /Non-deterministic/);
});

test('the same moves always give exactly the same game', () => {
  const a = play(7, 60), b = play(7, 60);
  assert.deepStrictEqual(a.trace, b.trace);
  assert.strictEqual(a.sim.hash(), b.sim.hash());
  assert.strictEqual(a.sim.kcal, b.sim.kcal);
  assert.ok(a.sim.kcal > 0, 'some merges happened');
});

test('different moves give a different game', () => {
  assert.notStrictEqual(play(7, 40).sim.hash(), play(8, 40).sim.hash());
});

test('a drop must be a whole number inside the jar', () => {
  const sim = new Sim({ pub: 1 });
  sim.setPiece(1, { lv: 0 }); sim.setPiece(2, { lv: 0 });
  assert.strictEqual(sim.drop(10.5), false);
  assert.strictEqual(sim.drop(-1), false);
  assert.strictEqual(sim.drop(R.W + 1), false);
  assert.strictEqual(sim.drop(180), true);
  assert.strictEqual(sim.drop(180), false, 'next food is not ready yet');
});

test('a food cannot be dropped before it is revealed', () => {
  const sim = new Sim({ pub: 1 });
  assert.strictEqual(sim.canDrop(), false);
  sim.setPiece(1, { lv: 2 });
  assert.strictEqual(sim.canDrop(), true);
});

test('two equal foods merge into the next one and score calories', () => {
  const sim = new Sim({ pub: 1, events: true });
  for (let k = 1; k <= 3; k++) sim.setPiece(k, { lv: 0 });
  sim.drop(180);
  while (!sim.canDrop()) sim.tick();
  sim.drop(180);
  for (let i = 0; i < 240; i++) sim.tick();
  assert.strictEqual(sim.kcal, Sim.kcalFor(1));
  assert.strictEqual(sim.foods.length, 1);
  assert.strictEqual(sim.foods[0].food.lv, 1);
  assert.ok(sim.events.some((e) => e.type === 'merge' && e.gain === 10));
});

test('merging the golden food is recorded', () => {
  const sim = new Sim({ pub: 1 });
  sim.setPiece(1, { lv: 1, gold: true }); sim.setPiece(2, { lv: 1 }); sim.setPiece(3, { lv: 0 });
  sim.drop(180);
  assert.strictEqual(sim.gold, 'jar');
  while (!sim.canDrop()) sim.tick();
  sim.drop(180);
  for (let i = 0; i < 240; i++) sim.tick();
  assert.strictEqual(sim.gold, 'merged');
});

test('after 15 seconds the food must fall, and later drops are refused', () => {
  const sim = new Sim({ pub: 1 });
  sim.setPiece(1, { lv: 0 }); sim.setPiece(2, { lv: 0 });
  for (let i = 0; i < R.DROP_STEPS; i++) sim.tick();
  assert.strictEqual(sim.mustDrop(), true);
  assert.strictEqual(sim.canDrop(), true);
  sim.tick();
  assert.strictEqual(sim.canDrop(), false);
});

test('a run ends when the foods run out or the jar fills', () => {
  const { sim } = play(3);
  assert.strictEqual(sim.over, true);
  assert.ok(sim.overReason === 'full' || sim.overReason === 'done');
  assert.ok(sim.dropped <= R.MAX_FOODS);
});

test('each power-up works once', () => {
  const sim = new Sim({ pub: 5 });
  for (let k = 1; k <= 4; k++) sim.setPiece(k, { lv: k % 2 });
  assert.strictEqual(sim.power('shake'), false, 'nothing to shake in an empty jar');
  sim.drop(100);
  while (!sim.canDrop()) sim.tick();
  const before = [sim.pieces[2].lv, sim.pieces[3].lv];
  assert.strictEqual(sim.power('swap'), true);
  assert.deepStrictEqual([sim.pieces[2].lv, sim.pieces[3].lv], [before[1], before[0]]);
  assert.strictEqual(sim.power('swap'), false);
  assert.strictEqual(sim.power('shake'), true);
  assert.strictEqual(sim.power('sweep'), true);
  assert.strictEqual(sim.foods.length, 0);
  assert.strictEqual(sim.power('nope'), false);
});

test('a settled pile goes to rest, and wakes when it is hit or a food is taken away', () => {
  const sim = new Sim({ pub: 'rest' });
  // A donut on the floor with a cookie and a candy leaning on it: three different foods, nothing merges.
  [[3, 180], [1, 140], [0, 216]].forEach(([lv, x], k) => {
    sim.setPiece(k + 1, { lv, gold: false }); sim.setPiece(k + 2, { lv: 4, gold: false });
    while (!sim.canDrop()) sim.tick();
    sim.drop(x);
  });
  for (let i = 0; i < 400; i++) sim.tick();
  assert.ok(sim.foods.every((b) => b.isSleeping), 'everything is at rest a few seconds after the last drop');
  const before = sim.foods.map((b) => [b.position.x, b.position.y, b.angle]);
  for (let i = 0; i < 300; i++) sim.tick();
  assert.deepStrictEqual(sim.foods.map((b) => [b.position.x, b.position.y, b.angle]), before, 'a pile at rest does not move at all');

  // A can lands on the pile: what it hits wakes up.
  while (!sim.canDrop()) sim.tick();
  sim.drop(180);
  let woke = false;
  for (let i = 0; i < 120 && !woke; i++) { sim.tick(); woke = sim.foods.slice(0, 3).some((b) => !b.isSleeping); }
  assert.ok(woke, 'a falling food wakes the pile it lands on');

  // Sweep takes the small ones away: everything left is awake, so nothing stays hanging.
  for (let i = 0; i < 400; i++) sim.tick();
  assert.ok(sim.foods.every((b) => b.isSleeping));
  assert.ok(sim.power('sweep'));
  assert.ok(sim.foods.every((b) => !b.isSleeping), 'taking a food out wakes the rest');
});

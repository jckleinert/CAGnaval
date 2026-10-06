/*
 * The game simulation. The same file runs in the browser (to play) and on
 * the referee server (to check the run), and both must reach exactly the
 * same result from the same list of moves.
 *
 * Rules for anything written here:
 *  - time is counted in steps (60 per second), never in clock time
 *  - no Math.random, no Date; the only randomness is the seeded generator
 *  - only +, -, *, /, and the exact Math functions (the physics library is
 *    wrapped so it cannot use anything else, see detmath.js)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./matter-det.js'), require('./foods.js'));
  else { root.CAG = root.CAG || {}; root.CAG.Sim = factory(root.CAG.Matter, root.CAG.FOODS); }
})(typeof self !== 'undefined' ? self : this, function (Matter, FOODS) {
  'use strict';
  var Engine = Matter.Engine, Bodies = Matter.Bodies, Body = Matter.Body, Composite = Matter.Composite, Events = Matter.Events;

  var RULES = Object.freeze({
    VERSION: 3,            // bump whenever anything that changes the outcome of a run changes
    W: 360, H: 520,        // jar size in game units
    PAD: 3,                // inner margin of the jar walls
    DROP_Y: 46,            // height the food is dropped from
    LINE_Y: 96,            // the "full" line
    WALL: 60,
    STEP_MS: 1000 / 60,
    GRAVITY: 1.5,
    READY_STEPS: 31,       // wait after a drop before the next food is ready (about half a second)
    SETTLE_STEPS: 150,     // wait after the last food before the run ends
    GRACE_STEPS: 72,       // a new food cannot count as "over the line" for this long
    WARN_STEPS: 18,
    FULL_STEPS: 96,        // a food over the line for this long ends the run
    DROP_STEPS: 900,       // 15 seconds to drop each food
    MAX_FOODS: 200,
    SPAWN_LEVELS: 5,       // dropped foods are levels 0..4
    DOUBLE_TOP_KCAL: 1000
  });
  var TOP = FOODS.length - 1;

  function kcalFor(lv) { return 10 * lv * (lv + 1) / 2; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  /* Small seeded generator (mulberry32): integer math only, same everywhere. */
  function rng32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /*
   * opts.pub     public seed of the run (only used by Shake)
   * opts.events  true to collect visual events (merges, sweeps) for the page
   */
  function Sim(opts) {
    opts = opts || {};
    this.pub = (opts.pub >>> 0) || 0;
    this._rand = rng32(this.pub);
    this._collect = !!opts.events;
    this.events = [];

    this.engine = Engine.create({ positionIterations: 8, velocityIterations: 6 });
    this.engine.gravity.y = RULES.GRAVITY;
    this.world = this.engine.world;
    this._nextId = 1;

    var W = RULES.W, H = RULES.H, PAD = RULES.PAD, WALL = RULES.WALL;
    this._addBody(Bodies.rectangle(PAD - WALL / 2, H / 2, WALL, H * 3, { isStatic: true }));
    this._addBody(Bodies.rectangle(W - PAD + WALL / 2, H / 2, WALL, H * 3, { isStatic: true }));
    this._addBody(Bodies.rectangle(W / 2, H - PAD + WALL / 2, W + WALL * 2, WALL, { isStatic: true }));

    this.foods = [];           // bodies in the jar, oldest first
    this.pieces = [];          // pieces[k] = { lv, gold } for the k-th food of the run (1-based), as revealed
    this.step = 0;
    this.kcal = 0;
    this.dropped = 0;
    this.ready = true;         // a food is waiting to be dropped
    this.readyAt = 0;
    this.turnStart = 0;
    this.maxLv = -1;
    this.warn = false;
    this.over = false;
    this.overReason = null;    // 'full' | 'done'
    this.overStep = -1;
    this.gold = 'none';        // 'none' | 'jar' | 'merged'
    this.uses = { shake: 1, swap: 1, sweep: 1 };
    this._merges = [];

    var self = this;
    var onPairs = function (ev) { self._onPairs(ev.pairs); };
    Events.on(this.engine, 'collisionStart', onPairs);
    Events.on(this.engine, 'collisionActive', onPairs);
  }

  /* Body ids are numbered per run so they are the same on both sides. */
  Sim.prototype._addBody = function (b) {
    b.id = this._nextId++;
    Composite.add(this.world, b);
    return b;
  };

  Sim.prototype._emit = function (ev) { if (this._collect) this.events.push(ev); };

  Sim.prototype._add = function (x, y, lv, gold) {
    var f = FOODS[lv], PAD = RULES.PAD, b;
    var px = clamp(x, f.ext + PAD + 1, RULES.W - f.ext - PAD - 1), py = Math.min(y, RULES.H - f.ext - PAD - 1);
    var o = { restitution: f.rest, friction: f.fric, frictionAir: 0.004, density: f.dens };
    if (f.poly) {
      o.position = { x: px, y: py };
      o.vertices = f.poly.map(function (p) { return { x: p.x, y: p.y }; });
      b = Body.create(o);
    } else b = Bodies.circle(px, py, f.r, o);
    b.food = { lv: lv, gold: !!gold, born: this.step, above: 0, gone: false };
    this._addBody(b);
    this.foods.push(b);
    if (lv > this.maxLv) this.maxLv = lv;
    return b;
  };

  Sim.prototype._remove = function (b) {
    Composite.remove(this.world, b);
    var i = this.foods.indexOf(b);
    if (i >= 0) this.foods.splice(i, 1);
  };

  Sim.prototype._onPairs = function (pairs) {
    for (var i = 0; i < pairs.length; i++) {
      var a = pairs[i].bodyA, b = pairs[i].bodyB;
      if (!a.food || !b.food || a.food.gone || b.food.gone || a.food.lv !== b.food.lv) continue;
      a.food.gone = b.food.gone = true;
      this._merges.push(a, b);
    }
  };

  Sim.prototype._runMerges = function () {
    var m = this._merges;
    if (!m.length) return;
    for (var i = 0; i < m.length; i += 2) {
      var a = m[i], b = m[i + 1], lv = a.food.lv, gain;
      var x = (a.position.x + b.position.x) / 2, y = (a.position.y + b.position.y) / 2;
      var golden = a.food.gold || b.food.gold;
      this._remove(a); this._remove(b);
      if (lv < TOP) {
        var nb = this._add(x, y, lv + 1, false);
        Body.setVelocity(nb, { x: (a.velocity.x + b.velocity.x) / 2, y: (a.velocity.y + b.velocity.y) / 2 });
        gain = kcalFor(lv + 1);
      } else gain = RULES.DOUBLE_TOP_KCAL;
      if (golden) this.gold = 'merged';
      this.kcal += gain;
      this._emit({ type: 'merge', x: x, y: y, lv: Math.min(lv + 1, TOP), made: lv < TOP, gain: gain, gold: golden });
    }
    m.length = 0;
  };

  Sim.prototype._checkFull = function () {
    var warn = false, full = false;
    for (var i = 0; i < this.foods.length; i++) {
      var b = this.foods[i], f = b.food;
      if (this.step - f.born < RULES.GRACE_STEPS) { f.above = 0; continue; }
      if (b.bounds.min.y < RULES.LINE_Y) {
        f.above++;
        if (f.above > RULES.WARN_STEPS) warn = true;
        if (f.above > RULES.FULL_STEPS) full = true;
      } else f.above = 0;
    }
    this.warn = warn;
    if (full) this._end('full');
  };

  Sim.prototype._end = function (reason) {
    this.over = true; this.overReason = reason; this.overStep = this.step;
  };

  /* Reveal the k-th food of the run (1-based). */
  Sim.prototype.setPiece = function (k, piece) {
    this.pieces[k] = { lv: piece.lv | 0, gold: !!piece.gold };
  };
  /* The food waiting to be dropped, or null. */
  Sim.prototype.current = function () {
    return (!this.over && this.ready && this.dropped < RULES.MAX_FOODS) ? (this.pieces[this.dropped + 1] || null) : null;
  };
  /* The food shown in the "Next" slot, or null. */
  Sim.prototype.preview = function () {
    var k = this.dropped + (this.ready ? 2 : 1);
    return k <= RULES.MAX_FOODS ? (this.pieces[k] || null) : null;
  };
  Sim.prototype.left = function () { return RULES.MAX_FOODS - this.dropped; };
  Sim.prototype.deadline = function () { return this.turnStart + RULES.DROP_STEPS; };
  Sim.prototype.canDrop = function () {
    return !this.over && this.ready && this.dropped < RULES.MAX_FOODS && !!this.pieces[this.dropped + 1] && this.step <= this.deadline();
  };
  /* True when the 15 seconds are up and the food has to fall now. */
  Sim.prototype.mustDrop = function () {
    return !this.over && this.ready && this.dropped < RULES.MAX_FOODS && this.step >= this.deadline();
  };

  /* Drop the current food at x (a whole number of game units, 0..W). */
  Sim.prototype.drop = function (x) {
    if (!this.canDrop()) return false;
    if (x !== (x | 0) || x < 0 || x > RULES.W) return false;
    var p = this.pieces[this.dropped + 1], f = FOODS[p.lv];
    this._add(clamp(x, f.hw + RULES.PAD + 2, RULES.W - f.hw - RULES.PAD - 2), RULES.DROP_Y, p.lv, p.gold);
    if (p.gold) this.gold = 'jar';
    this.dropped++;
    this.ready = false;
    this.readyAt = this.step + RULES.READY_STEPS;
    return true;
  };

  /* Power-ups, one use each per run. Returns true if it was applied. */
  Sim.prototype.power = function (type) {
    if (this.over || !this.uses[type]) return false;
    var i, b;
    if (type === 'shake') {
      if (!this.foods.length) return false;
      for (i = 0; i < this.foods.length; i++) {
        b = this.foods[i];
        var dx = this._rand() * 12 - 6, dy = 4 + this._rand() * 5, da = this._rand() * 0.3 - 0.15;
        Body.setVelocity(b, { x: b.velocity.x + dx, y: b.velocity.y - dy });
        Body.setAngularVelocity(b, b.angularVelocity + da);
        b.food.born = this.step; b.food.above = 0;
      }
    } else if (type === 'swap') {
      var k = this.dropped + 1;
      if (!this.ready || k + 1 > RULES.MAX_FOODS || !this.pieces[k] || !this.pieces[k + 1]) return false;
      var t = this.pieces[k]; this.pieces[k] = this.pieces[k + 1]; this.pieces[k + 1] = t;
    } else if (type === 'sweep') {
      var hit = [];
      for (i = 0; i < this.foods.length; i++) {
        b = this.foods[i];
        if (b.food.lv <= 1 && !b.food.gone && !b.food.gold) hit.push(b);
      }
      if (!hit.length) return false;
      for (i = 0; i < hit.length; i++) {
        hit[i].food.gone = true;
        this._emit({ type: 'sweep', x: hit[i].position.x, y: hit[i].position.y, lv: hit[i].food.lv });
        this._remove(hit[i]);
      }
    } else return false;
    this.uses[type] = 0;
    return true;
  };

  /* Advance the game one step (1/60 of a second). */
  Sim.prototype.tick = function () {
    if (this.over) return;
    Engine.update(this.engine, RULES.STEP_MS);
    this.step++;
    this._runMerges();
    if (!this.ready) {
      if (this.dropped >= RULES.MAX_FOODS) {
        if (this.step >= this.readyAt + RULES.SETTLE_STEPS) {
          this._checkFull();
          if (!this.over) this._end('done');
          return;
        }
      } else if (this.step >= this.readyAt) {
        this.ready = true; this.turnStart = this.step;
      }
    }
    this._checkFull();
  };

  /*
   * Fingerprint of the exact state of the run. The page sends it with every
   * drop; if it ever differs from the referee's, the two simulations have
   * drifted apart and we know at which drop.
   */
  var hbuf = new DataView(new ArrayBuffer(8));
  Sim.prototype.hash = function () {
    var h = 0x811c9dc5;
    function mix(n) { h ^= n; h = Math.imul(h, 0x01000193); }
    function mixF(v) { hbuf.setFloat64(0, v, true); mix(hbuf.getUint32(0, true)); mix(hbuf.getUint32(4, true)); }
    mix(this.step); mix(this.kcal); mix(this.dropped); mix(this.foods.length);
    for (var i = 0; i < this.foods.length; i++) {
      var b = this.foods[i];
      mix(b.food.lv * 2 + (b.food.gold ? 1 : 0));
      mixF(b.position.x); mixF(b.position.y); mixF(b.angle);
    }
    return h >>> 0;
  };

  Sim.RULES = RULES;
  Sim.FOODS = FOODS;
  Sim.TOP = TOP;
  Sim.kcalFor = kcalFor;
  Sim.rng32 = rng32;
  return Sim;
});

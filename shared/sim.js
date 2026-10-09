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

  /* Round foods touch as true circles.
     The engine treats a circle as a polygon with flat sides, and two flat sides resting on each
     other hold still: a cookie dropped on top of a waffle would sit there in balance, however hard
     it landed. So when both bodies are round, the contact is worked out here from their centres
     and radii, which is exact (and much cheaper). Round against flat things (walls, floor,
     onigiri, can, box) still goes through the engine's polygons. */
  var Collision = Matter.Collision, Pair = Matter.Pair;
  if (!Collision.cagRound) {
    Collision.cagRound = true;
    var polygons = Collision.collides;
    Collision.collides = function (bodyA, bodyB, pairs) {
      if (!bodyA.circleRadius || !bodyB.circleRadius) return polygons(bodyA, bodyB, pairs);
      var a = bodyA.id < bodyB.id ? bodyA : bodyB, b = a === bodyA ? bodyB : bodyA;
      var dx = a.position.x - b.position.x, dy = a.position.y - b.position.y;
      var d2 = dx * dx + dy * dy, r = a.circleRadius + b.circleRadius;
      if (d2 >= r * r) return null;
      var pair = pairs && pairs.table[Pair.id(a, b)], c;
      if (pair) c = pair.collision;
      else { c = Collision.create(a, b); c.collided = true; c.bodyA = a; c.bodyB = b; c.parentA = a.parent; c.parentB = b.parent; }
      var d = Math.sqrt(d2), nx = 0, ny = -1;                 // the normal points from b to a
      if (d > 1e-9) { nx = dx / d; ny = dy / d; }
      if (nx > -0.004 && nx < 0.004) {                        // dead centre, one right on top of the other:
        nx = (a.id + b.id) & 1 ? 0.004 : -0.004;              // nothing balances there, so it leans to one side
        ny = ny < 0 ? -0.999992 : 0.999992;
      }
      c.normal.x = nx; c.normal.y = ny;
      c.tangent.x = -ny; c.tangent.y = nx;
      c.depth = r - d;
      c.penetration.x = nx * c.depth; c.penetration.y = ny * c.depth;
      // One point of contact, halfway into the overlap. The engine keeps it per pair, so it is one object, moved every step.
      var touch = c.touch || (c.touch = { x: 0, y: 0, index: 0, body: b, isInternal: false });
      touch.x = b.position.x + nx * (b.circleRadius - c.depth / 2);
      touch.y = b.position.y + ny * (b.circleRadius - c.depth / 2);
      c.supports[0] = touch; c.supports.length = 1;
      return c;
    };
  }

  /*
   * Rest. Foods pressed together in a pile never come to a full stop on their own: the engine keeps
   * nudging them apart, and they tremble and slowly turn for ever. So a food that has stayed in the
   * same spot for a while goes to rest: it stops dead and holds its place like part of the jar.
   * It gets going again as soon as a food that is moving touches it, and every food gets going
   * when one is taken out of the jar (a merge, Sweep) or the jar is shaken.
   * So that none is left hanging when what held it creeps away: every time a food really changes
   * place, the resting foods right next to it are let loose for a moment. If they have nothing to
   * do they go back to rest; if they were being held, they fall.
   */
  var Sleeping = Matter.Sleeping, Resolver = Matter.Resolver;
  if (!Resolver.cagRest) {
    Resolver.cagRest = true;
    var solveStart = Resolver.preSolvePosition;
    Resolver.preSolvePosition = function (pairs) {         // runs every step, once the touching pairs are known
      var fast = RULES.REST_SPEED * RULES.REST_SPEED;
      for (var i = 0; i < pairs.length; i++) {
        var p = pairs[i];
        if (!p.isActive) continue;
        var a = p.collision.parentA, b = p.collision.parentB;
        if (!a.food || !b.food || a.isSleeping === b.isSleeping) continue;
        var still = a.isSleeping ? a : b, other = a.isSleeping ? b : a;
        // "moving": fast, and going somewhere. One that only trembles on its spot wakes nobody.
        if (!(other.food.v2 < fast) && other.food.stay < RULES.REST_CHECK) { Sleeping.set(still, false); still.food.quiet = 0; still.food.stay = 0; still.food.hit = true; }
      }
      solveStart(pairs);
    };
  }

  /*
   * No bounce for the gentlest touches. A heavy food sitting on a light one would otherwise never
   * settle: the tiny bounce the engine gives every touch keeps the two hammering each other.
   * Foods that meet slower than BOUNCE_MIN just stop; anything that really falls bounces as always.
   */
  if (!Resolver.cagBounce) {
    Resolver.cagBounce = true;
    var solveSpeeds = Resolver.preSolveVelocity;
    Resolver.preSolveVelocity = function (pairs) {
      for (var i = 0; i < pairs.length; i++) {
        var p = pairs[i];
        if (!p.isActive) continue;
        var c = p.collision, a = c.parentA, b = c.parentB;
        var closing = ((a.position.x - a.positionPrev.x) - (b.position.x - b.positionPrev.x)) * c.normal.x +
                      ((a.position.y - a.positionPrev.y) - (b.position.y - b.positionPrev.y)) * c.normal.y;
        if (closing > -RULES.BOUNCE_MIN) p.restitution = 0;
      }
      solveSpeeds(pairs);
    };
  }

  var RULES = Object.freeze({
    VERSION: 11,            // bump whenever anything that changes the outcome of a run changes
    W: 360, H: 520,        // jar size in game units
    PAD: 3,                // inner margin of the jar walls
    DROP_Y: 46,            // height the food is dropped from
    LINE_Y: 96,            // the "full" line: a food is over it when its centre is, so half of it may stick out
    WALL: 60,
    WALL_GIVE: 0.5,        // how far a food may sink into a wall or the floor before it is put back
    STEP_MS: 1000 / 60,
    GRAVITY: 1.5,
    BOUNCE_MIN: 1.5,       // game units per step; foods that meet slower than this do not bounce (a fall of about 3 units)
    READY_STEPS: 31,       // wait after a drop before the next food is ready (about half a second)
    SETTLE_STEPS: 150,     // wait after the last food before the run ends
    GRACE_STEPS: 72,       // a new food cannot count as "over the line" for this long
    WARN_STEPS: 18,        // over the line for this long: the warning starts
    FULL_STEPS: 180,       // over the line for this long, without a break: the run ends (3 seconds, time for the pile to settle)
                           // ...or at once, when a second food also stays over the line (past WARN_STEPS) while the first is there
    REST_STEPS: 60,        // a food that stays in the same spot this long goes to rest (1 second)
    REST_ROOM: 1.2,        // "the same spot": it has not moved or turned (measured at its rim) more than this
    REST_SPEED: 0.2,       // game units per step; a food moving faster than this wakes the resting foods it touches
    REST_LONG: 150,        // a food whose centre has not left its spot for this long rests even if it is still bouncing or spinning there
    REST_CHECK: 10,        // steps a resting food is let loose when a neighbour changes place
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
    this.warn = false; this.danger = 0;
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

  Sim.prototype._add = function (x, y, lv, gold, angle) {
    var f = FOODS[lv], PAD = RULES.PAD, b;
    var px = clamp(x, f.ext + PAD + 1, RULES.W - f.ext - PAD - 1), py = Math.min(y, RULES.H - f.ext - PAD - 1);
    var o = { restitution: f.rest, friction: f.fric, frictionAir: 0.004, density: f.dens };
    if (f.poly) {
      o.position = { x: px, y: py };
      o.vertices = f.poly.map(function (p) { return { x: p.x, y: p.y }; });
      if (angle) o.angle = angle;
      b = Body.create(o);
    } else b = Bodies.circle(px, py, f.r, o);
    // ax, ay, aa: the spot and angle it is being watched at; stay: steps its centre has stayed there;
    // quiet: steps it has neither moved nor turned; v2: its speed, squared
    b.food = { lv: lv, gold: !!gold, born: this.step, above: 0, gone: false, ax: px, ay: py, aa: angle || 0, quiet: 0, stay: 0, v2: 1, hit: false };
    this._addBody(b);
    this.foods.push(b);
    if (lv > this.maxLv) this.maxLv = lv;
    return b;
  };

  /*
   * The walls and the floor are solid. The engine only pushes a food out of a wall little by little,
   * so a small food squeezed by heavy ones could sink into the glass and even end up outside the jar.
   * After every step, a food that is more than WALL_GIVE into a wall is put back against it.
   */
  Sim.prototype._keepIn = function () {
    var give = RULES.WALL_GIVE, left = RULES.PAD - give, right = RULES.W - RULES.PAD + give, floor = RULES.H - RULES.PAD + give;
    for (var i = 0; i < this.foods.length; i++) {
      var b = this.foods[i], vs = b.vertices, x0 = vs[0].x, x1 = x0, y1 = vs[0].y, mx = 0, my = 0;
      if (b.isSleeping) continue;
      for (var k = 1; k < vs.length; k++) {        // its real outline (b.bounds also covers where it is heading)
        if (vs[k].x < x0) x0 = vs[k].x; else if (vs[k].x > x1) x1 = vs[k].x;
        if (vs[k].y > y1) y1 = vs[k].y;
      }
      if (x0 < left) mx = left - x0; else if (x1 > right) mx = right - x1;
      if (y1 > floor) my = floor - y1;
      if (!mx && !my) continue;
      var vx = b.position.x - b.positionPrev.x, vy = b.position.y - b.positionPrev.y;
      Body.setPosition(b, { x: b.position.x + mx, y: b.position.y + my });
      if ((mx > 0 && vx < 0) || (mx < 0 && vx > 0)) vx = 0;        // and it stops pushing into the wall
      if (my && vy > 0) vy = 0;
      Body.setVelocity(b, { x: vx, y: vy });
    }
  };

  /* Foods that have settled go to rest (see "Rest" above). */
  Sim.prototype._rest = function () {
    var room = RULES.REST_ROOM * RULES.REST_ROOM, slow = RULES.REST_SPEED * RULES.REST_SPEED;
    for (var i = 0; i < this.foods.length; i++) {
      var b = this.foods[i], f = b.food;
      if (b.isSleeping) { f.v2 = 0; continue; }
      var vx = b.position.x - b.positionPrev.x, vy = b.position.y - b.positionPrev.y, r = FOODS[f.lv].r;
      var turn = (b.angle - b.anglePrev) * r;
      var dx = b.position.x - f.ax, dy = b.position.y - f.ay, da = (b.angle - f.aa) * r;
      var moved = dx * dx + dy * dy >= room;
      f.v2 = vx * vx + vy * vy;
      if (moved || f.hit) { f.hit = false; this._stir(b); }
      if (moved) { f.ax = b.position.x; f.ay = b.position.y; f.aa = b.angle; f.quiet = 0; f.stay = 0; continue; }
      if (da * da >= room) { f.aa = b.angle; f.quiet = 0; } else f.quiet++;
      if (++f.stay >= RULES.REST_LONG || (f.quiet >= RULES.REST_STEPS && f.v2 + turn * turn < slow)) Sleeping.set(b, true);
    }
  };
  /* Let loose, for a moment, the resting foods next to one that has changed place. */
  Sim.prototype._stir = function (b) {
    var box = b.bounds, near = 2, quiet = RULES.REST_STEPS - RULES.REST_CHECK;
    for (var i = 0; i < this.foods.length; i++) {
      var o = this.foods[i], ob = o.bounds;
      if (!o.isSleeping || ob.min.x > box.max.x + near || ob.max.x < box.min.x - near || ob.min.y > box.max.y + near || ob.max.y < box.min.y - near) continue;
      Sleeping.set(o, false); o.food.quiet = quiet; o.food.stay = RULES.REST_LONG - RULES.REST_CHECK;
    }
  };
  Sim.prototype._wakeAll = function () {
    for (var i = 0; i < this.foods.length; i++) {
      var b = this.foods[i];
      if (b.isSleeping) Sleeping.set(b, false);
      b.food.quiet = 0; b.food.stay = 0;
    }
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
    this._wakeAll();           // what rested on the merged foods has to fall
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
    var warn = false, full = false, most = 0, over = 0;
    for (var i = 0; i < this.foods.length; i++) {
      var b = this.foods[i], f = b.food;
      if (this.step - f.born < RULES.GRACE_STEPS) { f.above = 0; continue; }
      if (b.position.y < RULES.LINE_Y) {
        f.above++;
        if (f.above > most) most = f.above;
        if (f.above > RULES.WARN_STEPS) { warn = true; over++; }
        if (f.above > RULES.FULL_STEPS) full = true;
      } else f.above = 0;
    }
    if (over >= 2) full = true;      // two foods over the line at once: no more waiting
    this.warn = warn;
    this.danger = most;      // steps the worst food has been over the line; the run ends past FULL_STEPS
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
  /* Some foods (f.tilt) are dropped leaning to one side, so they land on a corner and tumble
     instead of falling flat. The side alternates from one drop to the next. */
  function tiltOf(lv, k) { var t = FOODS[lv].tilt || 0; return t ? ((k & 1) ? t : -t) : 0; }
  /* The angle the food in hand will be dropped at. */
  Sim.prototype.dropAngle = function () {
    var p = this.current();
    return p ? tiltOf(p.lv, this.dropped + 1) : 0;
  };

  Sim.prototype.drop = function (x) {
    if (!this.canDrop()) return false;
    if (x !== (x | 0) || x < 0 || x > RULES.W) return false;
    var p = this.pieces[this.dropped + 1], f = FOODS[p.lv];
    this._add(clamp(x, f.hw + RULES.PAD + 2, RULES.W - f.hw - RULES.PAD - 2), RULES.DROP_Y, p.lv, p.gold, tiltOf(p.lv, this.dropped + 1));
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
      this._wakeAll();
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
      this._wakeAll();
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
    this._keepIn();
    this._rest();
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

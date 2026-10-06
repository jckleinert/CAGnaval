/*
 * The game page. It plays the run with the shared simulation and reports
 * every move to the referee, which plays the same run on its side and owns
 * the score. The page never decides which foods come next.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var Sim = window.CAG && window.CAG.Sim;
  if (!Sim) { $('fail').hidden = false; return; }

  var R = Sim.RULES, FOODS = Sim.FOODS, TOP = Sim.TOP;
  var W = R.W, H = R.H, TAU = Math.PI * 2;
  var EMOJI = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
  var GOLD = '#FFC93C';
  var CONFETTI = ['#EE3D77', '#3BC7F5', '#FFC93C'];
  var GREEN = '#4CC463';
  /* A food with its own drawing (f.art) has a picture in web/img/foods/<level>.webp holding its faces
     side by side; f.art.faces says which one is the normal face, eyes half closed, eyes closed and
     surprised (a food drawn with a single face uses it for all four). The rest are placeholders. */
  var FACE_OPEN = 0, FACE_HALF = 1, FACE_CLOSED = 2, FACE_WOW = 3, FACES = 4;
  var ART = {};
  FOODS.forEach(function (f, i) {
    f.i = i;
    if (!f.art) return;
    var img = new Image(), a = ART[i] = { img: img, ok: false, cache: {}, cached: 0 };
    img.onload = function () { a.ok = true; lastNext = '?'; drawLadder(); };
    img.src = '/web/img/foods/' + i + '.webp';
  });
  var apiMeta = document.querySelector('meta[name="cag-api"]');
  var API = apiMeta ? apiMeta.content.replace(/\/$/, '') : '';

  var cv = $('game'), ctx = cv.getContext('2d'), stage = $('stage'), jar = $('jar');
  var kcalEl = $('kcal'), bestEl = $('best'), nextDisc = $('nextDisc'), ladder = $('ladder');
  var statusEl = $('status'), toastEl = $('toast');
  var homeEl = $('home'), overEl = $('over'), boardEl = $('board'), nameEl = $('name');
  var btn = { shake: $('pwShake'), swap: $('pwSwap'), sweep: $('pwSweep') };
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var css = getComputedStyle(document.documentElement);
  var INK = css.getPropertyValue('--ink').trim() || '#1B2233';
  var LANTERN = css.getPropertyValue('--pink').trim() || '#EF4360';
  var cagEl = $('cag'), leftEl = $('left');

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function fmt(n) { return Number(n).toLocaleString('en-US'); }
  function load(key, fallback) { try { var v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } }
  function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage is optional */ } }

  /* Player: a random id kept in this browser plus the name typed on the start screen. */
  function newId() {
    var a = new Uint8Array(16), s = '';
    (window.crypto || window.msCrypto).getRandomValues(a);
    for (var i = 0; i < a.length; i++) s += ('0' + a[i].toString(16)).slice(-2);
    return s;
  }
  var player = load('cagnaval.player', null);
  if (!player || typeof player.id !== 'string' || player.id.length < 8) { player = { id: newId(), name: '' }; save('cagnaval.player', player); }
  var best = load('cagnaval.best', 0) || 0;

  /* Talking to the referee */
  function call(method, path, body, tries) {
    return new Promise(function (resolve, reject) {
      var attempt = 0;
      function fail(code, status) { var e = new Error(code); e.code = code; e.status = status || 0; reject(e); }
      (function go() {
        attempt++;
        var ctl = window.AbortController ? new AbortController() : null;
        var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 8000);
        fetch(API + path, {
          method: method, cache: 'no-store', signal: ctl ? ctl.signal : undefined,
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined
        }).then(function (res) {
          clearTimeout(timer);
          return res.json().catch(function () { return {}; }).then(function (data) {
            if (res.status >= 500 && attempt < tries) { setTimeout(go, 400 * attempt); return; }
            if (res.status >= 400) fail(data.error || 'http-' + res.status, res.status); else resolve(data);
          });
        }).catch(function () {
          clearTimeout(timer);
          if (attempt < tries) setTimeout(go, 400 * attempt); else fail('network');
        });
      })();
    });
  }

  /* ---------- run state ---------- */
  var run = null;      // { id, sim, seq, chain, live, desync, goldSeen, ending }
  var aim = W / 2, down = false, fx = [], toastTimer = 0, scale = 1, lastStatus = '', lastNext = '', lastMax = -2, lastUses = '', lastCag = -999, lastLeft = -2, boardBack = null, avSize = 44, nowMs = 0, vis = {};

  function toast(msg) {
    toastEl.textContent = msg; toastEl.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.hidden = true; }, 2200);
  }

  function startRun() {
    var name = nameEl.value.replace(/\s+/g, ' ').trim().slice(0, 16);
    player.name = name || 'Player'; save('cagnaval.player', player);
    $('play').disabled = true; $('again').disabled = true; $('homeMsg').textContent = 'Starting…';
    call('POST', '/api/runs', { player: player }, 2).then(function (start) {
      var sim = new Sim({ pub: start.pub, events: true });
      sim.setPiece(1, start.pieces[0]); sim.setPiece(2, start.pieces[1]);
      run = { id: start.runId, sim: sim, seq: 0, chain: Promise.resolve(), live: true, desync: false, goldSeen: false, ending: false, barFrom: 1, barAt: 0 };
      fx.length = 0; vis = {}; aim = W / 2; acc = 0; last = 0;
      homeEl.hidden = true; overEl.hidden = true; boardEl.hidden = true; toastEl.hidden = true; boardBack = null;
      $('homeMsg').textContent = '';
      cv.focus();
    }).catch(function (e) {
      homeEl.hidden = false; overEl.hidden = true;
      $('homeMsg').textContent = e.code === 'slow-down' ? 'Too many requests. Wait a moment.' : 'Could not reach the server. Try again.';
    }).then(function () { $('play').disabled = false; $('again').disabled = false; });
  }

  /* Messages of a run go out one at a time, in order. */
  function post(kind, msg, onReply) {
    var r = run;
    r.chain = r.chain.then(function () {
      if (!r.live && !r.ending) return null;
      return call('POST', '/api/runs/' + r.id + '/' + kind, msg, 3).then(function (reply) {
        if (reply.sync === false) r.desync = true;
        onReply(reply);
      });
    }).catch(function (e) { stopRun(r, e.code); });
  }

  function doDrop() {
    if (!run || !run.live) return;
    var sim = run.sim, x = Math.round(clamp(aim, 0, W));
    if (!sim.canDrop()) return;
    var msg = { seq: run.seq + 1, step: sim.step, x: x, h: sim.hash() };
    var timeLeft = clamp((sim.deadline() - sim.step) / R.DROP_STEPS, 0, 1);
    if (!sim.drop(x)) return;
    run.seq++;
    run.barFrom = timeLeft; run.barAt = sim.step;   // the time bar refills from here
    post('drop', msg, function (reply) { if (reply.piece) sim.setPiece(reply.k, reply.piece); });
  }

  function usePower(type) {
    if (!run || !run.live) return;
    var sim = run.sim, msg = { seq: run.seq + 1, step: sim.step, power: type, h: sim.hash() };
    if (!sim.power(type)) {
      if (!sim.uses[type]) return;
      toast(type === 'shake' ? 'Nothing to shake yet' : type === 'sweep' ? 'No candy or cookies in the jar' : (sim.ready ? 'No next food to swap' : 'Wait for the next food'));
      return;
    }
    run.seq++;
    post('power', msg, function (reply) {
      (reply.pieces || []).forEach(function (p, i) { if (p) sim.setPiece(reply.k + i, p); });
    });
  }

  /* The run ended normally: wait for pending messages, then ask the referee for the result. */
  function endRun() {
    var r = run, sim = r.sim;
    r.live = false; r.ending = true;
    r.chain = r.chain.then(function () {
      return call('POST', '/api/runs/' + r.id + '/finish', { step: sim.overStep, kcal: sim.kcal, reason: 'over' }, 3);
    }).then(function (res) { showResult(r, res, null); }).catch(function (e) { stopRun(r, e.code); });
  }

  /* Something broke the run (expired, connection lost, refused move). Show what the referee has. */
  function stopRun(r, code) {
    if (r.stopped) return;
    r.stopped = true; r.live = false; r.ending = false;
    var sim = r.sim;
    call('POST', '/api/runs/' + r.id + '/finish', { step: sim.over ? sim.overStep : sim.step, kcal: sim.kcal, reason: sim.over ? 'over' : 'quit' }, 2)
      .then(function (res) { showResult(r, res, code); })
      .catch(function () { showResult(r, null, code); });
  }

  function showResult(r, res, problem) {
    if (run !== r) return;
    var sim = r.sim, kcal = res ? res.kcal : sim.kcal, title;
    if (problem === 'run-expired' || (res && res.status === 'expired')) title = 'Run expired';
    else if (problem === 'network') title = 'Connection lost';
    else if (problem) title = 'Run stopped';
    else title = sim.overReason === 'done' ? 'All ' + R.MAX_FOODS + ' foods dropped!' : 'Jar is full!';
    $('overTitle').textContent = title;
    $('overKcal').textContent = fmt(kcal);
    $('overUsed').textContent = (res ? res.dropped : sim.dropped) + ' of ' + R.MAX_FOODS + ' foods';
    var topFood = FOODS[Math.max(0, res ? res.maxLv : sim.maxLv)];
    $('overTop').textContent = 'Biggest: ' + topFood.e + ' ' + topFood.n;

    var ob = $('overBonus'), g = res && res.gold;
    ob.classList.toggle('hot', !!(g && g.merged));
    ob.textContent = !g ? '' : g.merged ? 'Golden bonus: ×' + g.mult + ' (practice, no prize)'
      : g.appeared ? 'Golden food was not merged: no bonus' : 'No golden food this run';

    var oc = $('overCheck'), ok = !!(res && res.verified);
    oc.classList.toggle('bad', !ok); oc.classList.toggle('ok', ok);
    oc.textContent = !res ? 'The referee could not be reached: this run was not saved.'
      : ok ? '✓ Checked by the referee'
      : res.status === 'expired' ? 'More than 15 seconds without a move. Calories so far were kept.'
      : !res.counted ? 'The referee refused this run. It does not count.'
      : res.sync === false ? 'Your screen and the referee disagreed from move ' + res.mismatchAt + '. The referee score is used.'
      : 'The referee score is used.';

    $('overWeek').textContent = '';
    if (res && res.counted) {
      if (res.verified && kcal > best) { best = kcal; save('cagnaval.best', best); }
      call('GET', '/api/leaderboard?player=' + encodeURIComponent(player.id), null, 1).then(function (b) {
        if (run === r && b.you) $('overWeek').textContent = 'Rank ' + b.you.rank + ' this week with ' + fmt(b.you.total) + ' kcal';
      }).catch(function () { /* ranking is optional here */ });
    }
    overEl.hidden = false;
    $('again').focus();
  }

  function openBoard() {
    var list = $('rank'), msg = $('rankMsg');
    list.textContent = ''; msg.textContent = 'Loading…';
    // The ranking takes the place of the card it was opened from, and gives it back on close.
    boardBack = !overEl.hidden ? overEl : !homeEl.hidden ? homeEl : null;
    if (boardBack) boardBack.hidden = true;
    boardEl.hidden = false;
    call('GET', '/api/leaderboard?player=' + encodeURIComponent(player.id), null, 2).then(function (b) {
      msg.textContent = b.top.length ? '' : 'No runs yet this week. Be the first.';
      var rows = b.top.slice(0, 15);
      if (b.you && b.you.rank > rows.length) rows.push(b.you);
      rows.forEach(function (row) {
        var li = document.createElement('li'), a = document.createElement('span'), n = document.createElement('span'), k = document.createElement('span');
        a.className = 'pos'; a.textContent = row.rank; n.className = 'who'; n.textContent = row.name; k.textContent = fmt(row.total);
        if (row.you) li.className = 'you';
        li.appendChild(a); li.appendChild(n); li.appendChild(k); list.appendChild(li);
      });
    }).catch(function () { msg.textContent = 'Could not load the ranking.'; });
  }

  /* ---------- screen updates ---------- */
  function icon(f, size, gold) {
    var dpr = Math.min(window.devicePixelRatio || 1, 3), c = document.createElement('canvas');
    c.width = c.height = Math.round(size * dpr);
    var g = c.getContext('2d'), s = (size / 2 - 2) / (f.ext * (gold ? 1.5 : 1)) * dpr;
    g.setTransform(s, 0, 0, s, c.width / 2, c.height / 2);
    drawFood(g, 0, 0, f, 0, gold, 0, FACE_OPEN);
    return c;
  }
  function drawLadder() {
    ladder.textContent = '';
    FOODS.forEach(function (f) {
      var li = document.createElement('li');
      li.title = f.n; li.setAttribute('aria-label', f.n);
      li.appendChild(icon(f, 28, false));
      ladder.appendChild(li);
    });
    lastMax = -2;
  }
  drawLadder();

  function refresh() {
    var sim = run ? run.sim : null, i;
    kcalEl.textContent = fmt(sim ? sim.kcal : 0);
    bestEl.textContent = fmt(best);
    var leftKey = sim && run.live ? sim.left() : -1;
    if (leftKey !== lastLeft) { lastLeft = leftKey; leftEl.hidden = leftKey < 0; leftEl.textContent = leftKey + ' foods left'; }

    var p = sim ? sim.preview() : null, key = p ? p.lv + (p.gold ? 'g' : '') : '';
    if (key !== lastNext) {
      lastNext = key;
      nextDisc.textContent = '';
      nextDisc.classList.toggle('gold', !!(p && p.gold));
      if (p) { nextDisc.appendChild(icon(FOODS[p.lv], 38, p.gold)); nextDisc.setAttribute('aria-label', 'Next: ' + (p.gold ? 'golden ' : '') + FOODS[p.lv].n); }
      else nextDisc.setAttribute('aria-label', 'No next food');
      if (p && p.gold && run && !run.goldSeen) { run.goldSeen = true; toast('Golden ' + FOODS[p.lv].n.toLowerCase() + ' is next!'); }
    }

    var max = sim ? sim.maxLv : -1;
    if (max !== lastMax) { lastMax = max; for (i = 0; i < ladder.children.length; i++) ladder.children[i].classList.toggle('on', i <= max); }

    var uses = sim && run.live ? '' + sim.uses.shake + sim.uses.swap + sim.uses.sweep : 'off';
    if (uses !== lastUses) {
      lastUses = uses;
      Object.keys(btn).forEach(function (k) {
        var left = sim ? sim.uses[k] : 1;
        btn[k].disabled = !(sim && run.live && left);
      });
    }

    var text = '', cls = '';
    if (sim && run.desync) { text = 'Out of sync with the referee'; cls = 'bad'; }
    else if (sim && sim.gold === 'merged') { text = 'Golden bonus won! See it at the end'; cls = 'hot'; }
    else if (sim && sim.gold === 'jar') { text = 'Merge the golden one with its twin!'; cls = 'hot'; }
    else if (sim && run.live && ((p && p.gold) || (sim.current() && sim.current().gold))) { text = 'A golden food is coming!'; cls = 'hot'; }
    if (sim && !run.live && !run.desync) { text = ''; cls = ''; }   // the result card says the rest
    if (text + cls !== lastStatus) { lastStatus = text + cls; statusEl.textContent = text; statusEl.className = 'status' + (cls ? ' ' + cls : ''); }

    // CAG rides along the top of the jar, above where the food will fall.
    var jw = jar.clientWidth, ax = clamp(Math.round(clamp(aim, 0, W)), 24, W - 24);
    var cagX = Math.round(ax / W * jw - avSize / 2);
    if (cagX !== lastCag) { lastCag = cagX; cagEl.style.transform = 'translateX(' + cagX + 'px)'; }
  }

  /* ---------- drawing ---------- */
  function trace(c, f) {
    c.beginPath();
    if (f.poly) {
      c.moveTo(f.poly[0].x, f.poly[0].y);
      for (var i = 1; i < f.poly.length; i++) c.lineTo(f.poly[i].x, f.poly[i].y);
      c.closePath();
    } else c.arc(0, 0, f.r, 0, TAU);
  }
  /* One face of a food's picture, already shrunk to the size it will have on screen. Shrinking in
     halves and keeping the result gives clean edges; drawing the big picture small each frame does not. */
  function sprite(a, pic, px, kind) {
    var key = pic + kind + '@' + px, c = a.cache[key];
    if (c) return c;
    var src = a.img, size = a.img.height, sx = pic * size, g, half;
    while (size / 2 >= px && size > 8) {
      half = Math.round(size / 2);
      c = document.createElement('canvas'); c.width = c.height = half;
      c.getContext('2d').drawImage(src, sx, 0, size, size, 0, 0, half, half);
      src = c; sx = 0; size = half;
    }
    c = document.createElement('canvas'); c.width = c.height = px;
    g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, sx, 0, size, size, 0, 0, px, px);
    if (kind === 'gold') { g.globalCompositeOperation = 'source-atop'; g.globalAlpha = 0.42; g.fillStyle = GOLD; g.fillRect(0, 0, px, px); }
    if (kind === 'shadow') { g.globalCompositeOperation = 'source-in'; g.fillStyle = INK; g.fillRect(0, 0, px, px); }
    if (a.cached > 80) { a.cache = {}; a.cached = 0; }
    a.cache[key] = c; a.cached++;
    return c;
  }
  /* Which face a food shows. Blinking follows the real clock and is different for every food. */
  function blink(id) {
    var period = 2600 + (id * 7919) % 3700, t = (nowMs + id * 1371) % period;
    return t < 60 ? FACE_HALF : t < 150 ? FACE_CLOSED : t < 210 ? FACE_HALF : FACE_OPEN;
  }
  function faceOf(b, step) {
    if (reduced) return FACE_OPEN;
    // Surprised while it falls, right after a merge or a shake, and while it pokes above the line.
    if (step - b.food.born < 40 || b.food.above > 0) return FACE_WOW;
    return blink(b.id);
  }
  /* How a food in the jar moves on screen, apart from where the simulation puts it: it squashes and
     wobbles when something hits it, and pops in when it is born from a merge. This is only for the
     eye and never touches the simulation. */
  function feel(sim) {
    var i, b, v, dx, dy, d, k, t;
    for (i = 0; i < sim.foods.length; i++) {
      b = sim.foods[i]; v = vis[b.id];
      if (!v) {
        // A dropped food appears at the drop height; anything appearing elsewhere comes from a merge.
        vis[b.id] = { vx: b.velocity.x, vy: b.velocity.y, hitAt: -99, hitK: 0, hitDir: 0, popAt: Math.abs(b.position.y - R.DROP_Y) > 3 ? sim.step : -99 };
        continue;
      }
      dx = b.velocity.x - v.vx; dy = b.velocity.y - v.vy; v.vx = b.velocity.x; v.vy = b.velocity.y;
      d = Math.sqrt(dx * dx + dy * dy);
      if (d < 2.4) continue;                       // gravity alone changes the speed by about 0.4 a step
      k = Math.min(0.16, (d - 2) * 0.012);
      t = sim.step - v.hitAt;
      if (k > v.hitK * Math.exp(-t / 6)) { v.hitAt = sim.step; v.hitK = k; v.hitDir = Math.atan2(dy, dx); }
    }
    if (sim.step % 600 === 0) {                    // forget the foods that are gone
      var keep = {};
      for (i = 0; i < sim.foods.length; i++) keep[sim.foods[i].id] = vis[sim.foods[i].id];
      vis = keep;
    }
  }
  var POSE = { k: 0, dir: 0, pop: 1, shadow: true };
  function poseOf(b, step, live) {
    var v = vis[b.id], t;
    POSE.k = 0; POSE.pop = 1;
    if (v && live && !reduced) {
      t = step - v.hitAt;
      if (t < 30) { POSE.k = v.hitK * Math.exp(-t / 6) * Math.cos(t * 0.7); POSE.dir = v.hitDir; }
      t = step - v.popAt;
      if (t < 24) POSE.pop = 1 - 0.32 * Math.exp(-t / 4) * Math.cos(t * 0.6);
    }
    return POSE;
  }
  function applyPose(c, angle, pose) {
    if (pose) {
      if (pose.pop !== 1) c.scale(pose.pop, pose.pop);
      if (pose.k) { c.rotate(pose.dir); c.scale(1 - pose.k, 1 + pose.k * 0.8); c.rotate(-pose.dir); }
    }
    c.rotate(angle);
  }
  var SHADOW_DY = 3.4, SHADOW_ALPHA = 0.17;
  /* spin: rotation of the golden rays; only used when gold is true. face: which face to show.
     pose: squash, pop and shadow of a food in the jar (see poseOf); leave it out for a plain picture. */
  function drawFood(c, x, y, f, angle, gold, spin, face, pose) {
    c.save();
    c.translate(x, y);
    c.lineJoin = 'round';
    var art = ART[f.i], h = 0, px = 0, m;
    if (art && art.ok) {
      // The picture is a square of side 2 * f.art.half centred on the food.
      m = c.getTransform(); h = f.art.half;
      px = Math.max(4, Math.round(h * 2 * Math.sqrt(m.a * m.a + m.b * m.b)));
    } else art = null;
    if (gold) {
      var n = 10, R1 = f.ext * 1.4, R0 = f.ext * 1.06;
      c.save();
      c.rotate(spin);
      c.beginPath();
      for (var i = 0; i < n * 2; i++) {
        var a = i * Math.PI / n, rr = i % 2 ? R0 : R1;
        if (i) c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); else c.moveTo(rr, 0);
      }
      c.closePath();
      c.fillStyle = GOLD; c.fill();
      c.lineWidth = 2.5; c.strokeStyle = INK; c.stroke();
      c.restore();
    }
    if (pose && pose.shadow) {
      // The shadow always falls straight down the screen, however the food is turned.
      c.save();
      c.translate(0, SHADOW_DY);
      applyPose(c, angle, pose);
      c.globalAlpha = SHADOW_ALPHA;
      if (art) c.drawImage(sprite(art, f.art.faces[FACE_OPEN], px, 'shadow'), -h, -h, h * 2, h * 2);
      else { trace(c, f); c.fillStyle = INK; c.fill(); }
      c.restore();
    }
    applyPose(c, angle, pose);
    if (art) {
      c.drawImage(sprite(art, f.art.faces[face || FACE_OPEN], px, gold ? 'gold' : ''), -h, -h, h * 2, h * 2);
      c.restore();
      return;
    }
    // Placeholder sticker: white border with a dark edge, coloured centre with a dark outline.
    trace(c, f);
    c.fillStyle = '#ffffff'; c.fill();
    c.lineWidth = 2; c.strokeStyle = INK; c.stroke();
    c.save();
    c.scale(0.8, 0.8);
    trace(c, f);
    c.fillStyle = gold ? GOLD : f.c; c.fill();
    c.lineWidth = 2.5; c.strokeStyle = INK; c.stroke();
    c.restore();
    c.font = Math.round(f.r * f.es * (gold ? 0.66 : 0.82)) + 'px ' + EMOJI;
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = INK;
    c.fillText(f.e, 0, f.r * f.ey);
    c.restore();
  }

  function draw() {
    var sim = run ? run.sim : null, step = sim ? sim.step : 0, i;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, W, H);

    ctx.save();
    ctx.globalAlpha = sim && sim.warn ? (reduced ? 1 : 0.6 + 0.4 * Math.sin(step / 5.4)) : 0.45;
    ctx.setLineDash([2, 10]); ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.strokeStyle = LANTERN;
    ctx.beginPath(); ctx.moveTo(0, R.LINE_Y); ctx.lineTo(W, R.LINE_Y); ctx.stroke();
    ctx.restore();
    if (!sim) return;

    var spin = reduced ? 0 : step / 54, cur = run.live ? sim.current() : null;
    if (cur && sim.canDrop()) {
      var f = FOODS[cur.lv], x = clamp(Math.round(clamp(aim, 0, W)), f.hw + R.PAD + 2, W - f.hw - R.PAD - 2);
      x = clamp(x, f.ext + R.PAD + 1, W - f.ext - R.PAD - 1);
      ctx.save();
      ctx.setLineDash([1, 9]); ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.strokeStyle = 'rgba(28,159,208,0.45)';
      ctx.beginPath(); ctx.moveTo(x, R.DROP_Y + f.r + 4); ctx.lineTo(x, H); ctx.stroke();
      ctx.restore();
      // The food in hand blinks too, and gets nervous in the last three seconds.
      drawFood(ctx, x, R.DROP_Y, f, 0, cur.gold, spin, reduced ? FACE_OPEN : sim.deadline() - step < 180 ? FACE_WOW : blink(977));
    }

    // From the bottom of the jar up, so that each food's shadow falls on the ones under it.
    var b, pile = sim.foods.slice().sort(function (p, q) { return q.position.y - p.position.y || p.id - q.id; });
    for (i = 0; i < pile.length; i++) { b = pile[i]; if (!b.food.gold) drawFood(ctx, b.position.x, b.position.y, FOODS[b.food.lv], b.angle, false, 0, faceOf(b, step), poseOf(b, step, run.live)); }
    for (i = 0; i < pile.length; i++) { b = pile[i]; if (b.food.gold) drawFood(ctx, b.position.x, b.position.y, FOODS[b.food.lv], b.angle, true, spin, faceOf(b, step), poseOf(b, step, run.live)); }

    for (i = fx.length - 1; i >= 0; i--) {
      var p = fx[i], k = (step - p.t) / (p.gold ? 54 : 34);
      if (k >= 1 || k < 0) { fx.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = 1 - k;
      if (!reduced) {
        ctx.lineWidth = p.gold ? 6 : 4; ctx.strokeStyle = p.gold ? GOLD : '#ffffff';
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 + (p.gold ? 0.9 : 0.35) * k), 0, TAU); ctx.stroke();
        // a few confetti dots flying out
        for (var d = 0; d < 6; d++) {
          var ang = d * TAU / 6 + p.x, dist = p.r * (1.1 + 0.9 * k);
          ctx.fillStyle = CONFETTI[d % 3];
          ctx.beginPath(); ctx.arc(p.x + Math.cos(ang) * dist, p.y + Math.sin(ang) * dist, 3.2 * (1 - k * 0.5), 0, TAU); ctx.fill();
        }
      }
      if (p.txt) {
        ctx.font = '700 19px Fredoka,"Trebuchet MS",sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 5; ctx.strokeStyle = '#ffffff'; ctx.fillStyle = LANTERN;
        var ty = clamp(p.y - p.r - 10 - (reduced ? 0 : 16 * k), 14, H - 10);
        ctx.strokeText(p.txt, p.x, ty); ctx.fillText(p.txt, p.x, ty);
      }
      ctx.restore();
    }

    /* Time left to drop: a bar along the top of the jar. It runs out while you aim and, after each drop, refills in green. */
    if (run.live && sim.dropped < R.MAX_FOODS) {
      var frac, barColor;
      if (sim.ready) {
        frac = clamp((sim.deadline() - step) / R.DROP_STEPS, 0, 1);
        barColor = step - sim.turnStart < 24 ? GREEN : (sim.deadline() - step) / 60 <= 5 ? LANTERN : GOLD;
      } else {
        var grow = reduced ? 1 : clamp((step - run.barAt) / R.READY_STEPS, 0, 1);
        frac = run.barFrom + (1 - run.barFrom) * (1 - (1 - grow) * (1 - grow));
        barColor = GREEN;
      }
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.beginPath(); ctx.moveTo(8, 6); ctx.lineTo(W - 8, 6); ctx.stroke();
      if (frac > 0.01) {
        ctx.strokeStyle = barColor;
        ctx.beginPath(); ctx.moveTo(8, 6); ctx.lineTo(8 + (W - 16) * frac, 6); ctx.stroke();
      }
      ctx.restore();
    }
  }

  function fit() {
    // The jar takes all the room the stage gives it, keeping its shape. Above it goes CAG, whose
    // size follows the jar's. The jar never gets smaller than MIN_JAR_H: on a very short screen
    // the page scrolls instead of squashing it.
    var MIN_JAR_H = 300, MAX_JAR_W = 760;
    var bw = stage.clientWidth - 18, sh = stage.clientHeight;
    var guess = Math.min(bw / W, (sh - 66) / H);
    avSize = clamp(Math.round(W * guess * 0.15), 40, 84);
    var bh = Math.max(sh - (avSize + 24), MIN_JAR_H);
    var s = clamp(Math.min(bw / W, bh / H), 0.3, MAX_JAR_W / W);
    var cw = Math.floor(W * s), ch = Math.floor(H * s);
    jar.style.width = cw + 'px'; jar.style.height = ch + 'px';
    jar.style.setProperty('--av', avSize + 'px');
    lastCag = -999;
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    scale = cv.width / W;
  }
  if (window.ResizeObserver) new ResizeObserver(fit).observe(stage);
  window.addEventListener('resize', fit);

  /* ---------- main loop: game time follows real time, never faster ---------- */
  var last = 0, acc = 0;
  function stepOnce() {
    var sim = run.sim;
    sim.tick();
    feel(sim);
    if (sim.events.length) {
      for (var i = 0; i < sim.events.length; i++) {
        var ev = sim.events[i];
        if (ev.type === 'merge') {
          fx.push({ x: ev.x, y: ev.y, r: FOODS[ev.lv].ext, t: sim.step, txt: '+' + ev.gain, gold: ev.gold });
          if (ev.gold) toast('Golden food merged!');
          else if (!ev.made) toast('Double Big Order! +' + fmt(ev.gain) + ' kcal');
          else if (ev.lv === TOP) toast('Big Order! +' + fmt(ev.gain) + ' kcal');
        } else if (ev.type === 'sweep') fx.push({ x: ev.x, y: ev.y, r: FOODS[ev.lv].r, t: sim.step, txt: '', gold: false });
      }
      sim.events.length = 0;
    }
    if (sim.mustDrop()) doDrop();
    if (sim.over && run.live) endRun();
    // The 15 seconds passed and the food could not be dropped (the referee's answer never came).
    else if (run.live && sim.ready && sim.dropped < R.MAX_FOODS && sim.step > sim.deadline()) stopRun(run, 'run-expired');
  }
  function frame(t) {
    // The game clock follows the real clock, also across a pause (hidden tab, slow frame):
    // it catches up instead of stopping, because the referee does not accept a clock that falls behind.
    var dt = Math.min(30000, t - (last || t)); last = t; nowMs = t;
    if (run && run.live) {
      acc += dt;
      var n = 0;
      while (acc >= R.STEP_MS && n < 240 && run.live) { stepOnce(); acc -= R.STEP_MS; n++; }
    }
    refresh();
    draw();
    requestAnimationFrame(frame);
  }

  /* ---------- input ---------- */
  function aimAt(e) {
    var r = cv.getBoundingClientRect();
    if (r.width) aim = clamp((e.clientX - r.left) / r.width * W, 0, W);
  }
  cv.addEventListener('pointerdown', function (e) {
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* not supported */ }
    down = true; aimAt(e); e.preventDefault();
  });
  cv.addEventListener('pointermove', function (e) { if (e.pointerType === 'mouse' || down) aimAt(e); });
  cv.addEventListener('pointerup', function (e) { if (down) { down = false; aimAt(e); doDrop(); } });
  cv.addEventListener('pointercancel', function () { down = false; });
  cv.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') { aim = clamp(aim - 12, 0, W); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { aim = clamp(aim + 12, 0, W); e.preventDefault(); }
    else if (e.key === ' ' || e.key === 'Enter') { doDrop(); e.preventDefault(); }
  });
  Object.keys(btn).forEach(function (k) { btn[k].addEventListener('click', function () { usePower(k); }); });
  $('play').addEventListener('click', startRun);
  $('again').addEventListener('click', startRun);
  nameEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') startRun(); });
  $('openBoard').addEventListener('click', openBoard);
  $('openBoard2').addEventListener('click', openBoard);
  $('closeBoard').addEventListener('click', function () { boardEl.hidden = true; if (boardBack) boardBack.hidden = false; boardBack = null; });

  nameEl.value = player.name || '';
  fit();
  requestAnimationFrame(frame);
})();

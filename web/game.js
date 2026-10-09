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
    if (f.art.gold) {     // its golden version has a picture of its own
      a.gold = new Image();
      a.gold.onload = function () { a.goldOk = true; a.cache = {}; a.cached = 0; lastNext = '?'; };
      a.gold.src = '/web/img/foods/' + i + '-gold.webp';
    }
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
  var leftEl = $('left');

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
  var aim = W / 2, down = false, fx = [], toastTimer = 0, scale = 1, lastStatus = '', lastNext = '', lastMax = -2, lastUses = '', lastLeft = -2, boardBack = null, nowMs = 0, vis = {};

  function toast(msg) {
    toastEl.textContent = msg; toastEl.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.hidden = true; }, 2200);
  }

  /* ---------- sound ---------- */
  /* Browsers only let a page make sound after the player touches it, so the sound engine is
     started on the first tap or click. Merges use one of a few pops at random, higher for small
     foods and lower for big ones, so they never sound exactly the same twice in a row. */
  var sfx = { ctx: null, gain: null, pops: [], gold: null, drop: null, last: -1, muted: !!load('cagnaval.muted', false), frame: 0 };
  var muteBtn = $('mute');
  function showMute() { muteBtn.setAttribute('aria-pressed', sfx.muted ? 'true' : 'false'); muteBtn.setAttribute('aria-label', sfx.muted ? 'Sound on' : 'Sound off'); }
  showMute();
  muteBtn.addEventListener('click', function () {
    sfx.muted = !sfx.muted; save('cagnaval.muted', sfx.muted); showMute();
    if (sfx.gain) sfx.gain.gain.value = sfx.muted ? 0 : 1;
    wakeSound();
  });
  function wakeSound() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!sfx.ctx) {
      try { sfx.ctx = new AC(); } catch (e) { return; }
      sfx.gain = sfx.ctx.createGain(); sfx.gain.gain.value = sfx.muted ? 0 : 1; sfx.gain.connect(sfx.ctx.destination);
      var get = function (n, put) {
        fetch('/web/snd/' + n + '.mp3').then(function (r) { return r.arrayBuffer(); })
          .then(function (b) { return new Promise(function (ok, no) { sfx.ctx.decodeAudioData(b, ok, no); }); })
          .then(put)
          .catch(function () { /* the game works without sound */ });
      };
      ['pop0', 'pop1', 'pop2'].forEach(function (n, i) { get(n, function (buf) { sfx.pops[i] = buf; }); });
      get('gold', function (buf) { sfx.gold = buf; });
      get('drop', function (buf) { sfx.drop = buf; });
    }
    if (sfx.ctx.state === 'suspended') sfx.ctx.resume();
  }
  function play(buf, rate, vol) {
    if (!sfx.ctx || !buf || sfx.muted || sfx.frame >= 3) return;      // at most three sounds at once
    sfx.frame++;
    var src = sfx.ctx.createBufferSource(), g = sfx.ctx.createGain();
    src.buffer = buf; src.playbackRate.value = rate; g.gain.value = vol;
    src.connect(g); g.connect(sfx.gain); src.start();
  }
  /* Letting go of a food: very soft, and never twice the same (a little higher or lower, a little
     louder or softer; a bit lower for big foods). It plays hundreds of times a run. */
  function soundDrop(lv) {
    play(sfx.drop, (1.08 - lv * 0.03) * (0.9 + Math.random() * 0.2), 0.05 + Math.random() * 0.02);
  }
  function soundMerge(lv, gold) {
    var n = sfx.pops.length, i;
    if (!n) return;
    i = Math.floor(Math.random() * n);
    if (n > 1 && i === sfx.last) i = (i + 1) % n;
    sfx.last = i;
    var rate = (1.28 - lv * 0.055) * (0.97 + Math.random() * 0.06);
    play(sfx.pops[i], rate, 0.55 + Math.min(lv, 10) * 0.03);
    if (gold) play(sfx.gold, 1, 1);                // the golden onigiri: the pop plus fairy dust
  }
  cv.addEventListener('pointerdown', wakeSound);

  function startRun() {
    wakeSound();
    var card = !homeEl.hidden ? homeEl : !overEl.hidden ? overEl : null, leaving = !!card, t0 = Date.now();
    if (leaving && !reduced) card.classList.add('leaving');        // CAG ducks behind the card
    var name = nameEl.value.replace(/\s+/g, ' ').trim().slice(0, 16);
    player.name = name || 'Player'; save('cagnaval.player', player);
    $('play').disabled = true; $('again').disabled = true; $('homeMsg').textContent = 'Starting…';
    call('POST', '/api/runs', { player: player }, 2).then(function (start) {
      // let her finish ducking before the card goes
      var wait = leaving && !reduced ? Math.max(0, 250 - (Date.now() - t0)) : 0;
      return new Promise(function (ok) { setTimeout(function () { ok(start); }, wait); });
    }).then(function (start) {
      var sim = new Sim({ pub: start.pub, events: true });
      sim.setPiece(1, start.pieces[0]); sim.setPiece(2, start.pieces[1]);
      run = { id: start.runId, sim: sim, seq: 0, chain: Promise.resolve(), live: true, desync: false, goldSeen: false, ending: false, barFrom: 1, barAt: 0 };
      fx.length = 0; vis = {}; aim = W / 2; acc = 0; last = 0; combo = 0; lastMerge = -999; comboFx.n = 0;
      homeEl.hidden = true; overEl.hidden = true; boardEl.hidden = true; toastEl.hidden = true; boardBack = null;
      if (card) card.classList.remove('leaving');
      PUP.riseAt = nowMs || 1; PUP.sinkAt = 0;                                        // and comes up behind the jar
      $('homeMsg').textContent = '';
      cv.focus();
    }).catch(function (e) {
      if (card) { card.classList.remove('leaving'); card.hidden = false; }
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
    var held = sim.current();
    if (!sim.drop(x)) return;
    soundDrop(held ? held.lv : 0);
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
    PUP.sinkAt = nowMs || 1;                         // CAG ducks behind the jar; she comes up over the result card
    r.chain = r.chain.then(function () {
      return call('POST', '/api/runs/' + r.id + '/finish', { step: sim.overStep, kcal: sim.kcal, reason: 'over' }, 3);
    }).then(function (res) { showResult(r, res, null); }).catch(function (e) { stopRun(r, e.code); });
  }

  /* Something broke the run (expired, connection lost, refused move). Show what the referee has. */
  function stopRun(r, code) {
    if (r.stopped) return;
    r.stopped = true; r.live = false; r.ending = false;
    if (!PUP.sinkAt) PUP.sinkAt = nowMs || 1;
    var sim = r.sim;
    call('POST', '/api/runs/' + r.id + '/finish', { step: sim.over ? sim.overStep : sim.step, kcal: sim.kcal, reason: sim.over ? 'over' : 'quit' }, 2)
      .then(function (res) { showResult(r, res, code); })
      .catch(function () { showResult(r, null, code); });
  }

  /* The score on the result card counts up from zero. */
  var countTok = 0;
  function countUp(el, to) {
    var tok = ++countTok, t0 = performance.now(), dur = reduced ? 0 : 850;
    (function tick(now) {
      if (tok !== countTok) return;
      var k = dur ? Math.min(1, (now - t0) / dur) : 1;
      el.textContent = fmt(Math.round(to * (1 - Math.pow(1 - k, 3))));
      if (k < 1) requestAnimationFrame(tick);
    })(t0);
  }

  function showResult(r, res, problem) {
    if (run !== r) return;
    var sim = r.sim, kcal = res ? res.kcal : sim.kcal, title;
    if (problem === 'run-expired' || (res && res.status === 'expired')) title = 'Run expired';
    else if (problem === 'network') title = 'Connection lost';
    else if (problem) title = 'Run stopped';
    else title = sim.overReason === 'done' ? 'All ' + R.MAX_FOODS + ' foods dropped!' : 'Jar is full!';
    $('overTitle').textContent = title;
    $('overKcal').textContent = '0';
    $('overUsed').textContent = (res ? res.dropped : sim.dropped) + ' / ' + R.MAX_FOODS;
    var topFood = FOODS[Math.max(0, res ? res.maxLv : sim.maxLv)], topEl = $('overTop');
    topEl.textContent = 'Biggest: ';
    var nm = document.createElement('b'); nm.textContent = topFood.n; topEl.appendChild(nm);
    var hero = $('overHero'); hero.textContent = ''; hero.appendChild(icon(topFood, 66 * cardScale(), false));

    var g = res && res.gold;
    $('overGold').classList.toggle('hot', !!(g && g.merged));
    $('overBonus').textContent = g && g.merged ? '×' + g.mult : g && g.appeared ? 'Missed' : 'None';

    var oc = $('overCheck'), ok = !!(res && res.verified);
    oc.classList.toggle('bad', !ok); oc.classList.toggle('ok', ok);
    oc.textContent = !res ? 'The referee could not be reached: this run was not saved.'
      : ok ? '✓ Checked by the referee'
      : res.status === 'expired' ? 'More than 15 seconds without a move. Calories so far were kept.'
      : !res.counted ? 'The referee refused this run. It does not count.'
      : res.sync === false ? 'Your screen and the referee disagreed from move ' + res.mismatchAt + '. The referee score is used.'
      : 'The referee score is used.';

    $('overWeek').textContent = '–';
    var record = !!(res && res.counted && res.verified && kcal > best && kcal > 0);
    $('overBest').hidden = !record;
    if (res && res.counted) {
      if (record) { best = kcal; save('cagnaval.best', best); }
      call('GET', '/api/leaderboard?player=' + encodeURIComponent(player.id), null, 1).then(function (b) {
        if (run === r && b.you) { $('overWeek').textContent = '#' + b.you.rank; $('overWeek').title = fmt(b.you.total) + ' kcal this week'; }
      }).catch(function () { /* ranking is optional here */ });
    }
    // Show the card once CAG has ducked behind the jar.
    var wait = PUP.sinkAt && !reduced ? Math.max(0, PUP.sinkAt + 300 - nowMs) : 0;
    setTimeout(function () {
      if (run !== r) return;
      overEl.hidden = false;
      countUp($('overKcal'), kcal);
      $('again').focus();
    }, wait);
  }

  /* The ranking of the week, two ways: the total of all runs (with how many runs) or the best single run. */
  var boardBy = 'total', boardTok = 0;
  function openBoard() {
    // The ranking takes the place of the card it was opened from, and gives it back on close.
    boardBack = !overEl.hidden ? overEl : !homeEl.hidden ? homeEl : null;
    if (boardBack) boardBack.hidden = true;
    boardEl.hidden = false;
    loadBoard(boardBy);
  }
  function loadBoard(by) {
    var list = $('rank'), msg = $('rankMsg'), head = $('rankHead'), tok = ++boardTok, total = by === 'total';
    boardBy = by;
    $('tabTotal').setAttribute('aria-selected', total ? 'true' : 'false');
    $('tabBest').setAttribute('aria-selected', total ? 'false' : 'true');
    list.textContent = ''; head.textContent = ''; msg.textContent = 'Loading…';
    list.classList.toggle('runs', total); head.classList.toggle('runs', total);
    call('GET', '/api/leaderboard?by=' + by + '&player=' + encodeURIComponent(player.id), null, 2).then(function (b) {
      if (tok !== boardTok) return;
      msg.textContent = b.top.length ? '' : 'No runs yet this week. Be the first.';
      var cells = function (el, texts, classes) {
        texts.forEach(function (t, i) { var c = document.createElement('span'); c.textContent = t; if (classes[i]) c.className = classes[i]; el.appendChild(c); });
      };
      if (b.top.length) cells(head, total ? ['#', 'Player', 'Runs', 'kcal'] : ['#', 'Player', 'kcal'], []);
      var rows = b.top.slice(0, 20);
      if (b.you && b.you.rank > rows.length) rows.push(b.you);
      rows.forEach(function (row) {
        var li = document.createElement('li');
        var pos = 'pos' + (row.rank <= 3 ? ' p' + row.rank : '');     // gold, silver and bronze for the top three
        if (total) cells(li, [row.rank, row.name, row.runs, fmt(row.total)], [pos, 'who', 'runs-n', 'kc']);
        else cells(li, [row.rank, row.name, fmt(row.best)], [pos, 'who', 'kc']);
        if (row.you) li.className = 'you';
        list.appendChild(li);
      });
    }).catch(function () { if (tok === boardTok) msg.textContent = 'Could not load the ranking.'; });
  }
  $('tabTotal').addEventListener('click', function () { loadBoard('total'); });
  $('tabBest').addEventListener('click', function () { loadBoard('best'); });

  /* How much the cards (start, result, ranking) are enlarged on this screen: the --k of the page. */
  function cardScale() { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--k')) || 1; }

  /* ---------- screen updates ---------- */
  /* A small picture of a food, made at exactly the size it is shown: a picture made smaller and
     then stretched by the page looks blurred. */
  function icon(f, size, gold) {
    var dpr = Math.min(window.devicePixelRatio || 1, 3), c = document.createElement('canvas');
    c.width = c.height = Math.max(8, Math.round(size * dpr));
    var g = c.getContext('2d'), s = (c.width / 2 - 2 * dpr) / (f.ext * (gold ? 1.15 : 1));
    g.setTransform(s, 0, 0, s, c.width / 2, c.height / 2);
    drawFood(g, 0, 0, f, 0, gold, 0, FACE_OPEN);
    return c;
  }
  function drawLadder() {
    ladder.textContent = '';
    FOODS.forEach(function (f) {
      var li = document.createElement('li');
      li.title = f.n; li.setAttribute('aria-label', f.n);
      ladder.appendChild(li);
    });
    var size = ladder.children[0].getBoundingClientRect().width || 28;
    FOODS.forEach(function (f, i) { ladder.children[i].appendChild(icon(f, size, false)); });
    lastMax = -2;
    // The same order, small, on the start card.
    var menu = $('homeMenu');
    menu.textContent = '';
    var big = cardScale();                          // the cards are drawn bigger on big screens: make the pictures that big too
    FOODS.forEach(function (f) { var li = document.createElement('li'); li.title = f.n; li.appendChild(icon(f, 20 * big, false)); menu.appendChild(li); });
  }
  drawLadder();
  /* The sizes of the small pictures follow the window: make them again when it changes. */
  var lastIcons = '';
  function fitIcons() {
    var key = (window.devicePixelRatio || 1) + ':' + nextDisc.getBoundingClientRect().width + ':' + (ladder.children[0] ? ladder.children[0].getBoundingClientRect().width : 0);
    if (key === lastIcons) return;
    lastIcons = key; lastNext = '?';
    drawLadder();
  }

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
      if (p) { nextDisc.appendChild(icon(FOODS[p.lv], nextDisc.getBoundingClientRect().width || 36, p.gold)); nextDisc.setAttribute('aria-label', 'Next: ' + (p.gold ? 'golden ' : '') + FOODS[p.lv].n); }
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
    var own = kind === 'gold' && a.goldOk;        // a golden picture of its own, or the plain one tinted
    var src = own ? a.gold : a.img, size = src.height, sx = pic * size, g, half;
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
    if (kind === 'gold' && !own) { g.globalCompositeOperation = 'source-atop'; g.globalAlpha = 0.42; g.fillStyle = GOLD; g.fillRect(0, 0, px, px); }
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
  /* Foods pressed together in a pile never sit perfectly still in the simulation: they tremble by a
     fraction of a unit. The picture follows the simulation through a soft filter that swallows that
     trembling: it eases towards the real place, and is never more than STEADY units behind it. */
  var STEADY = 0.9, STEADY_EASE = 0.18;
  function steady(b, v) {
    var ex = b.position.x - v.x, ey = b.position.y - v.y, d = Math.sqrt(ex * ex + ey * ey), k = STEADY_EASE;
    if (d * (1 - k) > STEADY) k = 1 - STEADY / d;
    v.x += ex * k; v.y += ey * k;
    var ea = b.angle - v.a, most = STEADY / FOODS[b.food.lv].r;      // the same, measured at the rim
    k = STEADY_EASE;
    if (Math.abs(ea) * (1 - k) > most) k = 1 - most / Math.abs(ea);
    v.a += ea * k;
  }
  function feel(sim) {
    var i, b, v, dx, dy, d, k, t;
    for (i = 0; i < sim.foods.length; i++) {
      b = sim.foods[i]; v = vis[b.id];
      if (!v) {
        // A dropped food appears at the drop height; anything appearing elsewhere comes from a merge.
        vis[b.id] = { x: b.position.x, y: b.position.y, a: b.angle, vx: b.velocity.x, vy: b.velocity.y, hitAt: -99, hitK: 0, hitDir: 0, popAt: Math.abs(b.position.y - R.DROP_Y) > 3 ? sim.step : -99 };
        continue;
      }
      steady(b, v);
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
  /* spin: drives the pulse of the golden glow; only used when gold is true. face: which face to show.
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
      // A faint golden glow around it, just a detail, that swells and fades slowly (spin runs with the game clock).
      var beat = Math.sin(spin * 4), glow = f.ext * (1.24 + 0.04 * beat), light = 0.46 + 0.14 * beat;
      var halo = c.createRadialGradient(0, 0, f.ext * 0.75, 0, 0, glow);
      halo.addColorStop(0, 'rgba(255,214,64,' + light.toFixed(3) + ')');
      halo.addColorStop(0.6, 'rgba(255,214,64,' + (light * 0.4).toFixed(3) + ')');
      halo.addColorStop(1, 'rgba(255,214,64,0)');
      c.fillStyle = halo;
      c.beginPath(); c.arc(0, 0, glow, 0, TAU); c.fill();
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
    if (art && !angle && !(pose && (pose.k || pose.pop !== 1))) {
      // Not turned and not squashed: put the picture straight on the screen's own pixels. Going
      // through the usual scaling would smear it a little, and this is the food the player looks at.
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.drawImage(sprite(art, f.art.faces[face || FACE_OPEN], px, gold ? 'gold' : ''), Math.round(m.e - px / 2), Math.round(m.f - px / 2));
      c.restore();
      return;
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

  /* ---------- merge party: a ring, sparks in the food's colours, the calories popping up, combos ---------- */
  var MERGE_STEPS = 52, COMBO_STEPS = 50;
  function rnd01(seed, i) {                        // a fixed "random" number for spark i of a merge
    var h = Math.imul(seed ^ (i * 0x9E3779B1), 0x85EBCA6B); h ^= h >>> 13; h = Math.imul(h, 0xC2B2AE35); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function star(c, x, y, r) {
    c.beginPath();
    for (var j = 0; j < 8; j++) { var a = j * Math.PI / 4, q = j % 2 ? r * 0.38 : r; c.lineTo(x + Math.cos(a) * q, y + Math.sin(a) * q); }
    c.closePath(); c.fill();
  }
  /* Draws one merge celebration; returns false once it is over. */
  function drawMerge(p, step) {
    var t = step - p.t, life = p.gold ? MERGE_STEPS + 20 : MERGE_STEPS;
    if (t < 0 || t >= life) return false;
    var f = FOODS[p.lv], k = t / life, j, n, a, sp, d, x, y, sz, fade;
    ctx.save();
    if (!reduced) {
      // a white flash ring that opens up
      if (t < 18) {
        ctx.globalAlpha = 1 - t / 18;
        ctx.lineWidth = p.gold ? 7 : 4 + p.lv * 0.3; ctx.strokeStyle = p.gold ? GOLD : '#ffffff';
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 + (p.gold ? 0.9 : 0.45) * t / 18), 0, TAU); ctx.stroke();
      }
      // sparks fly out, slow down and fall a little
      n = Math.min(10 + p.lv * 2, 28) + (p.gold ? 10 : 0);
      for (j = 0; j < n; j++) {
        var r1 = rnd01(p.seed, j), r2 = rnd01(p.seed, j + 97), r3 = rnd01(p.seed, j + 211);
        var own = 26 + r3 * 18;
        if (t >= own) continue;
        a = TAU * j / n + r1 * 0.6;
        sp = (2.2 + r2 * 2.6) * (0.75 + p.lv * 0.06);
        d = p.r * 0.55 + sp * 12 * (1 - Math.exp(-t / 12));
        x = p.x + Math.cos(a) * d; y = p.y + Math.sin(a) * d + 0.035 * t * t;
        fade = 1 - t / own;
        ctx.globalAlpha = Math.min(1, fade * 1.6);
        ctx.fillStyle = p.gold ? (j % 2 ? GOLD : '#FFF6D5') : j % 3 === 0 ? '#ffffff' : j % 3 === 1 ? f.c : CONFETTI[j % CONFETTI.length];
        sz = (2.6 + r3 * 2.6) * (0.6 + 0.4 * fade);
        if (j % 3 === 0) star(ctx, x, y, sz * 1.5);
        else { ctx.beginPath(); ctx.arc(x, y, sz, 0, TAU); ctx.fill(); }
      }
    }
    // the calories pop up, bigger for bigger foods, and float away
    var pop = reduced ? 1 : t < 5 ? 0.45 + 0.75 * t / 5 : t < 11 ? 1.2 - 0.2 * (t - 5) / 6 : 1;
    var size = 17 + Math.min(p.lv, 10) * 1.7 + (p.gold ? 4 : 0);
    var ty = clamp(p.y - p.r - 8 - (reduced ? 0 : 20 * k), 16, H - 12);
    ctx.globalAlpha = k < 0.65 ? 1 : 1 - (k - 0.65) / 0.35;
    ctx.font = '700 ' + size.toFixed(1) + 'px Fredoka,"Trebuchet MS",sans-serif';
    var half = ctx.measureText(p.txt).width / 2 + 4;
    ctx.translate(clamp(p.x, half, W - half), ty); ctx.scale(pop, pop);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    ctx.lineWidth = 6; ctx.strokeStyle = '#ffffff'; ctx.fillStyle = p.gold ? '#E2A31C' : LANTERN;
    ctx.strokeText(p.txt, 0, 0); ctx.fillText(p.txt, 0, 0);
    ctx.restore();
    return true;
  }
  /* Merges that follow each other quickly make a combo: one badge under the line counts them. */
  var comboFx = { n: 0, t: -999 };
  function drawCombo(step) {
    var t = step - comboFx.t;
    if (comboFx.n < 2 || t < 0 || t > 80) return;
    var pop = reduced ? 1 : t < 5 ? 0.5 + 0.8 * t / 5 : t < 11 ? 1.3 - 0.3 * (t - 5) / 6 : 1;
    var txt = 'Combo ×' + comboFx.n + '!';
    ctx.save();
    ctx.globalAlpha = t < 60 ? 1 : 1 - (t - 60) / 20;
    ctx.translate(W / 2, R.LINE_Y + 34); ctx.scale(pop, pop);
    ctx.font = '700 20px Fredoka,"Trebuchet MS",sans-serif';
    var w = ctx.measureText(txt).width + 28, h = 32;
    ctx.fillStyle = 'rgba(27,34,51,0.12)'; roundRect(ctx, -w / 2, -h / 2 + 3, w, h, h / 2); ctx.fill();
    ctx.fillStyle = '#ffffff'; roundRect(ctx, -w / 2, -h / 2, w, h, h / 2); ctx.fill();
    ctx.fillStyle = '#1C9FD0'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(txt, 0, 1);
    ctx.restore();
  }
  function roundRect(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  /* The jar gives a little jolt when a big food is made. Only for the eye. */
  var jolt = { at: 0, amp: 0 };
  function joltJar(lv) { if (!reduced && lv >= 6) { jolt.at = nowMs; jolt.amp = Math.min(7, 2 + (lv - 6) * 1.2); } }
  function drawJolt() {
    if (!jolt.amp) return;
    var t = (nowMs - jolt.at) / 1000;
    if (t > 0.4) { jolt.amp = 0; jar.style.transform = ''; return; }
    var e = jolt.amp * Math.exp(-t * 9);
    jar.style.transform = 'translate(' + (e * Math.sin(t * 74)).toFixed(2) + 'px,' + (e * 0.7 * Math.cos(t * 58)).toFixed(2) + 'px)';
  }

  /* Where the food in hand hangs: above the aim, kept clear of the walls. */
  function holdX(f) {
    var x = clamp(Math.round(clamp(aim, 0, W)), f.hw + R.PAD + 2, W - f.hw - R.PAD - 2);
    return clamp(x, f.ext + R.PAD + 1, W - f.ext - R.PAD - 1);
  }

  function draw() {
    var sim = run ? run.sim : null, step = sim ? sim.step : 0, i;
    // Wipe every pixel of the canvas: it can be a fraction taller than the scaled game area, and a
    // strip left unwiped at the bottom would keep piling up whatever is drawn over it.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    ctx.save();
    ctx.globalAlpha = sim && sim.warn ? (reduced ? 1 : 0.6 + 0.4 * Math.sin(step / 5.4)) : 0.45;
    ctx.setLineDash([2, 10]); ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.strokeStyle = LANTERN;
    ctx.beginPath(); ctx.moveTo(0, R.LINE_Y); ctx.lineTo(W, R.LINE_Y); ctx.stroke();
    ctx.restore();
    if (!sim) return;

    var spin = reduced ? 0 : step / 54, cur = run.live ? sim.current() : null;
    if (cur && sim.canDrop()) {
      var f = FOODS[cur.lv], x = holdX(f);
      ctx.save();
      ctx.setLineDash([1, 9]); ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.strokeStyle = 'rgba(28,159,208,0.45)';
      ctx.beginPath(); ctx.moveTo(x, R.DROP_Y + f.r + 4); ctx.lineTo(x, H); ctx.stroke();
      ctx.restore();
      // The food in hand blinks too, and gets nervous in the last three seconds.
      drawFood(ctx, x, R.DROP_Y, f, sim.dropAngle(), cur.gold, spin, reduced ? FACE_OPEN : sim.deadline() - step < 180 ? FACE_WOW : blink(977));
    }

    // From the bottom of the jar up, so that each food's shadow falls on the ones under it.
    var b, pile = sim.foods.slice().sort(function (p, q) { return q.position.y - p.position.y || p.id - q.id; });
    var at;
    for (i = 0; i < pile.length; i++) { b = pile[i]; at = vis[b.id] || { x: b.position.x, y: b.position.y, a: b.angle }; if (!b.food.gold) drawFood(ctx, at.x, at.y, FOODS[b.food.lv], at.a, false, 0, faceOf(b, step), poseOf(b, step, run.live)); }
    for (i = 0; i < pile.length; i++) { b = pile[i]; at = vis[b.id] || { x: b.position.x, y: b.position.y, a: b.angle }; if (b.food.gold) drawFood(ctx, at.x, at.y, FOODS[b.food.lv], at.a, true, spin, faceOf(b, step), poseOf(b, step, run.live)); }

    for (i = fx.length - 1; i >= 0; i--) {
      if (fx[i].lv !== undefined) { if (!drawMerge(fx[i], step)) fx.splice(i, 1); continue; }
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

    drawCombo(step);

    /* A food is over the line: count down the seconds left for the pile to settle before the run ends. */
    if (run.live && sim.warn) {
      var secs = clamp(Math.ceil((R.FULL_STEPS - sim.danger) / 60), 1, 9);
      ctx.save();
      ctx.beginPath(); ctx.arc(W - 22, R.LINE_Y, 13, 0, TAU);
      ctx.fillStyle = LANTERN; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = '#ffffff'; ctx.stroke();
      ctx.font = '700 17px Fredoka,"Trebuchet MS",sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#ffffff';
      ctx.fillText(secs, W - 22, R.LINE_Y + 1);
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

  /* ---------- CAG, who leans over the jar and drops the food ----------
     Her bust follows the aim, right above the food in hand. Its bottom edge is tucked behind the
     jar's rim, so it never shows a gap when she moves up and down. The drawing and its sizes come
     from web/cag-art.js (see scripts/gen-cag.py). All of this is only for the eye.

     Her picture is painted once per face on her own small canvas, with at least twice the pixels
     of the screen, and after that the page only slides that canvas around. That keeps her lines
     clean on ordinary monitors and lets her move by fractions of a pixel, so breathing looks
     smooth instead of going up and down in steps. */
  var puppet = $('puppet'), pctx = puppet.getContext('2d'), ART_P = window.CAG_PUPPET || null;
  var PUP = { TUCK_PX: 4, bodyH: 0, css: 1, w: 0, h: 0, ok: false, x: W / 2, shown: -1, moved: '' };
  if (ART_P) {
    PUP.bodyH = ART_P.bodyWidth * ART_P.body.h / ART_P.body.w;
    PUP.body = new Image();
    PUP.body.onload = function () { PUP.ok = true; PUP.shown = -1; };
    PUP.body.src = '/web/img/cag/body.webp';
  }
  /* Paints one of CAG's faces on a canvas, filling it. */
  function paintCag(canvas, g, face) {
    var B = ART_P.body, src = PUP.body, sx = face * B.w, w = B.w, h = B.h, t;
    // Halve step by step down to the size needed: shrinking a lot in one go looks jagged.
    while (w / 2 >= canvas.width && w > 8) {
      t = document.createElement('canvas'); t.width = Math.round(w / 2); t.height = Math.round(h / 2);
      t.getContext('2d').drawImage(src, sx, 0, w, h, 0, 0, t.width, t.height);
      src = t; sx = 0; w = t.width; h = t.height;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, sx, 0, w, h, 0, 0, canvas.width, canvas.height);
  }
  function paintPuppet(face) { paintCag(puppet, pctx, face); PUP.shown = face; }
  /* CAG over the cards: made at the exact number of screen pixels she covers, so she looks sharp.
     A card that is hidden forgets she was up, so she comes up again the next time it shows. */
  var cards = [homeEl, overEl, boardEl];
  function drawPeek() {
    if (!ART_P || !PUP.ok) return;
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      if (card.hidden) { if (card.classList.contains('ready')) card.classList.remove('ready', 'leaving'); continue; }
      var cv2 = card.querySelector('.peek'), r = cv2.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 3);
      var w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
      var face = reduced ? 0 : blink(4242) === FACE_CLOSED ? 1 : 0, key = w + 'x' + h + ':' + face;
      if (key !== cv2.cagKey) {
        cv2.cagKey = key;
        if (cv2.width !== w || cv2.height !== h) { cv2.width = w; cv2.height = h; }
        paintCag(cv2, cv2.getContext('2d'), face);
      }
      if (!card.classList.contains('ready')) (function (c) { requestAnimationFrame(function () { if (!c.hidden) c.classList.add('ready'); }); })(card);
    }
  }
  function drawPuppet() {
    if (!ART_P || !PUP.ok) return;
    var BW = ART_P.bodyWidth;
    var sim = run ? run.sim : null, live = !!(run && run.live), step = sim ? sim.step : 0;
    var cur = live ? sim.current() : null;
    var justDropped = live && sim.dropped > 0 && step - run.barAt < 18;

    // She stays above the food in hand; near a wall she stops before the food does.
    var tx = cur && sim.canDrop() ? holdX(FOODS[cur.lv]) : clamp(aim, 0, W);
    var bx = clamp(tx, BW / 2, W - BW / 2);          // never past the walls of the jar
    PUP.x += (bx - PUP.x) * (reduced ? 1 : 0.6);

    // Face: startled right after dropping and while the jar is about to overflow; blinks otherwise.
    var face = 0;
    if (!reduced) {
      if (justDropped || (live && sim.warn)) face = 2;
      else if (blink(4242) === FACE_CLOSED) face = 1;
    }
    if (face >= ART_P.body.faces) face = 0;
    if (face !== PUP.shown) paintPuppet(face);

    // She breathes a little and nods when she lets go. Never more than what the rim hides.
    var bob = reduced ? 0 : Math.sin(nowMs / 560) * 1.1 + (justDropped ? Math.sin(Math.PI * (step - run.barAt) / 18) * 1.6 : 0);
    bob = clamp(bob * PUP.css, -PUP.TUCK_PX + 1, PUP.TUCK_PX - 1);
    // At the start of a run she comes up from behind the rim.
    var rise = 0;
    if (PUP.riseAt && !reduced) {
      var rt = (nowMs - PUP.riseAt) / 380;
      if (rt < 1) rise = (PUP.h + PUP.TUCK_PX) * Math.pow(1 - rt, 3); else PUP.riseAt = 0;
    }
    // ...and when the run is over she ducks back down.
    if (PUP.sinkAt && !reduced) rise = (PUP.h + PUP.TUCK_PX) * Math.pow(Math.min(1, (nowMs - PUP.sinkAt) / 260), 2);
    var mx = PUP.x * PUP.css - PUP.w / 2, my = bob + rise, dp = window.devicePixelRatio || 1, move;
    // Sharp screens (phones): land on whole screen pixels and skip the 3D layer, which iPhones
    // otherwise redraw at a lower resolution. Plain screens: smooth sub-pixel movement.
    if (dp >= 2) move = 'translate(' + (Math.round(mx * dp) / dp) + 'px,' + (Math.round(my * dp) / dp) + 'px)';
    else move = 'translate3d(' + mx.toFixed(2) + 'px,' + my.toFixed(2) + 'px,0)';
    if (move !== PUP.moved) {
      PUP.moved = move; puppet.style.transform = move;
      puppet.style.clipPath = rise > 0.5 ? 'inset(0 0 ' + rise.toFixed(1) + 'px 0)' : '';   // nothing shows below the rim
    }
  }

  function fit() {
    // The jar takes all the room the stage gives it, keeping its shape. Above it goes CAG, whose
    // size follows the jar's. The jar never gets smaller than MIN_JAR_H: on a very short screen
    // the page scrolls instead of squashing it.
    var MIN_JAR_H = 300, MAX_JAR_W = 760;
    var bw = stage.clientWidth - 18, sh = stage.clientHeight;
    var guess = Math.min(bw / W, (sh - 66) / H);
    var bh = Math.max(sh - (PUP.bodyH * guess + 16), MIN_JAR_H);
    var s = clamp(Math.min(bw / W, bh / H), 0.3, MAX_JAR_W / W);
    var cw = Math.floor(W * s), ch = Math.floor(H * s);
    jar.style.width = cw + 'px'; jar.style.height = ch + 'px';
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    scale = cv.width / W;

    // CAG's own canvas: just her bust, resting behind the rim. See drawPuppet for how it moves.
    var css = cw / W, pw = Math.round(ART_P ? ART_P.bodyWidth * css : 0), ph = Math.round(PUP.bodyH * css);
    jar.style.setProperty('--av', (ph + PUP.TUCK_PX - 4) + 'px');
    puppet.style.width = pw + 'px'; puppet.style.height = ph + 'px';
    puppet.style.top = -(ph + PUP.TUCK_PX) + 'px';
    var sharp = Math.max(2, Math.min(Math.ceil(window.devicePixelRatio || 1), 3));   // at least two canvas pixels per screen pixel
    puppet.width = Math.max(1, pw * sharp); puppet.height = Math.max(1, ph * sharp);
    PUP.css = css; PUP.w = pw; PUP.h = ph; PUP.shown = -1; PUP.moved = '';
    fitIcons();
  }
  /* Tall phones: the power-ups sit on the counter, under the jar, so the jar can use the whole width.
     Shorter screens (where height is what is missing) and wide screens: they stand in a column
     on the right of the jar. */
  var powersEl = document.querySelector('.powers'), playEl = document.querySelector('.play'), counterEl = document.querySelector('.counter');
  var tallQ = window.matchMedia('(max-aspect-ratio: 10/19)');
  function placePowers() {
    if (!tallQ.matches) { if (powersEl.parentNode !== playEl) playEl.appendChild(powersEl); }
    else if (powersEl.parentNode !== counterEl) counterEl.insertBefore(powersEl, counterEl.firstChild);
  }
  placePowers();

  if (tallQ.addEventListener) tallQ.addEventListener('change', function () { placePowers(); fit(); });
  if (window.ResizeObserver) new ResizeObserver(fit).observe(stage);
  window.addEventListener('resize', fit);

  /* ---------- main loop: game time follows real time, never faster ---------- */
  var last = 0, acc = 0, combo = 0, lastMerge = -999;
  function stepOnce() {
    var sim = run.sim;
    sim.tick();
    feel(sim);
    if (sim.events.length) {
      for (var i = 0; i < sim.events.length; i++) {
        var ev = sim.events[i];
        if (ev.type === 'merge') {
          combo = sim.step - lastMerge <= COMBO_STEPS ? combo + 1 : 1; lastMerge = sim.step;
          fx.push({ x: ev.x, y: ev.y, r: FOODS[ev.lv].ext, t: sim.step, txt: '+' + fmt(ev.gain), gold: ev.gold, lv: ev.lv, seed: (sim.step * 7919 + Math.round(ev.x * 13)) | 0 });
          if (combo > 1) { comboFx.n = combo; comboFx.t = sim.step; }
          joltJar(ev.lv);
          soundMerge(ev.lv, ev.gold);
          if (ev.gold) toast('Golden food merged!');
          else if (!ev.made) toast('Double Pizza Box! +' + fmt(ev.gain) + ' kcal');
          else if (ev.lv === TOP) toast('Pizza Box! +' + fmt(ev.gain) + ' kcal');
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
      sfx.frame = 0;
      while (acc >= R.STEP_MS && n < 240 && run.live) { stepOnce(); acc -= R.STEP_MS; n++; }
    }
    refresh();
    draw();
    drawJolt();
    drawPuppet();
    drawPeek();
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

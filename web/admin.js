/*
 * Admin panel: reads the contract through the server and prepares the owner's
 * transactions; the owner's wallet confirms each one. Only the contract owner
 * gets in (the server checks it on the chain).
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var CW = window.CAGW, S = null, timer = 0;

  function say(t) { $('msg').textContent = t || ''; }
  function ron(wei) { return CW.ron(wei || '0'); }
  function fmt(n) { return Number(n || 0).toLocaleString('es-AR'); }
  function short(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : '–'; }
  function when(ms) { return new Date(ms).toLocaleString('es-AR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  /* "12,5" or "12.5" RON -> wei as text */
  function toWei(v) {
    var s = String(v || '').trim().replace(',', '.');
    if (!/^\d+(\.\d{0,18})?$/.test(s)) return null;
    var p = s.split('.'), frac = (p[1] || '').padEnd(18, '0');
    return (BigInt(p[0]) * 10n ** 18n + BigInt(frac)).toString();
  }
  function num(v) { var s = String(v || '').trim().replace(',', '.'); return s === '' || isNaN(Number(s)) ? null : Number(s); }

  /* Owner transaction: the server prepares it, the wallet confirms it. */
  function send(fn, args, value, what) {
    say('Confirmá en tu billetera: ' + what + '…');
    return CW.api('POST', '/api/admin/tx', { fn: fn, args: args || [], value: value }).then(CW.send).then(function () {
      say('Enviado: ' + what + '. Se actualiza en unos segundos.');
      setTimeout(load, 7000);
    }).catch(function (e) { say(e.code === 'rejected' ? 'Cancelado en la billetera.' : 'No se pudo: ' + (e.message || e.code)); });
  }

  function load() {
    return CW.api('GET', '/api/admin/state', null, 60000).then(function (s) { S = s; render(); })
      .catch(function (e) {
        if (e.code === 'not-owner') { $('panel').hidden = true; $('gate').hidden = false; $('gateMsg').textContent = 'Esta billetera no es la dueña del contrato.'; return; }
        if (e.code === 'sign-in') { $('panel').hidden = true; $('gate').hidden = false; return; }
        say('No se pudo leer el contrato (' + e.code + '). Probá "Actualizar" en un momento.');
      });
  }

  function cell(tr, text, cls) { var td = document.createElement('td'); td.textContent = text; if (cls) td.className = cls; tr.appendChild(td); return td; }
  function rows(tbody, players, posted, week) {
    tbody.textContent = '';
    players.forEach(function (p, i) {
      var tr = document.createElement('tr');
      cell(tr, i + 1); cell(tr, p.name); cell(tr, short(p.addr), 'addr'); cell(tr, p.runs, 'num'); cell(tr, fmt(p.total), 'num'); cell(tr, ron(p.share), 'num');
      if (posted !== undefined) {
        var td = cell(tr, '');
        if (posted) {
          var b = document.createElement('button'); b.className = 'btn small'; b.textContent = 'Anular';
          b.title = 'Saca el premio de esta billetera antes de que lo cobre';
          b.addEventListener('click', function () { if (confirm('¿Anular el premio de ' + p.name + '?')) send('voidResult', [String(week), p.addr], null, 'anular el premio de ' + p.name); });
          td.appendChild(b);
        }
      }
      tbody.appendChild(tr);
    });
  }

  function render() {
    var s = S, now = s.weeks[0], last = s.weeks[1];
    if ($('panel').hidden) loadPlayers();
    $('gate').hidden = true; $('panel').hidden = false;
    $('who').textContent = 'Dueño ' + short(CW.address);
    $('sContract').textContent = short(s.contract);
    var st = s.storage || {};
    $('sStore').textContent = st.safe ? 'En disco permanente ✓' : 'Se borran en cada deploy ✗';
    $('sStore').className = st.safe ? 'ok' : 'warn';
    $('sState').textContent = s.paused ? 'Pausado' : 'Activo';
    $('sState').className = s.paused ? 'warn' : 'ok';
    $('pause').textContent = s.paused ? 'Reanudar el juego' : 'Pausar el juego';
    $('sReferee').textContent = short(s.referee);
    $('sRefBal').textContent = ron(s.refereeBalance) + ' RON';
    var lowGas = s.refereeBalance !== null && BigInt(s.refereeBalance) < 10n ** 18n;
    $('sRefBal').className = lowGas ? 'warn' : '';
    $('sOpen').textContent = s.openRuns; $('sRuns').textContent = s.runCount;
    $('sWarn').textContent = lowGas ? 'Al árbitro le queda menos de 1 RON: mandale un poco para que pueda seguir cerrando partidas.' : '';

    $('nowLabel').textContent = '· desde el ' + now.weekId + ' · cierra ' + when(now.endsAt);
    $('nowTickets').textContent = fmt(now.tickets);
    $('nowEst').textContent = ron(now.estimate) + ' RON';
    $('nowPool').textContent = ron(BigInt(now.weekPool || '0') - BigInt(now.weekRolled || '0')) + ' RON';
    $('nowSuggest').textContent = ron(now.suggestDeposit) + ' RON';
    rows($('nowRows'), now.players);

    var grace = Number(s.fundGrace || 0) * 1000, posted = last.postedAt && last.postedAt !== '0';
    var open = !posted && Date.now() < last.endsAt + grace;
    $('lastLabel').textContent = '· desde el ' + last.weekId;
    var st = $('lastStatus');
    if (posted) { st.textContent = 'Reparto publicado el ' + when(Number(last.postedAt) * 1000) + '. Los jugadores cobran hasta el ' + when(last.endsAt + Number(s.claimWeeks || 1) * 7 * 86400000) + '.'; st.className = 'status ok'; }
    else if (open) { st.textContent = 'Esperando que cargues el pozo. El reparto se publica solo el ' + when(last.endsAt + grace) + ', o antes si tocás "Publicar el reparto ahora".'; st.className = 'status'; }
    else { st.textContent = 'El árbitro está publicando el reparto.'; st.className = 'status'; }
    $('lastFundRow').hidden = !open;
    $('lastTickets').textContent = fmt(last.tickets);
    $('lastSuggest').textContent = ron(last.suggestDeposit) + ' RON';
    $('lastPool').textContent = ron(BigInt(last.weekPool || '0') - BigInt(last.weekRolled || '0')) + ' RON';
    $('lastPaid').textContent = ron(last.weekAssigned) + ' / ' + ron(last.weekClaimed) + ' RON';
    rows($('lastRows'), last.players, !!posted, last.week);

    var old = $('oldRows'); old.textContent = '';
    s.weeks.slice(1).forEach(function (wk) {
      var left = BigInt(wk.leftover || '0'), ended = Date.now() >= wk.claimEndsAt, posted = wk.postedAt && wk.postedAt !== '0';
      if (!posted && left === 0n) return;
      var tr = document.createElement('tr');
      cell(tr, wk.weekId); cell(tr, ron(wk.weekAssigned), 'num'); cell(tr, ron(wk.weekClaimed), 'num');
      cell(tr, ended ? ron(wk.leftover) : ron(BigInt(wk.weekAssigned || '0') - BigInt(wk.weekClaimed || '0')), 'num');
      cell(tr, ended ? 'Terminó el plazo' : 'Cobran hasta el ' + when(wk.claimEndsAt));
      var td = cell(tr, '');
      if (ended && left > 0n) {
        var b1 = document.createElement('button'); b1.className = 'btn small pink'; b1.textContent = 'Retirar';
        b1.addEventListener('click', function () { send('recoverPool', [String(wk.week), CW.address], null, 'retirar ' + ron(wk.leftover) + ' RON sin cobrar de la semana del ' + wk.weekId); });
        var b2 = document.createElement('button'); b2.className = 'btn small'; b2.textContent = 'Al pozo actual';
        b2.addEventListener('click', function () { send('rollover', [String(wk.week), String(s.weeks[0].week)], null, 'pasar ' + ron(wk.leftover) + ' RON al pozo de esta semana'); });
        td.appendChild(b1); td.appendChild(document.createTextNode(' ')); td.appendChild(b2);
      }
      old.appendChild(tr);
    });

    $('boxTotal').textContent = ron(s.bonusBox) + ' RON';
    $('boxPending').textContent = ron(s.goldPending) + ' RON';
    $('boxFree').textContent = ron(s.bonusFree) + ' RON';
    var cap = BigInt(s.capPerTicket || '0');
    $('boxTickets').textContent = cap > 0n ? String(BigInt(s.bonusFree || '0') / cap) + ' (máx. ' + s.maxTickets + ')' : '–';

    $('tixHeld').textContent = fmt(s.ticketsHeld);
    $('tixId').textContent = short(s.ticket) + ' · #' + s.ticketId;

    var active = document.activeElement && document.activeElement.tagName === 'INPUT';
    if (!active) {     // do not overwrite what the owner is typing
      $('spPool').value = Number(s.poolBps) / 100; $('spBox').value = Number(s.bonusBps) / 100; $('spFee').value = Number(s.feeBps) / 100;
      $('cfMax').value = s.maxTickets; $('cfCap').value = ron(s.capPerTicket); $('cfGrace').value = Number(s.fundGrace || 0) / 3600;
    }
    var you = 100 - Number(s.poolBps) / 100 - Number(s.bonusBps) / 100;
    var feeP = Number(s.feeBps) / 100, left = you - feeP;
    $('spNote').textContent = 'Comisiones ya descontadas antes de depositar (Ronin Market 2,5% + tu comisión de creador): ' + feeP + '%. '
      + (left > 0.05 ? 'Además el contrato te manda el ' + left.toFixed(1) + '% restante.' : 'Todo lo que depositás va al pozo y a la caja.');

    var jobs = $('jobs'); jobs.textContent = '';
    if (!s.pendingTx.length) { var li = document.createElement('li'); li.textContent = 'Ninguna.'; jobs.appendChild(li); }
    s.pendingTx.forEach(function (j) {
      var li = document.createElement('li');
      li.textContent = (j.kind === 'settle' ? 'Cerrar partida #' + j.runId : j.kind === 'post' ? 'Publicar reparto de la semana ' + j.week : 'Pasar sobrante') + (j.tries ? ' · ' + j.tries + ' intentos' : '');
      jobs.appendChild(li);
    });
  }

  /* ---------- actions ---------- */
  /* Players: stats and ban. */
  var P = [];
  function loadPlayers() {
    return CW.api('GET', '/api/admin/players', null, 60000).then(function (r) { P = r.players || []; renderPlayers(); })
      .catch(function (e) { say('No se pudo leer la lista de jugadores (' + e.code + ').'); });
  }
  function renderPlayers() {
    var q = $('pFind').value.trim().toLowerCase(), tb = $('pRows');
    var list = P.filter(function (p) { return !q || p.name.toLowerCase().indexOf(q) >= 0 || p.addr.indexOf(q) >= 0; });
    $('pCount').textContent = '· ' + P.length + (P.filter(function (p) { return p.banned; }).length ? ' · ' + P.filter(function (p) { return p.banned; }).length + ' baneados' : '');
    tb.textContent = '';
    list.forEach(function (p) {
      var tr = document.createElement('tr'); if (p.banned) tr.className = 'banned';
      cell(tr, p.name);
      var a = cell(tr, short(p.addr), 'addr'); a.title = p.addr;
      cell(tr, p.joined ? new Date(p.joined).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' }) : '–');
      cell(tr, fmt(p.runs), 'num'); cell(tr, fmt(p.tickets), 'num'); cell(tr, fmt(p.week), 'num'); cell(tr, fmt(p.total), 'num');
      cell(tr, p.golds ? p.golds + ' · ' + ron(p.goldWei) + ' RON' : '–', 'num');
      var st = cell(tr, ''), tag = document.createElement('span'); tag.className = p.banned ? 'tag ban' : 'tag'; tag.textContent = p.banned ? 'Baneado' : 'OK'; st.appendChild(tag);
      var td = cell(tr, ''), b = document.createElement('button');
      b.className = p.banned ? 'btn small' : 'btn small danger'; b.textContent = p.banned ? 'Desbanear' : 'Banear';
      b.addEventListener('click', function () {
        var on = !p.banned;
        if (!confirm(on ? '¿Banear a ' + p.name + '? No va a poder jugar partidas pagas y sale del ranking y del reparto.' : '¿Desbanear a ' + p.name + '?')) return;
        b.disabled = true;
        CW.api('POST', '/api/admin/ban', { addr: p.addr, ban: on }).then(function (r) { p.banned = r.banned; renderPlayers(); say((r.banned ? 'Baneado: ' : 'Desbaneado: ') + p.name); })
          .catch(function (e) { b.disabled = false; say('No se pudo: ' + e.code); });
      });
      td.appendChild(b);
      tb.appendChild(tr);
    });
  }
  $('pFind').addEventListener('input', renderPlayers);
  $('pReload').addEventListener('click', loadPlayers);

  function amount(id) { var w = toWei($(id).value); if (!w || w === '0') { say('Escribí un monto en RON.'); return null; } return w; }
  $('connect').addEventListener('click', function () {
    $('gateMsg').textContent = 'Revisá tu billetera…';
    CW.connect().then(function () { $('gateMsg').textContent = 'Leyendo el contrato…'; return load(); })
      .catch(function (e) { $('gateMsg').textContent = e.code === 'rejected' ? 'Cancelado en la billetera.' : (e.message || 'No se pudo conectar.'); });
  });
  $('reload').addEventListener('click', function () { say('Actualizando…'); load().then(function () { say(''); }); });
  $('pause').addEventListener('click', function () {
    var p = !S.paused;
    if (p && !confirm('¿Pausar? Nadie va a poder empezar partidas con tickets ni cobrar premios hasta que lo reanudes.')) return;
    send('setPaused', [p], null, p ? 'pausar el juego' : 'reanudar el juego');
  });
  $('nowDeposit').addEventListener('click', function () {
    var w = amount('nowAmt'); if (!w) return;
    send('deposit', [String(S.weeks[0].week)], $('nowAmt').value.replace(',', '.'), 'depositar ' + $('nowAmt').value + ' RON en la semana actual');
  });
  $('lastDeposit').addEventListener('click', function () {
    var w = amount('lastAmt'); if (!w) return;
    send('deposit', [String(S.weeks[1].week)], $('lastAmt').value.replace(',', '.'), 'depositar ' + $('lastAmt').value + ' RON en la semana pasada');
  });
  $('lastClose').addEventListener('click', function () {
    if (!confirm('¿Publicar el reparto de la semana pasada ahora? Después ya no se puede cargar más en ese pozo.')) return;
    say('Publicando el reparto…');
    CW.api('POST', '/api/admin/close', { week: S.weeks[1].week }, 60000).then(function () {
      say('El árbitro está publicando el reparto. Se ve en unos segundos.'); setTimeout(load, 9000);
    }).catch(function (e) { say('No se pudo: ' + e.code); });
  });
  $('boxFund').addEventListener('click', function () {
    var w = amount('boxAmt'); if (!w) return;
    send('fundBonus', [], $('boxAmt').value.replace(',', '.'), 'cargar ' + $('boxAmt').value + ' RON en la caja');
  });
  $('boxTake').addEventListener('click', function () {
    var w = amount('boxAmt'); if (!w) return;
    if (BigInt(w) > BigInt(S.bonusFree || '0')) { say('Solo podés retirar la parte libre: ' + ron(S.bonusFree) + ' RON.'); return; }
    send('withdrawBonus', [w, CW.address], null, 'retirar ' + $('boxAmt').value + ' RON de la caja');
  });
  $('tixTake').addEventListener('click', function () {
    var n = num($('tixAmt').value);
    if (!n || n < 1 || n !== Math.floor(n)) { say('Escribí cuántos tickets.'); return; }
    if (n > Number(S.ticketsHeld)) { say('En el contrato hay ' + S.ticketsHeld + '.'); return; }
    send('withdrawTickets', [String(n), CW.address], null, 'retirar ' + n + ' tickets');
  });
  $('spSave').addEventListener('click', function () {
    var a = num($('spPool').value), b = num($('spBox').value), f = num($('spFee').value);
    if (a === null || b === null || f === null || a + b + f > 100) { say('Los porcentajes no pueden sumar más de 100.'); return; }
    send('setSplit', [String(Math.round(a * 100)), String(Math.round(b * 100)), String(Math.round(f * 100)), S.treasury || CW.address], null, 'cambiar el reparto');
  });
  $('cfSave').addEventListener('click', function () {
    var m = num($('cfMax').value), cap = toWei($('cfCap').value), g = num($('cfGrace').value);
    if (!m || m < 1 || m > 20 || !cap || g === null || g < 0 || g > 72) { say('Revisá los valores: tickets de 1 a 20, horas de 0 a 72.'); return; }
    send('setConfig', [String(m), cap, String(S.claimDelay), String(S.claimWeeks)], null, 'guardar partidas y premios').then(function () {
      if (Math.round(g * 3600) !== Number(S.fundGrace)) return send('setFundGrace', [String(Math.round(g * 3600))], null, 'cambiar las horas para cargar el pozo');
    });
  });

  CW.init().then(function () {
    if (!CW.enabled) { $('gateMsg').textContent = 'El juego no está conectado a un contrato.'; $('connect').disabled = true; return; }
    if (CW.address) load();
  });
  timer = setInterval(function () { if (!$('panel').hidden && !document.hidden) load(); }, 60000);
})();

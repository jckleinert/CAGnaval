'use strict';
/*
 * Web server: serves the game page and the referee API.
 *
 *   POST /api/runs                 start a run            { player: { id, name } }
 *   POST /api/runs/:id/drop        drop a food            { seq, step, x, h }
 *   POST /api/runs/:id/power       use a power-up         { seq, step, power, h }
 *   POST /api/runs/:id/finish      end of the run         { step, kcal, reason }
 *   GET  /api/leaderboard          ranking of the week    ?week=YYYY-MM-DD&player=<id>&by=total|best
 *   GET  /api/health
 *
 * With the blockchain on (GAME_CONTRACT + REFEREE_KEY):
 *   GET  /api/chain                contract settings
 *   POST /api/auth/nonce           message to sign        { address }
 *   POST /api/auth                 session token          { address, signature }
 *   GET  /api/wallet               tickets and prizes     (Authorization: Bearer <token>)
 *   POST /api/tx/play              data of the play tx    { n }            (token)
 *   POST /api/tx/claim-gold        data of the claim tx                    (token)
 *   POST /api/tx/claim             data of the claim tx   { week }         (token)
 *   GET  /api/golds                golden onigiri prizes: latest and biggest this week
 *   GET  /api/market               tickets on sale in Ronin Market, by price
 *   POST /api/tx/buy               data of a Ronin Market purchase { n }   (token)
 *   POST /api/runs                 a paid run             { player, txHash } (token)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./config.js');
const Store = require('./store.js');
const { RunManager, RunError, cleanName, playerKey } = require('./runs.js');
const { ethers } = require('ethers');
const { Chain, weekNumberOf } = require('./chain.js');
const { Auth } = require('./auth.js');
const { Market } = require('./market.js');
const crypto = require('crypto');
const Sim = require('../shared/sim.js');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.ico': 'image/x-icon', '.json': 'application/json' };
const CSP = "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

function createApp(options) {
  const config = Object.assign({}, cfg, options || {});
  const chain = config.chain || new Chain(config);
  const market = config.market || new Market(config);
  config.PAID_ONLY = !!chain.enabled;
  const store = new Store(config);
  const runs = new RunManager(config, store, config.now);
  try {
    const fixed = store.fixBest(store.weekId(Date.now()), playerKey);
    if (fixed) console.log('best run of', fixed, 'players set back to one ticket');
  } catch (e) { console.error('could not check best runs', e.message); }
  const auth = new Auth(config.REFEREE_KEY ? crypto.createHash('sha256').update('session:' + config.REFEREE_KEY).digest('hex') : null);
  const bootAt = Date.now();
  if (chain.enabled) runs.onPaid = (run, result) => chain.settle(run.chain.runId, result.goldWei || '0');

  /* Shake, Swap and Sweep: for everyone without the blockchain; with it, for holders of the NFT. */
  async function powersFor(addr) {
    if (!chain.enabled || !config.HOLDER_NFT) return true;
    if (!addr || !chain.isHolder) return false;
    try { return await chain.isHolder(addr); } catch (e) { return false; }
  }
  function who(req) {
    const h = String(req.headers.authorization || '');
    const a = auth.check(h.startsWith('Bearer ') ? h.slice(7) : '');
    if (!a) throw new RunError(401, 'sign-in');
    return a;
  }

  /* Weekly prize estimate: tickets played this week x ticket price x the pool's share. */
  function estimatePool(tickets) {
    const bps = chain.cache && chain.cache.v && chain.cache.v.poolBps ? chain.cache.v.poolBps : 7250;
    return BigInt(tickets) * ethers.parseEther(String(config.TICKET_PRICE)) * BigInt(bps) / 10000n;
  }
  /* The pool players see: what the tickets sold so far should bring (or the sales already loaded,
     if more), plus any extra the owner added or rolled over into that week. */
  async function poolShown(weekId, tickets) {
    const est = estimatePool(tickets);
    if (!chain.enabled || !chain.weekFunds) return { pool: est, extra: 0n };
    const f = await chain.weekFunds(weekNumberOf(weekId)).catch(() => ({ sales: 0n, extra: 0n }));
    return { pool: (f.sales > est ? f.sales : est) + f.extra, extra: f.extra };
  }
  function shareOf(pool, total, sum) { return sum > 0 && total > 0 ? (pool * BigInt(total) / BigInt(sum)).toString() : '0'; }

  /* The admin panel: the contract as it stands, plus the rankings with wallets and what each would get. */
  /* Is the data folder on a disk that survives deploys? (Railway tells where its volume is.) */
  function storage() {
    const vol = process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
    const dir = path.resolve(config.DATA_DIR);
    const onRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
    return { dir, volume: vol || null, safe: vol ? (dir === path.resolve(vol) || dir.startsWith(path.resolve(vol) + path.sep)) : !onRailway };
  }
  async function adminState() {
    const c = await chain.adminRead();
    const price = ethers.parseEther(String(config.TICKET_PRICE));
    const fee = BigInt(c.feeBps || 250);
    for (const wk of c.weeks) {
      const rows = store.leaderboard(wk.weekId, 'total');
      const tickets = store.weekTickets(wk.weekId);
      const sum = rows.reduce((a, r) => a + (r.addr ? r.total : 0), 0);
      const pool = BigInt(wk.weekPool || '0') - BigInt(wk.weekRolled || '0');
      const shown = await poolShown(wk.weekId, tickets), est = shown.pool;
      wk.tickets = tickets;
      wk.estimate = est.toString();
      wk.extra = shown.extra.toString();
      // what the owner receives for those tickets on the market (price minus the fee), the amount to deposit
      wk.suggestDeposit = (BigInt(tickets) * price * (10000n - fee) / 10000n).toString();
      wk.players = rows.filter((r) => r.addr).slice(0, 100).map((r) => ({ name: r.name, addr: r.addr, total: r.total, runs: r.runs,
        share: shareOf(pool > 0n ? pool : est, r.total, sum) }));
    }
    c.ticketPrice = String(config.TICKET_PRICE);
    c.storage = storage();
    return c;
  }

  /* A paid run: the tickets were sent in `txHash`; checks it on the chain before the game starts. */
  async function paidRun(req, body, ip) {
    if (!chain.enabled) throw new RunError(400, 'practice-only');
    const addr = who(req);
    if (store.isBanned(addr)) throw new RunError(403, 'banned');
    if (typeof body.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) throw new RunError(400, 'bad-tx');
    const found = await chain.runFromTx(body.txHash, 60000);
    if (found.error) throw new RunError(found.error === 'tx-not-found' ? 404 : 422, found.error);
    const cr = await chain.getRun(found.runId);
    if (cr.player !== addr) throw new RunError(403, 'not-your-run');
    if (cr.settled) throw new RunError(409, 'run-finished');
    const seen = store.chainRun(found.runId);
    // A run can be played once. Only a run cut by a server restart may start again.
    if (seen && !(seen.status === 'playing' && seen.at < bootAt && !runs.active.has(seen.run))) throw new RunError(409, 'run-finished');
    const prof = store.profile(addr);
    if (!prof) throw new RunError(409, 'need-name');
    const out = runs.create({ id: addr, name: prof.name }, { ua: req.headers['user-agent'], ip, chain: { runId: found.runId, tickets: cr.tickets, cap: cr.cap }, powers: await powersFor(addr) });
    store.addTickets(store.weekId(Date.now()), cr.tickets);
    out.chainRun = found.runId;
    if (chain.forget) chain.forget(addr);
    return out;
  }
  const hits = new Map();

  function ipOf(req) {
    // Behind one trusted proxy the last entry is the one it added; earlier entries are whatever the visitor sent.
    if (config.TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',').pop().trim();
    return req.socket.remoteAddress || 'unknown';
  }
  function limited(ip) {
    const minute = Math.floor(Date.now() / 60000);
    const e = hits.get(ip);
    if (!e || e.minute !== minute) { hits.set(ip, { minute, n: 1 }); return false; }
    return ++e.n > config.RATE_LIMIT_PER_MIN;
  }
  function send(res, status, body, extra) {
    const data = JSON.stringify(body);
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, extra || {}));
    res.end(data);
  }
  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > 4096) { reject(new RunError(413, 'too-large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); resolve(v && typeof v === 'object' ? v : {}); } catch (e) { reject(new RunError(400, 'bad-json')); } });
      req.on('error', () => reject(new RunError(400, 'bad-request')));
    });
  }
  function serveFile(res, file, cache) {
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP, 'Referrer-Policy': 'no-referrer' });
      res.end(data);
    });
  }
  /* Texts and picture of the CAGnaval Ticket collection, as wallets and Ronin Market read them.
     The address is this site's (or PUBLIC_URL), so it follows the site if it moves. */
  function nftMeta(req, res, pathname) {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const site = (config.PUBLIC_URL || (/^[a-z0-9.-]+(:\d+)?$/i.test(host) ? 'https://' + host : '')).replace(/\/+$/, '');
    const desc = 'Your entry to the CAGnaval games on Ronin. Each ticket is one entry.';
    const body = pathname.endsWith('collection.json')
      ? { name: 'CAGnaval Ticket', description: desc, image: site + '/nft/ticket.png', external_link: site + '/' }
      : { name: 'CAGnaval Ticket', description: desc, image: site + '/nft/ticket.png', external_url: site + '/',
          attributes: [{ trait_type: 'Type', value: '1 Entry' }, { trait_type: 'Series', value: '01' }] };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body, null, 1));
  }

  function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/web/index.html' : pathname === '/admin' ? '/web/admin.html' : pathname;
    if (!rel.startsWith('/web/') && !rel.startsWith('/shared/')) rel = '/web' + rel;
    const file = path.normalize(path.join(ROOT, rel));
    const okDir = file.startsWith(path.join(ROOT, 'web') + path.sep) || file.startsWith(path.join(ROOT, 'shared') + path.sep);
    if (!okDir || !TYPES[path.extname(file)]) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    serveFile(res, file, 'no-cache');
  }

  async function api(req, res, url) {
    const cors = {};
    if (config.ALLOWED_ORIGIN) {
      cors['Access-Control-Allow-Origin'] = config.ALLOWED_ORIGIN; cors['Vary'] = 'Origin';
      cors['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'; cors['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    try {
      const ip = ipOf(req);
      if (limited(ip)) throw new RunError(429, 'slow-down');
      const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
      if (req.method === 'GET' && parts[1] === 'health') {
        return send(res, 200, { ok: true, rulesVersion: Sim.RULES.VERSION, activeRuns: runs.active.size, dataSafe: storage().safe,
          chain: chain.enabled ? { contract: config.GAME_CONTRACT, referee: chain.referee, pendingTx: chain.jobs.length } : null }, cors);
      }
      if (req.method === 'GET' && parts[1] === 'chain') {
        if (!chain.enabled) return send(res, 200, { enabled: false }, cors);
        return send(res, 200, Object.assign({ enabled: true, goldOdds: config.GOLD_ODDS, goldFrom: config.GOLD_FROM }, await chain.info()), cors);
      }
      if (req.method === 'POST' && parts[1] === 'auth') {
        if (!chain.enabled) throw new RunError(400, 'practice-only');
        const body = await readJson(req);
        if (parts[2] === 'nonce') {
          const message = auth.nonce(String(body.address || ''));
          if (!message) throw new RunError(400, 'bad-address');
          return send(res, 200, { message }, cors);
        }
        const s = auth.login(String(body.address || ''), body.signature);
        if (!s) throw new RunError(401, 'bad-signature');
        return send(res, 200, s, cors);
      }
      if (req.method === 'GET' && parts[1] === 'wallet') {
        if (!chain.enabled) throw new RunError(400, 'practice-only');
        const addr = who(req);
        const info = await chain.wallet_(addr);
        const w = store.weekId(Date.now()), board = runs.leaderboard(w, 1, '', 'total');
        const shownNow = await poolShown(w, board.tickets), pool = shownNow.pool, mine = store.weekTotal(w, playerKey(addr));
        const prof = store.profile(addr);
        // last week, while its results are not out yet: what this wallet should get
        const lw = info.weekly ? info.weekly.weekId : null;
        let last = null;
        if (lw) {
          const lb = runs.leaderboard(lw, 1, '', 'total'), lmine = store.weekTotal(lw, playerKey(addr));
          last = { kcal: lmine, mine: shareOf((await poolShown(lw, lb.tickets)).pool, lmine, lb.sum) };
        }
        return send(res, 200, Object.assign({ address: addr, name: prof ? prof.name : null,
          estimate: { pool: pool.toString(), extra: shownNow.extra.toString(), mine: shareOf(pool, mine, board.sum), kcal: mine, endsAt: board.endsAt }, lastEstimate: last, holder: await powersFor(addr) }, info), cors);
      }
      if (parts[1] === 'admin') {
        if (!chain.enabled) throw new RunError(400, 'practice-only');
        const addr = who(req);
        // the owner (cold wallet) or the operator it named (day-to-day wallet)
        const role = addr === await chain.owner() ? 'owner' : (chain.operator && addr === await chain.operator() ? 'operator' : null);
        if (!role) throw new RunError(403, 'not-owner');
        if (req.method === 'GET' && parts[2] === 'state') return send(res, 200, Object.assign(await adminState(), { role }), cors);
        if (req.method === 'POST' && parts[2] === 'tx') {
          const body = await readJson(req);
          let tx;
          try { tx = chain.txAdmin(String(body.fn || ''), Array.isArray(body.args) ? body.args : [], body.value); } catch (e) { throw new RunError(400, 'bad-admin-tx'); }
          return send(res, 200, Object.assign({ from: addr }, tx), cors);
        }
        if (req.method === 'GET' && parts[2] === 'players') {
          const now = store.weekId(Date.now()), only = url.searchParams.get('week') || '';
          if (only && !/^\d{4}-\d{2}-\d{2}$/.test(only)) throw new RunError(400, 'bad-week');
          const list = store.players(playerKey, now, only).sort(only ? (a, b) => b.total - a.total || a.name.localeCompare(b.name) : (a, b) => b.last - a.last || b.joined - a.joined);
          const weeks = store.weekIds(); if (weeks.indexOf(now) < 0) weeks.unshift(now);
          return send(res, 200, { players: list, weeks, thisWeek: now, week: only || null }, cors);
        }
        if (req.method === 'POST' && parts[2] === 'ban') {
          const body = await readJson(req);
          const target = String(body.addr || '').toLowerCase();
          if (!/^0x[0-9a-f]{40}$/.test(target)) throw new RunError(400, 'bad-address');
          if (target === addr) throw new RunError(400, 'not-yourself');
          store.setBan(target, !!body.ban, Date.now());
          console.log((body.ban ? 'banned ' : 'unbanned ') + target);
          return send(res, 200, { addr: target, banned: store.isBanned(target) }, cors);
        }
        if (req.method === 'POST' && parts[2] === 'close') {
          const body = await readJson(req);
          const out = await chain.closeWeeks(store, Number(body.week));
          return send(res, 200, out || {}, cors);
        }
        throw new RunError(404, 'not-found');
      }
      if (parts[1] === 'me' && (req.method === 'GET' || req.method === 'POST')) {
        if (!chain.enabled) throw new RunError(400, 'practice-only');
        const addr = who(req);
        if (req.method === 'POST') {
          const body = await readJson(req);
          const name = cleanName(body.name);
          if (name.length < 2) throw new RunError(400, 'name-too-short');
          const prof = store.profile(addr);
          if (prof && prof.name !== name) throw new RunError(409, 'name-set');
          if (store.nameTaken(name, addr)) throw new RunError(409, 'name-taken');
          if (!prof) store.setProfile(addr, name, Date.now());
        }
        const prof = store.profile(addr);
        return send(res, 200, { address: addr, name: prof ? prof.name : null }, cors);
      }
      if (req.method === 'POST' && parts[1] === 'tx') {
        if (!chain.enabled) throw new RunError(400, 'practice-only');
        const addr = who(req);
        const body = await readJson(req);
        if (parts[2] === 'play') {
          if (store.isBanned(addr)) throw new RunError(403, 'banned');
          const n = Number(body.n);
          if (!Number.isInteger(n) || n < 1 || n > 1000) throw new RunError(400, 'bad-tickets');
          return send(res, 200, Object.assign({ from: addr }, await chain.txPlay(addr, n)), cors);
        }
        if (parts[2] === 'buy') {
          const n = Number(body.n);
          if (!market.enabled) throw new RunError(400, 'no-shop');
          if (!Number.isInteger(n) || n < 1 || n > 1000) throw new RunError(400, 'bad-tickets');
          const info = await chain.info();
          let tx;
          try { tx = await market.txBuy(addr, n, info.ticket, info.ticketId); } catch (e) {
            if (e.message === 'not-enough-listed') { const err = new RunError(409, 'not-enough-listed'); err.extra = { available: e.available }; throw err; }
            if (e.message === 'not-enough-ron') throw new RunError(409, 'not-enough-ron');
            console.error('shop:', e.message); throw new RunError(503, 'shop-busy');
          }
          return send(res, 200, Object.assign({ from: addr }, tx), cors);
        }
        if (parts[2] === 'claim-gold') return send(res, 200, Object.assign({ from: addr }, chain.txClaimGold()), cors);
        if (parts[2] === 'claim') {
          const w = Number(body.week);
          if (!Number.isInteger(w) || w < 0) throw new RunError(400, 'bad-week');
          return send(res, 200, Object.assign({ from: addr }, chain.txClaim(w)), cors);
        }
      }
      if (req.method === 'GET' && parts[1] === 'golds') {
        // Golden onigiri prizes of paid runs: the latest, and the biggest of this week.
        const now = Date.now(), all = store.golds().filter((g) => g.at <= now), week = store.weekId(now);
        const pub = (g) => ({ id: g.id, name: g.name, mult: g.mult, wei: g.wei, at: g.at });
        const latest = all.slice(-30).reverse().map(pub);
        const biggest = all.filter((g) => g.week === week).sort((a, b) => (BigInt(b.wei) > BigInt(a.wei) ? 1 : BigInt(b.wei) < BigInt(a.wei) ? -1 : b.at - a.at)).slice(0, 15).map(pub);
        return send(res, 200, { latest, biggest, now: Date.now() }, cors);
      }
      if (req.method === 'GET' && parts[1] === 'market') {
        if (!chain.enabled || !market.enabled) return send(res, 200, { enabled: false }, cors);
        const info = await chain.info();
        if (parts[2] === 'image') {
          const img = await market.image(info.ticket, info.ticketId).catch(() => null);
          if (!img) throw new RunError(404, 'no-image');
          res.writeHead(200, { 'Content-Type': img.type, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
          return res.end(img.body);
        }
        let s;
        try { s = await market.summary(info.ticket, info.ticketId); s.meta = market.meta ? await market.meta(info.ticket, info.ticketId).catch(() => null) : null; } catch (e) { console.error('shop list:', String(e.message).slice(0, 200)); throw new RunError(503, 'shop-busy'); }
        return send(res, 200, Object.assign({ enabled: true, ticket: info.ticket, ticketId: info.ticketId }, s), cors);
      }
      if (req.method === 'GET' && parts[1] === 'leaderboard') {
        const b = runs.leaderboard(url.searchParams.get('week') || '', 50, url.searchParams.get('player') || '', url.searchParams.get('by') || '');
        if (chain.enabled) {
          const shown = await poolShown(b.week, b.tickets), pool = shown.pool;
          b.pool = pool.toString(); b.extra = shown.extra.toString();
          for (const row of b.top.concat(b.you ? [b.you] : [])) row.prize = row.paid ? shareOf(pool, row.total, b.sum) : '0';
        }
        return send(res, 200, b, cors);
      }
      if (req.method === 'POST' && parts[1] === 'runs') {
        const body = await readJson(req);
        if (parts.length === 2 && body.txHash) {
          let out;
          try { out = await paidRun(req, body, ip); } catch (e) {
            console.error('paid run refused:', body.txHash, e.code || '', e.shortMessage || e.message);
            throw e;
          }
          console.log('paid run', out.chainRun, 'started for', who(req), out.tickets, 'tickets');
          return send(res, 200, out, cors);
        }
        if (parts.length === 2) {
          let addr = null;
          if (req.headers.authorization) { try { addr = who(req); } catch (e) { addr = null; } }
          return send(res, 200, runs.create(body.player, { ua: req.headers['user-agent'], ip, powers: await powersFor(addr) }), cors);
        }
        const id = parts[2], action = parts[3];
        if (!/^[a-f0-9]{24}$/.test(id)) throw new RunError(404, 'run-not-found');
        if (action === 'drop') return send(res, 200, runs.event(id, Object.assign({}, body, { type: 'drop' })), cors);
        if (action === 'power') return send(res, 200, runs.event(id, Object.assign({}, body, { type: 'power' })), cors);
        if (action === 'finish') return send(res, 200, runs.finish(id, body), cors);
      }
      throw new RunError(404, 'not-found');
    } catch (e) {
      if (e instanceof RunError) return send(res, e.status, Object.assign({ error: e.code }, e.extra || {}), cors);
      if (e && e.code && /SERVER_ERROR|TIMEOUT|NETWORK_ERROR|CALL_EXCEPTION|BAD_DATA/.test(e.code)) {
        console.error('chain read failed:', url.pathname, e.shortMessage || e.message);
        return send(res, 503, { error: 'chain-busy' }, cors);
      }
      console.error(e);
      return send(res, 500, { error: 'server-error' }, cors);
    }
  }

  const server = http.createServer((req, res) => {
    try {
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Bad request'); return; }
      if (url.pathname.startsWith('/api/')) { api(req, res, url); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
      if (/^\/nft\/(1|collection)\.json$/.test(url.pathname)) { nftMeta(req, res, url.pathname); return; }
      serveStatic(req, res, url.pathname);
    } catch (e) {
      console.error(e);
      try { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('Server error'); } catch (e2) { /* connection already gone */ }
    }
  });
  const timer = setInterval(() => {
    try { runs.sweep(); } catch (e) { console.error(e); }
    const minute = Math.floor(Date.now() / 60000);
    for (const [ip, e] of hits) if (e.minute !== minute) hits.delete(ip);
  }, 5000);
  timer.unref();
  let closer = null;
  if (chain.enabled && !config.NO_CLOSER) {
    const close = () => chain.closeWeeks(store).catch((e) => console.error('weekly close:', e.shortMessage || e.message));
    setTimeout(close, 20000).unref();
    closer = setInterval(close, config.CLOSE_EVERY_MS);
    closer.unref();
  }
  server.on('close', () => { clearInterval(timer); if (closer) clearInterval(closer); store.flush(); });
  return { server, runs, store, config, chain, auth };
}

if (require.main === module) {
  const app = createApp();
  app.server.listen(app.config.PORT, () => console.log('CAGnaval referee listening on port ' + app.config.PORT));
  const stop = () => { app.store.flush(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { createApp };

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
 *   POST /api/runs                 a paid run             { player, txHash } (token)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./config.js');
const Store = require('./store.js');
const { RunManager, RunError } = require('./runs.js');
const { Chain } = require('./chain.js');
const { Auth } = require('./auth.js');
const crypto = require('crypto');
const Sim = require('../shared/sim.js');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.ico': 'image/x-icon', '.json': 'application/json' };
const CSP = "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

function createApp(options) {
  const config = Object.assign({}, cfg, options || {});
  const chain = config.chain || new Chain(config);
  config.PAID_ONLY = !!chain.enabled;
  const store = new Store(config);
  const runs = new RunManager(config, store, config.now);
  const auth = new Auth(config.REFEREE_KEY ? crypto.createHash('sha256').update('session:' + config.REFEREE_KEY).digest('hex') : null);
  const bootAt = Date.now();
  if (chain.enabled) runs.onPaid = (run, result) => chain.settle(run.chain.runId, result.goldWei || '0');

  function who(req) {
    const h = String(req.headers.authorization || '');
    const a = auth.check(h.startsWith('Bearer ') ? h.slice(7) : '');
    if (!a) throw new RunError(401, 'sign-in');
    return a;
  }

  /* A paid run: the tickets were sent in `txHash`; checks it on the chain before the game starts. */
  async function paidRun(req, body, ip) {
    if (!chain.enabled) throw new RunError(400, 'practice-only');
    const addr = who(req);
    if (typeof body.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) throw new RunError(400, 'bad-tx');
    const found = await chain.runFromTx(body.txHash, 60000);
    if (found.error) throw new RunError(found.error === 'tx-not-found' ? 404 : 422, found.error);
    const cr = await chain.getRun(found.runId);
    if (cr.player !== addr) throw new RunError(403, 'not-your-run');
    if (cr.settled) throw new RunError(409, 'run-finished');
    const seen = store.chainRun(found.runId);
    // A run can be played once. Only a run cut by a server restart may start again.
    if (seen && !(seen.status === 'playing' && seen.at < bootAt && !runs.active.has(seen.run))) throw new RunError(409, 'run-finished');
    const name = body.player && typeof body.player.name === 'string' ? body.player.name : '';
    const out = runs.create({ id: addr, name }, { ua: req.headers['user-agent'], ip, chain: { runId: found.runId, tickets: cr.tickets, cap: cr.cap } });
    out.chainRun = found.runId;
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
  function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/web/index.html' : pathname;
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
        return send(res, 200, { ok: true, rulesVersion: Sim.RULES.VERSION, activeRuns: runs.active.size,
          chain: chain.enabled ? { contract: config.GAME_CONTRACT, referee: chain.referee, pendingTx: chain.jobs.length } : null }, cors);
      }
      if (req.method === 'GET' && parts[1] === 'chain') {
        if (!chain.enabled) return send(res, 200, { enabled: false }, cors);
        return send(res, 200, Object.assign({ enabled: true }, await chain.info()), cors);
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
        return send(res, 200, Object.assign({ address: addr }, await chain.wallet_(addr)), cors);
      }
      if (req.method === 'POST' && parts[1] === 'tx') {
        if (!chain.enabled) throw new RunError(400, 'practice-only');
        const addr = who(req);
        const body = await readJson(req);
        if (parts[2] === 'play') {
          const n = Number(body.n);
          if (!Number.isInteger(n) || n < 1 || n > 20) throw new RunError(400, 'bad-tickets');
          return send(res, 200, Object.assign({ from: addr }, await chain.txPlay(addr, n)), cors);
        }
        if (parts[2] === 'claim-gold') return send(res, 200, Object.assign({ from: addr }, chain.txClaimGold()), cors);
        if (parts[2] === 'claim') {
          const w = Number(body.week);
          if (!Number.isInteger(w) || w < 0) throw new RunError(400, 'bad-week');
          return send(res, 200, Object.assign({ from: addr }, chain.txClaim(w)), cors);
        }
      }
      if (req.method === 'GET' && parts[1] === 'leaderboard') {
        return send(res, 200, runs.leaderboard(url.searchParams.get('week') || '', 50, url.searchParams.get('player') || '', url.searchParams.get('by') || ''), cors);
      }
      if (req.method === 'POST' && parts[1] === 'runs') {
        const body = await readJson(req);
        if (parts.length === 2 && body.txHash) return send(res, 200, await paidRun(req, body, ip), cors);
        if (parts.length === 2) return send(res, 200, runs.create(body.player, { ua: req.headers['user-agent'], ip }), cors);
        const id = parts[2], action = parts[3];
        if (!/^[a-f0-9]{24}$/.test(id)) throw new RunError(404, 'run-not-found');
        if (action === 'drop') return send(res, 200, runs.event(id, Object.assign({}, body, { type: 'drop' })), cors);
        if (action === 'power') return send(res, 200, runs.event(id, Object.assign({}, body, { type: 'power' })), cors);
        if (action === 'finish') return send(res, 200, runs.finish(id, body), cors);
      }
      throw new RunError(404, 'not-found');
    } catch (e) {
      if (e instanceof RunError) return send(res, e.status, { error: e.code }, cors);
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

'use strict';
/*
 * Web server: serves the game page and the referee API.
 *
 *   POST /api/runs                 start a run            { player: { id, name } }
 *   POST /api/runs/:id/drop        drop a food            { seq, step, x, h }
 *   POST /api/runs/:id/power       use a power-up         { seq, step, power, h }
 *   POST /api/runs/:id/finish      end of the run         { step, kcal, reason }
 *   GET  /api/leaderboard          ranking of the week    ?week=YYYY-MM-DD&player=<id>
 *   GET  /api/health
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./config.js');
const Store = require('./store.js');
const { RunManager, RunError } = require('./runs.js');
const Sim = require('../shared/sim.js');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json' };
const CSP = "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

function createApp(options) {
  const config = Object.assign({}, cfg, options || {});
  const store = new Store(config);
  const runs = new RunManager(config, store, config.now);
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
      cors['Access-Control-Allow-Headers'] = 'Content-Type'; cors['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    try {
      const ip = ipOf(req);
      if (limited(ip)) throw new RunError(429, 'slow-down');
      const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
      if (req.method === 'GET' && parts[1] === 'health') return send(res, 200, { ok: true, rulesVersion: Sim.RULES.VERSION, activeRuns: runs.active.size }, cors);
      if (req.method === 'GET' && parts[1] === 'leaderboard') {
        return send(res, 200, runs.leaderboard(url.searchParams.get('week') || '', 50, url.searchParams.get('player') || ''), cors);
      }
      if (req.method === 'POST' && parts[1] === 'runs') {
        const body = await readJson(req);
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
  server.on('close', () => { clearInterval(timer); store.flush(); });
  return { server, runs, store, config };
}

if (require.main === module) {
  const app = createApp();
  app.server.listen(app.config.PORT, () => console.log('CAGnaval referee listening on port ' + app.config.PORT));
  const stop = () => { app.store.flush(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { createApp };

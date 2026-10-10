/*
 * Browser check of the paid flow with a pretend wallet and a pretend chain:
 * connect + sign in, pick tickets, send them, play a few drops, quit, open the
 * prizes card and claim. Nothing touches a real blockchain.
 *   PLAYWRIGHT_PATH=... node scripts/e2e-wallet.js   (E2E_SHOTS=<dir> for screenshots)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ethers } = require('ethers');
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright')); } catch (e) { console.error('Playwright is not available: ' + e.message); process.exit(2); }
const { createApp } = require('../server/index.js');

(async () => {
  const w = ethers.Wallet.createRandom();
  const me = w.address.toLowerCase();
  const RON = (n) => ethers.parseEther(String(n)).toString();
  const sent = [], settled = [];
  let runN = 0;
  const fake = {
    enabled: true, jobs: [], referee: '0x' + '2'.repeat(40),
    async info() { return { contract: '0x' + '4'.repeat(40), chainId: 2020, ticket: '0x' + '6'.repeat(40), ticketId: '1', cap: RON(1), maxTickets: 5, week: 2908, paused: false }; },
    async wallet_() {
      return { tickets: 7 - sent.filter((t) => t.kind === 'play').length, gold: { won: RON(2.5), payableNow: true },
        weekly: { week: 2907, weekId: '2026-10-05', prize: RON(12.34), claimable: RON(12.34), claimed: false }, maxTicketsNow: 3, cap: RON(1), maxTickets: 5, paused: false };
    },
    async txPlay(from, n) { return { to: '0x' + '6'.repeat(40), data: '0xplay' + n }; },
    txClaimGold() { return { to: '0x' + '4'.repeat(40), data: '0xclaimgold' }; },
    txClaim(week) { return { to: '0x' + '4'.repeat(40), data: '0xclaim' + week }; },
    async runFromTx() { return { runId: String(++runN) }; },
    async getRun() { return { player: me, tickets: Number((sent.filter((t) => t.kind === 'play').pop() || { n: 1 }).n), week: 0, settled: false, cap: RON(1) }; },
    settle(id, g) { settled.push([id, g]); }
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cagnaval-e2ew-'));
  const app = createApp({ DATA_DIR: dir, chain: fake, REFEREE_KEY: '0x' + '5'.repeat(64), NO_CLOSER: true });
  await new Promise((r) => app.server.listen(0, r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 400, height: 760 }, deviceScaleFactor: 2 })).newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push('page error: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/401|409/.test(m.text())) problems.push('console: ' + m.text()); });
  await page.route('**/fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));

  // The pretend Ronin Wallet: signs with a real key kept in this script.
  await page.exposeFunction('__sign', async (hex) => w.signMessage(ethers.getBytes(hex)));
  await page.exposeFunction('__send', async (tx) => {
    const kind = tx.data.startsWith('0xplay') ? 'play' : tx.data === '0xclaimgold' ? 'claimGold' : 'claim';
    sent.push({ kind, n: kind === 'play' ? Number(tx.data.slice(6)) : 0 });
    return '0x' + String(sent.length).padStart(64, 'a');
  });
  await page.addInitScript((addr) => {
    window.ronin = { provider: { request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts') return [addr];
      if (method === 'eth_chainId') return '0x7e4';
      if (method === 'personal_sign') return window.__sign(params[0]);
      if (method === 'eth_sendTransaction') return window.__send(params[0]);
      throw new Error('unsupported ' + method);
    } } };
  }, w.address);

  const shot = process.env.E2E_SHOTS;
  const text = (id) => page.evaluate((i) => document.getElementById(i).textContent, id);
  await page.goto(base + '/');
  await page.fill('#name', 'Wallet bot');
  await page.waitForFunction(() => document.getElementById('play').textContent.includes('Connect'), null, { timeout: 5000 });
  if (shot) await page.screenshot({ path: path.join(shot, 'w1-home.png') });
  await page.click('#play');                                                    // connect + sign in
  await page.waitForFunction(() => document.getElementById('play').textContent.includes('ticket'), null, { timeout: 8000 });
  await page.click('#tPlus'); await page.click('#tPlus');
  const capped = await page.evaluate(() => document.getElementById('tPlus').disabled);   // 3 is the most the box allows
  const label = await text('play');
  if (shot) await page.screenshot({ path: path.join(shot, 'w2-connected.png') });
  await page.click('#play');                                                    // sends 3 tickets, starts the run
  await page.waitForFunction(() => document.getElementById('home').hidden, null, { timeout: 10000 });
  const note = await text('counterNote');
  const box = await page.locator('#game').boundingBox();
  for (let i = 0; i < 6; i++) { await page.mouse.click(box.x + 40 + i * 30, box.y + 30); await page.waitForTimeout(700); }
  // leave the run: the referee closes it and settles it on the chain
  const live = Array.from(app.runs.active.values())[0];
  app.runs._expire(live, 'test');
  await page.reload();
  await page.waitForFunction(() => document.getElementById('play').textContent.includes('ticket'), null, { timeout: 8000 });
  await page.click('#openPrizes');
  await page.waitForFunction(() => !document.getElementById('prizes').hidden && document.getElementById('goldAmt').textContent !== '0 RON', null, { timeout: 5000 });
  if (shot) await page.screenshot({ path: path.join(shot, 'w3-prizes.png') });
  const gold = await text('goldAmt'), week = await text('weekAmt');
  await page.click('#claimGold');
  await page.waitForFunction(() => document.getElementById('prizeMsg').textContent.startsWith('Sent'), null, { timeout: 5000 });
  await page.click('#claimWeek');
  await page.waitForTimeout(500);

  const out = { label, capped, note, gold, week, sent, settled, problems };
  console.log(JSON.stringify(out, null, 1));
  await browser.close(); app.server.close();
  const ok = label === 'Play with 3 tickets' && capped && /3 tickets/.test(note) && sent.map((s) => s.kind).join() === 'play,claimGold,claim' && sent[0].n === 3
    && settled.length === 1 && gold === '2.5 RON' && week === '12.34 RON' && !problems.length;
  console.log(ok ? 'E2E WALLET OK' : 'E2E WALLET FAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

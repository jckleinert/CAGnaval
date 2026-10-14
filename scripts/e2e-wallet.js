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
      return { tickets: 7 - sent.filter((t) => t.kind === 'play').length + sent.filter((t) => t.kind === 'buy').reduce((a, t) => a + t.n, 0), ron: RON(100), gold: { won: RON(2.5), payableNow: true },
        weekly: { week: 2907, weekId: '2026-10-05', prize: RON(12.34), claimable: RON(12.34), claimed: false }, maxTicketsNow: 3, cap: RON(1), maxTickets: 5, paused: false };
    },
    async txPlay(from, n) { return { to: '0x' + '6'.repeat(40), data: '0xplay' + n }; },
    txClaimGold() { return { to: '0x' + '4'.repeat(40), data: '0xclaimgold' }; },
    txClaim(week) { return { to: '0x' + '4'.repeat(40), data: '0xclaim' + week }; },
    async runFromTx() { return { runId: String(++runN) }; },
    async getRun() { return { player: me, tickets: Number((sent.filter((t) => t.kind === 'play').pop() || { n: 1 }).n), week: 0, settled: false, cap: RON(1) }; },
    settle(id, g) { settled.push([id, g]); }
  };
  const market = {
    enabled: true,
    async meta() { return { name: 'CAG Energy Drink', image: 'https://cdn.example/drink.png' }; },
    async image() { return { type: 'image/png', body: fs.readFileSync(path.join(__dirname, '..', 'web', 'img', 'logo.png')) }; },
    async summary() { return { available: 5, offers: [{ price: RON(5), qty: 2 }, { price: RON(6), qty: 3 }] }; },
    async txBuy(from, n) { return { to: '0x' + '7'.repeat(40), data: '0xbuy' + n, value: '0x1', gas: '0x30d40', total: n === 3 ? RON(16) : RON(5 * n), tickets: n }; }
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cagnaval-e2ew-'));
  const app = createApp({ DATA_DIR: dir, chain: fake, market, REFEREE_KEY: '0x' + '5'.repeat(64), NO_CLOSER: true });
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
    const kind = tx.data.startsWith('0xplay') ? 'play' : tx.data.startsWith('0xbuy') ? 'buy' : tx.data === '0xclaimgold' ? 'claimGold' : 'claim';
    sent.push({ kind, n: kind === 'play' ? Number(tx.data.slice(6)) : kind === 'buy' ? Number(tx.data.slice(5)) : 0, gas: tx.gas });
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
  await page.waitForFunction(() => document.getElementById('play').textContent.includes('Connect'), null, { timeout: 5000 });
  if (shot) await page.screenshot({ path: path.join(shot, 'w1-home.png') });
  await page.click('#play');                                                    // connect + sign in
  await page.waitForFunction(() => document.getElementById('play').textContent === 'Save my name', null, { timeout: 8000 });
  if (shot) await page.screenshot({ path: path.join(shot, 'w1b-name.png') });
  await page.fill('#name', 'Wallet bot');
  await page.click('#play');                                                    // the name now belongs to the wallet
  await page.waitForFunction(() => document.getElementById('play').textContent === 'Play for prizes', null, { timeout: 8000 });
  const welcome = await text('welcome');
  if (shot) await page.screenshot({ path: path.join(shot, 'w2-connected.png') });
  await page.click('#play');                                                    // asks how many tickets
  await page.waitForFunction(() => !document.getElementById('choose').hidden, null, { timeout: 5000 });
  await page.click('#tPlus'); await page.click('#tPlus');
  const capped = await page.evaluate(() => document.getElementById('tPlus').disabled);   // 3 is the most the box allows
  const label = await text('goPlay');
  if (shot) await page.screenshot({ path: path.join(shot, 'w2b-choose.png') });
  await page.click('#goPlay');                                                  // sends 3 tickets, starts the run
  await page.waitForFunction(() => document.getElementById('home').hidden, null, { timeout: 10000 });
  const note = await text('counterNote');
  const box = await page.locator('#game').boundingBox();
  for (let i = 0; i < 6; i++) { await page.mouse.click(box.x + 40 + i * 30, box.y + 30); await page.waitForTimeout(700); }
  // leave the run: the referee closes it and settles it on the chain
  const live = Array.from(app.runs.active.values())[0];
  app.runs._expire(live, 'test');
  await page.reload();
  await page.waitForFunction(() => document.getElementById('play').textContent === 'Play for prizes', null, { timeout: 8000 });
  await page.click('#openPrizes');
  await page.waitForFunction(() => !document.getElementById('prizes').hidden && document.getElementById('goldAmt').textContent !== '0 RON', null, { timeout: 5000 });
  if (shot) await page.screenshot({ path: path.join(shot, 'w3-prizes.png') });
  const gold = await text('goldAmt'), week = await text('weekAmt');
  await page.click('#claimGold');
  await page.waitForFunction(() => document.getElementById('prizeMsg').textContent.startsWith('Sent'), null, { timeout: 5000 });
  await page.click('#claimWeek');
  await page.waitForTimeout(500);

  await page.click('#closePrizes');
  // the shop: 3 tickets, the cheapest first (2 x 5 + 1 x 6 = 16 RON)
  await page.click('#openShop');
  await page.waitForFunction(() => document.getElementById('shopTotal').textContent === '5 RON', null, { timeout: 5000 });
  await page.click('#sPlus'); await page.click('#sPlus');
  const shopTotal = await text('shopTotal'), shopNote = await text('shopStock');
  if (shot) await page.screenshot({ path: path.join(shot, 'w5-shop.png') });
  const tixBefore = Number(await text('walletTix'));
  await page.click('#shopBuy');
  if (shot) { await page.waitForTimeout(250); await page.screenshot({ path: path.join(shot, 'w5b-steps.png') }); }
  await page.waitForFunction(() => !document.getElementById('shopDone').hidden, null, { timeout: 15000 });
  await page.waitForTimeout(900);
  const shopDone = await text('doneTotal'), tixAfter = Number(await text('walletTix'));
  if (shot) await page.screenshot({ path: path.join(shot, 'w6-bought.png') });
  await page.click('#doneHome');
  const homeBack = await page.evaluate(() => !document.getElementById('home').hidden && document.getElementById('shop').hidden);
  await page.click('#openBoard');
  await page.waitForTimeout(800);
  if (shot) await page.screenshot({ path: path.join(shot, 'w4-rank.png') });
  const out = { welcome, label, capped, note, gold, week, shopTotal, shopNote, shopDone, homeBack, tixBefore, tixAfter, sent, settled, problems };
  console.log(JSON.stringify(out, null, 1));
  await browser.close(); app.server.close();
  const ok = welcome === 'Welcome, Wallet bot!' && label === 'Play with 3 tickets' && capped && /3 tickets/.test(note) && sent.map((s) => s.kind).join() === 'play,claimGold,claim,buy' && sent[0].n === 3 && sent[3].n === 3 && sent[3].gas === '0x30d40'
    && shopTotal === '16 RON' && /5 on sale/.test(shopNote) && tixAfter === tixBefore + 3 && shopDone === 'You have ' + tixAfter + ' tickets' && homeBack
    && settled.length === 1 && gold === '2.5 RON' && week === '12.34 RON' && !problems.length;
  console.log(ok ? 'E2E WALLET OK' : 'E2E WALLET FAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

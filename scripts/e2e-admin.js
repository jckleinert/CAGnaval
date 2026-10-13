/*
 * Browser check of the admin panel with a pretend wallet and a pretend chain.
 *   PLAYWRIGHT_PATH=... node scripts/e2e-admin.js   (E2E_SHOTS=<dir> for screenshots)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ethers } = require('ethers');
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright')); } catch (e) { console.error('Playwright is not available: ' + e.message); process.exit(2); }
const { createApp } = require('../server/index.js');
const { Chain } = require('../server/chain.js');

(async () => {
  const owner = ethers.Wallet.createRandom(), stranger = ethers.Wallet.createRandom();
  const RON = (n) => ethers.parseEther(String(n)).toString();
  const W = Math.floor((Date.now() / 1000 - 4 * 86400) / (7 * 86400));
  const endOf = (n) => (4 * 86400 + (n + 1) * 7 * 86400) * 1000;
  const sent = [], closes = [];
  const real = new Chain({ GAME_CONTRACT: '0x' + '4'.repeat(40), REFEREE_KEY: '0x' + '5'.repeat(64), DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cagnaval-c-')), CHAIN_RPC: 'http://127.0.0.1:1', CHAIN_ID: 2020 });
  const week = (n, extra) => Object.assign({ week: n, weekId: new Date((4 * 86400 + n * 7 * 86400) * 1000).toISOString().slice(0, 10), endsAt: endOf(n),
    weekPool: '0', weekAssigned: '0', weekClaimed: '0', weekRolled: '0', postedAt: '0', leftover: '0' }, extra || {});
  const fake = {
    enabled: true, jobs: [], referee: '0x' + '2'.repeat(40),
    async info() { return { contract: '0x' + '4'.repeat(40), chainId: 2020, ticket: '0x' + '6'.repeat(40), ticketId: '1', cap: RON(1), maxTickets: 5, week: W, paused: false, poolBps: 7250 }; },
    async owner() { return owner.address.toLowerCase(); },
    async adminRead() {
      return { week: W, contract: '0x' + '4'.repeat(40), owner: owner.address, referee: '0x' + '2'.repeat(40), treasury: owner.address, ticket: '0x' + '6'.repeat(40), ticketId: '1',
        paused: false, capPerTicket: RON(1), maxTickets: '5', poolBps: '7250', bonusBps: '2000', feeBps: '250', fundGrace: '259200', claimDelay: '3600', claimWeeks: '1',
        bonusBox: RON(10), bonusFree: RON(9), goldPending: RON(1), openRuns: '0', runCount: '12', ticketsHeld: '9', refereeBalance: RON('4.98'),
        weeks: [week(W, { weekPool: RON(3) }), week(W - 1), week(W - 2, { postedAt: '1', weekPool: RON(5), weekAssigned: RON(5) })], pendingTx: [] };
    },
    txAdmin: real.txAdmin.bind(real),
    async closeWeeks(store, w) { closes.push(w); return { posted: true, week: w }; },
    async wallet_() { return {}; }
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cagnaval-e2ea-'));
  const app = createApp({ DATA_DIR: dir, chain: fake, REFEREE_KEY: '0x' + '5'.repeat(64), NO_CLOSER: true });
  // some paid play last week and this week
  const lastId = new Date((4 * 86400 + (W - 1) * 7 * 86400) * 1000).toISOString().slice(0, 10);
  const nowId = app.store.weekId(Date.now());
  app.store.addScore(lastId, 'k1', 'Ana', 9000, 1, '0x' + 'a'.repeat(40)); app.store.addScore(lastId, 'k2', 'Beto', 3000, 2, '0x' + 'b'.repeat(40));
  app.store.addTickets(lastId, 8); app.store.addTickets(nowId, 3);
  app.store.addScore(nowId, 'k1', 'Ana', 4000, 3, '0x' + 'a'.repeat(40));
  await new Promise((r) => app.server.listen(0, r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const browser = await chromium.launch();
  const problems = [];
  const open = async (wallet) => {
    const page = await (await browser.newContext({ viewport: { width: 1100, height: 1400 } })).newPage();
    page.on('pageerror', (e) => problems.push('page error: ' + e.message));
    page.on('dialog', (d) => d.accept());
    await page.route('**/fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.exposeFunction('__sign', async (hex) => wallet.signMessage(ethers.getBytes(hex)));
    await page.exposeFunction('__send', async (tx) => { sent.push(tx); return '0x' + String(sent.length).padStart(64, 'a'); });
    await page.addInitScript((addr) => {
      window.ronin = { provider: { request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts') return [addr];
        if (method === 'eth_chainId') return '0x7e4';
        if (method === 'personal_sign') return window.__sign(params[0]);
        if (method === 'eth_sendTransaction') return window.__send(params[0]);
        throw new Error('unsupported ' + method);
      } } };
    }, wallet.address);
    await page.goto(base + '/admin');
    await page.click('#connect');
    return page;
  };
  const shot = process.env.E2E_SHOTS;

  const outsider = await open(stranger);
  await outsider.waitForFunction(() => document.getElementById('gateMsg').textContent.includes('no es la dueña'), null, { timeout: 8000 });

  const page = await open(owner);
  await page.waitForFunction(() => !document.getElementById('panel').hidden, null, { timeout: 8000 });
  await page.waitForTimeout(300);
  if (shot) await page.screenshot({ path: path.join(shot, 'admin.png'), fullPage: true });
  const lastStatus = await page.textContent('#lastStatus');
  const suggest = await page.textContent('#lastSuggest');
  const lastRows = await page.$$eval('#lastRows tr', (r) => r.map((x) => x.textContent));
  await page.fill('#lastAmt', '39'); await page.click('#lastDeposit'); await page.waitForTimeout(300);
  await page.fill('#tixAmt', '9'); await page.click('#tixTake'); await page.waitForTimeout(300);
  await page.fill('#boxAmt', '2'); await page.click('#boxFund'); await page.waitForTimeout(300);
  await page.click('#lastClose'); await page.waitForTimeout(300);
  await browser.close(); app.server.close();

  const iface = new ethers.Interface(require('../server/chain.js').GAME_ABI);
  const decoded = sent.map((t) => { const d = iface.parseTransaction({ data: t.data, value: t.value || 0 }); return d.name + '(' + d.args.map(String).join(',') + ')' + (t.value ? ' value ' + ethers.formatEther(BigInt(t.value)) : ''); });
  const out = { lastStatus, suggest, lastRows, decoded, closes, problems };
  console.log(JSON.stringify(out, null, 1));
  const ok = /Esperando que cargues el pozo/.test(lastStatus) && suggest === '39 RON' && lastRows.length === 2
    && decoded[0] === 'deposit(' + (W - 1) + ') value 39.0' && decoded[1] === 'withdrawTickets(9,' + owner.address + ')' && decoded[2] === 'fundBonus() value 2.0'
    && closes[0] === W - 1 && !problems.length;
  console.log(ok ? 'E2E ADMIN OK' : 'E2E ADMIN FAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

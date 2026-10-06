/*
 * End-to-end check: starts the server, opens the page in a real browser and
 * plays a whole run by clicking, then checks that the referee verified it.
 * Needs Playwright (not installed by this project):  node scripts/e2e.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright')); } catch (e) { console.error('Playwright is not available: ' + e.message); process.exit(2); }
const { createApp } = require('../server/index.js');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cagnaval-e2e-'));
  const app = createApp({ DATA_DIR: dir, GOLD_ODDS: 1, GOLD_FROM: 5, GOLD_TO: 12 });
  await new Promise((r) => app.server.listen(0, r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 400, height: 760 }, deviceScaleFactor: 2 })).newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push('page error: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  await page.route('**/fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  const replies = [];
  page.on('response', async (res) => { if (res.url().includes('/api/runs/') && res.url().endsWith('/drop')) { try { replies.push(await res.json()); } catch (e) { /* ignore */ } } });

  await page.goto(base + '/');
  await page.fill('#name', 'E2E bot');
  await page.click('#play');
  await page.waitForFunction(() => document.getElementById('home').hidden, null, { timeout: 10000 });
  const box = await page.locator('#game').boundingBox();
  const shot = process.env.E2E_SHOTS;
  let drops = 0, usedPowers = false;
  const started = Date.now();
  while (Date.now() - started < 6 * 60 * 1000) {
    if (await page.evaluate(() => !document.getElementById('over').hidden)) break;
    const x = box.x + 20 + Math.random() * (box.width - 40);
    await page.mouse.move(x, box.y + 30); await page.mouse.down(); await page.mouse.up();
    drops++;
    await page.waitForTimeout(600 + Math.random() * 300);
    if (drops === 25 && !usedPowers) { usedPowers = true; await page.click('#pwSwap'); await page.waitForTimeout(200); await page.click('#pwShake'); await page.waitForTimeout(400); await page.click('#pwSweep'); }
    if (drops === 30 && shot) await page.screenshot({ path: path.join(shot, 'e2e-mid.png') });
  }
  await page.waitForFunction(() => !document.getElementById('over').hidden && document.getElementById('overCheck').textContent.length > 0, null, { timeout: 20000 });
  await page.waitForTimeout(800);
  const out = await page.evaluate(() => ({
    title: document.getElementById('overTitle').textContent, kcal: document.getElementById('overKcal').textContent,
    used: document.getElementById('overUsed').textContent, bonus: document.getElementById('overBonus').textContent,
    check: document.getElementById('overCheck').textContent, week: document.getElementById('overWeek').textContent
  }));
  if (shot) await page.screenshot({ path: path.join(shot, 'e2e-over.png') });
  await page.click('#openBoard2');
  await page.waitForFunction(() => document.querySelectorAll('#rank li').length > 0, null, { timeout: 5000 });
  const rank = await page.$$eval('#rank li', (els) => els.map((e) => e.textContent));
  if (shot) await page.screenshot({ path: path.join(shot, 'e2e-rank.png') });
  const stored = fs.readdirSync(path.join(dir, 'runs')).flatMap((w) => fs.readdirSync(path.join(dir, 'runs', w)).map((f) => JSON.parse(fs.readFileSync(path.join(dir, 'runs', w, f), 'utf8'))));
  const rec = stored[0];
  console.log(JSON.stringify({ clicks: drops, screen: out, rank, outOfSyncReplies: replies.filter((r) => r.sync === false).length,
    referee: rec && { status: rec.result.status, verified: rec.result.verified, kcal: rec.result.kcal, dropped: rec.result.dropped, moves: rec.events.length, mismatchAt: rec.result.mismatchAt, gold: rec.result.gold },
    problems }, null, 1));
  await browser.close();
  await new Promise((r) => app.server.close(r));
  const ok = rec && rec.result.verified && rec.result.status === 'finished' && problems.length === 0 && /Checked by the referee/.test(out.check);
  console.log(ok ? 'E2E OK' : 'E2E FAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

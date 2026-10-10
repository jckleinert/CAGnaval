// Local checks for CAGnaval.sol on a simulated chain (ganache). Run: npm run check
'use strict';
const fs = require('fs');
const path = require('path');
const solc = require('solc');
const ganache = require('ganache');
const { ethers } = require('ethers');
const assert = require('assert');

function compile() {
  const input = {
    language: 'Solidity',
    sources: {
      'CAGnaval.sol': { content: fs.readFileSync(path.join(__dirname, 'CAGnaval.sol'), 'utf8') },
      'MockTicket.sol': { content: fs.readFileSync(path.join(__dirname, 'test/MockTicket.sol'), 'utf8') },
    },
    settings: {
      evmVersion: 'paris',
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter(e => e.severity === 'error');
  for (const e of out.errors || []) console.log(e.formattedMessage);
  if (errs.length) process.exit(1);
  const pick = (f, c) => ({ abi: out.contracts[f][c].abi, bytecode: '0x' + out.contracts[f][c].evm.bytecode.object });
  return { game: pick('CAGnaval.sol', 'CAGnaval'), mock: pick('MockTicket.sol', 'MockTicket'), rej: pick('MockTicket.sol', 'RejectingPlayer') };
}

const RON = n => ethers.parseEther(String(n));
let passed = 0;
async function ok(name, fn) { await fn(); passed++; console.log('  ✓', name); }
async function fails(p, msg) {
  try { const tx = await p; if (tx && tx.wait) await tx.wait(); }
  catch (e) {
    const t = String(e.shortMessage || e.reason || e.message) + ' ' + String(e.data||'') + ' ' + (e.info ? JSON.stringify(e.info).slice(0,400) : '');
    if (msg && !t.includes(msg)) throw new Error(`expected "${msg}", got: ${t}`);
    return;
  }
  throw new Error('expected failure: ' + msg);
}

(async () => {
  const art = compile();
  fs.mkdirSync(path.join(__dirname, 'build'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'build/CAGnaval.abi.json'), JSON.stringify(art.game.abi, null, 1));

  const g = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 6, defaultBalance: 100000 },
                               chain: { hardfork: 'merge' } });
  const provider = new ethers.BrowserProvider(g, undefined, { cacheTimeout: -1 });
  const [owner, referee, p1, p2, p3, stranger] = await Promise.all([0,1,2,3,4,5].map(i => provider.getSigner(i)));
  const A = s => s.address;
  const bal = a => provider.getBalance(a);
  const travel = async s => { await g.request({ method: 'evm_increaseTime', params: [s] }); await g.request({ method: 'evm_mine', params: [] }); };

  const mock = await (await new ethers.ContractFactory(art.mock.abi, art.mock.bytecode, owner).deploy()).waitForDeployment();
  const ID = 7;
  const game = await (await new ethers.ContractFactory(art.game.abi, art.game.bytecode, owner)
    .deploy(await mock.getAddress(), ID, A(referee))).waitForDeployment();
  const G = await game.getAddress();
  for (const p of [p1, p2, p3]) await (await mock.mint(A(p), ID, 20)).wait();
  await (await mock.mint(A(p1), 99, 5)).wait();
  const play = (p, n, id = ID) => mock.connect(p).safeTransferFrom(A(p), G, id, n, '0x');

  console.log('Runs and golden onigiri');
  const runIdOf = rc => rc.logs.map(l => { try { return game.interface.parseLog(l); } catch { return null; } }).find(e => e && e.name === 'RunStarted').args.runId;
  await ok('no run while the bonus box is empty', () => fails(play(p1, 1), 'bonus box too low'));
  await ok('box funded', async () => { await (await game.fundBonus({ value: RON(300) })).wait(); assert.equal(await game.bonusBox(), RON(300)); });
  await ok('2 tickets start run 0; the tickets stay in the contract', async () => {
    const rc = await (await play(p1, 2)).wait();
    const ev = rc.logs.map(l => { try { return game.interface.parseLog(l); } catch { return null; } }).find(Boolean);
    assert.equal(ev.name, 'RunStarted'); assert.equal(ev.args.runId, 0n); assert.equal(ev.args.player, A(p1)); assert.equal(ev.args.tickets, 2n);
    assert.equal(await mock.balanceOf(G, ID), 2n);
    assert.equal(await mock.balanceOf(A(p1), ID), 18n);
  });
  await ok('many players at once: nothing is held back per run', async () => {
    await (await play(p2, 2)).wait(); await (await play(p3, 2)).wait();
    assert.equal(await game.openRuns(), 3n);
  });
  await ok('more tickets than the box covers at 21x is refused (3 x 105 > 300)', () => fails(play(p2, 3), 'bonus box too low'));
  await ok('wrong item refused', () => fails(play(p1, 1, 99), 'wrong item'));
  await ok('6 tickets refused', async () => { await (await game.fundBonus({ value: RON(1000) })).wait(); await fails(play(p2, 6), '1 to maxTickets'); });
  await ok('0 tickets refused', () => fails(play(p2, 0), '1 to maxTickets'));
  await ok('batch transfer refused', () => fails(mock.connect(p2).safeBatchTransferFrom(A(p2), G, [ID], [1], '0x'), 'one item'));
  await ok('a fake ticket contract cannot start runs', () => fails(game.connect(p2).onERC1155Received(A(p2), A(p2), ID, 1, '0x'), 'not our ticket'));
  await ok('plain RON sent to the contract is refused', () => fails(p2.sendTransaction({ to: G, value: RON(1) }), 'use deposit'));
  await ok('only the referee settles', () => fails(game.connect(p1).settleRun(0, RON(105)), 'not referee'));
  await ok('golden prize above 21x per ticket refused', () => fails(game.connect(referee).settleRun(0, RON(211)), 'over the cap'));
  await ok('settle pays the golden prize on the spot', async () => {
    const b0 = await bal(A(p1));
    await (await game.connect(referee).settleRun(0, RON(50))).wait();
    assert.equal(await bal(A(p1)) - b0, RON(50));
    assert.equal(await game.bonusBox(), RON(1250));
    assert.equal((await game.getRun(0)).gold, RON(50));
  });
  await ok('a run pays only once', () => fails(game.connect(referee).settleRun(0, RON(1)), 'already settled'));
  await ok('box runs dry: pays what it has, the rest becomes an IOU', async () => {
    await (await game.connect(referee).settleRun(1, RON(210))).wait();
    await (await game.withdrawBonus(RON(900), A(owner))).wait();
    assert.equal(await game.bonusBox(), RON(140));
    const b0 = await bal(A(p3));
    await (await game.connect(referee).settleRun(2, RON(210))).wait();
    assert.equal(await bal(A(p3)) - b0, RON(140));
    assert.equal(await game.debt(), RON(70));
    assert.equal(await game.iouCount(), 1n);
    assert.equal((await game.getIou(0)).player, A(p3));
  });
  await ok('with IOUs waiting: no new runs and the owner cannot take box RON', async () => {
    await fails(play(p1, 1), 'bonus box too low');
    await fails(game.withdrawBonus(0, A(owner)), 'pay the IOUs first');
  });
  await ok('next RON into the box pays the IOU first', async () => {
    const b0 = await bal(A(p3));
    await (await game.fundBonus({ value: RON(100) })).wait();
    assert.equal(await bal(A(p3)) - b0, RON(70));
    assert.equal(await game.debt(), 0n); assert.equal(await game.iouCount(), 0n);
    assert.equal(await game.bonusBox(), RON(30));
  });
  await ok('IOUs are paid in order, partly if needed', async () => {
    await (await game.fundBonus({ value: RON(180) })).wait();           // box 210
    const ra = runIdOf(await (await play(p1, 1)).wait());
    const rb = runIdOf(await (await play(p2, 1)).wait());
    const rc = runIdOf(await (await play(p3, 1)).wait());
    const rd = runIdOf(await (await play(p1, 1)).wait());
    await (await game.connect(referee).settleRun(ra, RON(105))).wait();
    await (await game.connect(referee).settleRun(rb, RON(105))).wait(); // box 0
    await (await game.connect(referee).settleRun(rc, RON(105))).wait(); // IOU p3 105
    await (await game.connect(referee).settleRun(rd, RON(105))).wait(); // IOU p1 105
    assert.equal(await game.debt(), RON(210)); assert.equal(await game.iouCount(), 2n);
    const p3a = await bal(A(p3)), p1a = await bal(A(p1));
    await (await game.connect(p2).fundBonus({ value: RON(150) })).wait();
    assert.equal(await bal(A(p3)) - p3a, RON(105));
    assert.equal(await bal(A(p1)) - p1a, RON(45));
    assert.equal(await game.debt(), RON(60)); assert.equal(await game.iouCount(), 1n);
    await (await game.connect(p2).fundBonus({ value: RON(100) })).wait();
    assert.equal(await bal(A(p1)) - p1a, RON(105));
    assert.equal(await game.debt(), 0n); assert.equal(await game.bonusBox(), RON(40));
  });
  await ok('settle with no gold pays nothing', async () => {
    await (await game.fundBonus({ value: RON(300) })).wait();
    const r = runIdOf(await (await play(p2, 2)).wait());
    const b0 = await bal(A(p2));
    await (await game.connect(referee).settleRun(r, 0)).wait();
    assert.equal(await bal(A(p2)), b0);
  });
  await ok('a wallet that refuses RON keeps the prize as owed, run still closes', async () => {
    const rej = await (await new ethers.ContractFactory(art.rej.abi, art.rej.bytecode, owner).deploy()).waitForDeployment();
    const R = await rej.getAddress();
    await (await mock.mint(R, ID, 1)).wait();
    await (await rej.play(await mock.getAddress(), G, ID, 1)).wait();
    const id = (await game.runCount()) - 1n;
    await (await game.connect(referee).settleRun(id, RON(10))).wait();
    assert.equal(await game.owed(R), RON(10));
    assert.equal((await game.getRun(id)).settled, true);
  });
  await ok('cap can change with runs open; each run keeps the cap it started with', async () => {
    const r = runIdOf(await (await play(p3, 1)).wait());
    await (await game.setConfig(5, RON(50), 3600, 1)).wait();
    await fails(game.connect(referee).settleRun(r, RON(106)), 'over the cap');
    await (await game.connect(referee).settleRun(r, RON(105))).wait();
    await (await game.setConfig(5, RON(105), 3600, 1)).wait();
  });
  await ok('owner can cancel a stuck run only after a day', async () => {
    await (await game.fundBonus({ value: RON(105) })).wait();
    const id = runIdOf(await (await play(p1, 1)).wait());
    await fails(game.cancelRun(id), 'give the referee a day');
    await travel(86400);
    await (await game.cancelRun(id)).wait();
    assert.equal(await game.openRuns(), 0n);
  });
  await ok('owner withdraws played tickets to sell again', async () => {
    const held = await game.ticketsHeld();
    assert.equal(held, await mock.balanceOf(G, ID));
    await fails(game.connect(p1).withdrawTickets(held, A(p1)), 'not owner');
    await (await game.withdrawTickets(held, A(owner))).wait();
    assert.equal(await mock.balanceOf(A(owner), ID), held);
  });
  await ok('owner withdraws free bonus RON; strangers cannot', async () => {
    await fails(game.connect(stranger).withdrawBonus(RON(1), A(stranger)), 'not owner');
    const box = await game.bonusBox();
    await fails(game.withdrawBonus(box + 1n, A(owner)), 'more than the box');
    await (await game.withdrawBonus(box - RON(105), A(owner))).wait();
    assert.equal(await game.bonusBox(), RON(105));
  });
  await ok('switch to another ticket collection (test drinks -> CAGnaval tickets)', async () => {
    const r = runIdOf(await (await play(p1, 1)).wait());
    await fails(game.setTicket(await mock.getAddress(), 99), 'wait for open runs');
    await (await game.connect(referee).settleRun(r, 0)).wait();
    await (await game.setTicket(await mock.getAddress(), 99)).wait();
    await fails(play(p1, 1), 'wrong item');
    const r2 = runIdOf(await (await play(p1, 1, 99)).wait());
    await (await game.connect(referee).settleRun(r2, 0)).wait();
    await (await game.setTicket(await mock.getAddress(), ID)).wait();
    await (await game.withdrawItems(await mock.getAddress(), 99, 1, A(owner))).wait();
    assert.equal(await mock.balanceOf(A(owner), 99), 1n);
  });
  await ok('paused game refuses runs', async () => {
    await (await game.setPaused(true)).wait();
    await fails(play(p1, 1), 'paused');
    await (await game.setPaused(false)).wait();
  });

  console.log('Sales split');
  const far = (await game.currentWeek()) + 50n;
  await ok('deposit splits 70 / 23 / 7 by default', async () => {
    await (await game.setSplit(7000, 2300, A(stranger))).wait();
    const box0 = await game.bonusBox(), t0 = await bal(A(stranger));
    await (await game.connect(p1).deposit(far, { value: RON(1000) })).wait();
    assert.equal(await game.weekPool(far), RON(700));
    assert.equal(await game.bonusBox() - box0, RON(230));
    assert.equal(await bal(A(stranger)) - t0, RON(70));
  });
  await ok('percentages are adjustable, never over 100%', async () => {
    await fails(game.setSplit(8000, 2001, A(stranger)), 'over 100%');
    await fails(game.connect(p1).setSplit(5000, 4000, A(p1)), 'not owner');
    await (await game.setSplit(5000, 4000, A(stranger))).wait();
    const box0 = await game.bonusBox(), t0 = await bal(A(stranger));
    await (await game.deposit(far, { value: RON(100) })).wait();
    assert.equal(await game.weekPool(far), RON(750));
    assert.equal(await game.bonusBox() - box0, RON(40));
    assert.equal(await bal(A(stranger)) - t0, RON(10));
  });
  await ok('deposit to a closed week refused', () => fails(game.deposit(0, { value: RON(1) }), 'week already closed'));

  console.log('Weekly pool');
  const w = await game.currentWeek();
  const now = Number((await provider.getBlock('latest')).timestamp);
  await ok('week number matches Monday 00:00 UTC', async () => {
    const start = Number(await game.weekStartsAt(w));
    assert.equal(new Date(start * 1000).getUTCDay(), 1);
    assert.equal(new Date(start * 1000).getUTCHours(), 0);
    assert.ok(start <= now && now < start + 7 * 86400);
  });
  await ok('pool funded for this week', async () => { await (await game.fundPool(w, { value: RON(100) })).wait(); assert.equal(await game.weekPool(w), RON(100)); });
  await ok('results refused before the week ends', () => fails(game.connect(referee).postResults(w, [A(p1)], [RON(1)]), 'week not over'));
  await ok('a closed week cannot be funded', async () => {
    await travel(Number(await game.weekEndsAt(w)) - now + 5);
    await fails(game.fundPool(w, { value: RON(1) }), 'week already closed');
  });
  await ok('only the referee posts results', () => fails(game.connect(p1).postResults(w, [A(p1)], [RON(100)]), 'not referee'));
  await ok('results posted in two parts', async () => {
    await (await game.connect(referee).postResults(w, [A(p1)], [RON(60)])).wait();
    await (await game.connect(referee).postResults(w, [A(p2)], [RON(30)], { gasLimit: 300000 })).wait(); // fixed gas: ganache can under-estimate when two postings land in the same second
    assert.equal(await game.weekAssigned(w), RON(90));
  });
  await ok('results cannot exceed the pool', () => fails(game.connect(referee).postResults(w, [A(p3)], [RON(11)]), 'more than the pool'));
  await ok('claims wait the safety hour', async () => {
    assert.equal(await game.claimable(A(p1), w), 0n);
    await fails(game.connect(p1).claim(w), 'nothing to claim');
    await travel(3601);
    assert.equal(await game.claimable(A(p1), w), RON(60));
  });
  await ok('player claims once', async () => {
    const b0 = await bal(A(p1));
    const rc = await (await game.connect(p1).claim(w)).wait();
    const gas = rc.gasUsed * rc.gasPrice;
    assert.equal(await bal(A(p1)) - b0 + gas, RON(60));
    await fails(game.connect(p1).claim(w), 'nothing to claim');
  });
  await ok('owner voids a wrong prize', async () => {
    await fails(game.voidResult(w, A(p1)), 'already claimed');
    await (await game.voidResult(w, A(p2))).wait();
    assert.equal(await game.claimable(A(p2), w), 0n);
    assert.equal(await game.weekAssigned(w), RON(60));
  });
  await ok('unassigned part rolls to the current week', async () => {
    await fails(game.connect(stranger).rollover(w, w + 1n), 'not allowed');
    await fails(game.rollover(w, w), 'target week closed');
    await (await game.connect(referee).rollover(w, w + 1n)).wait();
    assert.equal(await game.weekPool(w + 1n), RON(40));
    await fails(game.rollover(w, w + 1n), 'nothing to move');
    await fails(game.connect(referee).postResults(w, [A(p3)], [RON(1)]), 'more than the pool');
  });
  await ok('claims close after the following week', async () => {
    await (await game.connect(referee).postResults(w, [A(p3)], [RON(0)])).wait();
    const ends = Number(await game.claimEndsAt(w));
    const t = Number((await provider.getBlock('latest')).timestamp);
    await travel(ends - t + 5);
    await fails(game.connect(referee).postResults(w, [A(p3)], [RON(1)]), 'claim time over');
  });
  await ok('unclaimed prizes roll over after the deadline', async () => {
    // week w+1 is now closed with nobody posted; a week with results nobody claimed:
    const w2 = await game.currentWeek();
    await (await game.fundPool(w2, { value: RON(10) })).wait();
    await travel(7 * 86400);
    await (await game.connect(referee).postResults(w2, [A(p3)], [RON(10)])).wait();
    await travel(7 * 86400 + 10);
    assert.equal(await game.claimable(A(p3), w2), 0n);
    assert.equal(await game.leftover(w2), RON(10));
    const w3 = await game.currentWeek();
    await (await game.rollover(w2, w3)).wait();
    assert.equal(await game.weekPool(w3), RON(10));
  });
  await ok('a week nobody posted rolls over after its deadline', async () => {
    assert.equal(await game.leftover(w + 1n), RON(40));
    const w3 = await game.currentWeek();
    await (await game.rollover(w + 1n, w3)).wait();
    assert.equal(await game.weekPool(w3), RON(50));
  });
  await ok('contract RON adds up', async () => {
    const box = await game.bonusBox();
    // pools still held: w3 (50) ; everything else paid or moved
    assert.equal(await bal(G), box + RON(50) + RON(750) + RON(10)); // pools still held + the owed prize
  });

  console.log('Owner');
  await ok('ownership moves and the old owner loses control', async () => {
    await (await game.transferOwnership(A(p3))).wait();
    await fails(game.setPaused(true), 'not owner');
    await (await game.connect(p3).setReferee(A(p2))).wait();
    assert.equal(await game.referee(), A(p2));
  });

  console.log(`\nCONTRACT OK (${passed} checks)`);
  process.exit(0);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });

// Local checks for the CAGnaval Ticket collection (the one-file version that gets deployed),
// together with the game contract. Run: npm run check-ticket
'use strict';
const fs = require('fs');
const path = require('path');
const solc = require('solc');
const ganache = require('ganache');
const { ethers } = require('ethers');
const assert = require('assert');

require('./flatten.js');
const input = {
  language: 'Solidity',
  sources: {
    'CAGnavalTicket.flat.sol': { content: fs.readFileSync(path.join(__dirname, 'build/CAGnavalTicket.flat.sol'), 'utf8') },
    'CAGnaval.sol': { content: fs.readFileSync(path.join(__dirname, 'CAGnaval.sol'), 'utf8') },
  },
  settings: { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = (out.errors || []).filter((e) => e.severity === 'error');
for (const e of errs) console.log(e.formattedMessage);
if (errs.length) process.exit(1);
const pick = (f, c) => ({ abi: out.contracts[f][c].abi, bytecode: '0x' + out.contracts[f][c].evm.bytecode.object });
const T = pick('CAGnavalTicket.flat.sol', 'CAGnavalTicket'), G = pick('CAGnaval.sol', 'CAGnaval');
fs.writeFileSync(path.join(__dirname, 'build/CAGnavalTicket.abi.json'), JSON.stringify(T.abi, null, 1));

let passed = 0;
async function ok(name, fn) { await fn(); passed++; console.log('  ✓', name); }
async function fails(p, msg) {
  try { const tx = await p; if (tx && tx.wait) await tx.wait(); } catch (e) {
    const t = String(e.shortMessage || e.reason || e.message) + ' ' + String(e.data || '') + ' ' + (e.info ? JSON.stringify(e.info).slice(0, 400) : '');
    if (msg && !t.includes(msg)) throw new Error(`expected "${msg}", got: ${t}`);
    return;
  }
  throw new Error('expected failure: ' + msg);
}
const iface = new ethers.Interface(T.abi);
const err = (name) => iface.getError(name).selector;

(async () => {
  const g = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 5, defaultBalance: 100000 }, chain: { hardfork: 'merge' } });
  const provider = new ethers.BrowserProvider(g, undefined, { cacheTimeout: -1 });
  const [owner, referee, p1, p2, cold] = await Promise.all([0, 1, 2, 3, 4].map((i) => provider.getSigner(i)));
  const A = (s) => s.address;
  const BASE = 'https://cagnaval.example/nft/';
  const t = await (await new ethers.ContractFactory(T.abi, T.bytecode, owner).deploy(BASE)).waitForDeployment();

  console.log('Collection');
  await ok('name, symbol and owner', async () => {
    assert.equal(await t.name(), 'CAGnaval Ticket');
    assert.equal(await t.symbol(), 'CAGT');
    assert.equal(await t.owner(), A(owner));
    assert.equal(await t.TICKET(), 1n);
  });
  await ok('texts and picture addresses', async () => {
    assert.equal(await t.uri(1), BASE + '1.json');
    assert.equal(await t.contractURI(), BASE + 'collection.json');
    assert.equal(await t.supportsInterface('0xd9b67a26'), true);   // ERC-1155
    assert.equal(await t.supportsInterface('0x0e89341c'), true);   // ERC-1155 metadata
  });
  await ok('only the owner creates tickets', async () => {
    await fails(t.connect(p1).mint(A(p1), 1, 5), err('OwnableUnauthorizedAccount'));
    await (await t.mint(A(owner), 1, 1000)).wait();
    assert.equal(await t.balanceOf(A(owner), 1), 1000n);
    assert.equal(await t['totalSupply(uint256)'](1), 1000n);
  });
  await ok('tickets move like any ERC-1155; nobody takes someone else\'s', async () => {
    await (await t.safeTransferFrom(A(owner), A(p1), 1, 30, '0x')).wait();
    assert.equal(await t.balanceOf(A(p1), 1), 30n);
    await fails(t.connect(p2).safeTransferFrom(A(p1), A(p2), 1, 1, '0x'), err('ERC1155MissingApprovalForAll'));
    await fails(t.connect(p1).safeTransferFrom(A(p1), A(p2), 1, 31, '0x'), err('ERC1155InsufficientBalance'));
  });
  await ok('only the owner moves the texts and pictures', async () => {
    await fails(t.connect(p1).setBaseURI('https://x/'), err('OwnableUnauthorizedAccount'));
    await (await t.setBaseURI('https://cagnaval.com/nft/')).wait();
    assert.equal(await t.uri(1), 'https://cagnaval.com/nft/1.json');
  });
  await ok('ownership goes to the cold wallet', async () => {
    await (await t.transferOwnership(A(cold))).wait();
    assert.equal(await t.owner(), A(cold));
    await fails(t.mint(A(owner), 1, 1), err('OwnableUnauthorizedAccount'));
    await (await t.connect(cold).mint(A(cold), 1, 10)).wait();
    assert.equal(await t['totalSupply(uint256)'](1), 1010n);
  });

  console.log('With the game');
  const game = await (await new ethers.ContractFactory(G.abi, G.bytecode, owner).deploy(await t.getAddress(), 1, A(referee))).waitForDeployment();
  await (await game.fundBonus({ value: ethers.parseEther('2000') })).wait();
  await ok('a player starts a run by sending tickets to the game', async () => {
    await (await t.connect(p1).safeTransferFrom(A(p1), await game.getAddress(), 1, 3, '0x')).wait();
    assert.equal(await t.balanceOf(await game.getAddress(), 1), 3n);
    assert.equal(await game.openRuns(), 1n);
  });
  await ok('the game refuses other items and mixed batches', async () => {
    await (await t.connect(cold).mint(A(p1), 2, 1)).wait();
    await fails(t.connect(p1).safeTransferFrom(A(p1), await game.getAddress(), 2, 1, '0x'), 'wrong item');
    await fails(t.connect(p1).safeBatchTransferFrom(A(p1), await game.getAddress(), [1, 2], [1, 1], '0x'), 'one item at a time');
    // a "batch" of only the ticket is handled as a normal single send (OpenZeppelin does that): one more run
    await (await t.connect(p1).safeBatchTransferFrom(A(p1), await game.getAddress(), [1], [2], '0x')).wait();
    assert.equal(await game.openRuns(), 2n);
  });
  await ok('the owner takes the played tickets back to sell them again', async () => {
    await (await game.withdrawTickets(5, A(owner))).wait();
    assert.equal(await t.balanceOf(await game.getAddress(), 1), 0n);
  });

  console.log(`\nTICKET OK (${passed} checks)`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });

'use strict';
/* The shop: picks the cheapest listings and builds the purchase with the real Ronin Market library
   (the network is pretend: balances and gas answered here). */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Market } = require('../server/market.js');

const TOKEN = '0xb170845fccd48c7c055235e8435312568ff93f09';
const BUYER = '0x' + 'b'.repeat(40);
const RON = 10n ** 18n;

function order(i, maker, unit, qty) {
  return {
    id: i, hash: '0x' + String(i).padStart(64, '0'), maker, kind: 'Sell', expiredAt: String(Math.floor(Date.now() / 1000) + 86400),
    paymentToken: '0xe514d9deb7966c8be0ca922de8a064264ea6bcd4', startedAt: '1', basePrice: String(unit), currentPrice: String(unit),
    expectedState: '0', nonce: 0, marketFeePercentage: 250, signature: '0x' + '11'.repeat(65),
    assets: [{ erc: 'Erc1155', address: TOKEN, id: '1', quantity: String(qty) }],
    orderQuantity: { orderId: i, quantity: String(qty), remainingQuantity: String(qty), availableQuantity: String(qty) }
  };
}

function realLib(list, balance) {
  const sdk = require('@sky-mavis/mavis-market-core');
  const dir = path.dirname(require.resolve('@sky-mavis/mavis-market-core'));
  const e5 = require(require.resolve('ethers', { paths: [dir] }));
  const P = e5.providers.JsonRpcProvider.prototype;
  if (!P.__fake) {
    P.__fake = true;
    P.send = async function (method) {
      if (method === 'eth_chainId') return '0x7e4';
      if (method === 'net_version') return '2020';
      if (method === 'eth_getBalance') return '0x' + P.__balance.toString(16);
      if (method === 'eth_estimateGas') return '0x30d40';
      throw new Error('unexpected ' + method);
    };
  }
  P.__balance = balance;
  return { sdk: Object.assign(Object.create(sdk), { getErc1155Orders: async () => list }), e5 };
}

const cfg = { CHAIN_ID: 2020, CHAIN_RPC: 'http://127.0.0.1:1' };

test('summary groups the listings by price, cheapest first', async () => {
  const m = new Market(cfg, realLib([order(2, '0x' + '2'.repeat(40), 6n * RON, 3), order(1, '0x' + '1'.repeat(40), 5n * RON, 2), order(3, '0x' + '3'.repeat(40), 5n * RON, 1)], 0n));
  const s = await m.summary(TOKEN, 1);
  assert.deepStrictEqual(s, { available: 6, offers: [{ price: String(5n * RON), qty: 3 }, { price: String(6n * RON), qty: 3 }] });
});

test('a purchase takes the cheapest listings, skips the buyer\'s own, pays in RON', async () => {
  const list = [order(1, BUYER, 4n * RON, 5), order(2, '0x' + '2'.repeat(40), 5n * RON, 2), order(3, '0x' + '3'.repeat(40), 6n * RON, 9)];
  const m = new Market(cfg, realLib(list, 100n * RON));
  const tx = await m.txBuy(BUYER, 3, TOKEN, 1);
  const sdk = require('@sky-mavis/mavis-market-core');
  assert.strictEqual(tx.to.toLowerCase(), sdk.getConfig(2020).contractsAddress.marketGatewayMultisend.toLowerCase());
  assert.strictEqual(tx.total, String(2n * 5n * RON + 6n * RON));
  assert.strictEqual(BigInt(tx.value), 16n * RON);
  assert.ok(/^0x[0-9a-f]+$/.test(tx.gas) && BigInt(tx.gas) === 300000n);   // estimate x1.5
  assert.ok(tx.data.length > 1000);
});

test('not enough on sale, or not enough RON', async () => {
  const list = [order(1, '0x' + '1'.repeat(40), 5n * RON, 2)];
  await assert.rejects(new Market(cfg, realLib(list, 100n * RON)).txBuy(BUYER, 3, TOKEN, 1), (e) => e.message === 'not-enough-listed' && e.available === 2);
  await assert.rejects(new Market(cfg, realLib(list, 1n * RON)).txBuy(BUYER, 2, TOKEN, 1), /not-enough-ron/);
});

'use strict';
/*
 * Buying tickets from inside the game, through Ronin Market.
 *
 * The tickets on sale are the listings on Ronin Market (the owner's and any player's). The
 * server reads them with Sky Mavis' own Ronin Market library and builds the purchase
 * transaction; the player's wallet sends it, so the sale happens on Ronin Market as usual
 * (same fees, same volume). The server never holds anyone's RON.
 *
 * Settings (Railway variables, all optional):
 *   MARKET=off              hide the shop
 *   MARKET_API_KEY          Sky Mavis Developer Console key, if the market data asks for one
 *   MARKET_GRAPHQL          another address for the market data
 */
const path = require('path');

const CAPTURED = 'cagnaval:captured';

class Market {
  constructor(cfg, lib) {
    this.cfg = cfg;
    this.enabled = cfg.MARKET !== 'off';
    this.lib = lib || null;           // tests pass a pretend library
    this.cache = new Map();
  }

  _load() {
    if (this.lib) return this.lib;
    const sdk = require('@sky-mavis/mavis-market-core');
    const dir = path.dirname(require.resolve('@sky-mavis/mavis-market-core'));
    const e5 = require(require.resolve('ethers', { paths: [dir] }));
    // The library always asks the same address and sends no key; both can be changed here.
    const key = this.cfg.MARKET_API_KEY, url = this.cfg.MARKET_GRAPHQL;
    if (key || url) {
      const gq = require(require.resolve('graphql-request', { paths: [dir] }));
      const orig = gq.request;
      gq.request = (endpoint, query, variables, headers) =>
        orig(url || endpoint, query, variables, Object.assign({}, headers || {}, key ? { 'X-API-KEY': key } : {}));
    }
    this.lib = { sdk, e5 };
    return this.lib;
  }

  /* Listings of the ticket on sale, cheapest first. Read again every 15 seconds at most. */
  async orders(token, id) {
    const k = String(token).toLowerCase() + ':' + id;
    const hit = this.cache.get(k);
    if (hit && Date.now() - hit.at < 15000) return hit.v;
    const { sdk } = this._load();
    const list = await sdk.getErc1155Orders({
      chainId: this.cfg.CHAIN_ID, tokenAddress: String(token).toLowerCase(), tokenId: String(id),
      from: 0, size: 50, showInvalid: false, sort: sdk.Erc1155SortBy.PriceAsc
    });
    const now = Date.now() / 1000;
    const v = (list || []).filter((o) => o && Number((o.orderQuantity || {}).availableQuantity || 0) > 0 && !(Number(o.expiredAt) && Number(o.expiredAt) < now))
      .sort((a, b) => (BigInt(a.currentPrice) < BigInt(b.currentPrice) ? -1 : BigInt(a.currentPrice) > BigInt(b.currentPrice) ? 1 : 0));
    this.cache.set(k, { at: Date.now(), v });
    return v;
  }

  /* What the page shows: how many are on sale and at what price, grouped by price. */
  async summary(token, id) {
    const list = await this.orders(token, id);
    const byPrice = new Map();
    let available = 0;
    for (const o of list) {
      const q = Number(o.orderQuantity.availableQuantity);
      available += q;
      byPrice.set(o.currentPrice, (byPrice.get(o.currentPrice) || 0) + q);
    }
    return { available, offers: [...byPrice].slice(0, 20).map(([price, qty]) => ({ price: String(price), qty })) };
  }

  /* Picks the cheapest listings for n tickets (never the buyer's own). */
  pick(list, n, buyer) {
    const out = [];
    let got = 0;
    for (const o of list) {
      if (String(o.maker).toLowerCase() === buyer) continue;
      const q = Math.min(Number(o.orderQuantity.availableQuantity), n - got);
      if (q <= 0) continue;
      out.push({ order: o, quantity: q });
      got += q;
      if (got >= n) break;
    }
    return got >= n ? out : null;
  }

  /* The purchase transaction for the buyer's wallet, paid in RON. */
  async txBuy(from, n, token, id) {
    const { sdk, e5 } = this._load();
    this.cache.clear();                                      // fresh listings for a purchase
    const list = await this.orders(token, id);
    const chosen = this.pick(list, n, from);
    if (!chosen) {
      const err = new Error('not-enough-listed');
      err.available = list.filter((o) => String(o.maker).toLowerCase() !== from).reduce((a, o) => a + Number(o.orderQuantity.availableQuantity), 0);
      throw err;
    }
    // The library sends the transaction itself; this stand-in wallet keeps it instead of sending,
    // and the player's own wallet sends it.
    const provider = e5.providers.StaticJsonRpcProvider
      ? new e5.providers.StaticJsonRpcProvider({ url: this.cfg.CHAIN_RPC, timeout: 15000 }, this.cfg.CHAIN_ID)
      : null;
    let captured = null;
    class Keeper extends e5.VoidSigner {
      async sendTransaction(tx) { captured = await e5.utils.resolveProperties(tx); throw new Error(CAPTURED); }
    }
    const signer = new Keeper(e5.utils.getAddress(from), provider);
    const ron = sdk.paymentTokens[this.cfg.CHAIN_ID][sdk.Token.RON].address;
    try {
      await sdk.bulkBuyToken({
        chainId: this.cfg.CHAIN_ID, wallet: { account: from, provider: signer }, data: chosen,
        selectedTokenAddress: ron, deadline: String(Math.floor(Date.now() / 1000) + 30 * 60),
        tokenType: sdk.Erc.Erc1155, requiredAllSuccess: true
      });
    } catch (e) {
      if (!captured) {
        const m = String(e && e.message);
        console.error('market buy could not be prepared:', m.slice(0, 300));
        throw new Error(/insufficient/i.test(m) ? 'not-enough-ron' : 'buy-failed');
      }
    }
    if (!captured) throw new Error('buy-failed');
    const hex = (v) => (v == null ? undefined : '0x' + BigInt(v.toString()).toString(16));
    return { to: captured.to, data: captured.data, value: hex(captured.value || 0), gas: hex(captured.gasLimit),
      total: BigInt((captured.value || 0).toString()).toString(), tickets: n };
  }
}

module.exports = { Market, CAPTURED };

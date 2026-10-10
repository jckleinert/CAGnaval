'use strict';
/*
 * Sign-in with the wallet: the page asks the wallet to sign a short message
 * with a one-time code; the server checks the signature and hands back a
 * session token (valid 7 days) tied to that wallet address. No password, no
 * transaction, no gas.
 */
const crypto = require('crypto');
const { ethers } = require('ethers');

const TOKEN_DAYS = 7;

class Auth {
  constructor(secret) {
    this.secret = secret || crypto.randomBytes(32).toString('hex');
    this.nonces = new Map(); // address -> { code, exp }
  }

  message(address, code) {
    return 'Sign in to CAGnaval\n\nThis only proves the wallet is yours. It costs nothing and sends nothing.\n\nWallet: ' + address + '\nCode: ' + code;
  }

  nonce(address) {
    if (!ethers.isAddress(address)) return null;
    const a = address.toLowerCase();
    const code = crypto.randomBytes(8).toString('hex');
    this.nonces.set(a, { code, exp: Date.now() + 10 * 60000 });
    if (this.nonces.size > 5000) { const t = Date.now(); for (const [k, v] of this.nonces) if (v.exp < t) this.nonces.delete(k); }
    return this.message(a, code);
  }

  login(address, signature) {
    if (!ethers.isAddress(address) || typeof signature !== 'string') return null;
    const a = address.toLowerCase();
    const n = this.nonces.get(a);
    if (!n || n.exp < Date.now()) return null;
    let who;
    try { who = ethers.verifyMessage(this.message(a, n.code), signature).toLowerCase(); } catch (e) { return null; }
    if (who !== a) return null;
    this.nonces.delete(a);
    const exp = Date.now() + TOKEN_DAYS * 86400000;
    const body = a + '.' + exp;
    return { token: body + '.' + this._mac(body), address: a, exp };
  }

  /* Returns the wallet address of a valid token, or null. */
  check(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3 || !/^0x[0-9a-f]{40}$/.test(parts[0])) return null;
    const body = parts[0] + '.' + parts[1];
    const mac = this._mac(body);
    if (parts[2].length !== mac.length || !crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(mac))) return null;
    if (Number(parts[1]) < Date.now()) return null;
    return parts[0];
  }

  _mac(body) { return crypto.createHmac('sha256', this.secret).update(body).digest('hex').slice(0, 40); }
}

module.exports = { Auth };

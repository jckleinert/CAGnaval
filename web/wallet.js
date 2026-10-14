/*
 * CAGnaval wallet: connects the Ronin Wallet, signs in (a signature, no gas)
 * and sends the player's own transactions. The page never builds blockchain
 * data itself: the server hands it ready to send, the wallet asks the player
 * to confirm.
 */
(function () {
  'use strict';
  var KEY = 'cagnaval.wallet';
  var W = { enabled: false, cfg: null, address: null, token: null };

  function load() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function store(v) { try { if (v) localStorage.setItem(KEY, JSON.stringify(v)); else localStorage.removeItem(KEY); } catch (e) { /* optional */ } }

  function err(code, msg) { var e = new Error(msg || code); e.code = code; return e; }

  W.provider = function () {
    if (window.ronin && window.ronin.provider) return window.ronin.provider;
    if (window.ethereum) return window.ethereum;
    return null;
  };

  /* Calls to the server, with the session token. */
  W.api = function (method, path, body, timeoutMs) {
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, timeoutMs || 15000);
    var headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (W.token) headers.Authorization = 'Bearer ' + W.token;
    return fetch(path, { method: method, cache: 'no-store', headers: headers, body: body ? JSON.stringify(body) : undefined, signal: ctl ? ctl.signal : undefined })
      .then(function (res) {
        clearTimeout(timer);
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (res.status === 401 && data.error === 'sign-in') W.signOut();
          if (res.status >= 400) { var e = err(data.error || 'http-' + res.status); e.data = data; throw e; }
          return data;
        });
      }, function () { clearTimeout(timer); throw err('network'); });
  };

  /* Asks the server for the contract settings; retried a few times if the Ronin node is busy. */
  W.init = function (tries) {
    tries = tries === undefined ? 4 : tries;
    return W.api('GET', '/api/chain').catch(function (e) {
      if (tries <= 1 || e.code === 'network') throw e;
      return new Promise(function (ok) { setTimeout(ok, 2500); }).then(function () { return W.api('GET', '/api/chain'); });
    }).then(function (c) {
      W.enabled = !!c.enabled; W.cfg = c;
      var s = load();
      if (W.enabled && s && s.token && s.exp > Date.now() + 3600000 && s.contract === c.contract) { W.address = s.address; W.token = s.token; }
      return W;
    }).catch(function () { W.enabled = false; return W; });
  };

  function walletError(e) {
    if (e && (e.code === 4001 || e.code === 'ACTION_REJECTED' || /reject|denied|cancel/i.test(String(e.message)))) return err('rejected', 'Cancelled in the wallet');
    return err('wallet', (e && e.message) || 'Wallet error');
  }

  function toHex(s) {
    var b = new TextEncoder().encode(s), h = '0x';
    for (var i = 0; i < b.length; i++) h += ('0' + b[i].toString(16)).slice(-2);
    return h;
  }

  /* Connect + sign in. Asks the wallet for the account, the Ronin network, and one signature. */
  W.connect = function () {
    var p = W.provider();
    if (!p) return Promise.reject(err('no-wallet', 'Install the Ronin Wallet to play for prizes'));
    var addr;
    return p.request({ method: 'eth_requestAccounts' }).then(function (accs) {
      if (!accs || !accs[0]) throw err('no-account');
      addr = String(accs[0]).toLowerCase();
      return p.request({ method: 'eth_chainId' });
    }).then(function (id) {
      if (parseInt(id, 16) === W.cfg.chainId) return null;
      return p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + W.cfg.chainId.toString(16) }] });
    }).then(function () {
      return W.api('POST', '/api/auth/nonce', { address: addr });
    }).then(function (n) {
      return p.request({ method: 'personal_sign', params: [toHex(n.message), addr] });
    }).then(function (sig) {
      return W.api('POST', '/api/auth', { address: addr, signature: sig });
    }).then(function (s) {
      W.address = s.address; W.token = s.token;
      store({ address: s.address, token: s.token, exp: s.exp, contract: W.cfg.contract });
      return W;
    }).catch(function (e) { throw e.code && typeof e.code === 'string' && e.code !== 'ACTION_REJECTED' ? e : walletError(e); });
  };

  W.signOut = function () { W.address = null; W.token = null; store(null); };

  W.info = function () { return W.api('GET', '/api/wallet'); };

  /* Sends a transaction the server prepared ({ from, to, data }). Resolves with its hash. */
  W.send = function (tx) {
    var p = W.provider();
    if (!p) return Promise.reject(err('no-wallet'));
    return p.request({ method: 'eth_requestAccounts' }).then(function (accs) {
      if (!accs || String(accs[0]).toLowerCase() !== W.address) throw err('other-account', 'Switch the wallet to ' + W.short(W.address));
      var t = { from: tx.from, to: tx.to, data: tx.data };
      if (tx.value) t.value = tx.value;
      if (tx.gas) t.gas = tx.gas;
      return p.request({ method: 'eth_sendTransaction', params: [t] });
    }).catch(function (e) { throw e.code === 'other-account' ? e : walletError(e); });
  };

  W.short = function (a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : ''; };

  /* 1500000000000000000 -> "1.5" */
  W.ron = function (wei) {
    var s = String(wei || '0').replace(/^0+/, '') || '0';
    while (s.length < 19) s = '0' + s;
    var whole = s.slice(0, -18).replace(/^0+(?=\d)/, ''), frac = s.slice(-18).replace(/0+$/, '').slice(0, 3);
    return frac ? whole + '.' + frac : whole;
  };

  window.CAGW = W;
})();

'use strict';
/*
 * The referee's link with the CAGnaval contract on Ronin.
 *
 *  - reads: paid runs, golden prizes, weekly pools and claims
 *  - writes (signed with the referee wallet, one at a time, retried until mined):
 *      settleRun      at the end of every paid run (golden prize or 0)
 *      postResults    after the weekly close, the pool split by calories
 *      rollover       leftovers of a week into the open week
 *  - builds the data of the player's own transactions (play, claim) so the page
 *    needs no blockchain library: it only asks the wallet to send them.
 *
 * Pending writes are kept in DATA_DIR/chain so a restart does not lose them.
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const GAME_ABI = [
  'event RunStarted(uint256 indexed runId, address indexed player, uint256 tickets, uint256 week)',
  'function getRun(uint256) view returns (tuple(address player, uint32 tickets, uint32 week, uint64 startedAt, bool settled, uint128 gold, uint128 cap))',
  'function runCount() view returns (uint256)',
  'function currentWeek() view returns (uint256)',
  'function capPerTicket() view returns (uint256)',
  'function poolBps() view returns (uint256)',
  'function maxTickets() view returns (uint256)',
  'function bonusFree() view returns (uint256)',
  'function ticket() view returns (address)',
  'function ticketId() view returns (uint256)',
  'function paused() view returns (bool)',
  'function goldClaimable(address) view returns (uint256 won, bool payableNow)',
  'function weekPool(uint256) view returns (uint256)',
  'function weekRolled(uint256) view returns (uint256)',
  'function weekExtra(uint256) view returns (uint256)',
  'function weekAssigned(uint256) view returns (uint256)',
  'function postedAt(uint256) view returns (uint256)',
  'function prize(uint256, address) view returns (uint256)',
  'function claimed(uint256, address) view returns (bool)',
  'function claimable(address, uint256) view returns (uint256)',
  'function claimEndsAt(uint256) view returns (uint256)',
  'function leftover(uint256) view returns (uint256)',
  'function settleRun(uint256 runId, uint256 gold)',
  'function postResults(uint256 week, address[] players, uint256[] amounts)',
  'function rollover(uint256 fromWeek, uint256 toWeek)',
  'function claimGold()',
  'function claim(uint256 week)',
  // read by the admin panel
  'function owner() view returns (address)',
  'function referee() view returns (address)',
  'function treasury() view returns (address)',
  'function bonusBps() view returns (uint256)',
  'function feeBps() view returns (uint256)',
  'function fundGrace() view returns (uint256)',
  'function claimDelay() view returns (uint256)',
  'function claimWeeks() view returns (uint256)',
  'function bonusBox() view returns (uint256)',
  'function goldPending() view returns (uint256)',
  'function openRuns() view returns (uint256)',
  'function weekClaimed(uint256) view returns (uint256)',
  'function ticketsHeld() view returns (uint256)',
  // owner actions, sent from the owner's wallet through the admin panel
  'function deposit(uint256 week) payable',
  'function fundBonus() payable',
  'function fundPool(uint256 week) payable',
  'function withdrawTickets(uint256 amount, address to)',
  'function withdrawBonus(uint256 amount, address to)',
  'function setSplit(uint256 poolBps, uint256 bonusBps, uint256 feeBps, address treasury)',
  'function setConfig(uint256 maxTickets, uint256 capPerTicket, uint256 claimDelay, uint256 claimWeeks)',
  'function setPaused(bool p)',
  'function setFundGrace(uint256 fundGrace)',
  'function voidResult(uint256 week, address player)',
  'function cancelRun(uint256 runId)',
  'function recoverPool(uint256 week, address to)',
  'function operator() view returns (address)',
  'function setOperator(address operator)'
];
/* Owner actions the admin panel may prepare, and whether they carry RON. */
const ADMIN_TX = { deposit: true, fundBonus: true, fundPool: true, withdrawTickets: false, withdrawBonus: false, setSplit: false,
  setConfig: false, setPaused: false, setOperator: false, setFundGrace: false, voidResult: false, cancelRun: false, recoverPool: false, rollover: false };
const TICKET_ABI = [
  'function balanceOf(address, uint256) view returns (uint256)',
  'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)'
];

const WEEK_S = 7 * 86400, MONDAY0_S = 4 * 86400;
/* Contract week number <-> the ranking's week id (UTC date of its Monday). */
function weekNumberOf(weekId) { return Math.floor((Date.parse(weekId + 'T00:00:00Z') / 1000 - MONDAY0_S) / WEEK_S); }
function weekIdOf(n) { return new Date((MONDAY0_S + Number(n) * WEEK_S) * 1000).toISOString().slice(0, 10); }

/* Golden prize in wei: multiplier x tickets x ticket value, where the ticket value is the cap / 21. */
function goldPrize(mult, tickets, capWei) {
  const halves = BigInt(Math.round(mult * 2));
  const v = (BigInt(capWei) * BigInt(tickets) * halves) / 42n;
  const max = BigInt(capWei) * BigInt(tickets);
  return v > max ? max : v;
}

/* Weekly pool split by calories. rows: [{ addr, total }]. Floors every share; dust rolls over. */
function splitPool(poolWei, rows) {
  const pool = BigInt(poolWei);
  const list = rows.filter((r) => r.addr && r.total > 0);
  const sum = list.reduce((a, r) => a + BigInt(r.total), 0n);
  if (pool === 0n || sum === 0n) return [];
  return list.map((r) => ({ addr: r.addr, amount: (pool * BigInt(r.total)) / sum })).filter((r) => r.amount > 0n);
}

class Chain {
  constructor(cfg) {
    this.cfg = cfg;
    this.enabled = !!(cfg.GAME_CONTRACT && cfg.REFEREE_KEY);
    this.dir = path.join(cfg.DATA_DIR, 'chain');
    this.jobs = [];       // pending writes
    this.busy = false;
    this.cache = null;
    if (!this.enabled) return;
    fs.mkdirSync(this.dir, { recursive: true });
    // One request at a time and no batches: the public Ronin node refuses bursts ("Too many requests").
    const req = new ethers.FetchRequest(cfg.CHAIN_RPC);
    req.timeout = 15000;                       // a node that hangs must not block the reads behind it
    this.provider = new ethers.JsonRpcProvider(req, cfg.CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 });
    this.wallet = new ethers.Wallet(cfg.REFEREE_KEY, this.provider);
    this.game = new ethers.Contract(cfg.GAME_CONTRACT, GAME_ABI, this.wallet);
    this.iface = new ethers.Interface(GAME_ABI);
    this.ticketIface = new ethers.Interface(TICKET_ABI);
    try { this.jobs = JSON.parse(fs.readFileSync(path.join(this.dir, 'jobs.json'), 'utf8')); } catch (e) { this.jobs = []; }
    if (this.jobs.length) setTimeout(() => this._pump(), 3000);
  }

  get referee() { return this.wallet ? this.wallet.address : null; }

  /* Reads go out one after another and are retried when the node says it is busy. */
  async _read(fn) {
    const prev = this._queue || Promise.resolve();
    let release;
    this._queue = new Promise((r) => { release = r; });
    await prev;
    try {
      for (let i = 0; ; i++) {
        try { return await fn(); } catch (e) {
          const busy = /too many requests|rate limit|429|timeout/i.test(String((e && (e.info && e.info.responseBody)) || '') + ' ' + String(e && e.message));
          if (!busy || i >= 4) throw e;
          await new Promise((r) => setTimeout(r, 800 * Math.pow(2, i)));
        }
      }
    } finally { setTimeout(release, 120); }   // a small gap between requests
  }

  _save() {
    const f = path.join(this.dir, 'jobs.json');
    fs.writeFileSync(f + '.tmp', JSON.stringify(this.jobs));
    fs.renameSync(f + '.tmp', f);
  }

  /* Settings read from the contract, refreshed every minute. */
  async info() {
    if (this.cache && Date.now() - this.cache.at < 120000) return this.cache.v;
    if (this._infoP) return this._infoP;
    const g = this.game, rd = (f) => this._read(f);
    this._infoP = (async () => {
      const ticket = await rd(() => g.ticket()), ticketId = await rd(() => g.ticketId()), cap = await rd(() => g.capPerTicket());
      const maxTickets = await rd(() => g.maxTickets()), paused = await rd(() => g.paused());
      const poolBps = await rd(() => g.poolBps()).catch(() => 7250n);
      const free = await rd(() => g.bonusFree()).catch(() => 0n);
      // the biggest golden prize that can be won right now: x21 with as many tickets as the box allows
      const goldMax = cap === 0n ? 0n : (BigInt(Math.min(Number(maxTickets), Number(free / cap)))) * cap;
      const week = Math.floor((Date.now() / 1000 - MONDAY0_S) / WEEK_S);
      const v = { contract: this.cfg.GAME_CONTRACT, chainId: this.cfg.CHAIN_ID, ticket, ticketId: ticketId.toString(),
        cap: cap.toString(), maxTickets: Number(maxTickets), week, paused, poolBps: Number(poolBps), goldMax: goldMax.toString() };
      this.cache = { at: Date.now(), v };
      return v;
    })().finally(() => { this._infoP = null; });
    return this._infoP;
  }

  /* Finds the RunStarted of a transaction. Waits for it to be mined (up to `waitMs`). */
  async runFromTx(txHash, waitMs) {
    const end = Date.now() + (waitMs || 60000);
    let rc = null;
    while (Date.now() < end) {
      rc = await this._read(() => this.provider.getTransactionReceipt(txHash)).catch((e) => { console.error('receipt read failed:', e.shortMessage || e.message); return null; });
      if (rc) break;
      await new Promise((r) => setTimeout(r, 2500));
    }
    if (!rc) return { error: 'tx-not-found' };
    if (rc.status !== 1) return { error: 'tx-failed' };
    const want = this.cfg.GAME_CONTRACT.toLowerCase();
    for (const log of rc.logs) {
      if (log.address.toLowerCase() !== want) continue;
      let ev; try { ev = this.iface.parseLog(log); } catch (e) { continue; }
      if (ev && ev.name === 'RunStarted') return { runId: ev.args.runId.toString() };
    }
    return { error: 'no-run-in-tx' };
  }

  async getRun(runId) {
    const r = await this._read(() => this.game.getRun(BigInt(runId)));
    return { player: r.player.toLowerCase(), tickets: Number(r.tickets), week: Number(r.week), settled: r.settled, cap: r.cap.toString() };
  }

  /* What a wallet holds and can claim. */
  async wallet_(addr) {
    this._walletCache = this._walletCache || new Map();
    const hit = this._walletCache.get(addr);
    if (hit && Date.now() - hit.at < 8000) return hit.v;
    const info = await this.info();
    const ticket = new ethers.Contract(info.ticket, TICKET_ABI, this.provider);
    const w = info.week, g = this.game, rd = (f) => this._read(f);
    const tickets = await rd(() => ticket.balanceOf(addr, BigInt(info.ticketId)));
    const gold = await rd(() => g.goldClaimable(addr));
    const free = await rd(() => g.bonusFree());
    const lastPrize = await rd(() => g.prize(w - 1, addr));
    const lastClaimable = lastPrize > 0n ? await rd(() => g.claimable(addr, w - 1)) : 0n;
    const lastClaimed = lastPrize > 0n ? await rd(() => g.claimed(w - 1, addr)) : false;
    const ron = await rd(() => this.provider.getBalance(addr)).catch(() => null);
    const v = {
      tickets: Number(tickets), ron: ron === null ? null : ron.toString(),
      gold: { won: gold.won.toString(), payableNow: gold.payableNow },
      weekly: { week: w - 1, weekId: weekIdOf(w - 1), prize: lastPrize.toString(), claimable: lastClaimable.toString(), claimed: lastClaimed },
      maxTicketsNow: info.cap === '0' ? 0 : Math.min(info.maxTickets, Number(BigInt(free.toString()) / BigInt(info.cap))),
      cap: info.cap, maxTickets: info.maxTickets, paused: info.paused
    };
    this._walletCache.set(addr, { at: Date.now(), v });
    if (this._walletCache.size > 2000) this._walletCache.clear();
    return v;
  }
  /* Does this wallet hold an NFT of the holders' collection (Shake, Swap and Sweep)? Kept 5 minutes. */
  async isHolder(addr) {
    const nft = this.cfg.HOLDER_NFT;
    if (!nft) return true;
    this._holders = this._holders || new Map();
    const hit = this._holders.get(addr);
    if (hit && Date.now() - hit.at < 300000) return hit.v;
    const c = new ethers.Contract(nft, ['function balanceOf(address) view returns (uint256)'], this.provider);
    let v = false;
    try { v = (await this._read(() => c.balanceOf(addr))) > 0n; } catch (e) { console.error('holder check failed:', e.shortMessage || e.message); if (hit) return hit.v; }
    this._holders.set(addr, { at: Date.now(), v });
    if (this._holders.size > 5000) this._holders.clear();
    return v;
  }
  forget(addr) { if (this._walletCache) this._walletCache.delete(addr); }

  /* Data of the player's own transactions. */
  async txPlay(from, n) {
    const info = await this.info();
    return { to: info.ticket, data: this.ticketIface.encodeFunctionData('safeTransferFrom', [from, this.cfg.GAME_CONTRACT, BigInt(info.ticketId), BigInt(n), '0x']) };
  }
  txClaimGold() { return { to: this.cfg.GAME_CONTRACT, data: this.iface.encodeFunctionData('claimGold', []) }; }
  txClaim(week) { return { to: this.cfg.GAME_CONTRACT, data: this.iface.encodeFunctionData('claim', [BigInt(week)]) }; }

  /* ------------------------------------------------------------ writes */
  settle(runId, goldWei) { this._add({ kind: 'settle', runId: String(runId), gold: String(goldWei) }); }
  post(week, players, amounts) { this._add({ kind: 'post', week: Number(week), players, amounts: amounts.map(String) }); }
  roll(from, to) { this._add({ kind: 'roll', from: Number(from), to: Number(to) }); }

  _add(job) {
    job.tries = 0; job.addedAt = Date.now();
    this.jobs.push(job);
    this._save();
    this._pump();
  }

  async _pump() {
    if (this.busy || !this.jobs.length) return;
    this.busy = true;
    const job = this.jobs[0];
    try {
      let tx;
      if (job.kind === 'settle') tx = await this.game.settleRun(BigInt(job.runId), BigInt(job.gold), { gasLimit: 200000 });
      else if (job.kind === 'post') tx = await this.game.postResults(job.week, job.players, job.amounts.map(BigInt), { gasLimit: 120000 + 60000 * job.players.length });
      else if (job.kind === 'roll') tx = await this.game.rollover(job.from, job.to, { gasLimit: 150000 });
      const rc = await tx.wait(1, 120000);
      if (!rc || rc.status !== 1) throw new Error('reverted');
      console.log('chain:', job.kind, job.runId || job.week || job.from, 'ok', tx.hash);
      this.jobs.shift();
    } catch (e) {
      const msg = String((e && (e.shortMessage || e.reason || e.message)) || e);
      // Reverts that will never succeed are dropped (already settled, nothing to move...).
      const final = /already settled|nothing to move|week not over|claim time over|more than the pool|post results first/.test(msg);
      job.tries++;
      console.error('chain:', job.kind, 'failed (' + job.tries + '):', msg.slice(0, 200));
      if (final || job.tries >= 8) { console.error('chain: giving up on', JSON.stringify(job)); this.jobs.shift(); }
      else { this.jobs.push(this.jobs.shift()); await new Promise((r) => setTimeout(r, Math.min(60000, 5000 * job.tries))); }
    }
    this._save();
    this.busy = false;
    if (this.jobs.length) setImmediate(() => this._pump());
  }

  /* ------------------------------------------------------------ weekly close */
  /*
   * Called on a timer. After a week ends: posts the pool split by the Total
   * ranking (calories x tickets of paid runs), then moves leftovers (rounding,
   * a week nobody played, prizes nobody claimed in time) to the open week.
   */
  /* Seconds after the close that the owner has to load the pool (24 h; older contracts: none). */
  async grace() {
    if (this._grace !== undefined && Date.now() - this._graceAt < 600000) return this._grace;
    this._grace = Number(await this._read(() => this.game.fundGrace()).catch(() => 0n));
    this._graceAt = Date.now();
    return this._grace;
  }

  /*
   * force: a week number the owner asked to settle now (from the admin panel) instead of
   * waiting for the end of the grace period.
   */
  async closeWeeks(store, force) {
    const rd = (f) => this._read(f);
    const now = Math.floor((Date.now() / 1000 - MONDAY0_S) / WEEK_S);
    const doneFile = path.join(this.dir, 'weeks-' + this.cfg.GAME_CONTRACT.toLowerCase().slice(2, 10) + '.json');   // one record per contract
    let done = {};
    try { done = JSON.parse(fs.readFileSync(doneFile, 'utf8')); } catch (e) { done = {}; }
    const w = now - 1;
    const graceOver = Date.now() / 1000 >= MONDAY0_S + (w + 1) * WEEK_S + (await this.grace());
    if (!done[w] && !graceOver && force !== w) return { waiting: true, week: w };   // the owner may still load the pool
    if (!done[w] && Number(await rd(() => this.game.postedAt(w))) === 0 && !this.jobs.some((j) => j.kind === 'post' && j.week === w)) {
      const pool = (await rd(() => this.game.weekPool(w))) - (await rd(() => this.game.weekRolled(w)));
      const rows = store.leaderboard(weekIdOf(w), 'total').map((r) => ({ addr: r.addr, total: r.total }));
      const shares = splitPool(pool, rows);
      if (!shares.length) this.post(w, [], []);
      for (let i = 0; i < shares.length; i += 60) {
        const part = shares.slice(i, i + 60);
        this.post(w, part.map((s) => ethers.getAddress(s.addr)), part.map((s) => s.amount.toString()));
      }
      done[w] = { postedAt: Date.now(), winners: shares.length, pool: pool.toString() };
      fs.writeFileSync(doneFile, JSON.stringify(done));
      return { posted: true, week: w, winners: shares.length, pool: pool.toString() };
    }
    // Unclaimed prizes wait for the owner (take back or move on, from the admin panel),
    // unless AUTO_ROLLOVER is on: then the referee moves them to the open week.
    if (!this.cfg.AUTO_ROLLOVER) return { done: true, week: w };
    if (this.jobs.length) return; // let postings land before moving leftovers
    for (const from of [w, w - 1]) {
      if (from < 0) continue;
      const left = await rd(() => this.game.leftover(from)).catch(() => 0n);
      if (left > 0n && !this.jobs.some((j) => j.kind === 'roll' && j.from === from)) this.roll(from, now);
    }
    return { done: true, week: w };
  }

  /* ------------------------------------------------------------ admin panel */
  /* The day-to-day wallet the owner named (null if none, or if the contract has no operator yet). */
  async operator() {
    if (this._opAt && Date.now() - this._opAt < 60000) return this._op;
    const v = await this._read(() => this.game.operator()).catch(() => null);
    this._op = v && v !== ethers.ZeroAddress ? String(v).toLowerCase() : null;
    this._opAt = Date.now();
    return this._op;
  }

  async owner() {
    if (this._owner && Date.now() - this._ownerAt < 60000) return this._owner;
    this._owner = String(await this._read(() => this.game.owner())).toLowerCase();
    this._ownerAt = Date.now();
    return this._owner;
  }

  /* Everything the owner needs to see, read one value at a time. */
  /* Everything the admin panel shows. The public Ronin node takes one request at a time, so the
     settings and the older weeks (which rarely change) are kept for 5 minutes, or until the owner
     sends a transaction from the panel; only the live numbers are read every time. */
  async adminRead() {
    if (this._adminBusy) return this._adminBusy;          // two tabs asking at once share one reading
    this._adminBusy = this._adminRead().finally(() => { this._adminBusy = null; });
    return this._adminBusy;
  }
  async _adminRead() {
    const g = this.game, rd = (f) => this._read(f).catch(() => null);
    const s = (v) => (v === null || v === undefined ? null : v.toString());
    const w = Math.floor((Date.now() / 1000 - MONDAY0_S) / WEEK_S);
    const out = { week: w, contract: this.cfg.GAME_CONTRACT };
    const slow = this._adminSlow && Date.now() > (this._adminFreshUntil || 0) && this._adminSlow.week === w && Date.now() - this._adminSlow.at < 300000 ? this._adminSlow : null;
    const LIVE = ['paused', 'bonusBox', 'bonusFree', 'goldPending', 'openRuns', 'runCount', 'ticketsHeld'];
    const SET = ['owner', 'operator', 'referee', 'treasury', 'ticket', 'ticketId', 'capPerTicket', 'maxTickets', 'poolBps', 'bonusBps', 'feeBps', 'fundGrace', 'claimDelay', 'claimWeeks'];
    for (const k of slow ? LIVE : LIVE.concat(SET)) {
      const v = await rd(() => g[k]());
      out[k] = typeof v === 'boolean' || typeof v === 'string' ? v : s(v);
    }
    if (slow) Object.assign(out, slow.set);
    out.refereeBalance = s(await rd(() => this.provider.getBalance(this.wallet.address)));
    out.weeks = [];
    const claimWeeks = Number(out.claimWeeks || 1);
    const keep = { week: w, at: slow ? slow.at : Date.now(), set: {}, weeks: {} };
    for (const k of SET) keep.set[k] = out[k];
    for (const n of [w, w - 1, w - 2, w - 3, w - 4, w - 5]) {
      const row = { week: n, weekId: weekIdOf(n), endsAt: (MONDAY0_S + (n + 1) * WEEK_S) * 1000,
        claimEndsAt: (MONDAY0_S + (n + 1 + claimWeeks) * WEEK_S) * 1000 };
      const old = n <= w - 2 && slow && slow.weeks[n];
      if (old) Object.assign(row, old);
      else for (const k of ['weekPool', 'weekAssigned', 'weekClaimed', 'weekRolled', 'postedAt', 'leftover']) row[k] = s(await rd(() => g[k](n)));
      keep.weeks[n] = {};
      for (const k of ['weekPool', 'weekAssigned', 'weekClaimed', 'weekRolled', 'postedAt', 'leftover']) keep.weeks[n][k] = row[k];
      out.weeks.push(row);
    }
    this._adminSlow = keep;
    out.pendingTx = this.jobs.map((j) => ({ kind: j.kind, runId: j.runId, week: j.week, tries: j.tries }));
    return out;
  }

  /* RON in the contract for a week: from ticket sales (deposit) and extra (added by the owner or
     rolled over from earlier weeks). Read again every minute at most. Contracts older than the
     extra counter answer extra = 0, so everything loaded counts as sales. */
  async weekFunds(n) {
    this._funds = this._funds || new Map();
    const hit = this._funds.get(n);
    if (hit && Date.now() - hit.at < 60000 && Date.now() > (this._adminFreshUntil || 0)) return hit.v;
    const rd = (f) => this._read(f).catch(() => null);
    const pool = await rd(() => this.game.weekPool(n)), rolled = await rd(() => this.game.weekRolled(n));
    if (pool === null) return hit ? hit.v : { sales: 0n, extra: 0n };
    let extra = this.noExtra ? null : await this._read(() => this.game.weekExtra(n)).catch((e) => {
      if (/revert|CALL_EXCEPTION|could not decode/i.test(String(e && (e.code || '') + ' ' + e.message))) this.noExtra = true;
      return null;
    });
    extra = extra === null ? 0n : BigInt(extra);
    const total = BigInt(pool) - BigInt(rolled || 0n);
    const v = { sales: total > extra ? total - extra : 0n, extra: total > extra ? extra : (total > 0n ? total : 0n) };
    this._funds.set(n, { at: Date.now(), v });
    return v;
  }

  /* Data of an owner transaction. value: RON as text ("12.5"), only for the ones that carry RON. */
  txAdmin(fn, args, value) {
    if (!Object.prototype.hasOwnProperty.call(ADMIN_TX, fn)) throw new Error('not allowed');
    this._adminFreshUntil = Date.now() + 120000;
    if (fn === 'setOperator') this._opAt = 0;            // the owner is changing something: read it all again for the next 2 minutes
    const data = this.iface.encodeFunctionData(fn, args || []);
    const tx = { to: this.cfg.GAME_CONTRACT, data };
    if (ADMIN_TX[fn]) tx.value = '0x' + ethers.parseEther(String(value || '0')).toString(16);
    return tx;
  }
}

module.exports = { Chain, goldPrize, splitPool, weekNumberOf, weekIdOf, GAME_ABI };

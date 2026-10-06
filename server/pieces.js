'use strict';
/*
 * Everything random about a run is derived from one secret created when the
 * run starts: the order of the foods, whether a golden food appears, where,
 * and its prize multiplier. The page only receives a fingerprint of the
 * secret at the start (commit) and the secret itself at the end, so anyone
 * can check afterwards that nothing was changed during the run.
 */
const crypto = require('crypto');
const Sim = require('../shared/sim.js');

/* Prize table of the golden food: [multiplier of the ticket, chance in %]. Average 1.8. */
const BONUS = [[0.5, 20], [1, 43], [2, 20], [3, 10], [5, 3.5], [8, 2], [13, 1], [21, 0.5]];

function newSecret() { return crypto.randomBytes(32).toString('hex'); }
function commitOf(secret) { return crypto.createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex'); }
function u32(secret, label) {
  return crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(label).digest().readUInt32BE(0);
}
function unit(secret, label) { return u32(secret, label) / 4294967296; }

function multiplierFor(roll) { // roll in [0, 100)
  let acc = 0;
  for (const [mult, pct] of BONUS) { acc += pct; if (roll < acc) return mult; }
  return 1;
}

/* Returns null (no golden food this run) or { at, lv, mult }. */
function goldPlan(secret, cfg) {
  if (unit(secret, 'gold:roll') >= cfg.GOLD_ODDS) return null;
  const span = cfg.GOLD_TO - cfg.GOLD_FROM + 1;
  return {
    at: cfg.GOLD_FROM + (u32(secret, 'gold:at') % span),
    lv: 1 + (u32(secret, 'gold:lv') % 3),             // cookie, onigiri or donut
    mult: multiplierFor(unit(secret, 'gold:mult') * 100)
  };
}

/* The k-th food of the run (1-based). */
function pieceAt(secret, gold, k) {
  if (k < 1 || k > Sim.RULES.MAX_FOODS) return null;
  if (gold && gold.at === k) return { lv: gold.lv, gold: true };
  return { lv: u32(secret, 'piece:' + k) % Sim.RULES.SPAWN_LEVELS, gold: false };
}

module.exports = { BONUS, newSecret, commitOf, goldPlan, pieceAt, multiplierFor, u32 };

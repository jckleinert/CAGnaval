'use strict';
/* All settings come from environment variables, with safe defaults for local use. */
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

module.exports = {
  PORT: num(process.env.PORT, 3000),
  DATA_DIR: process.env.DATA_DIR || require('path').join(__dirname, '..', 'data'),
  // Chance that a run contains a golden food (design: 1 in 8).
  GOLD_ODDS: num(process.env.GOLD_ODDS, 0.125),
  // The golden food appears between these two foods of the run.
  GOLD_FROM: num(process.env.GOLD_FROM, 5),
  GOLD_TO: num(process.env.GOLD_TO, 120),
  // Real time allowed between two moves: 15 s of game clock plus slack for slow devices and network.
  TURN_WALL_MS: num(process.env.TURN_WALL_MS, 25000),
  // How far the game clock of a move may be ahead of real time.
  AHEAD_SLACK_MS: num(process.env.AHEAD_SLACK_MS, 2000),
  // How far the game clock may fall behind real time before the run is closed (pauses, lost connection).
  MAX_LAG_MS: num(process.env.MAX_LAG_MS, 10000),
  // Limits on runs in progress: in total and per visitor address.
  MAX_ACTIVE_RUNS: num(process.env.MAX_ACTIVE_RUNS, 300),
  MAX_ACTIVE_PER_IP: num(process.env.MAX_ACTIVE_PER_IP, 6),
  // Week boundary in UTC: day of week (0 = Sunday .. 6 = Saturday) and hour.
  WEEK_START_DOW: num(process.env.WEEK_START_DOW, 1),
  WEEK_START_HOUR: num(process.env.WEEK_START_HOUR, 0),
  // Set to the site origin (e.g. https://www.caglorie.com) if the page is hosted elsewhere.
  ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || '',
  // Set to 1 behind one proxy (Railway) so the visitor address is taken from the entry that proxy adds to X-Forwarded-For.
  TRUST_PROXY: process.env.TRUST_PROXY === '1',
  RATE_LIMIT_PER_MIN: num(process.env.RATE_LIMIT_PER_MIN, 600)
};

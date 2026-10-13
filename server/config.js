'use strict';
/* All settings come from environment variables, with safe defaults for local use. */
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

module.exports = {
  PORT: num(process.env.PORT, 3000),
  DATA_DIR: process.env.DATA_DIR || require('path').join(__dirname, '..', 'data'),
  // Chance that a run contains a golden food (design: 1 in 10, so the golden box pays at most
  // 18% of the ticket price on average: 0.1 x average multiplier 1.8 x ticket).
  GOLD_ODDS: num(process.env.GOLD_ODDS, 0.1),
  // The golden food appears between these two foods of the run.
  GOLD_FROM: num(process.env.GOLD_FROM, 60),   // from food 60: a run has to last a while to get it
  GOLD_TO: num(process.env.GOLD_TO, 150),
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
  RATE_LIMIT_PER_MIN: num(process.env.RATE_LIMIT_PER_MIN, 600),
  // Blockchain (Ronin). Without GAME_CONTRACT and REFEREE_KEY the game runs in practice mode only.
  GAME_CONTRACT: process.env.GAME_CONTRACT || '',
  REFEREE_KEY: process.env.REFEREE_KEY || '',   // private key of the referee wallet: only as a Railway variable, never in the code
  CHAIN_RPC: process.env.CHAIN_RPC || 'https://api.roninchain.com/rpc',
  CHAIN_ID: num(process.env.CHAIN_ID, 2020),
  // Price of one ticket in RON: the base of the weekly prize estimate shown to players.
  TICKET_PRICE: process.env.TICKET_PRICE || '5',
  // 1 = the referee moves unclaimed prizes to the open week by itself. Off: the owner decides in the admin panel.
  AUTO_ROLLOVER: process.env.AUTO_ROLLOVER === '1',
  // How often the weekly close is checked (ms).
  CLOSE_EVERY_MS: num(process.env.CLOSE_EVERY_MS, 10 * 60000)
};

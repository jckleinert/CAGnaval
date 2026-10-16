'use strict';
/* The texts of the CAGnaval Ticket NFT, read by wallets and Ronin Market. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { createApp } = require('../server/index.js');

async function get(app, url, host) {
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const r = await fetch(base + url, { headers: host ? { 'X-Forwarded-Host': host } : {} });
  return { status: r.status, type: r.headers.get('content-type'), body: r.status === 200 && /json/.test(r.headers.get('content-type')) ? await r.json() : null };
}

test('ticket and collection texts point to this site, the picture is served', async () => {
  const app = createApp({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'nft-')) });
  await new Promise((r) => app.server.listen(0, r));
  try {
    const one = await get(app, '/nft/1.json', 'cagnaval.example');
    assert.strictEqual(one.status, 200);
    assert.strictEqual(one.body.name, 'CAGnaval Ticket');
    assert.strictEqual(one.body.image, 'https://cagnaval.example/nft/ticket.png');
    assert.ok(!/pool|drop|merge|week/i.test(one.body.description));
    const col = await get(app, '/nft/collection.json', 'cagnaval.example');
    assert.strictEqual(col.body.external_link, 'https://cagnaval.example/');
    assert.strictEqual((await get(app, '/nft/2.json')).status, 404);
    const png = await get(app, '/nft/ticket.png');
    assert.strictEqual(png.status, 200); assert.strictEqual(png.type, 'image/png');
  } finally { app.server.close(); }
});

test('PUBLIC_URL wins over the address the site was opened with', async () => {
  const app = createApp({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'nft-')), PUBLIC_URL: 'https://cagnaval.com/' });
  await new Promise((r) => app.server.listen(0, r));
  try {
    assert.strictEqual((await get(app, '/nft/1.json', 'other.example')).body.image, 'https://cagnaval.com/nft/ticket.png');
  } finally { app.server.close(); }
});

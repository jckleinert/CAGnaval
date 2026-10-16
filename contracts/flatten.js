// Makes build/CAGnavalTicket.flat.sol: the ticket and the OpenZeppelin parts it uses in one file,
// to paste into Remix and to verify on the Ronin explorer. Run: node flatten.js
'use strict';
const fs = require('fs'), path = require('path');
const seen = new Set(), parts = [];
function add(file) {
  file = path.resolve(file);
  if (seen.has(file)) return;
  seen.add(file);
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/^import\s+(?:\{[^}]*\}\s+from\s+)?"([^"]+)";/gm)) {
    const dep = m[1].startsWith('.') ? path.join(path.dirname(file), m[1]) : require.resolve(m[1], { paths: [__dirname] });
    add(dep);
  }
  const body = src.replace(/^\/\/ SPDX-License-Identifier:.*\n/m, '').replace(/^pragma solidity [^;]+;\n/gm, '')
    .replace(/^import\s+[^;]+;\n/gm, '').trim();
  parts.push('// ---- ' + path.relative(__dirname, file).replace(/^node_modules\//, '') + '\n\n' + body);
}
add(path.join(__dirname, 'CAGnavalTicket.sol'));
const out = '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.24;\n\n// CAGnaval Ticket, in one file (includes OpenZeppelin Contracts 5.0.2, MIT).\n\n' + parts.join('\n\n') + '\n';
fs.mkdirSync(path.join(__dirname, 'build'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'build/CAGnavalTicket.flat.sol'), out);
console.log('build/CAGnavalTicket.flat.sol', out.split('\n').length, 'lines,', parts.length, 'files');

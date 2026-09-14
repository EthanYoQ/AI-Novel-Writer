// Print context around matches in a minified bundle
const fs = require('fs');
const file = process.argv[2];
const needle = process.argv[3];
const before = Number(process.argv[4] || 700);
const after = Number(process.argv[5] || 900);
const max = Number(process.argv[6] || 3);
const s = fs.readFileSync(file, 'utf8');
let i = s.indexOf(needle), n = 0;
if (i < 0) { console.log('NOT FOUND'); process.exit(0); }
while (i >= 0 && n < max) {
  console.log('===== @' + i + ' =====');
  console.log(s.slice(Math.max(0, i - before), i + after).replace(/\n/g, ' '));
  console.log('');
  i = s.indexOf(needle, i + 1); n++;
}

// Minimal asar reader: list / extract / grep without external deps
const fs = require('fs');
const path = require('path');

const ASAR = process.env.ASAR_PATH || (process.argv[2] || './app.asar');
const MODE = process.argv[3] || 'list';

function readHeader(fd) {
  // Locate the JSON header by scanning for '{"files"' and brace-balance it.
  const probe = Buffer.alloc(4 * 1024 * 1024);
  const n = fs.readSync(fd, probe, 0, probe.length, 0);
  const needle = Buffer.from('{"files"', 'utf8');
  const start = probe.indexOf(needle, 0, 'utf8');
  if (start < 0) throw new Error('header not found');
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < n; i++) {
    const c = probe[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === 0x5c) esc = true;
      else if (c === 0x22) inStr = false;
      continue;
    }
    if (c === 0x22) inStr = true;
    else if (c === 0x7b) depth++;
    else if (c === 0x7d) { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error('header truncated');
  const json = probe.toString('utf8', start, end);
  return { header: JSON.parse(json), dataOffset: end };
}

function walk(node, prefix, out) {
  const files = node.files || {};
  for (const name of Object.keys(files)) {
    const item = files[name];
    const p = prefix ? prefix + '/' + name : name;
    if (item.files) walk(item, p, out);
    else out.push({ p, size: item.size, offset: Number(item.offset), unpacked: !!item.unpacked });
  }
}

const fd = fs.openSync(ASAR, 'r');
const { header, dataOffset } = readHeader(fd);
const all = [];
walk(header, '', all);

if (MODE === 'list') {
  console.log('total files:', all.length);
  const q = (process.argv[4] || '').toLowerCase();
  all.filter(f => f.p.toLowerCase().includes(q)).slice(0, 400)
    .forEach(f => console.log(f.size.toString().padStart(9), f.p));
} else if (MODE === 'grep') {
  const needle = Buffer.from(process.argv[4], 'utf8');
  let hits = 0;
  for (const f of all) {
    if (f.size > 8 * 1024 * 1024) continue;
    const buf = Buffer.alloc(f.size);
    try { fs.readSync(fd, buf, 0, f.size, dataOffset + f.offset); } catch (e) { continue; }
    if (buf.includes(needle)) { console.log(f.p); hits++; }
  }
  console.log('--- hits:', hits);
} else if (MODE === 'extract') {
  const patterns = process.argv.slice(4);
  const outDir = process.env.EXTRACT_DIR || path.join(process.cwd(), 'asar_extract');
  let n = 0;
  for (const f of all) {
    if (!patterns.some(p => f.p.includes(p))) continue;
    const dest = path.join(outDir, f.p);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const buf = Buffer.alloc(f.size);
      fs.readSync(fd, buf, 0, f.size, dataOffset + f.offset);
      fs.writeFileSync(dest, buf);
      n++;
    } catch (e) {
      console.log('skip:', f.p, e.message);
    }
  }
  console.log('extracted:', n, '->', outDir);
}
fs.closeSync(fd);

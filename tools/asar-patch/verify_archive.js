// Compare every file in two asar archives (content hash) to prove only the
// intended file changed. Usage: node verify_archive.js <asarA> <asarB>
const fs = require('fs')
const { createHash } = require('node:crypto')

function readArchive(p) {
  const fd = fs.openSync(p, 'r')
  const sizeBuf = Buffer.alloc(8)
  fs.readSync(fd, sizeBuf, 0, 8, 0)
  const headerBufLen = sizeBuf.readUInt32LE(4)
  const headerBuf = Buffer.alloc(headerBufLen)
  fs.readSync(fd, headerBuf, 0, headerBufLen, 8)
  const jsonLen = headerBuf.readUInt32LE(4)
  const header = JSON.parse(headerBuf.toString('utf8', 8, 8 + jsonLen))
  return { fd, header, dataOffset: 8 + headerBufLen }
}

function collect(node, prefix, out) {
  const files = node.files || {}
  for (const name of Object.keys(files)) {
    const item = files[name]
    const p = prefix ? prefix + '/' + name : name
    if (item.files) collect(item, p, out)
    else out.push({ node: item, p })
  }
  return out
}

function hashEntry(archive, e) {
  if (e.node.unpacked) return 'unpacked:' + e.node.size
  const size = Number(e.node.size)
  const buf = Buffer.alloc(size)
  fs.readSync(archive.fd, buf, 0, size, archive.dataOffset + Number(e.node.offset))
  return createHash('sha256').update(buf).digest('hex')
}

const A = readArchive(process.argv[2])
const B = readArchive(process.argv[3])
const ea = collect(A.header, '', [])
const eb = collect(B.header, '', [])
console.log('files A:', ea.length, ' files B:', eb.length)

const mapB = new Map(eb.map(e => [e.p, e]))
const added = [], removed = [], changed = [], same = []
for (const e of ea) {
  const f = mapB.get(e.p)
  if (!f) { removed.push(e.p); continue }
  if (Number(f.node.size) !== Number(e.node.size)) { changed.push(e.p); continue }
  if (hashEntry(A, e) !== hashEntry(B, f)) changed.push(e.p)
  else same.push(e.p)
}
for (const e of eb) if (!ea.some(x => x.p === e.p)) added.push(e.p)

console.log('unchanged:', same.length)
console.log('changed  :', changed.length, changed.slice(0, 10))
console.log('added    :', added.length, added.slice(0, 10))
console.log('removed  :', removed.length, removed.slice(0, 10))

if (changed.length === 1 && changed[0] === 'dist-electron/main.js') {
  console.log('OK: only dist-electron/main.js differs')
} else {
  console.log('CHECK: unexpected diff set')
}
fs.closeSync(A.fd)
fs.closeSync(B.fd)

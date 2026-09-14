// Precise asar rewriter: parse pickle header, recompute offsets, rewrite archive.
// Usage (set ASAR_PATH to the target app.asar, or pass it as the working dir's ./app.asar):
//   node asar_patch.js extract <asar> <inArchivePath> <outFile>
//   node asar_patch.js verify  <asar> <tmpOut>        // repack unchanged, compare sha256
//   node asar_patch.js patch   <asar> <inArchivePath> <newContentFile> <outAsar>
const fs = require('fs')
const path = require('path')
const { createHash } = require('node:crypto')
const os = require('os')
const { runCheck } = require('./check_budget.js')

function align4(n) {
  return (n + 3) & ~3
}

function readArchive(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  const sizeBuf = Buffer.alloc(8)
  fs.readSync(fd, sizeBuf, 0, 8, 0)
  const headerBufLen = sizeBuf.readUInt32LE(4)
  const headerBuf = Buffer.alloc(headerBufLen)
  fs.readSync(fd, headerBuf, 0, headerBufLen, 8)
  const jsonLen = headerBuf.readUInt32LE(4)
  const header = JSON.parse(headerBuf.toString('utf8', 8, 8 + jsonLen))
  return { fd, header, dataOffset: 8 + headerBufLen }
}

// Depth-first in JSON key order, matching asar's original serialization order.
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

function buildHeaderBuf(header) {
  const json = JSON.stringify(header)
  const jsonBuf = Buffer.from(json, 'utf8')
  const aligned = align4(4 + jsonBuf.length)
  const headerBuf = Buffer.alloc(4 + aligned)
  headerBuf.writeUInt32LE(aligned, 0)
  headerBuf.writeUInt32LE(jsonBuf.length, 4)
  jsonBuf.copy(headerBuf, 8)
  const sizeBuf = Buffer.alloc(8)
  sizeBuf.writeUInt32LE(4, 0)
  sizeBuf.writeUInt32LE(headerBuf.length, 4)
  return { sizeBuf, headerBuf }
}

function sha256File(p) {
  const h = createHash('sha256')
  const fd = fs.openSync(p, 'r')
  const buf = Buffer.alloc(8 * 1024 * 1024)
  let n
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n))
  fs.closeSync(fd)
  return h.digest('hex')
}

function writeArchive(asarPath, outPath, replacements) {
  const { fd, header, dataOffset } = readArchive(asarPath)
  const entries = collect(header, '', [])
  const replIndex = new Map() // archive path -> {buffer, size}
  if (replacements) {
    for (const [arcPath, filePath] of Object.entries(replacements)) {
      const buf = fs.readFileSync(filePath)
      replIndex.set(arcPath, buf)
    }
  }

  // Pass 1: assign new offsets
  let cursor = 0
  for (const e of entries) {
    if (replIndex.has(e.p)) {
      const buf = replIndex.get(e.p)
      e.newSize = buf.length
      e.node.size = buf.length
      delete e.node.unpacked
      e.node.offset = String(cursor)
      cursor += buf.length
    } else if (e.node.unpacked) {
      // keep as-is (lives in app.asar.unpacked)
    } else {
      e.node.offset = String(cursor)
      cursor += Number(e.node.size)
    }
  }

  const { sizeBuf, headerBuf } = buildHeaderBuf(header)
  const outFd = fs.openSync(outPath, 'w')
  fs.writeSync(outFd, sizeBuf)
  fs.writeSync(outFd, headerBuf)

  // Pass 2: copy data
  const chunk = Buffer.allocUnsafe(8 * 1024 * 1024)
  let written = 0
  for (const e of entries) {
    if (replIndex.has(e.p)) {
      fs.writeSync(outFd, replIndex.get(e.p))
      written += e.newSize
      continue
    }
    if (e.node.unpacked) continue
    const size = Number(e.node.size)
    const start = dataOffset + Number(e.node.offset)
    let remaining = size
    let pos = start
    // NOTE: offset was mutated in pass 1; recover original from a saved map
    while (remaining > 0) {
      const n = Math.min(chunk.length, remaining)
      fs.readSync(fd, chunk, 0, n, pos)
      fs.writeSync(outFd, chunk, 0, n)
      pos += n
      remaining -= n
    }
    written += size
  }
  fs.closeSync(outFd)
  fs.closeSync(fd)
  return { bytes: written, outSize: fs.statSync(outPath).size }
}

// Bug guard: pass 1 mutates node.offset, but pass 2 needs the ORIGINAL offset.
function writeArchiveSafe(asarPath, outPath, replacements) {
  const { fd, header, dataOffset } = readArchive(asarPath)
  const entries = collect(header, '', [])
  const repl = new Map()
  if (replacements) {
    for (const [arcPath, filePath] of Object.entries(replacements)) {
      repl.set(arcPath, fs.readFileSync(filePath))
    }
  }
  const originalOffset = new Map()
  for (const e of entries) originalOffset.set(e.node, Number(e.node.offset ?? 0))

  let cursor = 0
  for (const e of entries) {
    if (repl.has(e.p)) {
      const buf = repl.get(e.p)
      e.node.size = buf.length
      delete e.node.unpacked
      e.node.offset = String(cursor)
      cursor += buf.length
    } else if (e.node.unpacked) {
      // no data in archive
    } else {
      e.node.offset = String(cursor)
      cursor += Number(e.node.size)
    }
  }

  const { sizeBuf, headerBuf } = buildHeaderBuf(header)
  const outFd = fs.openSync(outPath, 'w')
  fs.writeSync(outFd, sizeBuf)
  fs.writeSync(outFd, headerBuf)

  const chunk = Buffer.allocUnsafe(8 * 1024 * 1024)
  for (const e of entries) {
    if (repl.has(e.p)) {
      fs.writeSync(outFd, repl.get(e.p))
      continue
    }
    if (e.node.unpacked) continue
    const size = Number(e.node.size)
    let remaining = size
    let pos = dataOffset + (originalOffset.get(e.node) || 0)
    while (remaining > 0) {
      const n = Math.min(chunk.length, remaining)
      fs.readSync(fd, chunk, 0, n, pos)
      fs.writeSync(outFd, chunk, 0, n)
      pos += n
      remaining -= n
    }
  }
  fs.closeSync(outFd)
  fs.closeSync(fd)
  return fs.statSync(outPath).size
}

const [, , mode, ...args] = process.argv
const ASAR = process.env.ASAR_PATH || './app.asar'  // set ASAR_PATH to the target app.asar

if (mode === 'extract') {
  const [arcPath, outFile] = args
  const { fd, header, dataOffset } = readArchive(ASAR)
  const entries = collect(header, '', [])
  const hit = entries.find(e => e.p === arcPath)
  if (!hit) throw new Error('not found: ' + arcPath)
  const buf = Buffer.alloc(Number(hit.node.size))
  fs.readSync(fd, buf, 0, buf.length, dataOffset + Number(hit.node.offset))
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, buf)
  fs.closeSync(fd)
  console.log('extracted', arcPath, buf.length, '->', outFile)
} else if (mode === 'verify') {
  const tmp = args[0]
  const t0 = Date.now()
  const size = writeArchiveSafe(ASAR, tmp)
  console.log('repacked size:', size, 'in', ((Date.now() - t0) / 1000).toFixed(1) + 's')
  const a = sha256File(ASAR)
  const b = sha256File(tmp)
  console.log('orig  sha256:', a)
  console.log('repack sha256:', b)
  console.log(a === b ? 'MATCH: packer is byte-identical' : 'MISMATCH: packer differs, abort patch')
}

// ---- Patch table -----------------------------------------------------------
// Each entry: { arc: path inside asar, mark: substring that proves it applied,
//               from: exact original text, to: replacement }
// Anchors are byte-exact; if the app updates and an anchor stops matching, we
// abort rather than write garbage.
const PATCHES = [
  {
    name: 'custom-provider-capabilities',
    arc: 'dist-electron/main.js',
    mark: 'return $a(e.capabilities);',
    from: 'if (i && i.protocol === n && Qa(e.baseUrl) === Qa(i.baseUrl)) return $a(i.models.find((e) => e.name === r)?.capabilities);',
    to: 'if (i && i.protocol === n && Qa(e.baseUrl) === Qa(i.baseUrl)) { let c = $a(i.models.find((e) => e.name === r)?.capabilities); if (c) return c; } return $a(e.capabilities);',
  },
  {
    // Local llama.cpp is ~55s per batch and single-slot; the shipped 20-minute
    // deadline kills character-architecture mid-run. Widen budgets.
    // HARD CEILING — enforced by generation-harness (var G):
    //   {maxAttempts:32, maxRequestedOutputTokens:147456,
    //    maxRequestedOutputTokensPerAttempt:32768, deadlineMs:36e5}
    // Any value above it throws "生成会话预算超过应用安全上限。" — stay <= these.
    name: 'widen-runtime-budgets',
    arc: 'dist/assets/index-CxbeuPBs.js',
    mark: '"character-architecture":Object.freeze({maxAttempts:20,maxRequestedOutputTokens:147456,',
    from: 'Uk=Object.freeze({structured:Object.freeze({maxAttempts:16,maxRequestedOutputTokens:131072,maxRequestedOutputTokensPerAttempt:8192,deadlineMs:6e5}),text:Object.freeze({maxAttempts:8,maxRequestedOutputTokens:65536,maxRequestedOutputTokensPerAttempt:8192,deadlineMs:12e5}),"character-architecture":Object.freeze({maxAttempts:12,maxRequestedOutputTokens:98304,maxRequestedOutputTokensPerAttempt:8192,deadlineMs:12e5})}',
    to: 'Uk=Object.freeze({structured:Object.freeze({maxAttempts:20,maxRequestedOutputTokens:131072,maxRequestedOutputTokensPerAttempt:8192,deadlineMs:18e5}),text:Object.freeze({maxAttempts:12,maxRequestedOutputTokens:65536,maxRequestedOutputTokensPerAttempt:8192,deadlineMs:24e5}),"character-architecture":Object.freeze({maxAttempts:20,maxRequestedOutputTokens:147456,maxRequestedOutputTokensPerAttempt:8192,deadlineMs:36e5})}',
  },
  {
    // Models (esp. custom OpenAI-compatible endpoints) like to emit "**第N章：标题**". The heading parser only
    // accepts #/-/* + space, so those headings were invisible -> "缺失 20 章".
    name: 'outline-heading-bold',
    arc: 'dist/assets/index-CxbeuPBs.js',
    mark: '|\\\\*{1,2})?第(',
    from: '(?:#{1,6}[\\\\t ]+|[-*+][\\\\t ]+)?第(${xM})',
    to: '(?:#{1,6}[\\\\t ]+|[-*+][\\\\t ]+|\\\\*{1,2})?第(${xM})',
  },
  {
    // The batch prompt tells the model to write a one-line "later overview" for
    // chapters beyond this batch, but models still emit real "第21–25章：..." headings.
    // Those were counted as out-of-range errors and failed the whole batch
    // (reproduced: "缺失 0 章，...越界 11 处"). Now headings fully past the batch
    // upper bound are skipped instead — "missing" chapters are still caught.
    name: 'outline-ignore-later-headings',
    arc: 'dist/assets/index-CxbeuPBs.js',
    mark: 'if(i.from>r)continue;',
    from: 'if(i.from<n||i.to>r||i.from>i.to){c.push(`${i.from}-${i.to}`);continue}',
    to: 'if(i.from>i.to){c.push(`${i.from}-${i.to}`);continue}if(i.from>r)continue;if(i.from<n||i.to>r){c.push(`${i.from}-${i.to}`);continue}',
  },
]

function extractTo(arcPath, outFile) {
  const { fd, header, dataOffset } = readArchive(ASAR)
  const hit = collect(header, '', []).find(e => e.p === arcPath)
  if (!hit) throw new Error('not found in archive: ' + arcPath)
  const buf = Buffer.alloc(Number(hit.node.size))
  fs.readSync(fd, buf, 0, buf.length, dataOffset + Number(hit.node.offset))
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, buf)
  fs.closeSync(fd)
  return buf
}

if (mode === 'apply') {
  // Idempotent: custom providers get user-declared capabilities; local-model
  // friendly runtime budgets. Built-in presets are left untouched.
  const tmpDir = process.env.PATCH_TMP_DIR || path.join(process.cwd(), 'patched')
  fs.mkdirSync(tmpDir, { recursive: true })

  const replacements = {}
  const pending = new Map() // arc -> working content, so several patches can stack
  let applied = 0
  for (const p of PATCHES) {
    let s = pending.get(p.arc)
    if (s === undefined) {
      const cur = path.join(tmpDir, path.basename(p.arc) + '.current')
      extractTo(p.arc, cur)
      s = fs.readFileSync(cur, 'utf8')
      pending.set(p.arc, s)
    }
    if (s.includes(p.mark)) {
      console.log(`[skip] ${p.name} — already applied`)
      continue
    }
    const hits = s.split(p.from).length - 1
    if (hits !== 1) {
      throw new Error(`[${p.name}] anchor matched ${hits} times; app version changed, aborting (no file written)`)
    }
    s = s.replace(p.from, p.to)
    pending.set(p.arc, s)
    const out = path.join(tmpDir, p.name + '.js')
    fs.writeFileSync(out, s)
    replacements[p.arc] = out
    applied++
    console.log(`[ok]   ${p.name} — ${p.arc}`)
  }

  // Self-check: every patch's marker must be present in the final content.
  // Catches a wrong `mark` (e.g. bad escaping) that would otherwise break
  // idempotence on the next run.
  for (const p of PATCHES) {
    const s = pending.get(p.arc)
    if (s !== undefined && !s.includes(p.mark)) {
      throw new Error(`[${p.name}] marker not found after patching — 'mark' is wrong, app.asar NOT modified`)
    }
  }

  if (applied === 0) {
    console.log('nothing to do')
    process.exit(0)
  }

  // Pre-write guard: the harness enforces an app-level ceiling (var G) and throws
  // "生成会话预算超过应用安全上限。" if any budget value exceeds it. Verify before
  // we touch app.asar, so a bad edit can never leave the app broken.
  if (replacements['dist/assets/index-CxbeuPBs.js']) {
    const hTmp = path.join(tmpDir, 'harness.probe.js')
    extractTo('dist/assets/generation-harness-HLbxCy5z.js', hTmp)
    const res = runCheck(
      fs.readFileSync(hTmp, 'utf8'),
      fs.readFileSync(replacements['dist/assets/index-CxbeuPBs.js'], 'utf8')
    )
    for (const r of res.rows) {
      if (r.over.length) console.error(`  [ceiling] ${r.name}: ${r.over.join(',')} exceeds app limit`)
    }
    if (!res.ok) throw new Error('budget exceeds app policy ceiling — app.asar NOT modified')
    console.log('[ok]   budget ceiling check passed')
  }

  const backup = path.join(process.env.BACKUP_DIR || path.join(process.cwd(), 'backup'), 'app.asar.pre-patch.bak')
  if (!fs.existsSync(backup)) {
    fs.mkdirSync(path.dirname(backup), { recursive: true })
    fs.copyFileSync(ASAR, backup)
    console.log('backup ->', backup)
  }
  const tmpAsar = path.join(os.tmpdir(), 'app.asar.patched')
  writeArchiveSafe(ASAR, tmpAsar, replacements)
  fs.copyFileSync(tmpAsar, ASAR)
  fs.unlinkSync(tmpAsar)
  console.log('patched', ASAR)
} else if (mode === 'restore') {
  const backup = path.join(process.env.BACKUP_DIR || path.join(process.cwd(), 'backup'), 'app.asar.pre-patch.bak')
  if (!fs.existsSync(backup)) throw new Error('backup not found: ' + backup)
  fs.copyFileSync(backup, ASAR)
  console.log('restored original app.asar from', backup)
} else if (mode === 'patch') {
  const [arcPath, newFile, outAsar] = args
  const t0 = Date.now()
  const size = writeArchiveSafe(ASAR, outAsar, { [arcPath]: newFile })
  console.log('patched archive written:', outAsar, size, 'bytes in', ((Date.now() - t0) / 1000).toFixed(1) + 's')
} else {
  console.log('unknown mode')
}

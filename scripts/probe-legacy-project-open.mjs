/* eslint-env node */

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const [, , portText, projectPath, markerPath, mode] = process.argv
const port = Number(portText)
if (!Number.isInteger(port) || !projectPath || !markerPath || (mode && !['--draft-write-proof', '--v025-save-proof'].includes(mode))) {
  throw new Error('Usage: node probe-legacy-project-open.mjs <port> <projectPath> <markerPath> [--draft-write-proof]')
}
const writeProof = mode === '--draft-write-proof'
const v025SaveProof = mode === '--v025-save-proof'
if (v025SaveProof) {
  const cacheRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.runtime', '.cache')
  const child = relative(cacheRoot, resolve(projectPath))
  if (isAbsolute(child) || !/^ai-novel-installer-smoke-[a-f0-9]+[\\/]/.test(child)) {
    throw new Error('v0.2.5 save proof requires an isolated installer fixture')
  }
}
if (writeProof) {
  const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.runtime', 'cache', 's14c-old-binaries')
  const child = relative(fixtureRoot, resolve(projectPath))
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('Draft writer proof requires an isolated old-binary fixture project')
  }
}

const deadline = Date.now() + 20_000
let page
while (Date.now() < deadline) {
  try {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())
    page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl)
    if (page) break
  } catch {
    // The legacy Electron debugger endpoint may not be ready yet.
  }
  await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
}
if (!page) throw new Error('Legacy Electron DevTools endpoint did not expose a renderer page')

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolvePromise, rejectPromise) => {
  const timer = setTimeout(() => rejectPromise(new Error('Timed out connecting to legacy renderer')), 10_000)
  socket.addEventListener('open', () => {
    clearTimeout(timer)
    resolvePromise()
  }, { once: true })
  socket.addEventListener('error', () => {
    clearTimeout(timer)
    rejectPromise(new Error('Could not connect to legacy renderer'))
  }, { once: true })
})

const draftContent = writeProof ? `A11_OLD_WRITER_${randomUUID()}` : null
const globalProof = process.env.AI_NOVEL_V110_GLOBAL_PROOF === '1'
const globalRead = globalProof ? `
  const config = await window.velaAPI.invoke('config:get')
  if (config?.theme !== 'light' || config.locale !== 'zh-CN' || config.proxy?.port !== 7890) {
    throw new Error('legacy config:get did not read the v1.1 global seed')
  }
  const recent = await window.velaAPI.invoke('project:recent-list')
  if (!Array.isArray(recent) || recent.length !== 1
      || recent[0]?.path !== ${JSON.stringify(resolve(projectPath))}
      || recent[0]?.name !== '升级保留验证小说') {
    throw new Error('legacy project:recent-list did not read the v1.1 recent seed')
  }
` : ''
const draftWrite = writeProof ? `
  if (result.project.path !== ${JSON.stringify(resolve(projectPath))}) {
    throw new Error('legacy project:open returned another project before draft write')
  }
  const context = { projectId: result.project.id, projectPath: result.project.path,
    leaseId: result.project.sessionLease }
  if (!context.projectId || !context.leaseId) throw new Error('legacy project:open did not return a session lease')
  const content = ${JSON.stringify(draftContent)}
  const created = await window.velaAPI.invoke('db:draft-create',
    { chapterNumber: 43, version: 1, source: 'write', content, wordCount: content.length },
    ${JSON.stringify(resolve(projectPath))}, context)
  if (!created || !created.success || !Number.isInteger(created.id)) {
    throw new Error(created && created.error ? created.error : 'legacy draft-create failed')
  }
  const readBack = await window.velaAPI.invoke('db:draft-get-full', created.id, ${JSON.stringify(resolve(projectPath))}, context)
  if (!readBack || readBack.id !== created.id || readBack.content !== content) {
    throw new Error('legacy draft read-back differs from the committed content')
  }
  return { projectPath: result.project.path, projectName: result.project.name,
    draft: { id: created.id, chapterNumber: 43, content, readBackContent: readBack.content } }
` : ''
const expression = `(async () => {
  if (!window.velaAPI || typeof window.velaAPI.invoke !== 'function') {
    throw new Error('legacy preload API is unavailable')
  }
  ${globalRead}
  const result = await window.velaAPI.invoke('project:open', ${JSON.stringify(resolve(projectPath))})
  if (!result || !result.success || !result.project) {
    throw new Error(result && result.error ? result.error : 'legacy project:open failed')
  }
  ${draftWrite}
  ${v025SaveProof ? `
  const before = await window.velaAPI.invoke('db:draft-get-full', 71)
  if (before?.id !== 71 || before.status !== 'draft' || before.chapterNumber !== 7 || before.version !== 1) {
    throw new Error('v0.2.5 editable fixture draft is missing')
  }
  const saved = await window.velaAPI.invoke('db:draft-update-content', before.id, before.content, before.wordCount)
  if (saved?.success !== true) throw new Error('v0.2.5 draft save failed')
  const after = await window.velaAPI.invoke('db:draft-get-full', before.id)
  if (JSON.stringify({ ...after, updatedAt: before.updatedAt }) !== JSON.stringify(before)
      || after.updatedAt === before.updatedAt) throw new Error('v0.2.5 saved draft read-back differs')
  return { projectPath: result.project.path, projectName: result.project.name, draft: { before, after } }
  ` : ''}
  return { projectPath: result.project.path, projectName: result.project.name${globalProof ? ', globalSeedRead: true' : ''} }
})()`

const response = await new Promise((resolvePromise, rejectPromise) => {
  const requestId = 1
  const timer = setTimeout(() => rejectPromise(new Error('Legacy project:open IPC timed out')), 20_000)
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    if (message.id !== requestId) return
    clearTimeout(timer)
    resolvePromise(message)
  })
  socket.send(JSON.stringify({
    id: requestId,
    method: 'Runtime.evaluate',
    params: {
      expression,
      awaitPromise: true,
      returnByValue: true,
    },
  }))
})
socket.close()

if (response.error) throw new Error(response.error.message || 'Legacy renderer evaluation failed')
if (response.result?.exceptionDetails) {
  throw new Error(response.result.exceptionDetails.exception?.description || 'Legacy project:open threw')
}
const proof = response.result?.result?.value
if (!proof?.projectPath || resolve(proof.projectPath) !== resolve(projectPath)) {
  throw new Error('Legacy application opened a different project than requested')
}
if (globalProof && proof.globalSeedRead !== true) {
  throw new Error('Legacy application did not confirm the v1.1 global seed')
}
if (writeProof && (!Number.isInteger(proof.draft?.id) || proof.draft.content !== draftContent
  || proof.draft.readBackContent !== draftContent)) {
  throw new Error('Legacy application did not return exact draft write/read proof')
}

writeFileSync(markerPath, `${JSON.stringify({
  ...proof,
  verifiedBy: v025SaveProof ? 'legacy-renderer-cdp-v025-save' : writeProof ? 'legacy-renderer-cdp-draft-write' : 'legacy-renderer-cdp-project-open',
  verifiedAt: new Date().toISOString(),
}, null, 2)}\n`, 'utf8')

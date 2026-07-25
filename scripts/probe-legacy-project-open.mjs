/* eslint-env node */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [, , portText, projectPath, markerPath] = process.argv
const port = Number(portText)
if (!Number.isInteger(port) || !projectPath || !markerPath) {
  throw new Error('Usage: node probe-legacy-project-open.mjs <port> <projectPath> <markerPath>')
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

const expression = `(async () => {
  if (!window.velaAPI || typeof window.velaAPI.invoke !== 'function') {
    throw new Error('legacy preload API is unavailable')
  }
  const result = await window.velaAPI.invoke('project:open', ${JSON.stringify(resolve(projectPath))})
  if (!result || !result.success || !result.project) {
    throw new Error(result && result.error ? result.error : 'legacy project:open failed')
  }
  return { projectPath: result.project.path, projectName: result.project.name }
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

writeFileSync(markerPath, `${JSON.stringify({
  ...proof,
  verifiedBy: 'legacy-renderer-cdp-project-open',
  verifiedAt: new Date().toISOString(),
}, null, 2)}\n`, 'utf8')

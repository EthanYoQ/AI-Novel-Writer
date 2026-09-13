/* Metadata-only Vitest reporter. Added alongside the default reporter in CI.
 * It never changes worker arguments, return values, errors, retry policy or timeouts.
 * The fork observer uses Node's live builtin export so Vitest's ESM fork import
 * sees it even though the CLI was loaded before reporters were initialized.
 */
const fs = require('node:fs')
const path = require('node:path')
const childProcess = require('node:child_process')
const { syncBuiltinESMExports } = require('node:module')
const { createHash } = require('node:crypto')
const installed = Symbol.for('ai-novel.vitest-worker-diagnostics')

function emit(event, metadata = {}) {
  try {
    fs.writeSync(2, '[vitest-worker-diagnostic] ' + JSON.stringify({ event, observerPid: process.pid,
      monotonicNs: process.hrtime.bigint().toString(), ...metadata }) + '\n')
  } catch { /* Diagnostics must not alter test outcomes if the output sink fails. */ }
}
function relativeTestFile(root, value) {
  if (typeof value !== 'string') return null
  const relative = path.relative(root, path.resolve(root, value)).replaceAll('\\', '/')
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative) || relative.length > 500
    || !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(relative)) return null
  return relative
}
function observeWorkers(root) {
  if (childProcess[installed]) return
  childProcess[installed] = true
  const originalFork = childProcess.fork
  childProcess.fork = function (...args) {
    const child = Reflect.apply(originalFork, this, args)
    // Observe only Vitest's fork worker. Do not inspect arbitrary test subprocesses.
    const modulePath = typeof args[0] === 'string' ? args[0].replaceAll('\\', '/') : ''
    if (!/\/vitest\/dist\/workers\/forks\.js$/u.test(modulePath)) return child
    child.once('spawn', () => emit('worker-spawn', { workerPid: child.pid }))
    child.once('exit', (code, signal) => emit('worker-exit', { workerPid: child.pid,
      exitCode: Number.isInteger(code) ? code : null, signal: typeof signal === 'string' && /^SIG[A-Z0-9]+$/u.test(signal) ? signal : null }))
    child.once('close', (code, signal) => emit('worker-close', { workerPid: child.pid,
      exitCode: Number.isInteger(code) ? code : null, signal: typeof signal === 'string' && /^SIG[A-Z0-9]+$/u.test(signal) ? signal : null }))
    const originalSend = child.send
    child.send = function (message, ...sendArgs) {
      try {
        if (message?.__vitest_worker_request__ === true && ['run', 'collect', 'start', 'stop'].includes(message.type)) {
          const files = Array.isArray(message.context?.files)
            ? message.context.files.map(file => relativeTestFile(root, file?.filepath)).filter(Boolean) : []
          emit('worker-request', { workerPid: child.pid, method: message.type, files })
        }
      } catch { /* Preserve the original send result and error semantics. */ }
      return Reflect.apply(originalSend, this, [message, ...sendArgs])
    }
    return child
  }
  syncBuiltinESMExports()
}
class VitestWorkerDiagnostics {
  onInit(context) {
    try {
      this.root = path.resolve(context.config.root)
      observeWorkers(this.root)
      emit('diagnostics-ready')
    } catch { emit('diagnostics-unavailable') }
  }
  boundary(event, task, isCase = false) {
    try {
      const file = relativeTestFile(this.root, isCase ? task.module.moduleId : task.moduleId)
      if (!file || isCase && file !== 'electron/services/__tests__/vector-migration-snapshot.test.ts') return
      const metadata = { file }
      if (isCase && typeof task.id === 'string') metadata.testId = createHash('sha256').update(task.id).digest('hex').slice(0, 16)
      if (Number.isSafeInteger(task.location?.line) && task.location.line > 0) metadata.line = task.location.line
      emit(event, metadata)
    } catch { /* Reporter metadata must not fail or intercept a test. */ }
  }
  onTestModuleQueued(module) { this.boundary('suite-queued', module) }
  onTestModuleStart(module) { this.boundary('suite-start', module) }
  onTestModuleEnd(module) { this.boundary('suite-end', module) }
  onTestCaseReady(test) { this.boundary('test-start', test, true) }
  onTestCaseResult(test) { this.boundary('test-end', test, true) }
}
module.exports = VitestWorkerDiagnostics

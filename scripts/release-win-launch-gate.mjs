/* eslint-env node */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'

function usage() {
  return [
    'Usage: node scripts/release-win-launch-gate.mjs',
    '--armed-path <path> --release-path <path> --result-path <path>',
    '-- <command> [args...]',
  ].join(' ')
}

function parseArguments(argv) {
  const separator = argv.indexOf('--')
  if (separator < 0) throw new Error(usage())
  const options = argv.slice(0, separator)
  const command = argv.slice(separator + 1)
  if (command.length === 0) throw new Error(usage())

  const values = new Map()
  for (let index = 0; index < options.length; index += 2) {
    const key = options[index]
    const value = options[index + 1]
    if (!['--armed-path', '--release-path', '--result-path'].includes(key) || !value) {
      throw new Error(usage())
    }
    values.set(key, value)
  }
  const armedPath = values.get('--armed-path')
  const releasePath = values.get('--release-path')
  const resultPath = values.get('--result-path')
  if (!armedPath || !releasePath || !resultPath || values.size !== 3) throw new Error(usage())

  return { armedPath, releasePath, resultPath, command: command[0], args: command.slice(1) }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8')
}

function delay(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
}

async function waitForRelease(releasePath) {
  const timeoutMilliseconds = Number.parseInt(
    process.env.AI_NOVEL_RELEASE_GATE_ARM_TIMEOUT_MS ?? '120000',
    10,
  )
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1_000) {
    throw new Error('AI_NOVEL_RELEASE_GATE_ARM_TIMEOUT_MS must be an integer of at least 1000 milliseconds')
  }
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    if (existsSync(releasePath)) return
    await delay(10)
  }
  throw new Error(`Timed out waiting for the release-gate monitoring acknowledgement: ${releasePath}`)
}

function waitForChild(child) {
  return new Promise(resolvePromise => {
    child.once('error', error => resolvePromise({ error, code: null, signal: null }))
    child.once('exit', (code, signal) => resolvePromise({ error: null, code, signal }))
  })
}

async function main() {
  const { armedPath, releasePath, resultPath, command, args } = parseArguments(process.argv.slice(2))
  const armedAt = new Date().toISOString()
  writeJson(armedPath, {
    state: 'armed',
    processId: process.pid,
    armedAt,
    command,
    args,
  })

  try {
    await waitForRelease(releasePath)
  } catch (error) {
    writeJson(resultPath, {
      state: 'not-released',
      processId: process.pid,
      armedAt,
      error: error instanceof Error ? error.message : String(error),
      completedAt: new Date().toISOString(),
    })
    throw error
  }

  const releasedAt = new Date().toISOString()
  const target = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  })
  const result = await waitForChild(target)
  const payload = {
    state: result.error ? 'spawn-error' : 'completed',
    processId: process.pid,
    targetProcessId: target.pid ?? null,
    targetExitCode: result.code,
    targetSignal: result.signal,
    error: result.error ? result.error.message : null,
    armedAt,
    releasedAt,
    completedAt: new Date().toISOString(),
  }
  writeJson(resultPath, payload)

  if (result.error) throw result.error
  if (result.signal) {
    process.exitCode = 1
    return
  }
  process.exitCode = result.code ?? 1
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

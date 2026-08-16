#!/usr/bin/env node
/** Tarball, disposable-profile, browser, persistence, and Electron regression qualification. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import yaml from 'js-yaml'

const execFileAsync = promisify(execFile)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(packageRoot, '..', '..')
const packageName = '@ethanyoq/dsh-ai-novel-writer'
const profileName = 'web'
const supportedHarnessCommit = '47f943859bef60e4160492346772ded9b24f765a'
const expectedPresetPlugins = [
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-agent-instructions',
  '@ethanyoq/dsh-ai-novel-writer/agent',
]
const requiredTarballEntries = [
  'package/README.md',
  'package/cordis.patch.yml',
  'package/lib/agent.js',
  'package/lib/client.js',
  'package/lib/index.js',
  'package/lib/types/agent.d.ts',
  'package/lib/types/client/index.d.ts',
  'package/lib/types/index.d.ts',
  'package/package.json',
  'package/presets/ai-novel-writer/agent.cordis.yml',
  'package/presets/ai-novel-writer/preset.yml',
]
const chapterText = '# 退潮来信\n\n午夜，灯塔的主灯第一次熄灭。\n\n林夏在退去的潮水里捡到一封尚未寄出的信。\n'

function fail(message) {
  throw new Error(message)
}

function assertHarnessCommit(commit) {
  if (commit !== supportedHarnessCommit) {
    fail(`Qualification requires DeepSeek Harness commit ${supportedHarnessCommit}; received ${commit}`)
  }
}

function objectOf(value, subject) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${subject} must be an object`)
  return value
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

function parsePreset(text) {
  const rows = yaml.load(text)
  if (!Array.isArray(rows)) fail('Preset must be a YAML row array')
  const names = rows.map((row) => {
    const record = objectOf(row, 'Preset row')
    if (typeof record.name !== 'string') fail('Preset row must name a plugin')
    return record.name
  })
  if (JSON.stringify(names) !== JSON.stringify(expectedPresetPlugins)) {
    fail('Preset plugin roster is not dedicated to novel writing')
  }
  const persona = objectOf(rows[0], 'Persona row')
  const config = objectOf(persona.config, 'Persona config')
  if (typeof config.text !== 'string' || !config.text.includes('novel_read') || !config.text.includes('novel_apply_change')) {
    fail('Preset persona must describe both novel tools')
  }
  return { names }
}

async function validatePreset(path) {
  return parsePreset(await readFile(path, 'utf8'))
}

function assertBundlePatch(text) {
  const patches = yaml.load(text)
  if (!Array.isArray(patches) || patches.length !== 1) fail('Bundle patch must contain one insert operation')
  const operation = objectOf(patches[0], 'Bundle patch operation')
  if (!Array.isArray(operation.insert) || operation.insert.length !== 1) fail('Bundle patch must insert one Host row')
  const row = objectOf(operation.insert[0], 'Bundle Host row')
  if (row.id !== 'ai-novel-writer' || row.name !== packageName) fail('Bundle patch must mount only the AI novel Host entry')
}

async function checkSource() {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const exportsField = objectOf(manifest.exports, 'Package exports')
  for (const key of ['.', './agent', './client', './cordis.patch.yml', './package.json']) {
    if (!(key in exportsField)) fail(`Package export is missing: ${key}`)
  }
  const dsh = objectOf(manifest.dsh, 'Package dsh manifest')
  const bundle = objectOf(dsh.bundle, 'Package bundle manifest')
  const client = objectOf(dsh.client, 'Package client manifest')
  if (bundle.patch !== './cordis.patch.yml') fail('Package bundle patch declaration is invalid')
  if (client.platform !== 'web') fail('Package client platform must be web')
  if (!Array.isArray(manifest.files) || manifest.files.includes('lib/client.js.map')) {
    fail('Published files must include declared artifacts and exclude the client source map')
  }
  for (const path of [
    'README.md', 'cordis.patch.yml', 'presets/ai-novel-writer/agent.cordis.yml',
    'presets/ai-novel-writer/preset.yml', 'scripts/qualification-preset.mjs',
  ]) {
    if (!(await exists(join(packageRoot, path)))) fail(`Source package artifact is missing: ${path}`)
  }
  await validatePreset(join(packageRoot, 'presets', 'ai-novel-writer', 'agent.cordis.yml'))
  assertBundlePatch(await readFile(join(packageRoot, 'cordis.patch.yml'), 'utf8'))
  return manifest
}

function assertTarballEntries(entries) {
  const normalized = entries.map(entry => entry.replaceAll('\\', '/')).filter(Boolean)
  for (const required of requiredTarballEntries) {
    if (!normalized.includes(required)) fail(`Tarball artifact is missing: ${required}`)
  }
  const forbidden = normalized.find(entry =>
    entry.includes('/src/')
    || entry.includes('/tests/')
    || entry.endsWith('.js.map')
    || entry.endsWith('.ts') && !entry.endsWith('.d.ts'))
  if (forbidden !== undefined) fail(`Tarball contains a development-only artifact: ${forbidden}`)
}

function assertProfileInstalled(manifest, tarballName) {
  const dependencies = objectOf(manifest.dependencies, 'Profile dependencies')
  const specifier = dependencies[packageName]
  if (typeof specifier !== 'string' || !specifier.includes(tarballName) || /^(?:link|workspace):/.test(specifier)) {
    fail('Profile must install the plugin from the packed tarball bytes')
  }
  const dsh = objectOf(manifest.dsh, 'Profile dsh manifest')
  const profile = objectOf(dsh.profile, 'Profile bundle manifest')
  if (!Array.isArray(profile.bundles)) fail('Profile bundle list is missing')
  for (const bundle of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', packageName]) {
    if (!profile.bundles.includes(bundle)) fail(`Profile bundle is missing: ${bundle}`)
  }
  return { specifier, bundles: profile.bundles }
}

function assertProfileRemoved(manifest) {
  const dependencies = manifest.dependencies === undefined
    ? {}
    : objectOf(manifest.dependencies, 'Profile dependencies')
  const profile = objectOf(objectOf(manifest.dsh, 'Profile dsh manifest').profile, 'Profile bundle manifest')
  if (packageName in dependencies || !Array.isArray(profile.bundles) || profile.bundles.includes(packageName)) {
    fail('Profile uninstall retained the AI novel dependency or bundle layer')
  }
}

function powershellQuote(path) {
  return `'${path.replaceAll("'", "''")}'`
}

function ownershipRecord(root, sourceProject, purpose, ttlDays, retainReason) {
  const createdAt = new Date().toISOString()
  const expiresAt = new Date(Date.parse(createdAt) + ttlDays * 86_400_000).toISOString()
  return {
    owner: 'codex-ticket-107',
    sourceProject,
    purpose,
    createdAt,
    expiresAt,
    ttlDays,
    retainReason,
    cleanup: {
      shell: 'PowerShell',
      command: `Remove-Item -LiteralPath ${powershellQuote(root)} -Recurse -Force`,
    },
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function assertInside(parent, child) {
  const rel = relative(parent, child)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail(`Qualification path must be a child of ${parent}`)
  }
}

async function pnpmLaunch(args) {
  if (process.platform !== 'win32') return { file: 'pnpm', args }
  for (const directory of (process.env.PATH ?? '').split(';').filter(Boolean)) {
    const entry = join(directory, 'node_modules', 'corepack', 'dist', 'pnpm.js')
    if (await exists(entry)) return { file: process.execPath, args: [entry, ...args] }
  }
  fail('Cannot locate the pnpm Corepack launcher on PATH')
}

async function recordCommand(logRoot, label, file, args, options = {}) {
  const startedAt = new Date().toISOString()
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const streamsClosed = Promise.all([
    new Promise(resolveClose => child.stdout.once('close', resolveClose)),
    new Promise(resolveClose => child.stderr.once('close', resolveClose)),
  ])
  const exited = { value: undefined }
  const exit = new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      exited.value = { code, signal }
      resolveExit(exited.value)
    })
  })
  const timeoutMs = options.timeout ?? 180_000
  let timeout
  let timedOut = false
  let outcome
  let failure
  try {
    const settled = await Promise.race([
      exit.then(value => ({ kind: 'exit', value })),
      new Promise(resolveTimeout => {
        timeout = setTimeout(() => resolveTimeout({ kind: 'timeout' }), timeoutMs)
      }),
    ])
    if (settled.kind === 'timeout') {
      timedOut = true
      await terminateProcessTree(child, exit, exited)
      outcome = await exit
    } else {
      outcome = settled.value
    }
  } catch (error) {
    failure = error
    if (exited.value === undefined) {
      try {
        await terminateProcessTree(child, exit, exited)
      } catch (cleanupError) {
        failure = new AggregateError([error, cleanupError], `${label} execution and cleanup both failed`)
      }
    }
    outcome = exited.value
  } finally {
    clearTimeout(timeout)
  }
  let streamTimeout
  try {
    await Promise.race([
      streamsClosed,
      new Promise((_, reject) => {
        streamTimeout = setTimeout(() => reject(new Error(`${label} output pipes did not close`)), 10_000)
      }),
    ])
  } catch (streamError) {
    failure = failure === undefined
      ? streamError
      : new AggregateError([failure, streamError], `${label} execution and pipe cleanup both failed`)
  } finally {
    clearTimeout(streamTimeout)
  }
  try {
    await Promise.all([
      writeFile(join(logRoot, `${label}.stdout.log`), stdout, 'utf8'),
      writeFile(join(logRoot, `${label}.stderr.log`), stderr, 'utf8'),
    ])
  } catch (logError) {
    if (failure !== undefined) throw new AggregateError([failure, logError], `${label} execution and log persistence both failed`)
    throw logError
  }
  const exitCode = outcome?.code ?? null
  const signal = outcome?.signal ?? null
  if (failure !== undefined || timedOut || exitCode !== 0) {
    const detail = `exitCode=${exitCode ?? 'null'}, signal=${signal ?? 'null'}, timedOut=${timedOut}`
    const cause = failure ?? new Error(`${label} exited unsuccessfully`)
    throw new Error(`${label} failed (${detail}): ${stderr || (failure instanceof Error ? failure.message : String(failure ?? ''))}`, { cause })
  }
  return {
    label, startedAt, finishedAt: new Date().toISOString(), stdout, stderr,
    exitCode, signal, timedOut,
  }
}

async function runPnpm(logRoot, label, args, options) {
  const launch = await pnpmLaunch(args)
  return recordCommand(logRoot, label, launch.file, launch.args, options)
}

function dshLaunch(harnessRoot, args) {
  return {
    file: process.execPath,
    args: ['--import', 'tsx/esm', join(harnessRoot, 'apps', 'cli', 'src', 'bin.ts'), ...args],
  }
}

async function runDsh(logRoot, label, harnessRoot, args, env, timeout) {
  const launch = dshLaunch(harnessRoot, args)
  return recordCommand(logRoot, label, launch.file, launch.args, { cwd: harnessRoot, env, timeout })
}

async function sha256(path) {
  const contents = await readFile(path)
  return createHash('sha256').update(contents).digest('hex')
}

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'string' || address === null) {
        server.close()
        reject(new Error('Cannot allocate a loopback qualification port'))
        return
      }
      server.close(error => error === undefined ? resolvePort(address.port) : reject(error))
    })
  })
}

async function waitForWeb(url, exited) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (exited.value !== undefined) fail(`Web process exited before readiness: ${JSON.stringify(exited.value)}`)
    try {
      const response = await fetch(url)
      if (response.ok) return response.text()
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }
  fail(`Web profile did not become ready: ${url}`)
}

function bootGraphFromHtml(html) {
  const match = /<script>window\.__DSH_BOOT__ = ([\s\S]*?)<\/script>/.exec(html)
  if (match?.[1] === undefined) fail('Web index did not contain the client boot graph')
  return objectOf(JSON.parse(match[1]), 'Web client boot graph')
}

async function waitForExit(exit, timeoutMs) {
  let timeout
  try {
    await Promise.race([
      exit,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Web process did not stop')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function terminateProcessTree(child, exit, exited, timeoutMs = 10_000) {
  if (exited.value !== undefined) {
    await exit
    return
  }
  const pid = child.pid
  if (pid === undefined) {
    await waitForExit(exit, timeoutMs)
    return
  }
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
        encoding: 'utf8', timeout: 10_000, windowsHide: true,
      })
    } catch (error) {
      if (exited.value === undefined) throw error
    }
    await waitForExit(exit, timeoutMs)
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
  }
  try {
    await waitForExit(exit, timeoutMs)
  } catch (error) {
    if (exited.value !== undefined) return
    try {
      process.kill(-pid, 'SIGKILL')
    } catch (killError) {
      if (!(killError instanceof Error && 'code' in killError && killError.code === 'ESRCH')) throw killError
    }
    try {
      await waitForExit(exit, timeoutMs)
    } catch (killWaitError) {
      throw new AggregateError([error, killWaitError], 'Process tree ignored graceful and forced termination')
    }
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
}

async function forceFixtureCleanup(pids) {
  for (const pid of pids) {
    if (!processIsAlive(pid)) continue
    if (process.platform === 'win32') {
      try {
        await execFileAsync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
          encoding: 'utf8', timeout: 10_000, windowsHide: true,
        })
      } catch (error) {
        if (processIsAlive(pid)) throw error
      }
    } else {
      try {
        process.kill(pid, 'SIGKILL')
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
      }
    }
  }
}

async function probeCommandTimeout(logRoot) {
  await mkdir(logRoot, { recursive: true })
  const pidPath = join(logRoot, 'process-tree-pids.json')
  const grandchildSource = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
  const childSource = [
    "const {spawn}=require('node:child_process')",
    "const {writeFileSync}=require('node:fs')",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(grandchildSource)}],{stdio:'ignore'})`,
    `writeFileSync(${JSON.stringify(pidPath)},JSON.stringify([process.pid,child.pid]))`,
    "process.on('SIGTERM',()=>{})",
    'setInterval(()=>{},1000)',
  ].join(';')
  let commandError
  try {
    await recordCommand(logRoot, 'process-tree-timeout', process.execPath, ['-e', childSource], { timeout: 500 })
  } catch (error) {
    commandError = error
  }
  let pids = []
  let validationError
  try {
    pids = JSON.parse(await readFile(pidPath, 'utf8'))
    if (!Array.isArray(pids) || pids.some(pid => !Number.isInteger(pid))) {
      fail('Command-timeout fixture did not record its process tree')
    }
    if (!(commandError instanceof Error) || !commandError.message.includes('timedOut=true')) {
      fail('recordCommand did not report an explicit timeout')
    }
    if (pids.some(processIsAlive)) fail('recordCommand timeout retained a fixture process')
  } catch (error) {
    validationError = error
  } finally {
    await forceFixtureCleanup(pids)
  }
  if (validationError !== undefined) throw validationError
  process.stdout.write('command timeout cleanup passed\n')
}

async function writeWebLogs(logRoot, label, stdout, stderr) {
  await Promise.all([
    writeFile(join(logRoot, `${label}.stdout.log`), stdout, 'utf8'),
    writeFile(join(logRoot, `${label}.stderr.log`), stderr, 'utf8'),
  ])
}

async function startWeb(logRoot, label, harnessRoot, env) {
  const port = await availablePort()
  const url = `http://127.0.0.1:${port}`
  const launch = dshLaunch(harnessRoot, ['--profile', profileName, '--port', String(port)])
  const child = spawn(launch.file, launch.args, {
    cwd: harnessRoot,
    detached: process.platform !== 'win32',
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  const exited = { value: undefined }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const exit = new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      exited.value = { code, signal }
      resolveExit(exited.value)
    })
  })
  try {
    const html = await waitForWeb(url, exited)
    return {
      url,
      html,
      async stop() {
        let terminationError
        try {
          await terminateProcessTree(child, exit, exited)
        } catch (error) {
          terminationError = error
        }
        try {
          await writeWebLogs(logRoot, label, stdout, stderr)
        } catch (logError) {
          if (terminationError !== undefined) {
            throw new AggregateError([terminationError, logError], 'Web termination and log persistence both failed')
          }
          throw logError
        }
        if (terminationError !== undefined) throw terminationError
      },
    }
  } catch (error) {
    const errors = [error]
    try {
      await terminateProcessTree(child, exit, exited)
    } catch (terminationError) {
      errors.push(terminationError)
    }
    try {
      await writeWebLogs(logRoot, label, stdout, stderr)
    } catch (logError) {
      errors.push(logError)
    }
    if (errors.length > 1) throw new AggregateError(errors, 'Web startup and cleanup both failed')
    throw error
  }
}

async function probeWeb(logRoot, label, harnessRoot, env) {
  const server = await startWeb(logRoot, `${label}-server`, harnessRoot, env)
  let result
  let bodyError
  try {
    const graph = bootGraphFromHtml(server.html)
    if (!Array.isArray(graph.entries)) fail('Web client boot graph entries are missing')
    const row = graph.entries.find(entry => objectOf(entry, 'Web client row').id === packageName)
    if (row === undefined || typeof row.url !== 'string') fail('Installed client bundle was not discovered')
    const bundleResponse = await fetch(new URL(row.url, server.url))
    if (!bundleResponse.ok || !(await bundleResponse.text()).includes('__ModuleLoader__')) {
      fail('Installed client bundle endpoint did not serve the packaged browser entry')
    }
    const browser = await recordCommand(logRoot, `${label}-browser`, process.execPath, [
      join(packageRoot, 'scripts', 'qualification-browser.mjs'), server.url, repositoryRoot,
    ], { cwd: repositoryRoot, env, timeout: 90_000 })
    const browserLine = browser.stdout.trimEnd().split(/\r?\n/).at(-1)
    const browserResult = objectOf(JSON.parse(browserLine ?? ''), 'Browser qualification result')
    if (browserResult.contextWindowOpened !== true || browserResult.presetInstalled !== true) {
      fail('Browser did not open the context window and confirm Preset installation')
    }
    result = { url: server.url, graphRevision: graph.rev, clientRevision: row.rev, presetInstalled: true }
  } catch (error) {
    bodyError = error
  }
  let stopError
  try {
    await server.stop()
  } catch (error) {
    stopError = error
  }
  if (bodyError !== undefined && stopError !== undefined) {
    throw new AggregateError([bodyError, stopError], 'Web probe and cleanup both failed')
  }
  if (bodyError !== undefined) throw bodyError
  if (stopError !== undefined) throw stopError
  return result
}

async function qualifyPreset(installedRoot, runRoot) {
  const module = await import(`${pathToFileURL(join(installedRoot, 'lib', 'index.js')).href}?qualification=${Date.now()}`)
  if (typeof module.createPresetInstaller !== 'function') fail('Installed Host export is missing createPresetInstaller')
  const presetRoot = join(runRoot, 'preset-root')
  const templateRoot = join(installedRoot, 'presets', 'ai-novel-writer')
  const installer = module.createPresetInstaller(templateRoot, presetRoot)
  const before = await installer.status()
  const first = await installer.install()
  const second = await installer.install()
  await writeFile(join(presetRoot, 'ai-novel-writer', 'agent.cordis.yml'), '\n# qualification conflict\n', { flag: 'a' })
  const conflict = await installer.install()
  await rm(join(presetRoot, 'ai-novel-writer'), { recursive: true, force: true })
  const restored = await installer.install()
  await validatePreset(join(presetRoot, 'ai-novel-writer', 'agent.cordis.yml'))
  if (before.status !== 'not-installed'
    || first.status !== 'installed' || first.changed !== true
    || second.status !== 'installed' || second.changed !== false
    || conflict.status !== 'conflict' || conflict.changed !== false
    || restored.status !== 'installed' || restored.changed !== true) {
    fail('Installed Preset did not preserve install, idempotence, conflict, and restore behavior')
  }
  return { before, first, second, conflict, restored }
}

async function qualifyPresetTools(logRoot, profileRoot, installedRoot, env) {
  const configRoot = join(profileRoot, 'qualification')
  const configPath = join(configRoot, 'cordis.yml')
  await mkdir(configRoot, { recursive: true })
  await writeFile(configPath, [
    "- id: llm\n  name: '@deepseek-ai/dsh-llm'",
    "- id: sessions\n  name: '@deepseek-ai/dsh-session'",
    "- id: system-prompt\n  name: '@deepseek-ai/dsh-system-prompt'\n  config:\n    persona: ''",
    "- id: tools\n  name: '@deepseek-ai/dsh-tools'",
    "- id: approval\n  name: '@deepseek-ai/dsh-user-approval'\n  config:\n    policy: ask",
    "- id: agents\n  name: '@deepseek-ai/dsh-agent'",
    "- id: agent-loop\n  name: '@deepseek-ai/dsh-agent-loop'\n  config:\n    agents: []",
    "- id: presets\n  name: '@deepseek-ai/dsh-agent-presets'\n  config:\n    default: ai-novel-writer\n    roots:\n      - path: !!js process.env.DSH_NOVEL_PRESET_ROOT\n        trust: user\n    includeUserRoot: false",
    '',
  ].join('\n\n'), 'utf8')
  const result = await recordCommand(logRoot, 'installed-preset-tools', process.execPath, [
    join(packageRoot, 'scripts', 'qualification-preset.mjs'), configPath,
  ], {
    cwd: repositoryRoot,
    env: { ...env, DSH_NOVEL_PRESET_ROOT: join(installedRoot, 'presets') },
    timeout: 60_000,
  })
  const payload = objectOf(JSON.parse(result.stdout.trimEnd().split(/\r?\n/).at(-1) ?? ''), 'Installed Preset tool probe')
  if (!Array.isArray(payload.agentTools) || !Array.isArray(payload.globalTools)) {
    fail('Installed Preset tool probe did not return tool arrays')
  }
  const names = payload.agentTools.map((schema) => {
    const tool = objectOf(schema, 'Installed Preset tool schema')
    if (typeof tool.name !== 'string' || typeof tool.description !== 'string') {
      fail('Installed Preset tool schema is incomplete')
    }
    objectOf(tool.parameters, 'Installed Preset tool parameters')
    return tool.name
  })
  if (JSON.stringify(names) !== JSON.stringify(['novel_read', 'novel_apply_change']) || payload.globalTools.length !== 0) {
    fail('Installed Preset must expose only novel_read and novel_apply_change to its agent and no root tools')
  }
  return { agentTools: payload.agentTools, globalTools: payload.globalTools }
}

async function writeChapter(installedRoot, workspaceRoot) {
  const module = await import(`${pathToFileURL(join(installedRoot, 'lib', 'index.js')).href}?chapter=${Date.now()}`)
  if (typeof module.openNovelProject !== 'function') fail('Installed Host export is missing openNovelProject')
  const project = module.openNovelProject(workspaceRoot)
  const signal = new AbortController().signal
  await project.apply({
    kind: 'initialize', projectId: '123e4567-e89b-42d3-a456-426614174000',
    createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z',
    title: '潮汐来信', language: 'zh-CN', genre: '奇幻悬疑', plannedChapters: 6,
    targetWordsPerChapter: 2_000, creativeStrategy: 'consistency-first',
  }, signal)
  const changes = [
    {
      target: { kind: 'characters' }, summary: '建立主要人物',
      replacement: '{"characters":[{"id":"lin-xia","name":"林夏","role":"灯塔守望人","summary":"能听见潮汐中的旧日回声。","goal":"找回失踪的弟弟。","relationships":[],"notes":"害怕深水，却从不离开灯塔。"}]}',
    },
    {
      target: { kind: 'story-blueprint' }, summary: '建立故事蓝图',
      replacement: '{"premise":"退潮后的海床会浮现来自未来的信件。","themes":["记忆","选择"],"world":"被永夜潮汐包围的群岛。","mainPlot":"林夏循着未来信件寻找失踪者。","endingGoal":"林夏决定保留真实记忆并点亮全部灯塔。"}',
    },
    {
      target: { kind: 'chapter-blueprint', chapter: 1 }, summary: '建立第一章蓝图',
      replacement: '{"chapter":1,"title":"退潮来信","purpose":"让林夏收到第一封未来信件。","beats":["夜潮退去","海床显出信匣","信上写着弟弟明日的求救"],"characterIds":["lin-xia"],"continuityNotes":["灯塔主灯在午夜熄灭"],"status":"planned"}',
    },
    {
      target: { kind: 'chapter-draft', chapter: 1 }, summary: '起草第一章', replacement: chapterText,
    },
  ]
  for (const change of changes) {
    await project.apply({
      kind: 'replace', target: change.target, baseRevision: 'absent', baseText: '',
      replacement: change.replacement, summary: change.summary,
    }, signal)
  }
}

async function readback(installedEntry, workspaceRoot) {
  const module = await import(`${pathToFileURL(installedEntry).href}?readback=${Date.now()}`)
  const project = module.openNovelProject(workspaceRoot)
  const result = await project.read({ kind: 'working-set', chapter: 1 }, new AbortController().signal)
  const draft = result.assets.find(asset => asset.target.kind === 'chapter-draft')
  const manifest = result.assets.find(asset => asset.target.kind === 'project')
  if (draft?.text !== chapterText) fail('Fresh-process readback did not recover the packaged first chapter')
  const projectData = JSON.parse(manifest?.text ?? '{}')
  if (projectData.creativeStrategy !== 'consistency-first') fail('Fresh-process readback lost the project strategy')
  process.stdout.write(`${JSON.stringify({ projectId: projectData.projectId, draftRevision: draft.revision })}\n`)
}

function parseOptions(args) {
  let harnessRoot = process.env.DSH_HARNESS_ROOT
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--harness-root') harnessRoot = args[++index]
    else if (value === '--qualification-root') fail('Qualification path must be a child owned by the fixed repository qualification root')
    else fail(`Unknown qualification option: ${value}`)
  }
  if (typeof harnessRoot !== 'string' || !isAbsolute(harnessRoot)) {
    fail('Qualification requires an absolute --harness-root or DSH_HARNESS_ROOT')
  }
  return {
    harnessRoot: resolve(harnessRoot),
    qualificationRoot: join(repositoryRoot, '.runtime', '.cache', 'dsh-ai-novel-qualification'),
  }
}

async function qualify(options) {
  const canonicalRepository = await realpath(repositoryRoot)
  const canonicalHarness = await realpath(options.harnessRoot)
  const qualificationBase = join(canonicalRepository, '.runtime', '.cache', 'dsh-ai-novel-qualification')
  const requestedQualificationRoot = resolve(options.qualificationRoot)
  if (requestedQualificationRoot !== qualificationBase) fail('Qualification root must be the fixed repository qualification directory')
  if (await exists(qualificationBase)) {
    const ownerPath = join(qualificationBase, '.vibe-owner.json')
    if (!(await exists(ownerPath))) fail('Existing qualification root is not owned by this ticket')
    const owner = objectOf(JSON.parse(await readFile(ownerPath, 'utf8')), 'Qualification root owner')
    if (owner.owner !== 'codex-ticket-107' || owner.sourceProject !== canonicalRepository) {
      fail('Existing qualification root is owned by a different task or project')
    }
  } else {
    await mkdir(qualificationBase, { recursive: true })
  }
  const qualificationRoot = await realpath(requestedQualificationRoot)
  assertInside(await realpath(join(canonicalRepository, '.runtime', '.cache')), qualificationRoot)
  const rootOwner = ownershipRecord(
    qualificationRoot, canonicalRepository, 'AI novel plugin qualification evidence root', 7,
    'Small receipts and the latest disposable run support review and rerun diagnostics.',
  )
  await writeJson(join(qualificationRoot, '.vibe-owner.json'), rootOwner)
  const slug = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const runRoot = join(qualificationRoot, 'runs', `${slug}-${process.pid}`)
  assertInside(qualificationRoot, runRoot)
  const artifactsRoot = join(runRoot, 'artifacts')
  const logRoot = join(runRoot, 'logs')
  const dshHome = join(runRoot, 'dsh-home')
  const workspaceRoot = join(runRoot, 'novel-workspace')
  const browserRoot = join(qualificationRoot, 'playwright-browsers')
  await Promise.all([mkdir(artifactsRoot, { recursive: true }), mkdir(logRoot, { recursive: true }), mkdir(workspaceRoot, { recursive: true })])
  const runOwner = ownershipRecord(
    runRoot, canonicalRepository, 'Tarball and disposable Harness Web profile qualification', 1,
    'Retained briefly with command logs, installed profile, tarball, and readback workspace for audit.',
  )
  await writeJson(join(runRoot, '.vibe-owner.json'), runOwner)
  const receiptPath = join(qualificationRoot, 'latest-receipt.json')
  const env = {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_AGENTS_HOME: join(runRoot, '.agents'),
    PLAYWRIGHT_BROWSERS_PATH: browserRoot,
  }
  const commands = []
  try {
    const sourceManifest = await checkSource()
    const sourceCommit = (await recordCommand(logRoot, 'source-commit-initial', 'git', ['rev-parse', 'HEAD'], { cwd: canonicalRepository })).stdout.trim()
    const sourceUnstaged = await recordCommand(logRoot, 'source-unstaged', 'git', ['diff', '--name-only'], { cwd: canonicalRepository })
    if (sourceUnstaged.stdout.trim() !== '') fail('Source checkout must have no unstaged changes during qualification')
    const sourceDiff = await recordCommand(logRoot, 'source-staged-diff', 'git', ['diff', '--cached', '--binary'], { cwd: canonicalRepository })
    const sourceDiffSha256 = createHash('sha256').update(sourceDiff.stdout).digest('hex')
    const harnessStatus = await recordCommand(logRoot, 'harness-status', 'git', ['status', '--porcelain=v1'], { cwd: canonicalHarness })
    if (harnessStatus.stdout.trim() !== '') fail('Harness checkout must be clean for artifact qualification')
    const harnessCommit = (await recordCommand(logRoot, 'harness-commit', 'git', ['rev-parse', 'HEAD'], { cwd: canonicalHarness })).stdout.trim()
    assertHarnessCommit(harnessCommit)
    commands.push(await runPnpm(logRoot, 'plugin-typecheck', ['run', 'typecheck'], { cwd: packageRoot }))
    commands.push(await runPnpm(logRoot, 'plugin-test', ['run', 'test'], { cwd: packageRoot, timeout: 180_000 }))
    commands.push(await runPnpm(logRoot, 'electron-typecheck', ['run', 'typecheck'], { cwd: canonicalRepository, timeout: 180_000 }))
    commands.push(await runPnpm(logRoot, 'electron-renderer-tests', ['exec', 'vitest', 'run', 'src'], { cwd: canonicalRepository, timeout: 300_000 }))
    commands.push(await runPnpm(logRoot, 'electron-main-tests', ['exec', 'vitest', 'run', 'electron', '--maxWorkers=1'], { cwd: canonicalRepository, timeout: 300_000 }))
    commands.push(await runPnpm(logRoot, 'electron-release-tests', ['exec', 'vitest', 'run', 'scripts'], { cwd: canonicalRepository, timeout: 300_000 }))
    commands.push(await runPnpm(logRoot, 'harness-build', ['run', 'build'], { cwd: canonicalHarness, timeout: 300_000 }))

    const tarball = join(artifactsRoot, 'ethanyoq-dsh-ai-novel-writer-0.1.0.tgz')
    commands.push(await runPnpm(logRoot, 'plugin-pack', ['pack', '--out', tarball], { cwd: packageRoot, timeout: 180_000 }))
    if (!(await exists(tarball)) || (await stat(tarball)).size === 0) fail('pnpm pack did not produce the qualification tarball')
    const tarList = await recordCommand(logRoot, 'tarball-list', 'tar', ['-tf', tarball], { cwd: runRoot })
    const tarEntries = tarList.stdout.trimEnd().split(/\r?\n/)
    assertTarballEntries(tarEntries)
    const tarballInstallSpec = process.platform === 'win32' && /\s/.test(tarball) ? `"${tarball}"` : tarball

    await runDsh(logRoot, 'profile-initialize', canonicalHarness, ['--profile', profileName, '--dump-config'], env, 120_000)
    await runDsh(logRoot, 'profile-install', canonicalHarness, ['plugin', '--profile', profileName, 'add', tarballInstallSpec, '--ignore-scripts'], env, 240_000)
    const profileRoot = join(dshHome, 'profiles', profileName)
    const profileManifestPath = join(profileRoot, 'package.json')
    const installedRoot = await realpath(join(profileRoot, 'node_modules', '@ethanyoq', 'dsh-ai-novel-writer'))
    const installedManifest = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'))
    if (installedManifest.name !== packageName || installedManifest.version !== sourceManifest.version) {
      fail('Installed profile package identity does not match the packed source manifest')
    }
    const profileInstalled = assertProfileInstalled(JSON.parse(await readFile(profileManifestPath, 'utf8')), basename(tarball))
    const dump = await runDsh(logRoot, 'profile-dump-installed', canonicalHarness, ['--profile', profileName, '--dump-config'], env, 120_000)
    if (!dump.stdout.includes(packageName) || dump.stdout.includes(canonicalRepository) || dump.stdout.includes('/src/index.ts')) {
      fail('Composed config did not resolve the installed bundle independently of development paths')
    }
    const preset = await qualifyPreset(installedRoot, runRoot)
    const presetTools = await qualifyPresetTools(logRoot, profileRoot, installedRoot, env)
    const firstHostHash = await sha256(join(installedRoot, 'lib', 'index.js'))
    await writeChapter(installedRoot, workspaceRoot)
    const readbackResult = await recordCommand(logRoot, 'chapter-restart-readback', process.execPath, [
      fileURLToPath(import.meta.url), '--readback', join(installedRoot, 'lib', 'index.js'), workspaceRoot,
    ], { cwd: runRoot, env, timeout: 60_000 })
    const readbackData = JSON.parse(readbackResult.stdout.trim())
    commands.push(await runPnpm(logRoot, 'playwright-chromium', ['exec', 'playwright', 'install', 'chromium'], {
      cwd: canonicalRepository,
      env,
      timeout: 300_000,
    }))
    const firstWeb = await probeWeb(logRoot, 'web-installed', canonicalHarness, env)

    await runDsh(logRoot, 'profile-uninstall', canonicalHarness, ['plugin', '--profile', profileName, 'remove', packageName], env, 240_000)
    assertProfileRemoved(JSON.parse(await readFile(profileManifestPath, 'utf8')))
    if (await exists(join(profileRoot, 'node_modules', '@ethanyoq', 'dsh-ai-novel-writer'))) {
      fail('Profile uninstall retained the installed package directory')
    }
    await runDsh(logRoot, 'profile-reinstall', canonicalHarness, ['plugin', '--profile', profileName, 'add', tarballInstallSpec, '--ignore-scripts'], env, 240_000)
    const reinstalledRoot = await realpath(join(profileRoot, 'node_modules', '@ethanyoq', 'dsh-ai-novel-writer'))
    assertProfileInstalled(JSON.parse(await readFile(profileManifestPath, 'utf8')), basename(tarball))
    if (await sha256(join(reinstalledRoot, 'lib', 'index.js')) !== firstHostHash) {
      fail('Reinstalled Host entry bytes differ from the first tarball installation')
    }
    const finalDump = await runDsh(logRoot, 'profile-dump-reinstalled', canonicalHarness, ['--profile', profileName, '--dump-config'], env, 120_000)
    if (!finalDump.stdout.includes(packageName)) fail('Reinstalled bundle is absent from the composed config')
    const secondWeb = await probeWeb(logRoot, 'web-reinstalled', canonicalHarness, env)

    const finalSourceCommit = (await recordCommand(logRoot, 'source-commit-final', 'git', ['rev-parse', 'HEAD'], { cwd: canonicalRepository })).stdout.trim()
    const finalSourceUnstaged = await recordCommand(logRoot, 'source-unstaged-final', 'git', ['diff', '--name-only'], { cwd: canonicalRepository })
    const finalSourceDiff = await recordCommand(logRoot, 'source-staged-diff-final', 'git', ['diff', '--cached', '--binary'], { cwd: canonicalRepository })
    const finalHarnessCommit = (await recordCommand(logRoot, 'harness-commit-final', 'git', ['rev-parse', 'HEAD'], { cwd: canonicalHarness })).stdout.trim()
    const finalHarnessStatus = await recordCommand(logRoot, 'harness-status-final', 'git', ['status', '--porcelain=v1'], { cwd: canonicalHarness })
    if (finalSourceCommit !== sourceCommit
      || finalSourceUnstaged.stdout.trim() !== ''
      || createHash('sha256').update(finalSourceDiff.stdout).digest('hex') !== sourceDiffSha256
      || finalHarnessCommit !== harnessCommit
      || finalHarnessStatus.stdout.trim() !== '') {
      fail('Source or Harness state changed during qualification')
    }

    const receipt = {
      status: 'passed',
      ticket: 107,
      createdAt: new Date().toISOString(),
      source: {
        repository: canonicalRepository,
        commit: sourceCommit,
        stagedDiffSha256: sourceDiffSha256,
      },
      harness: { repository: canonicalHarness, commit: harnessCommit, clean: true },
      artifact: { path: tarball, sha256: await sha256(tarball), bytes: (await stat(tarball)).size, entries: tarEntries.length },
      profile: { name: profileName, root: profileRoot, dependency: profileInstalled.specifier, bundles: profileInstalled.bundles },
      preset,
      presetTools,
      persistence: readbackData,
      web: { first: firstWeb, afterReinstall: secondWeb },
      checks: commands.map(command => ({ label: command.label, startedAt: command.startedAt, finishedAt: command.finishedAt })),
      ownership: { root: join(qualificationRoot, '.vibe-owner.json'), run: join(runRoot, '.vibe-owner.json'), expiresAt: runOwner.expiresAt },
    }
    await writeJson(join(runRoot, 'qualification-receipt.json'), receipt)
    await writeJson(receiptPath, receipt)
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
  } catch (error) {
    await writeJson(join(runRoot, 'qualification-failure.json'), {
      status: 'failed', ticket: 107, failedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error), ownership: runOwner,
    })
    throw error
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--check-source') {
    await checkSource()
    process.stdout.write('source qualification passed\n')
    return
  }
  if (args[0] === '--validate-preset') {
    const path = args[1]
    if (path === undefined) fail('--validate-preset requires a path')
    await validatePreset(resolve(path))
    process.stdout.write('preset qualification passed\n')
    return
  }
  if (args[0] === '--validate-harness-commit') {
    const commit = args[1]
    if (commit === undefined) fail('--validate-harness-commit requires a commit')
    assertHarnessCommit(commit)
    process.stdout.write('Harness commit qualification passed\n')
    return
  }
  if (args[0] === '--probe-command-timeout') {
    const logRoot = args[1]
    if (logRoot === undefined) fail('--probe-command-timeout requires an owned log root')
    await probeCommandTimeout(resolve(logRoot))
    return
  }
  if (args[0] === '--readback') {
    const installedEntry = args[1]
    const workspaceRoot = args[2]
    if (installedEntry === undefined || workspaceRoot === undefined) fail('--readback requires installed entry and workspace paths')
    await readback(resolve(installedEntry), resolve(workspaceRoot))
    return
  }
  await qualify(parseOptions(args))
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})

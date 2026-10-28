/* global process */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import { startFakeModel } from './fake-model.mjs'
import { assertNodeRunsTypeScript } from './node-version.mjs'
import { dismissCompletionToasts, dismissStartupNotice, firstInteractiveControl, waitForShell } from './pages/shell.mjs'

const asEntryPoint = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
// 场景模块会 import 应用里的 .ts：静态 import 会在任何代码运行前报 ERR_UNKNOWN_FILE_EXTENSION，所以先查再动态加载。
// 只在作为入口运行时查：vitest 导入驱动时 .ts 由 vite 转译，用不到 Node 的类型剥离
if (asEntryPoint) try { assertNodeRunsTypeScript(process.version, process.features.typescript) } catch (error) {
  process.stderr.write(`${error.message}
`)
  process.exit(2)
}
const [
  { ARCH_SCENARIOS }, { RUN_SCENARIOS }, { BLUEPRINT_SCENARIOS }, { CHAPTER_SCENARIOS }, { REFS_SCENARIOS },
  { VISUAL_SCENARIOS }, { X1_SCENARIOS }, { X2_SCENARIOS }, { RDX3_SCENARIOS }, { RD10_SCENARIOS }, { README_SCENARIOS }, { CONTRAST_SCENARIOS }, { F491_SCENARIOS }, { F484_SCENARIOS }, { ST504_SCENARIOS }, { F512_SCENARIOS }, { SM517_SCENARIOS }, { BPG_SCENARIOS }, { IMPORT_INFER_SCENARIOS }, { RBK_SCENARIOS }, { F537_SCENARIOS }, { D77_SCENARIOS },
  { BASELINE_SESSIONS, EXTRA_SCENARIOS, SCENARIOS: BASELINE_SCENARIOS, STAGE_SCENARIOS },
] = await Promise.all([
  import('./arch-scenarios.mjs'), import('./run-scenarios.mjs'), import('./blueprint-scenarios.mjs'), import('./chapter-scenarios.mjs'),
  import('./refs-scenarios.mjs'), import('./visual-scenarios.mjs'), import('./x1-scenarios.mjs'), import('./x2-scenarios.mjs'),
  import('./rdx3-scenarios.mjs'), import('./rd10-scenarios.mjs'), import('./readme-scenarios.mjs'), import('./contrast-scenarios.mjs'), import('./f491-scenarios.mjs'), import('./f484-scenarios.mjs'), import('./st504-scenarios.mjs'), import('./f512-scenarios.mjs'), import('./sm517-scenarios.mjs'), import('./bpg-scenarios.mjs'), import('./import-infer-scenarios.mjs'), import('./rbk-scenarios.mjs'), import('./f537-scenarios.mjs'), import('./d77-scenarios.mjs'), import('./scenarios.mjs'),
])

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const OFFSCREEN_WINDOW = fileURLToPath(new URL('./offscreen-window.cjs', import.meta.url))
const TIMEOUT = 60_000
const VIEWPORT = { width: 1440, height: 900 }
const THEMES = ['light', 'dark']
const SHELLS = ['writer', 'stage']
const ROOT_NAMES = ['legacy', 'canonical', 'userData', 'home', 'appData', 'localAppData', 'temp', 'projects']
const SCENARIOS = { ...BASELINE_SCENARIOS, ...EXTRA_SCENARIOS, ...STAGE_SCENARIOS, ...RUN_SCENARIOS, ...ARCH_SCENARIOS, ...BLUEPRINT_SCENARIOS, ...CHAPTER_SCENARIOS, ...REFS_SCENARIOS, ...VISUAL_SCENARIOS, ...X1_SCENARIOS, ...X2_SCENARIOS, ...RDX3_SCENARIOS, ...RD10_SCENARIOS, ...README_SCENARIOS, ...CONTRAST_SCENARIOS, ...F491_SCENARIOS, ...F484_SCENARIOS, ...ST504_SCENARIOS, ...F512_SCENARIOS, ...SM517_SCENARIOS, ...BPG_SCENARIOS, ...IMPORT_INFER_SCENARIOS, ...RBK_SCENARIOS, ...F537_SCENARIOS, ...D77_SCENARIOS }
/** 计时会话：先在同一隔离目录预启动一次写好外观（书房计时另建 20 部作品），再计之后那次冷启动。 */
const TIMED_SESSIONS = new Set(['startup-timing', 'library-timing'])
/** 空闲内存：与启动计时同样先预启动一次，第二次冷启动到可交互后静置，再按间隔采样全部进程的内存。 */
const IDLE_SESSIONS = new Set(['idle-memory'])
const PREPARED_SESSIONS = new Set([...TIMED_SESSIONS, ...IDLE_SESSIONS])
const IDLE_SETTLE_MS = 10_000
const IDLE_SAMPLES = 5
const IDLE_SAMPLE_INTERVAL_MS = 1_000
export const SHELF_BOOKS = 20
const ALL_SCENARIOS = [...Object.keys(SCENARIOS), 'baseline-all', ...PREPARED_SESSIONS]
const USAGE = `用法: node scripts/redesign/drive.mjs --scenario <名称> [--theme light|dark] [--shell writer|stage] [--out <目录>] [--dump-dom] [--console] [--video] [--app-root <目录>]
场景: ${ALL_SCENARIOS.join(', ')}`

export function parseArgs(argv) {
  const options = { scenario: null, theme: 'light', shell: null, out: path.join(repository, '.runtime', 'redesign-baseline'),
    dumpDom: false, console: false, video: false, appRoot: repository }
  const valueOf = (flag, index) => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 缺少取值\n${USAGE}`)
    return value
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--') continue
    else if (arg === '--scenario') options.scenario = valueOf(arg, index++)
    else if (arg === '--theme') options.theme = valueOf(arg, index++)
    else if (arg === '--shell') options.shell = valueOf(arg, index++)
    else if (arg === '--out') options.out = path.resolve(valueOf(arg, index++))
    else if (arg === '--app-root') options.appRoot = path.resolve(valueOf(arg, index++))
    else if (arg === '--dump-dom') options.dumpDom = true
    else if (arg === '--console') options.console = true
    else if (arg === '--video') options.video = true
    else throw new Error(`未知参数 ${arg}\n${USAGE}`)
  }
  if (!ALL_SCENARIOS.includes(options.scenario)) throw new Error(`未知或缺少场景 ${options.scenario}\n${USAGE}`)
  if (!THEMES.includes(options.theme)) throw new Error(`--theme 只接受 ${THEMES.join('|')}`)
  if (options.shell !== null && !SHELLS.includes(options.shell)) throw new Error(`--shell 只接受 ${SHELLS.join('|')}`)
  return options
}

/** Electron 的全部可写根都落在 parent 下的一个新目录里；项目路径要短，原生存储有长度上限。 */
export function createIsolatedRoots(parent) {
  fs.mkdirSync(parent, { recursive: true })
  const root = fs.mkdtempSync(path.join(parent, 'd'))
  const roots = Object.fromEntries(ROOT_NAMES.map(name => [name, path.join(root, name)]))
  for (const [name, directory] of Object.entries(roots)) if (name !== 'canonical') fs.mkdirSync(directory, { recursive: true })
  return { root, ...roots }
}

export function isolatedEnvironment(roots, base = process.env) {
  const env = { ...base, AI_NOVEL_APP_DATA_HOME: roots.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: roots.legacy,
    AI_NOVEL_VELA_HOME: roots.legacy, HOME: roots.home, USERPROFILE: roots.home, APPDATA: roots.appData,
    LOCALAPPDATA: roots.localAppData, TEMP: roots.temp, TMP: roots.temp }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT', 'AI_NOVEL_SMOKE_PROJECT_MARKER']) delete env[name]
  return env
}

function scratchParent() {
  const base = process.env.LOCALAPPDATA ?? os.tmpdir()
  return path.join(base, 'VibeCodingScratch', 'an', 'drive')
}

/** 用户真实配置目录。运行前后逐个比较其中的条目，证明隔离目录之外没有写入。 */
function realProfileDirectories() {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  return [path.join(os.homedir(), '.vela'), path.join(appData, 'ai-novel-writer'), path.join(appData, 'AI小说作家')]
}

/** 本机开着的书童约每 5 分钟刷新一次这几个 Chromium 缓存里文件的修改时间，所以它们的变化不能说明隔离失效，只列进 externalWritesIgnored。 */
const RUNNING_INSTANCE_CACHES = new Set(['GPUCache', 'DawnWebGPUCache', 'DawnGraphiteCache'])

/** 路径到「大小:修改时间」，目录只记存在，不存在的路径不记。超过 limit 个条目时报错：截断的快照会漏掉写入。 */
function profileEntries(target, entries, limit) {
  let stat
  try { stat = fs.lstatSync(target) } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return entries
    throw error
  }
  if (entries.size >= limit) throw new Error(`真实配置目录的条目超过 ${limit} 个，外部写入没法完整比较（停在 ${target}）`)
  if (!stat.isDirectory()) return entries.set(target, `${stat.size}:${stat.mtimeMs}`)
  let names
  try { names = fs.readdirSync(target) } catch (error) {
    // 运行中的书童可能在 lstat 与 readdir 之间删掉缓存目录
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return entries
    throw error
  }
  entries.set(target, 'dir')
  for (const name of names) profileEntries(path.join(target, name), entries, limit)
  return entries
}

export function snapshotRealProfiles(directories = realProfileDirectories(), limit = 50_000) {
  return Object.fromEntries(directories.map(directory => [directory, profileEntries(directory, new Map(), limit)]))
}

export function profileWrites(before) {
  const after = snapshotRealProfiles(Object.keys(before))
  const changed = Object.keys(before).flatMap(directory => {
    const previous = before[directory]
    const current = after[directory]
    return [...new Set([...previous.keys(), ...current.keys()])]
      .filter(entry => previous.get(entry) !== current.get(entry))
      .map(entry => ({ entry, ignored: RUNNING_INSTANCE_CACHES.has(path.relative(directory, entry).split(path.sep)[0]) }))
  })
  const entries = ignored => changed.filter(change => change.ignored === ignored).map(change => change.entry).sort()
  return { externalWrites: entries(false), externalWritesIgnored: entries(true) }
}

/** 以 --user-data-dir 匹配仍存活的 Electron 主进程与子进程。 */
function liveProcesses(userData) {
  const needle = userData.toLowerCase()
  if (process.platform === 'win32') {
    const script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"
    const output = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    return output.split(/\r?\n/).filter(line => line.toLowerCase().includes(needle)).map(line => Number(line.split('\t')[0]))
  }
  const output = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
  return output.split('\n').filter(line => line.toLowerCase().includes(needle)).map(line => Number(line.trim().split(/\s+/)[0]))
}

/** close 返回时 GPU、渲染等子进程可能还在退出，给它们约 3 秒。 */
async function residualProcesses(userData) {
  for (let attempt = 1; ; attempt++) {
    const pids = liveProcesses(userData)
    if (pids.length === 0 || attempt === 10) return pids
    await delay(300)
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) { return error.code === 'EPERM' }
}

/** close 失败时进程可能已自行退出，这时 taskkill 报「not found」；进程已不存在即视为已退出，不算强杀。 */
export async function quit(app, graceMs = 10_000) {
  const pid = app.process().pid
  let timer
  const closed = await Promise.race([app.close().then(() => true).catch(() => false),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), graceMs) })])
  clearTimeout(timer)
  if (closed || !pid || !isAlive(pid)) return { forced: false }
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else process.kill(pid, 'SIGKILL')
  } catch (error) {
    if (isAlive(pid)) throw error
  }
  return { forced: true }
}

/**
 * 隔离目录是新建的，应用没有存过界面语言，会按 navigator.language 取；非中文宿主上会落到英文，而场景全程按中文找控件。
 * --lang 固定 Chromium 的界面语言，宿主语言不再影响结果。
 */
export function launchArgs(roots) {
  return ['-r', OFFSCREEN_WINDOW, '.', `--user-data-dir=${roots.userData}`, '--lang=zh-CN']
}

/** 失败现场：截图、DOM 与无障碍树。取证本身失败不能盖掉原来的错误。 */
export async function captureFailure(page, base) {
  if (!page || page.isClosed()) return
  await page.screenshot({ path: `${base}.failure.png` }).catch(() => {})
  await dumpDom(page, base).catch(() => {})
}

/** 外部写入与残留进程都要留着隔离目录取证；只有全部检查通过才删。 */
export function sessionIsClean({ failedAt, sessionErrors, residualProcesses, externalWrites }) {
  return failedAt === null && sessionErrors.length === 0 && residualProcesses?.length === 0 && externalWrites?.length === 0
}

async function launch({ roots, appRoot, fakeModelPort, diagnostics, failureBase, shelfBooks = 0, renderTiming = false }) {
  const launchedAt = Date.now()
  const env = { ...isolatedEnvironment(roots), ...(renderTiming ? { DRIVE_RENDER_TIMING: String(shelfBooks || 1) } : {}) }
  const app = await electron.launch({ cwd: appRoot, args: launchArgs(roots), env, timeout: TIMEOUT })
  let page
  try {
    await app.evaluate((_, port) => {
      const originalFetch = globalThis.fetch
      globalThis.__driveExternalRequests = []
      globalThis.fetch = async (input, options) => {
        const url = new URL(String(input instanceof Request ? input.url : input))
        // 本机检索模型直接把 base_url 配成假服务的本机地址，这类请求原样放行。
        if (port !== null && url.origin === `http://127.0.0.1:${port}`) return originalFetch(input, options)
        if (port === null || url.origin !== 'https://api.openai.com' || !url.pathname.startsWith('/v1/')) {
          globalThis.__driveExternalRequests.push(url.origin)
          throw new Error('DRIVE_EXTERNAL_FETCH_REFUSED')
        }
        return originalFetch(`http://127.0.0.1:${port}${url.pathname}`, options)
      }
    }, fakeModelPort ?? null)
    app.process().stdout?.on('data', chunk => diagnostics.push(`[main:stdout] ${String(chunk).trimEnd()}`))
    app.process().stderr?.on('data', chunk => diagnostics.push(`[main:stderr] ${String(chunk).trimEnd()}`))
    page = await app.firstWindow({ timeout: TIMEOUT })
    page.on('console', message => diagnostics.push(`[renderer:${message.type()}] ${message.text()}`))
    page.on('pageerror', error => diagnostics.push(`[renderer:pageerror] ${error.stack ?? error.message}`))
    await firstInteractiveControl(page).waitFor({ state: 'visible', timeout: TIMEOUT })
    const interactiveAt = Date.now()
    const { readyToShow } = await app.evaluate(() => globalThis.__driveTiming)
    const timeOrigin = await page.evaluate(() => performance.timeOrigin)
    const timing = { launchToInteractiveMs: interactiveAt - launchedAt,
      readyToShowToInteractiveMs: readyToShow === null ? null : interactiveAt - readyToShow,
      navigationToInteractiveMs: Math.round(interactiveAt - timeOrigin) }
    // 页面里记下的时刻（导航开始为 0）：书房「新建作品」进入 DOM，书架上的书（旧欢迎页与新书房都是「预览《书名》」按钮）到齐。
    if (renderTiming) {
      const read = name => page.waitForFunction(attribute => document.documentElement.getAttribute(attribute), `data-drive-${name}`, { timeout: TIMEOUT })
        .then(handle => handle.jsonValue()).then(Number)
      timing.renderInteractiveMs = await read('interactive')
      if (shelfBooks > 0) {
        timing.renderShelfMs = await read('shelf')
        timing.renderIdleMs = await read('idle')
      }
    }
    page.setDefaultTimeout(20_000)
    assert.equal(path.resolve(await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))), roots.userData)
    await page.setViewportSize(VIEWPORT)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForShell(page, TIMEOUT)
    await dismissStartupNotice(page)
    assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
    return { app, page, timing }
  } catch (error) {
    // 启动失败时调用方拿不到 page，只能在退出前就地取证
    await captureFailure(page, failureBase)
    await quit(app)
    throw error
  }
}

const invoke = (page, channel, ...args) =>
  page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })

const APPEARANCE_V3_KEY = 'ai-novel-writer-appearance-v3'
const APPEARANCE_PREVIOUS_KEY = 'ai-novel-writer-appearance'

/**
 * 外观写到被测构建在读的那个键。RD-10 起只有 v3 键（只有浅色与深色，没有外壳偏好）；
 * trunk 只有旧键，主题与外壳在同一次写入里改，shell 为 null 时不碰外壳偏好，版本号与它的 serializeAppearanceProfile 一致：
 * 只有新外壳写 v2，其余写 v1。两个键都还没有时返回 null。
 */
export function appearanceWrite(stored, { theme, shell }) {
  if (stored.v3 !== null) {
    if (shell === 'writer') throw new Error('被测构建只有纸墨外壳，不能选 --shell writer')
    const current = JSON.parse(stored.v3)
    return { key: APPEARANCE_V3_KEY, value: { ...current, colorTheme: theme, revision: current.revision + 1, origin: 'author' } }
  }
  if (stored.previous === null) return null
  const current = JSON.parse(stored.previous)
  const value = { ...current, colorTheme: theme, ...(shell ? { shellPreference: shell } : {}), revision: current.revision + 1, origin: 'author' }
  value.schemaVersion = value.shellPreference === 'stage' ? 2 : 1
  return { key: APPEARANCE_PREVIOUS_KEY, value }
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

/**
 * 空闲内存：每次采样是 app.getAppMetrics() 的全部进程，合计工作集与私有字节（KB，Windows 才有私有字节），
 * 取各次合计的中位数；按进程类型的工作集也各取中位数。
 */
export function idleMemory(samples) {
  if (samples.length === 0) throw new Error('空闲内存没有采样')
  const total = (metrics, field) => metrics.reduce((sum, metric) => sum + (metric.memory[field] ?? 0), 0)
  const types = [...new Set(samples.flatMap(metrics => metrics.map(metric => metric.type)))]
  return {
    samples: samples.length,
    workingSetKB: median(samples.map(metrics => total(metrics, 'workingSetSize'))),
    privateKB: median(samples.map(metrics => total(metrics, 'privateBytes'))),
    byType: Object.fromEntries(types.map(type => [type,
      median(samples.map(metrics => total(metrics.filter(metric => metric.type === type), 'workingSetSize')))])),
  }
}

async function sampleIdleMemory(app) {
  await delay(IDLE_SETTLE_MS)
  const samples = []
  for (let index = 0; index < IDLE_SAMPLES; index++) {
    if (index > 0) await delay(IDLE_SAMPLE_INTERVAL_MS)
    samples.push(await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map(({ type, memory }) => ({ type, memory }))))
  }
  return idleMemory(samples)
}

/** 改主题（trunk 上连同外壳偏好）后重载一次。 */
async function applyAppearance(page, appearance) {
  const keys = { v3: APPEARANCE_V3_KEY, previous: APPEARANCE_PREVIOUS_KEY }
  await page.waitForFunction(({ v3, previous }) => localStorage.getItem(v3) !== null || localStorage.getItem(previous) !== null, keys, { timeout: TIMEOUT })
  const stored = await page.evaluate(({ v3, previous }) => ({ v3: localStorage.getItem(v3), previous: localStorage.getItem(previous) }), keys)
  const write = appearanceWrite(stored, appearance)
  await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), write)
  await page.reload()
  await waitForShell(page, TIMEOUT)
}

/**
 * 启动计时量的是同一配置目录里的第二次冷启动：先启动一次写好主题（与外壳偏好）再退出，两侧都这样做。
 * 首次启动还要迁移旧配置、建库，与之后的启动不可比。
 */
async function prepareProfile({ roots, appRoot, diagnostics, failureBase }, appearance, shelfBooks = 0) {
  const prepared = await launch({ roots, appRoot, fakeModelPort: null, diagnostics, failureBase })
  try {
    await applyAppearance(prepared.page, appearance)
    if (shelfBooks > 0) await seedShelf(prepared, roots, shelfBooks)
  } finally { await quit(prepared.app) }
}

/** 用公开 IPC 新建 count 部作品；新建即进入最近项目，书房的书架上就有 count 本书。 */
async function seedShelf({ app, page }, roots, count) {
  for (let index = 1; index <= count; index++) {
    const grant = await chooseProjectDirectoryGrant(app, page, roots.projects)
    const created = await invoke(page, 'project:create', { parentGrantId: grant.grantId, name: `书架${String(index).padStart(2, '0')}`,
      genre: '悬疑', targetAudience: '全龄', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(created.success, true, created.error)
  }
  assert.equal((await invoke(page, 'project:recent-list')).length, count, `最近项目应有 ${count} 部`)
}

/**
 * 录屏：用 CDP 的 Page.startScreencast 收集画面变化时的帧，按帧时间戳交给本机 ffmpeg 编成 H.264 mp4。
 * Playwright 的 recordVideo 需要另外下载它自带的 ffmpeg，这里不依赖它。
 */
async function startScreencast(page) {
  const frames = []
  let session
  const attach = async target => {
    session = await target.context().newCDPSession(target)
    const own = session
    own.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      frames.push({ data, time: metadata.timestamp })
      own.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
    })
    await own.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height })
  }
  const detach = async () => {
    await session.send('Page.stopScreencast')
    await session.detach().catch(() => {})
  }
  await attach(page)
  return {
    /** context.restart() 退出应用前停在旧页面上，冷启动后接到新页面接着录，帧都进同一段视频。 */
    pause: detach,
    resume: attach,
    async stop(file, scratch) {
      await detach()
      assert.ok(frames.length > 1, '录屏没有收到画面')
      const directory = fs.mkdtempSync(path.join(scratch, 'frames-'))
      const lines = ['ffconcat version 1.0']
      frames.forEach((frame, index) => {
        const name = `${String(index).padStart(5, '0')}.jpg`
        fs.writeFileSync(path.join(directory, name), Buffer.from(frame.data, 'base64'))
        const next = frames[index + 1]?.time ?? frame.time + 1
        lines.push(`file '${name}'`, `duration ${Math.max(0.001, next - frame.time).toFixed(4)}`)
      })
      lines.push(`file '${String(frames.length - 1).padStart(5, '0')}.jpg'`)
      fs.writeFileSync(path.join(directory, 'frames.ffconcat'), lines.map(line => `${line}\n`).join(''))
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(directory, 'frames.ffconcat'),
        '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file],
      { windowsHide: true })
      return file
    },
  }
}

async function shoot(page, file) {
  await page.evaluate(() => document.fonts.ready)
  await dismissCompletionToasts(page)
  assert.equal(await page.evaluate(() => document.visibilityState), 'visible', '屏幕外窗口的页面被当作隐藏，截图会停帧')
  await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' })
}

async function dumpDom(page, base) {
  fs.writeFileSync(`${base}.dom.html`, await page.content())
  fs.writeFileSync(`${base}.aria.yml`, await page.locator('body').ariaSnapshot())
}

const messageOf = error => error instanceof Error ? error.message : String(error)

/** 一个会话一次冷启动：先跑首个截图点的 setup，再依次 run、截图、after。隔离与进程检查按会话做，结果抄进每一项。 */
async function runSession(sessionName, names, options) {
  const before = snapshotRealProfiles()
  const roots = createIsolatedRoots(scratchParent())
  const diagnostics = []
  const fake = names.some(name => SCENARIOS[name]?.model) ? await startFakeModel(diagnostics) : null
  const base = name => path.join(options.out, `${name}-${options.theme}`)
  const results = names.map(scenario => ({ scenario, theme: options.theme }))
  const shared = { session: sessionName, isolationRoot: roots.root }
  const sessionErrors = []
  let failedAt = null
  let current = null
  let launched
  let recording = null
  const restartRequests = []
  let currentAppRoot = options.appRoot
  const shell = names.map(name => SCENARIOS[name]?.shell).find(Boolean) ?? options.shell
  try {
    const shelfBooks = sessionName === 'library-timing' ? SHELF_BOOKS : 0
    const failureBase = base(sessionName)
    if (PREPARED_SESSIONS.has(sessionName)) await prepareProfile({ roots, appRoot: options.appRoot, diagnostics, failureBase }, { theme: options.theme, shell }, shelfBooks)
    launched = await launch({ roots, appRoot: options.appRoot, fakeModelPort: fake?.port, diagnostics, failureBase, shelfBooks, renderTiming: TIMED_SESSIONS.has(sessionName) })
    shared.timing = launched.timing
    const shellShown = page => page.locator('[data-shell-presentation]').first().getAttribute('data-shell-presentation')
    if (PREPARED_SESSIONS.has(sessionName)) {
      shared.shell = await shellShown(launched.page)
      if (IDLE_SESSIONS.has(sessionName)) shared.memory = await sampleIdleMemory(launched.app)
    } else {
      await applyAppearance(launched.page, { theme: options.theme, shell })
      shared.shell = await shellShown(launched.page)
      const context = {
        ...launched, roots, invoke, fake, diagnostics,
        /** 场景中途多拍一张图，与收尾截图放在同一目录。 */
        shoot: name => shoot(context.page, `${base(name)}.png`),
        reload: () => context.page.reload().then(() => waitForShell(context.page, TIMEOUT)),
        /** 退出应用再用同一隔离目录冷启动（真正的重启，不重写外观），context 换成新的 app 与 page。appRoot 换成另一份构建（旧版本造数据、新版本接着打开），之后不传时沿用上次启动的构建。 */
        restart: async ({ appRoot = currentAppRoot, beforeLaunch } = {}) => {
          restartRequests.push(...await launched.app.evaluate(() => globalThis.__driveExternalRequests))
          await recording?.pause()
          const exited = await quit(launched.app)
          assert.equal(exited.forced, false, '重启前应用没有正常退出')
          await beforeLaunch?.()
          launched = await launch({ roots, appRoot, fakeModelPort: fake?.port, diagnostics, failureBase })
          currentAppRoot = appRoot
          Object.assign(context, launched)
          await recording?.resume(context.page)
        },
      }
      current = 0
      await SCENARIOS[names[0]].setup?.(context)
      for (const [index, name] of names.entries()) {
        current = index
        results[index].screenshot = `${base(name)}.png`
        recording = options.video ? await startScreencast(context.page) : null
        const measured = await SCENARIOS[name].run(context)
        if (recording) results[index].video = await recording.stop(`${base(name)}.mp4`, roots.temp)
        recording = null
        if (measured) results[index].measured = measured
        await shoot(context.page, results[index].screenshot)
        if (options.dumpDom) await dumpDom(context.page, base(name))
        await SCENARIOS[name].after?.(context)
      }
      current = null
    }
    shared.externalRequests = [...restartRequests, ...await launched.app.evaluate(() => globalThis.__driveExternalRequests)]
    assert.deepEqual(shared.externalRequests, [], fake ? 'fetch 越过夹具访问外部网络' : '无夹具场景发出了 fetch')
  } catch (error) {
    if (current === null) sessionErrors.push(messageOf(error))
    else {
      failedAt = current
      results[current].error = messageOf(error)
    }
    await captureFailure(launched?.page, base(current === null ? sessionName : names[current]))
    options = { ...options, console: true }
  } finally {
    // 场景在 hold 与 release 之间抛错时门还关着：卡住的请求让运行一直进行，应用拒绝关闭，quit 要等满 10 秒再强杀
    fake?.gate.release()
    if (options.console) fs.writeFileSync(`${base(sessionName)}.console.log`, `${diagnostics.join('\n')}\n`)
    if (launched) shared.quit = await quit(launched.app).catch(error => { sessionErrors.push(messageOf(error)); return null })
    await fake?.close()
    if (fake) shared.modelRequests = fake.requests.length
  }
  try {
    shared.residualProcesses = await residualProcesses(roots.userData)
    Object.assign(shared, profileWrites(before))
  } catch (error) { sessionErrors.push(messageOf(error)) }
  const clean = sessionIsClean({ failedAt, sessionErrors, residualProcesses: shared.residualProcesses, externalWrites: shared.externalWrites })
  if (clean) fs.rmSync(roots.root, { recursive: true, force: true })
  return results.map((result, index) => {
    const errors = [result.error, failedAt !== null && index > failedAt ? `未运行：本会话的 ${names[failedAt]} 先失败` : null, ...sessionErrors]
    const error = errors.filter(Boolean).join('\n')
    return { ...result, ...shared, ...(error ? { error } : {}) }
  })
}

async function main() {
  let options
  try { options = parseArgs(process.argv.slice(2)) } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(2)
  }
  fs.mkdirSync(options.out, { recursive: true })
  const sessions = options.scenario === 'baseline-all'
    ? Object.entries(BASELINE_SESSIONS).map(([name, scenarios]) => [`baseline-${name}`, scenarios])
    : [[options.scenario, [options.scenario]]]
  const results = []
  for (const [sessionName, names] of sessions) {
    for (const result of await runSession(sessionName, names, options)) {
      results.push(result)
      process.stdout.write(`${JSON.stringify(result)}\n`)
    }
  }
  const failed = results.filter(result => result.error || result.residualProcesses?.length !== 0 || result.externalWrites?.length !== 0)
  fs.writeFileSync(path.join(options.out, `${options.scenario}-${options.theme}.json`), JSON.stringify(results, null, 2))
  process.exitCode = failed.length ? 1 : 0
}

if (asEntryPoint) await main()

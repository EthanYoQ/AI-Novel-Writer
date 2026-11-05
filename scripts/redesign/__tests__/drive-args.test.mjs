import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, it, vi } from 'vitest'
vi.mock('playwright', () => ({ _electron: { launch: () => { throw new Error('UNIT_TEST_MUST_NOT_LAUNCH_ELECTRON') } } }))
import { appearanceWrite, assertBuilt, captureFailure, driveSessions, finishRealSession, idleMemory, createIsolatedRoots, isolatedEnvironment, launchArgs, parseArgs,
  releaseSessionRoot, scanRunForSecret, sessionIsClean, writeConsoleLog } from '../drive.mjs'
import { fileStamps } from '../real-model.mjs'
import { BASELINE_SESSIONS, SCENARIOS } from '../scenarios.mjs'

const parents = []
afterEach(() => { for (const parent of parents.splice(0)) fs.rmSync(parent, { recursive: true, force: true }) })
const tempParent = () => { const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-args-')); parents.push(parent); return parent }

it('pnpm 透传的 -- 与全部参数都能解析', () => {
  const options = parseArgs(['--', '--scenario', 'baseline-all', '--theme', 'dark', '--out', 'shots/x', '--dump-dom', '--console', '--app-root', '../trunk'])
  assert.equal(options.scenario, 'baseline-all')
  assert.equal(options.theme, 'dark')
  assert.equal(options.out, path.resolve('shots/x'))
  assert.equal(options.appRoot, path.resolve('../trunk'))
  assert.equal(options.dumpDom, true)
  assert.equal(options.console, true)
})

it('默认浅色、诊断关闭、输出到 .runtime/redesign-baseline', () => {
  const options = parseArgs(['--scenario', 'settings'])
  assert.equal(options.theme, 'light')
  assert.equal(options.dumpDom, false)
  assert.equal(options.console, false)
  assert.equal(path.basename(path.dirname(options.out)), '.runtime')
  assert.equal(path.basename(options.out), 'redesign-baseline')
})

it('拒绝缺失或未知的场景、主题与参数', () => {
  assert.throws(() => parseArgs([]), /未知或缺少场景/)
  assert.throws(() => parseArgs(['--scenario', 'nope']), /未知或缺少场景 nope/)
  assert.throws(() => parseArgs(['--scenario', 'settings', '--theme', 'paper']), /--theme 只接受 light\|dark/)
  assert.throws(() => parseArgs(['--scenario', '--theme', 'dark']), /--scenario 缺少取值/)
  assert.throws(() => parseArgs(['--scenario', 'settings', '--headless']), /未知参数 --headless/)
})

it('每次运行得到 parent 下全新的隔离根，canonical 留给应用自己创建', () => {
  const parent = tempParent()
  const first = createIsolatedRoots(parent)
  const second = createIsolatedRoots(parent)
  assert.notEqual(first.root, second.root)
  assert.equal(path.dirname(first.root), parent)
  for (const [name, directory] of Object.entries(first)) {
    if (name === 'root') continue
    assert.equal(path.dirname(directory), first.root, `${name} 不在隔离根内`)
    assert.equal(fs.existsSync(directory), name !== 'canonical', `${name} 创建状态不对`)
  }
})

it('子进程环境的全部可写根都指向隔离目录', () => {
  const roots = createIsolatedRoots(tempParent())
  const env = isolatedEnvironment(roots, { PATH: 'p', APPDATA: 'C:/real', ELECTRON_RUN_AS_NODE: '1',
    VITE_DEV_SERVER_URL: 'http://x', AI_NOVEL_SMOKE_OPEN_PROJECT: 'C:/real/project' })
  for (const name of ['AI_NOVEL_APP_DATA_HOME', 'AI_NOVEL_LEGACY_SOURCE_HOME', 'AI_NOVEL_VELA_HOME', 'HOME', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) {
    assert.ok(env[name].startsWith(roots.root + path.sep), `${name} 越出隔离根: ${env[name]}`)
  }
  assert.equal(env.PATH, 'p')
  for (const name of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) assert.equal(env[name], undefined)
})

it('baseline-all 的会话恰好覆盖每个场景一次', () => {
  assert.deepEqual(Object.values(BASELINE_SESSIONS).flat().sort(), Object.keys(SCENARIOS).sort())
})

it('启动参数固定中文界面，非中文宿主上场景照样按中文找控件', () => {
  const roots = createIsolatedRoots(tempParent())
  const args = launchArgs(roots)
  assert.ok(args.includes('--lang=zh-CN'))
  assert.ok(args.includes(`--user-data-dir=${roots.userData}`))
})

it('外部写入或残留进程时不算干净，隔离目录留着取证', () => {
  const ok = { failedAt: null, sessionErrors: [], residualProcesses: [], externalWrites: [] }
  assert.equal(sessionIsClean(ok), true)
  assert.equal(sessionIsClean({ ...ok, externalWrites: ['C:/Users/x/AppData/Roaming/ai-novel-writer'] }), false)
  assert.equal(sessionIsClean({ ...ok, residualProcesses: [4242] }), false)
  assert.equal(sessionIsClean({ ...ok, externalWrites: undefined }), false)
  assert.equal(sessionIsClean({ ...ok, failedAt: 0 }), false)
})

it('启动失败的取证：截图失败也照样写 DOM 与无障碍树，且不抛错', async () => {
  const parent = tempParent()
  const base = path.join(parent, 'stage-library-light')
  const page = {
    isClosed: () => false,
    screenshot: () => Promise.reject(new Error('Target closed')),
    content: async () => '<html><body>启动卡住</body></html>',
    locator: () => ({ ariaSnapshot: async () => '- text: 启动卡住' }),
  }
  await captureFailure(page, base)
  assert.equal(fs.readFileSync(`${base}.dom.html`, 'utf8'), '<html><body>启动卡住</body></html>')
  assert.equal(fs.readFileSync(`${base}.aria.yml`, 'utf8'), '- text: 启动卡住')
  await captureFailure(undefined, base)
})

it('外观写入跟着被测构建走：head 只有 v3 键，只改主题；trunk 只有旧键，照旧写外壳偏好与 v1、v2', () => {
  const v3 = { schemaVersion: 3, revision: 4, colorTheme: 'light', zoom: 1, writingFont: 'lxgw-wenkai', uiFont: 'noto-sans-sc', origin: 'legacy-import', legacyImportCompleted: true }
  assert.deepEqual(appearanceWrite({ v3: JSON.stringify(v3), previous: JSON.stringify({ schemaVersion: 1 }) }, { theme: 'dark', shell: 'stage' }), {
    key: 'ai-novel-writer-appearance-v3',
    value: { ...v3, colorTheme: 'dark', revision: 5, origin: 'author' },
  })
  assert.throws(() => appearanceWrite({ v3: JSON.stringify(v3), previous: null }, { theme: 'dark', shell: 'writer' }), /只有纸墨外壳/)

  const previous = { schemaVersion: 1, revision: 2, shellPreference: 'unset', colorTheme: 'light', zoom: 1 }
  assert.deepEqual(appearanceWrite({ v3: null, previous: JSON.stringify(previous) }, { theme: 'dark', shell: 'stage' }), {
    key: 'ai-novel-writer-appearance',
    value: { ...previous, schemaVersion: 2, shellPreference: 'stage', colorTheme: 'dark', revision: 3, origin: 'author' },
  })
  assert.deepEqual(appearanceWrite({ v3: null, previous: JSON.stringify(previous) }, { theme: 'light', shell: null }).value,
    { ...previous, revision: 3, origin: 'author' })
  assert.equal(appearanceWrite({ v3: null, previous: null }, { theme: 'light', shell: null }), null)
})

it('空闲内存取各次采样全部进程合计的中位数，按进程类型分列，单位 KB', () => {
  const sample = (browser, renderer, gpu) => [
    { type: 'Browser', memory: { workingSetSize: browser, privateBytes: browser - 10 } },
    { type: 'Tab', memory: { workingSetSize: renderer, privateBytes: renderer - 10 } },
    { type: 'GPU', memory: { workingSetSize: gpu, privateBytes: gpu - 10 } },
  ]
  assert.deepEqual(idleMemory([sample(100, 300, 50), sample(110, 290, 60), sample(90, 400, 40)]), {
    samples: 3,
    workingSetKB: 460,
    privateKB: 430,
    byType: { Browser: 100, Tab: 300, GPU: 50 },
  })
  assert.throws(() => idleMemory([]), /没有采样/)
})

it('真实模型场景只能带 --real-model 跑，--real-model 也不能用在假模型场景上', () => {
  assert.equal(parseArgs(['--scenario', 'real-main', '--real-model']).realModel, true)
  assert.equal(parseArgs(['--scenario', 'settings']).realModel, false)
  assert.throws(() => parseArgs(['--scenario', 'real-main']), /real-main 是真实模型场景，要带 --real-model/)
  assert.throws(() => parseArgs(['--scenario', 'finalize', '--real-model']), /--real-model 只用于真实模型场景/)
  assert.throws(() => parseArgs(['--scenario', 'real-main', '--real-model', '--api-key', 'sk-x']), /未知参数 --api-key/)
})

it('没构建的应用根直接报错，不去启动 Electron', () => {
  const root = tempParent()
  assert.throws(() => assertBuilt(root), /dist-electron[\\/]main\.js 不存在/)
  fs.mkdirSync(path.join(root, 'dist-electron'))
  fs.writeFileSync(path.join(root, 'dist-electron', 'main.js'), '')
  assertBuilt(root)
})

it('真实模式删模型配置失败时记进会话错误，隔离目录留着，收尾的密钥扫描照样查到并删掉', () => {
  const root = tempParent()
  const config = path.join(root, 'canonical', 'generations', 'g1', 'models.json')
  fs.mkdirSync(path.dirname(config), { recursive: true })
  fs.writeFileSync(config, '{"apiKey":"sk-test-secret"}')
  const shared = { isolationRoot: root }
  const sessionErrors = []
  finishRealSession({ shared, sessionErrors, modelLog: [{ path: '/v1/embeddings', status: 200, ms: 3 }], canonical: path.join(root, 'canonical'),
    remove: () => 'EBUSY' })
  assert.deepEqual(sessionErrors, [`删不掉模型配置 ${config}：EBUSY`])
  assert.equal(shared.modelRequests, 1)
  assert.equal(sessionIsClean({ failedAt: null, sessionErrors, residualProcesses: [], externalWrites: [] }), false)

  const out = tempParent()
  const outBefore = fileStamps(out)
  const results = [{ ...shared, error: sessionErrors.join('\n') }]
  scanRunForSecret(results, out, outBefore, 'sk-test-secret')
  assert.deepEqual(results[0].keyScan.hits, [config])
  assert.equal(fs.existsSync(config), false)
})

it('诊断日志写不进去时只记进会话错误，不打断后面的退出与凭据清理', () => {
  const sessionErrors = []
  writeConsoleLog(path.join(tempParent(), 'missing', 'x.console.log'), ['line'], sessionErrors)
  assert.equal(sessionErrors.length, 1)
  assert.match(sessionErrors[0], /ENOENT/)
  const file = path.join(tempParent(), 'ok.console.log')
  writeConsoleLog(file, ['a', 'b'], sessionErrors)
  assert.equal(fs.readFileSync(file, 'utf8'), 'a\nb\n')
})

it('含密钥的文件有一个删不掉时记下路径与原因，其余照删，结果里不含密钥', () => {
  const out = tempParent()
  const outBefore = fileStamps(out)
  const stuck = path.join(out, 'stuck.log')
  const other = path.join(out, 'other.log')
  for (const file of [stuck, other]) fs.writeFileSync(file, 'sk-test-secret')
  const results = [{ isolationRoot: path.join(out, 'gone') }]
  scanRunForSecret(results, out, outBefore, 'sk-test-secret', file => {
    if (file === stuck) return 'EBUSY'
    fs.rmSync(file)
    return null
  })
  assert.deepEqual(results[0].keyScan.removeFailures, [{ file: stuck, reason: 'EBUSY' }])
  assert.equal(fs.existsSync(other), false)
  assert.equal(JSON.stringify(results).includes('sk-test-secret'), false)
})

it('干净会话的隔离目录删不掉时记进会话错误，不抛；不干净的会话不删', () => {
  const sessionErrors = []
  const removed = []
  releaseSessionRoot('C:/iso/a', true, sessionErrors, () => 'EPERM')
  releaseSessionRoot('C:/iso/b', false, sessionErrors, root => { removed.push(root); return null })
  assert.deepEqual(sessionErrors, ['删不掉隔离目录 C:/iso/a：EPERM'])
  assert.deepEqual(removed, [])
})

it('会话里任一步抛错（含收尾清理），结果 JSON 照样写出、密钥扫描照样执行、退出码为失败', async () => {
  const out = tempParent()
  const root = path.join(tempParent(), 'iso')
  const leaked = path.join(root, 'canonical', 'models.json')
  const stdout = []
  const write = process.stdout.write
  process.stdout.write = chunk => { stdout.push(String(chunk)); return true }
  let exitCode
  try {
    exitCode = await driveSessions({
      sessions: [['real-x', ['real-x']]],
      options: { out, theme: 'light', scenario: 'real-x' },
      realKey: 'sk-test-secret',
      makeRoots: () => ({ root }),
      run: async () => {
        fs.mkdirSync(path.dirname(leaked), { recursive: true })
        fs.writeFileSync(leaked, '{"apiKey":"sk-test-secret"}')
        throw Object.assign(new Error('EBUSY: resource busy or locked, rmdir'), { code: 'EBUSY' })
      },
    })
  } finally { process.stdout.write = write }
  assert.equal(exitCode, 1)
  const written = fs.readFileSync(path.join(out, 'real-x-light.json'), 'utf8')
  assert.equal(written.includes('sk-test-secret'), false)
  const [result] = JSON.parse(written)
  assert.match(result.error, /EBUSY/)
  assert.deepEqual(result.keyScan.hits, [leaked])
  assert.equal(fs.existsSync(leaked), false)
  assert.equal(stdout.join('').includes('"keyScan"'), true)
})

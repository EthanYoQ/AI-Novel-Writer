import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'vitest'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const driver = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../f05-a11-offline-import-journey.mjs'), 'utf8')
const functionSource = (name, source = driver) => {
  const start = source.indexOf(`async function ${name}(`) >= 0
    ? source.indexOf(`async function ${name}(`) : source.indexOf(`function ${name}(`)
  return start < 0 ? '' : source.slice(start, source.indexOf('\n}', start) + 2)
}

test('unpacked provenance separates package source from script-only execution and build heads', () => {
  const packageSource = 'a'.repeat(40)
  const executionHead = 'b'.repeat(40)
  const buildTreeHead = 'c'.repeat(40)
  const buildTree = path.resolve('build-tree')
  const repository = path.resolve('execution-tree')
  const packageDir = path.join(buildTree, 'release', '1.2.0', 'win-unpacked')
  const verify = (overrides = {}) => vm.runInNewContext(`${functionSource('unpackedPackageProvenance')}\nunpackedPackageProvenance()`, {
    assert, path, buildTree, repository, packageDir, testedSha: packageSource,
    fs: { readFileSync: () => '{"version":"1.2.0"}', realpathSync: { native: value => value } },
    execFileSync: (_command, args, { cwd }) => {
      if (args[0] === 'rev-parse') return cwd === repository ? executionHead : buildTreeHead
      if (args[0] === 'status') return cwd === buildTree ? overrides.buildDirty ?? '' : overrides.executionDirty ?? ' M scripts/driver.mjs'
      assert.equal(args[2], `${packageSource}..${cwd === repository ? executionHead : buildTreeHead}`)
      if (args.includes('--')) return overrides.fixtureChanges ?? ''
      return overrides.changes ?? 'scripts/driver.mjs'
    },
  })
  const provenance = verify()
  assert.equal(provenance.packageSourceSha, packageSource)
  assert.equal(provenance.executionHead, executionHead)
  assert.equal(provenance.buildTreeHead, buildTreeHead)
  for (const overrides of [
    { changes: 'electron/main.ts' }, { executionDirty: ' M src/App.tsx' },
    { buildDirty: ' M scripts/driver.mjs' }, { fixtureChanges: 'scripts/fixtures/s14c-official-old-sources/manifest.json' },
  ]) assert.throws(() => verify(overrides))
})

test('native picker rejects a different main PID and preserves the observed dialog identity', () => {
  const receipt = { nativePickerEvidence: [] }
  const choose = vm.runInNewContext(`${functionSource('chooseNativeDirectory')}\nchooseNativeDirectory`, {
    assert, receipt, nativePickerHelper: 'helper.ps1', exe: 'app.exe', repository: 'repo',
    spawnSync: () => ({ status: 0, stdout: JSON.stringify({ dialogTitle: 'directory', dialogPid: 123,
      typedExact: true, submitted: true }) }),
  })
  assert.throws(() => choose('directory', 'target', 456))
  assert.equal(receipt.nativePickerEvidence[0].dialogPid, 123)
  assert.doesNotThrow(() => choose('directory', 'target', 123))
})

test('native import failure retains production result and visible alert without grant tokens', async () => {
  const capture = vm.runInNewContext(`${functionSource('captureNativeImportFailure')}\ncaptureNativeImportFailure`, {
    setTimeout, clearTimeout,
    __a11Dialogs: [{ type: 'confirm' }],
    __a11NativeCalls: [
      { channel: 'dialog:select-legacy-project', senderId: 7, args: [], result: { grantId: 'private-grant', displayName: 'source' } },
      { channel: 'project:import-legacy-copy', senderId: 7, args: ['private-grant'], result: { state: 'blocked', code: 'PROJECT_STORAGE_PATH_UNSUPPORTED' } },
    ],
    document: { querySelectorAll: () => [{ getClientRects: () => [1], textContent: 'PROJECT_STORAGE_PATH_UNSUPPORTED' }], querySelector: () => null },
  })
  const diagnostic = await capture({ app: { evaluate: fn => Promise.resolve(fn()) }, page: { evaluate: fn => Promise.resolve(fn()) } })
  assert.equal(diagnostic.main.calls[1].result.code, 'PROJECT_STORAGE_PATH_UNSUPPORTED')
  assert.equal(diagnostic.renderer.alerts[0], 'PROJECT_STORAGE_PATH_UNSUPPORTED')
  assert.equal(JSON.stringify(diagnostic).includes('private-grant'), false)
})

test('native project and legacy receipts require opaque grants consumed by their selecting sender', () => {
  const u01 = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../f05-u01-transitions-journey.mjs'), 'utf8')
  const sourceGrant = '11111111-1111-4111-8111-111111111111'
  const targetGrant = '22222222-2222-4222-8222-222222222222'
  const projectId = '33333333-3333-4333-8333-333333333333'
  const choice = (channel, grantId, args = []) => ({ channel, senderId: 7, args, result: { grantId, displayName: 'folder' } })
  const projectCalls = [
    choice('dialog:select-folder', sourceGrant, ['project-create']),
    { channel: 'project:create', senderId: 7, args: [{ parentGrantId: sourceGrant }], result: { success: true, projectId } },
    choice('dialog:select-folder', targetGrant, ['project-open']),
    { channel: 'project:open', senderId: 7, args: [{ grantId: targetGrant }], result: { success: true, project: { id: projectId } } },
  ]
  const importCalls = [choice('dialog:select-legacy-project', sourceGrant), choice('dialog:select-project-restore-target', targetGrant),
    { channel: 'project:import-legacy-copy', senderId: 7, args: [sourceGrant, targetGrant],
      result: { state: 'ready', projectId, targetRoot: 'target' } }]
  for (const [name, source, calls] of [
    ['verifyNativeProjectGrants', u01, projectCalls], ['verifyNativeImportGrants', driver, importCalls],
  ]) {
    const verify = input => vm.runInNewContext(`${functionSource(name, source)}\n${name}(${JSON.stringify(input)})`, { assert })
    assert.doesNotThrow(() => verify(calls))
    for (const mutate of [
      items => { items.at(-1).senderId = 8 },
      items => { items[0].result.path = 'C:\\raw-path' },
      items => { items[0].result.grantId = 'C:\\raw-path' },
      items => { items[0].result.grantId = projectId },
      items => { items.at(-1).result = { success: false, state: 'blocked' } },
    ]) {
      const altered = structuredClone(calls)
      mutate(altered)
      assert.throws(() => verify(altered), undefined, `${name} accepted invalid native evidence`)
    }
  }
})

test('Windows partial launch records bounded startup facts and kills its exact process tree', async () => {
  const original = new Error('skin wait timed out')
  const receipt = {}
  const kills = []
  const app = {
    process: () => ({ pid: 424242 }),
    firstWindow: async () => ({
      locator: () => ({ waitFor: async () => { throw original } }),
      evaluate: async () => ({ startupState: 'blocked', visibleAlert: true }),
    }),
    close: () => new Promise(() => {}),
  }
  const deps = {
    assert, Buffer, setTimeout, clearTimeout, process: { env: {} }, path,
    macMode: false, macStage: () => {}, packageDir: 'package', exe: 'app.exe', receipt,
    electron: { launch: async () => app },
    fs: { existsSync: () => true, readFileSync: () => Buffer.from([0xef, 0xbb, 0xbf]), readdirSync: () => [] },
    execFileSync: (command, args, options) => { kills.push({ command, args, options }); return '' },
    closeMacApplication: () => { throw new Error('Mac cleanup was used') },
  }
  const launch = vm.runInNewContext(`${functionSource('closeWindowsApplication')}\n${functionSource('configHasBom')}\n${functionSource('launch')}\nlaunch`, deps)
  const roots = { canonical: 'canonical', legacy: 'legacy', userData: 'userData', home: 'home', appData: 'appData', localAppData: 'localAppData' }
  let timer
  try {
    await assert.rejects(Promise.race([
      launch(roots),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('launch cleanup hung')), 5_000) }),
    ]), error => error === original)
  } finally { clearTimeout(timer) }
  assert.deepEqual(kills.map(({ command, args }) => [command, ...args]),
    [['taskkill', '/PID', '424242', '/T', '/F']])
  assert.equal(receipt.startupDiagnostic.stage, 'first-window-ready')
  assert.equal(receipt.startupDiagnostic.startupState, 'blocked')
  assert.equal(receipt.startupDiagnostic.visibleAlert, true)
  assert.equal(receipt.startupDiagnostic.legacyConfigHasBom, true)
  assert(!JSON.stringify(receipt.startupDiagnostic).includes('secret'))
})

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

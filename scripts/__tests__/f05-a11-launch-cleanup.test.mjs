import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'vitest'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const driver = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../f05-a11-offline-import-journey.mjs'), 'utf8')
const functionSource = name => {
  const start = driver.indexOf(`async function ${name}(`) >= 0
    ? driver.indexOf(`async function ${name}(`) : driver.indexOf(`function ${name}(`)
  return start < 0 ? '' : driver.slice(start, driver.indexOf('\n}', start) + 2)
}

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

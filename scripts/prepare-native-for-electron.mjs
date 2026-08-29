/* global process */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..')
const require = createRequire(import.meta.url)
const electronExecutable = require('electron')
const electronVersion = require('electron/package.json').version
const successMarker = 'BETTER_SQLITE3_ELECTRON_ABI_OK'

export function probeElectronNativeBinding(runner = spawnSync) {
  const result = runner(electronExecutable, [
    '-e',
    `const Database = require('better-sqlite3'); const db = new Database(':memory:'); const ok = db.prepare('select 1 as ok').get().ok; db.close(); if (ok !== 1) process.exit(2); process.stdout.write('${successMarker}')`,
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    windowsHide: true,
  })

  return {
    ok: result.status === 0 && String(result.stdout).includes(successMarker),
    diagnostic: String(result.stderr || result.error || '').trim(),
  }
}

async function rebuildElectronNativeBinding() {
  const { rebuild } = await import('@electron/rebuild')
  await rebuild({
    buildPath: repositoryRoot,
    electronVersion,
    force: true,
    onlyModules: ['better-sqlite3'],
  })
}

export async function ensureElectronNativeBinding({
  probe = probeElectronNativeBinding,
  rebuild = rebuildElectronNativeBinding,
} = {}) {
  const initial = probe()
  if (initial.ok) return { repaired: false }

  console.log(`Preparing better-sqlite3 for Electron ${electronVersion}...`)
  await rebuild()
  const repaired = probe()
  if (!repaired.ok) {
    throw new Error(
      `better-sqlite3 still cannot load in Electron ${electronVersion}: ${repaired.diagnostic || 'unknown native module error'}`,
    )
  }
  return { repaired: true }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const result = await ensureElectronNativeBinding()
  console.log(result.repaired
    ? `Rebuilt and verified better-sqlite3 for Electron ${electronVersion}`
    : `Verified better-sqlite3 for Electron ${electronVersion}`)
}

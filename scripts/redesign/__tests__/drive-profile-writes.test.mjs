import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, it, vi } from 'vitest'
vi.mock('playwright', () => ({ _electron: { launch: () => { throw new Error('UNIT_TEST_MUST_NOT_LAUNCH_ELECTRON') } } }))
import { profileWrites, snapshotRealProfiles } from '../drive.mjs'

const parents = []
afterEach(() => { for (const parent of parents.splice(0)) fs.rmSync(parent, { recursive: true, force: true }) })

const GPU_CACHES = ['GPUCache', 'DawnWebGPUCache', 'DawnGraphiteCache']

/** 一个已经用过的配置目录：三个 GPU 缓存各有 data_1，根上有 Preferences 与 Local State。 */
function usedProfile() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-profile-'))
  parents.push(parent)
  const directory = path.join(parent, 'ai-novel-writer')
  for (const cache of GPU_CACHES) {
    fs.mkdirSync(path.join(directory, cache), { recursive: true })
    fs.writeFileSync(path.join(directory, cache, 'data_1'), 'cache')
  }
  fs.writeFileSync(path.join(directory, 'Preferences'), '{}')
  fs.writeFileSync(path.join(directory, 'Local State'), '{}')
  return { parent, directory, cacheFiles: GPU_CACHES.map(cache => path.join(directory, cache, 'data_1')) }
}

/** 本机正在运行的书童：另一个进程把 GPU 缓存文件的修改时间刷新到将来，再在缓存目录里新建一个文件。 */
function runningInstanceRefreshes(cacheFiles, added) {
  const script = `const fs = require('node:fs')
const [added, ...files] = process.argv.slice(1)
const later = new Date(Date.now() + 60_000)
for (const file of files) fs.utimesSync(file, later, later)
fs.writeFileSync(added, 'cache')`
  execFileSync(process.execPath, ['-e', script, added, ...cacheFiles])
}

it('另一个进程刷新 GPU 缓存不算外部写入，但被忽略的路径要列出来', () => {
  const { directory, cacheFiles } = usedProfile()
  const before = snapshotRealProfiles([directory])
  const added = path.join(directory, 'GPUCache', 'f_000001')
  runningInstanceRefreshes(cacheFiles, added)

  assert.deepEqual(profileWrites(before), { externalWrites: [], externalWritesIgnored: [...cacheFiles, added].sort() })
})

it('缓存同时在刷新时，改动、新建、删除真实配置文件和新出现的配置目录都会报出来', () => {
  const { parent, directory, cacheFiles } = usedProfile()
  const legacy = path.join(parent, 'AI小说作家')
  const before = snapshotRealProfiles([directory, legacy])
  const added = path.join(directory, 'GPUCache', 'f_000001')
  runningInstanceRefreshes(cacheFiles, added)
  const later = new Date(Date.now() + 60_000)
  fs.writeFileSync(path.join(directory, 'Preferences'), '{"leaked":true}')
  fs.utimesSync(path.join(directory, 'Preferences'), later, later)
  fs.mkdirSync(path.join(directory, 'Local Storage'))
  fs.writeFileSync(path.join(directory, 'Local Storage', '000003.log'), 'leaked')
  fs.rmSync(path.join(directory, 'Local State'))
  fs.mkdirSync(legacy)
  fs.writeFileSync(path.join(legacy, 'config.json'), '{}')

  const { externalWrites, externalWritesIgnored } = profileWrites(before)
  assert.deepEqual(externalWrites, [
    path.join(directory, 'Local State'),
    path.join(directory, 'Local Storage'),
    path.join(directory, 'Local Storage', '000003.log'),
    path.join(directory, 'Preferences'),
    legacy,
    path.join(legacy, 'config.json'),
  ].sort())
  assert.deepEqual(externalWritesIgnored, [...cacheFiles, added].sort())
})

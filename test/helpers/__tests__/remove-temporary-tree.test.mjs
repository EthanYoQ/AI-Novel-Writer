import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTemporaryTree } from '../remove-temporary-tree.mjs'

const helper = fileURLToPath(new URL('../remove-temporary-tree.mjs', import.meta.url))
const roots = []

function electronBinary() {
  try { return createRequire(import.meta.url)('electron') } catch { return undefined }
}

// 模拟 r3-native 夹具：临时目录里有一个 junction 指向临时目录外、仍要保留的目录。
function fixture() {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'remove-tree-outside-'))
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'remove-tree-scratch-'))
  roots.push(outside, scratch)
  fs.mkdirSync(path.join(outside, 'electron'))
  fs.writeFileSync(path.join(outside, 'electron', 'main.ts'), 'kept')
  fs.mkdirSync(path.join(scratch, 'adapter'))
  fs.symlinkSync(outside, path.join(scratch, 'adapter', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  return { outside, scratch }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    const link = path.join(root, 'adapter', 'linked')
    if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(link)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('removeTemporaryTree', () => {
  it('removes the scratch tree and keeps the files a junction inside it points to', () => {
    const { outside, scratch } = fixture()

    removeTemporaryTree(scratch, os.tmpdir())

    expect(fs.existsSync(scratch)).toBe(false)
    expect(fs.readFileSync(path.join(outside, 'electron', 'main.ts'), 'utf8')).toBe('kept')
  })

  const electron = electronBinary()
  it.skipIf(!electron)('keeps the junction target when the suite runs on Electron as Node', () => {
    const { outside, scratch } = fixture()
    const script = `import(${JSON.stringify(pathToFileURL(helper).href)}).then(m => m.removeTemporaryTree(process.argv[1], process.argv[2]))`

    const run = spawnSync(electron, ['-e', script, scratch, os.tmpdir()], {
      encoding: 'utf8', windowsHide: true, timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })

    expect(run.signal, 'Electron child ended by timeout').toBeNull()
    expect(run.status, run.stderr).toBe(0)
    expect(fs.existsSync(scratch)).toBe(false)
    expect(fs.readFileSync(path.join(outside, 'electron', 'main.ts'), 'utf8')).toBe('kept')
  }, 90_000)

  it('refuses a target that is not inside the given parent', () => {
    const { outside } = fixture()

    expect(() => removeTemporaryTree(outside, path.join(os.tmpdir(), 'elsewhere'))).toThrow(/Refusing to remove/)
    expect(() => removeTemporaryTree(os.tmpdir(), os.tmpdir())).toThrow(/Refusing to remove/)
    expect(fs.existsSync(path.join(outside, 'electron', 'main.ts'))).toBe(true)
  })

  it('refuses a target that is itself a link out of the given parent', () => {
    const { outside, scratch } = fixture()

    expect(() => removeTemporaryTree(path.join(scratch, 'adapter', 'linked'), scratch)).toThrow(/Refusing to remove/)
    expect(fs.readFileSync(path.join(outside, 'electron', 'main.ts'), 'utf8')).toBe('kept')
  })

  it('removes an entry whose name only starts with two dots', () => {
    const { scratch } = fixture()
    fs.mkdirSync(path.join(scratch, '..cache'))

    removeTemporaryTree(path.join(scratch, '..cache'), scratch)

    expect(fs.existsSync(path.join(scratch, '..cache'))).toBe(false)
  })
})

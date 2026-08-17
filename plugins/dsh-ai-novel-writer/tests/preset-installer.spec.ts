import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPresetInstaller } from '../src/preset-installer.ts'
import { makeTestWorkspace } from './test-workspace.ts'

const templateRoot = resolve(import.meta.dirname, '..', 'presets', 'ai-novel-writer')

describe('AI 小说作家 preset installer', () => {
  it('installs the exact package assets and repeats idempotently', async () => {
    const root = await makeTestWorkspace('preset-install-')
    const installer = createPresetInstaller(templateRoot, root)

    await expect(installer.status()).resolves.toEqual({ status: 'not-installed' })
    await expect(installer.install()).resolves.toEqual({ status: 'installed', changed: true })
    await expect(installer.install()).resolves.toEqual({ status: 'installed', changed: false })
    await expect(readFile(join(root, 'ai-novel-writer', 'agent.cordis.yml'), 'utf8'))
      .resolves.toBe(await readFile(join(templateRoot, 'agent.cordis.yml'), 'utf8'))
    await expect(readFile(join(root, 'ai-novel-writer', 'preset.yml'), 'utf8'))
      .resolves.toBe(await readFile(join(templateRoot, 'preset.yml'), 'utf8'))
  })

  it('reports a same-name conflict without changing any user byte', async () => {
    const root = await makeTestWorkspace('preset-conflict-')
    const target = join(root, 'ai-novel-writer')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'agent.cordis.yml'), 'user customization\n')
    const installer = createPresetInstaller(templateRoot, root)

    await expect(installer.status()).resolves.toEqual({ status: 'conflict' })
    await expect(installer.install()).resolves.toEqual({ status: 'conflict', changed: false })
    await expect(readFile(join(target, 'agent.cordis.yml'), 'utf8')).resolves.toBe('user customization\n')
    await expect(readFile(join(target, 'preset.yml'), 'utf8')).rejects.toThrow()
  })

  it.each(['directory', 'symlink'] as const)('treats a %s preset entry as a conflict', async (kind) => {
    const root = await makeTestWorkspace(`preset-${kind}-conflict-`)
    const target = join(root, 'ai-novel-writer')
    await mkdir(target, { recursive: true })
    if (kind === 'directory') {
      await mkdir(join(target, 'agent.cordis.yml'))
    } else {
      await symlink(templateRoot, join(target, 'agent.cordis.yml'), 'junction')
    }
    await writeFile(join(target, 'preset.yml'), await readFile(join(templateRoot, 'preset.yml')))
    const installer = createPresetInstaller(templateRoot, root)

    await expect(installer.status()).resolves.toEqual({ status: 'conflict' })
    await expect(installer.install()).resolves.toEqual({ status: 'conflict', changed: false })
  })

  it('does not publish a preset when cancellation wins before installation', async () => {
    const root = await makeTestWorkspace('preset-cancel-')
    const installer = createPresetInstaller(templateRoot, root)
    const abort = new AbortController()
    abort.abort()

    await expect(installer.install(abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(access(join(root, 'ai-novel-writer'))).rejects.toThrow()
  })
})

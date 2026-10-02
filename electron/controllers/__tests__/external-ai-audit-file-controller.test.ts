import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    }),
  },
}))

vi.mock('../../utils/config-utils', () => ({
  VELA_HOME: 'C:\\vela-app-data',
  ensureVelaHome: vi.fn(),
}))

import { registerExternalAiAuditFileController } from '../external-ai-audit-file-controller'

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

describe('external AI audit file controller', () => {
  let directory: string
  let setClipboardFiles: ReturnType<typeof vi.fn<(paths: string[]) => Promise<void>>>

  beforeEach(() => {
    mocks.handlers.clear()
    directory = mkdtempSync(path.join(tmpdir(), 'audit-files-'))
    setClipboardFiles = vi.fn<(paths: string[]) => Promise<void>>().mockResolvedValue(undefined)
    registerExternalAiAuditFileController({ directory, setClipboardFiles })
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('writes every material as a markdown file and puts them on the clipboard', async () => {
    const result = await handler('external-ai-audit:copy-files')({}, [
      { name: '00-审稿要求.md', content: '# 审稿要求\n\n请审稿。' },
      { name: '02-本章正文.md', content: '# 本章正文\n\n雾从港口漫上来。' },
    ])

    expect(result).toMatchObject({ success: true, fileCount: 2, directory })
    expect(readFileSync(path.join(directory, '00-审稿要求.md'), 'utf8')).toContain('请审稿')
    expect(readFileSync(path.join(directory, '02-本章正文.md'), 'utf8')).toContain('雾从港口漫上来')

    expect(setClipboardFiles).toHaveBeenCalledOnce()
    expect(setClipboardFiles.mock.calls[0]?.[0]).toEqual([
      path.join(directory, '00-审稿要求.md'),
      path.join(directory, '02-本章正文.md'),
    ])
  })

  it('clears the previous batch so a stale chapter cannot be pasted by mistake', async () => {
    writeFileSync(path.join(directory, '99-上一章正文.md'), 'stale', 'utf8')

    await handler('external-ai-audit:copy-files')({}, [{ name: '02-本章正文.md', content: '新的一章' }])

    expect(existsSync(path.join(directory, '99-上一章正文.md'))).toBe(false)
    expect(existsSync(path.join(directory, '02-本章正文.md'))).toBe(true)
  })

  it('keeps a hostile file name inside the target directory', async () => {
    const result = await handler('external-ai-audit:copy-files')({}, [
      { name: '../../evil.md', content: 'x' },
    ])

    expect(result).toMatchObject({ success: true })
    // 路径分隔符被压平，文件仍落在材料目录里
    expect(existsSync(path.join(directory, '..-..-evil.md'))).toBe(true)
    expect(existsSync(path.join(directory, '..', '..', 'evil.md'))).toBe(false)
  })

  it('gives the file a .md suffix when the renderer forgets one', async () => {
    await handler('external-ai-audit:copy-files')({}, [{ name: '本章正文', content: 'x' }])

    expect(existsSync(path.join(directory, '本章正文.md'))).toBe(true)
  })

  it('refuses payloads it cannot trust', async () => {
    for (const payload of [
      undefined,
      [],
      'not-an-array',
      [{ name: '', content: 'x' }],
      [{ name: 'ok.md', content: 42 }],
      Array.from({ length: 40 }, (_, index) => ({ name: `f-${index}.md`, content: 'x' })),
    ]) {
      await expect(handler('external-ai-audit:copy-files')({}, payload)).resolves.toMatchObject({
        success: false,
        error: expect.any(String),
      })
    }

    expect(setClipboardFiles).not.toHaveBeenCalled()
  })

  it('reports a controlled failure when the clipboard step blows up', async () => {
    setClipboardFiles.mockRejectedValue(new Error('clipboard busy'))

    await expect(handler('external-ai-audit:copy-files')({}, [{ name: 'a.md', content: 'x' }]))
      .resolves.toMatchObject({ success: false, error: 'clipboard busy' })
  })
})

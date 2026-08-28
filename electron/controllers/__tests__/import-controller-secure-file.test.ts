import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  showOpenDialog: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  dialog: { showOpenDialog: mocks.showOpenDialog },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    }),
  },
}))

import { registerImportController } from '../import-controller'
import type { WindowsSafeFileSystem } from '../../security/windows-safe-file-system'

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-import-secure-'))

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

function event() {
  return { sender: { id: 29, once: vi.fn() } }
}

function boundedReader(contents: Record<string, string>) {
  const decodedFiles: string[] = []
  const readText = vi.fn(async (
    capability: { relativePath: string },
    maxBytes = Number.POSITIVE_INFINITY,
  ) => {
    const content = contents[capability.relativePath] ?? ''
    if (Buffer.byteLength(content, 'utf8') > maxBytes) {
      throw new Error('SECURE_FS_FILE_TOO_LARGE')
    }
    decodedFiles.push(capability.relativePath)
    return content
  })
  const fileSystem = {
    readText,
    writeTextAtomically: vi.fn(),
    mkdir: vi.fn(),
    exists: vi.fn(),
    listDirectory: vi.fn(),
  } as unknown as WindowsSafeFileSystem
  return { fileSystem, readText, decodedFiles }
}

describe('novel import external-file capability', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.showOpenDialog.mockReset()
    registerImportController()
  })

  afterAll(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  })

  it('still imports a normal user-selected text file through the secure reader', async () => {
    const selected = path.join(temporaryRoot, 'normal.txt')
    fs.writeFileSync(selected, '第1章 开始\n正常内容', 'utf8')
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [selected] })

    const selection = await handler('dialog:select-novel-files')(event()) as Array<{ grantId: string }>
    expect(JSON.stringify(selection)).not.toContain(temporaryRoot)
    expect(JSON.stringify(selection)).not.toContain('dev:')
    const result = await handler('import:inspect-source')(event(), [selection[0].grantId])
    expect(result).toMatchObject({
      success: true,
      inspection: {
        chapterCount: 1,
        totalWords: '正常内容'.length,
        preview: [{ number: 1 }],
      },
    })
    expect(JSON.stringify(result)).not.toContain('正常内容')
    expect(JSON.stringify(result)).not.toContain(temporaryRoot)
    expect(JSON.stringify(result)).not.toContain('dev:')
  })

  it('does not import outside content when the selected file parent becomes a junction after grant issuance', async () => {
    const selectedRoot = path.join(temporaryRoot, 'selected')
    const guardedDirectory = path.join(selectedRoot, 'guarded')
    const outsideDirectory = path.join(temporaryRoot, 'outside')
    const selected = path.join(guardedDirectory, 'novel.txt')
    fs.mkdirSync(guardedDirectory, { recursive: true })
    fs.mkdirSync(outsideDirectory)
    fs.writeFileSync(selected, '第1章 内部\n内部内容', 'utf8')
    fs.writeFileSync(path.join(outsideDirectory, 'novel.txt'), '第1章 外部\n外部内容', 'utf8')
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [selected] })

    const selection = await handler('dialog:select-novel-files')(event()) as Array<{ grantId: string }>
    fs.rmSync(guardedDirectory, { recursive: true, force: true })
    fs.symlinkSync(outsideDirectory, guardedDirectory, 'junction')

    await expect(handler('import:inspect-source')(event(), [selection[0].grantId])).resolves.toMatchObject({
      success: false,
    })
  })

  it('rejects aggregate source bytes before reading any selected file', async () => {
    const selected = ['budget-a.txt', 'budget-b.txt', 'budget-c.txt'].map((name) => {
      const filePath = path.join(temporaryRoot, name)
      fs.writeFileSync(filePath, '1234', 'utf8')
      return filePath
    })
    const { fileSystem, readText } = boundedReader({})
    mocks.handlers.clear()
    registerImportController(fileSystem, filePath => ({ canonicalLocation: filePath }), {
      maxSourceFiles: 5_000,
      maxChapters: 5_000,
      maxTotalBytes: 10,
    })
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: selected })

    const selection = await handler('dialog:select-novel-files')(event()) as Array<{ grantId: string }>
    const result = await handler('import:inspect-source')(event(), selection.map(file => file.grantId))

    expect(result).toMatchObject({ success: false })
    expect(readText).not.toHaveBeenCalled()
  })

  it('rejects the third grown file before decoding it when only a smaller byte budget remains', async () => {
    const selected = ['growth-a.txt', 'growth-b.txt', 'growth-c.txt'].map((name) => {
      const filePath = path.join(temporaryRoot, name)
      fs.writeFileSync(filePath, 'x', 'utf8')
      return filePath
    })
    const { fileSystem, readText, decodedFiles } = boundedReader({
      'growth-a.txt': '1234',
      'growth-b.txt': '1234',
      'growth-c.txt': '1234',
    })
    mocks.handlers.clear()
    registerImportController(fileSystem, filePath => ({ canonicalLocation: filePath }), {
      maxSourceFiles: 5_000,
      maxChapters: 5_000,
      maxTotalBytes: 10,
    })
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: selected })

    const selection = await handler('dialog:select-novel-files')(event()) as Array<{ grantId: string }>
    const result = await handler('import:inspect-source')(event(), selection.map(file => file.grantId))

    expect(result).toMatchObject({ success: false })
    expect(readText.mock.calls.map(([capability, maxBytes]) => ({
      relativePath: capability.relativePath,
      maxBytes,
    }))).toEqual([
      { relativePath: 'growth-a.txt', maxBytes: 10 },
      { relativePath: 'growth-b.txt', maxBytes: 6 },
      { relativePath: 'growth-c.txt', maxBytes: 2 },
    ])
    expect(decodedFiles).toEqual(['growth-a.txt', 'growth-b.txt'])
  })

  it('rejects 5001 source grants before reading any file', async () => {
    const selected = path.join(temporaryRoot, 'too-many-files.txt')
    fs.writeFileSync(selected, 'x', 'utf8')
    const { fileSystem, readText } = boundedReader({ 'too-many-files.txt': 'x' })
    mocks.handlers.clear()
    registerImportController(fileSystem, filePath => ({ canonicalLocation: filePath }))
    mocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: Array.from({ length: 5_001 }, () => selected),
    })

    const selection = await handler('dialog:select-novel-files')(event()) as Array<{ grantId: string }>
    const result = await handler('import:inspect-source')(event(), selection.map(file => file.grantId))

    expect(result).toMatchObject({ success: false })
    expect(readText).not.toHaveBeenCalled()
  })

  it('stops after detecting chapter 5001 without reading a later file', async () => {
    const selected = ['chapters-a.txt', 'chapters-b.txt'].map((name) => {
      const filePath = path.join(temporaryRoot, name)
      fs.writeFileSync(filePath, 'x', 'utf8')
      return filePath
    })
    const oversizedChapterFile = Array.from(
      { length: 5_001 },
      (_, index) => `第${index + 1}章 标题\n正文`,
    ).join('\n')
    const { fileSystem, readText } = boundedReader({
      'chapters-a.txt': oversizedChapterFile,
      'chapters-b.txt': '第1章 后续\n不应读取',
    })
    mocks.handlers.clear()
    registerImportController(fileSystem, filePath => ({ canonicalLocation: filePath }))
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: selected })

    const selection = await handler('dialog:select-novel-files')(event()) as Array<{ grantId: string }>
    const result = await handler('import:inspect-source')(event(), selection.map(file => file.grantId))

    expect(result).toMatchObject({ success: false })
    expect(readText).toHaveBeenCalledTimes(1)
    expect(readText.mock.calls[0][0].relativePath).toBe('chapters-a.txt')
  })
})

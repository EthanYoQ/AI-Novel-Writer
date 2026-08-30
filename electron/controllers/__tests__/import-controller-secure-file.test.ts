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
import { nodeTestSecureFileSystem } from '../../../test/helpers/node-test-secure-file-system'
import { ExternalFileGrantService } from '../../services/external-file-grant-service'
import { ImportInspectionStore } from '../../services/import-inspection-store'
import { storedZip } from '../../services/__tests__/epub-test-fixture'
import { countDraftUnits } from '../../../src/shared/draft-units'

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-import-secure-'))
let grants: ExternalFileGrantService
let inspections: ImportInspectionStore
let nextGrantId = 0

function register(
  fileSystem: WindowsSafeFileSystem = nodeTestSecureFileSystem,
  fileIdentity = (filePath: string) => ({ canonicalLocation: filePath }),
  limits: { maxSourceFiles?: number; maxChapters?: number; maxTotalBytes?: number } = {},
) {
  registerImportController(
    fileSystem,
    fileIdentity,
    limits,
    grants,
    inspections,
    Buffer.alloc(32, 42),
  )
}

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
    nextGrantId = 0
    grants = new ExternalFileGrantService({ newGrantId: () => `import-grant-${++nextGrantId}` })
    inspections = new ImportInspectionStore()
    register()
  })

  afterAll(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  })

  it('still imports a normal user-selected text file through the secure reader', async () => {
    const selected = path.join(temporaryRoot, 'normal.txt')
    fs.writeFileSync(selected, '第1章 开始\n正常内容', 'utf8')
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [selected] })

    const result = await handler('dialog:select-novel-files')(event())
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
    expect(JSON.stringify(result)).not.toContain('grantId')
    expect(JSON.stringify(result)).not.toContain('canonicalLocation')
    expect(JSON.stringify(result)).not.toContain('fileIdentity')
    expect(grants.activeCount()).toBe(0)
    expect(inspections.activeCount()).toBe(1)
  })

  it('reads EPUB bytes and splits multiple chapter headings inside one spine document', async () => {
    const selected = path.join(temporaryRoot, '长篇参考.epub')
    const archive = storedZip({
      'META-INF/container.xml': '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
      'book.opf': `<package><manifest>
        <item id="novel" href="novel.xhtml" media-type="application/xhtml+xml"/>
        </manifest><spine><itemref idref="novel"/></spine></package>`,
      'novel.xhtml': `<html><body>
        <h1>第一章 雨夜</h1><p>雨落长安，陆云飞归来。</p>
        <h1>第二章 重逢</h1><p>Café 中，她听见旧日歌声。</p>
        </body></html>`,
    })
    fs.writeFileSync(selected, archive)
    const readBytes = vi.fn(async () => archive)
    const readText = vi.fn(async () => { throw new Error('EPUB must not be decoded as plain UTF-8') })
    const fileSystem = {
      readBytes,
      readText,
      writeTextAtomically: vi.fn(),
      mkdir: vi.fn(),
      exists: vi.fn(),
      listDirectory: vi.fn(),
    } as WindowsSafeFileSystem
    mocks.handlers.clear()
    register(fileSystem, filePath => ({ canonicalLocation: filePath }))
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [selected] })

    const result = await handler('dialog:select-novel-files')(event())

    expect(mocks.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      filters: expect.arrayContaining([
        expect.objectContaining({ extensions: expect.arrayContaining(['epub']) }),
      ]),
    }))
    expect(readBytes).toHaveBeenCalledOnce()
    expect(readText).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      success: true,
      inspection: {
        sourceCount: 1,
        chapterCount: 2,
        totalWords: countDraftUnits('雨落长安，陆云飞归来。')
          + countDraftUnits('Café 中，她听见旧日歌声。'),
        preview: [
          { number: 1, title: '雨夜' },
          { number: 2, title: '重逢' },
        ],
      },
    })
    expect(JSON.stringify(result)).not.toContain('雨落长安')
    expect(grants.activeCount()).toBe(0)
  })

  it.each([
    {
      fileName: 'damaged.epub',
      archive: Buffer.from('not a zip archive'),
      error: 'EPUB 文件已损坏，或缺少有效的 container.xml、OPF 与正文阅读顺序。',
    },
    {
      fileName: 'protected.epub',
      archive: storedZip({
        'META-INF/encryption.xml': `<encryption xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
          <enc:EncryptedData>
            <enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/>
            <enc:CipherData><enc:CipherReference URI="chapter.xhtml"/></enc:CipherData>
          </enc:EncryptedData>
        </encryption>`,
        'META-INF/container.xml': '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
        'book.opf': `<package><manifest>
          <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
          </manifest><spine><itemref idref="chapter"/></spine></package>`,
        'chapter.xhtml': '<html><body><p>Encrypted placeholder</p></body></html>',
      }),
      error: '该 EPUB 受 DRM 或加密保护，无法导入。请使用无 DRM 的 EPUB 或文本文件。',
    },
  ])('shows a safe actionable error for $fileName', async ({ fileName, archive, error }) => {
    const selected = path.join(temporaryRoot, fileName)
    fs.writeFileSync(selected, archive)
    const fileSystem = {
      readBytes: vi.fn(async () => archive),
      readText: vi.fn(),
      writeTextAtomically: vi.fn(),
      mkdir: vi.fn(),
      exists: vi.fn(),
      listDirectory: vi.fn(),
    } as WindowsSafeFileSystem
    mocks.handlers.clear()
    register(fileSystem, filePath => ({ canonicalLocation: filePath }))
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [selected] })

    await expect(handler('dialog:select-novel-files')(event())).resolves.toEqual({
      success: false,
      error,
    })
    expect(grants.activeCount()).toBe(0)
  })

  it('rejects duplicate author chapter numbers with an actionable localized message', async () => {
    const first = path.join(temporaryRoot, 'author-a.txt')
    const second = path.join(temporaryRoot, 'author-b.txt')
    const firstContent = '第1章 开始\n第一份正文'
    const secondContent = '第1章 重复\n第二份正文'
    fs.writeFileSync(first, firstContent, 'utf8')
    fs.writeFileSync(second, secondContent, 'utf8')
    const { fileSystem, readText } = boundedReader({
      'author-a.txt': firstContent,
      'author-b.txt': secondContent,
    })
    mocks.handlers.clear()
    register(fileSystem, filePath => ({ canonicalLocation: filePath }))
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [first, second] })

    await expect(handler('dialog:select-novel-files')(event(), 'author-manuscript')).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/重复的第 1 章/),
    })
    expect(readText).toHaveBeenCalledTimes(2)
    expect(inspections.activeCount()).toBe(0)
    expect(grants.activeCount()).toBe(0)
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

    mocks.handlers.clear()
    const swappingFileSystem = {
      ...nodeTestSecureFileSystem,
      readText: vi.fn(async (capability, maxBytes) => {
        fs.rmSync(guardedDirectory, { recursive: true, force: true })
        fs.symlinkSync(outsideDirectory, guardedDirectory, 'junction')
        return nodeTestSecureFileSystem.readText(capability, maxBytes)
      }),
    } as WindowsSafeFileSystem
    register(swappingFileSystem, filePath => ({ canonicalLocation: fs.realpathSync.native(filePath) }))

    await expect(handler('dialog:select-novel-files')(event())).resolves.toMatchObject({
      success: false,
    })
    expect(grants.activeCount()).toBe(0)
  })

  it('rejects aggregate source bytes before reading any selected file', async () => {
    const selected = ['budget-a.txt', 'budget-b.txt', 'budget-c.txt'].map((name) => {
      const filePath = path.join(temporaryRoot, name)
      fs.writeFileSync(filePath, '1234', 'utf8')
      return filePath
    })
    const { fileSystem, readText } = boundedReader({})
    mocks.handlers.clear()
    register(fileSystem, filePath => ({ canonicalLocation: filePath }), {
      maxSourceFiles: 5_000,
      maxChapters: 5_000,
      maxTotalBytes: 10,
    })
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: selected })

    const result = await handler('dialog:select-novel-files')(event())

    expect(result).toEqual({
      success: false,
      error: '所选文件总大小超过导入上限（最多 10 字节）。',
    })
    expect(readText).not.toHaveBeenCalled()
    expect(grants.activeCount()).toBe(0)
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
    register(fileSystem, filePath => ({ canonicalLocation: filePath }), {
      maxSourceFiles: 5_000,
      maxChapters: 5_000,
      maxTotalBytes: 10,
    })
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: selected })

    const result = await handler('dialog:select-novel-files')(event())

    expect(result).toEqual({
      success: false,
      error: '所选文件总大小超过导入上限（最多 10 字节）。',
    })
    expect(readText.mock.calls.map(([capability, maxBytes]) => ({
      relativePath: capability.relativePath,
      maxBytes,
    }))).toEqual([
      { relativePath: 'growth-a.txt', maxBytes: 10 },
      { relativePath: 'growth-b.txt', maxBytes: 6 },
      { relativePath: 'growth-c.txt', maxBytes: 2 },
    ])
    expect(decodedFiles).toEqual(['growth-a.txt', 'growth-b.txt'])
    expect(grants.activeCount()).toBe(0)
    expect(inspections.activeCount()).toBe(0)
  })

  it('rejects 5001 source grants before reading any file', async () => {
    const selected = path.join(temporaryRoot, 'too-many-files.txt')
    fs.writeFileSync(selected, 'x', 'utf8')
    const { fileSystem, readText } = boundedReader({ 'too-many-files.txt': 'x' })
    mocks.handlers.clear()
    register(fileSystem, filePath => ({ canonicalLocation: filePath }))
    mocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: Array.from({ length: 5_001 }, () => selected),
    })

    const result = await handler('dialog:select-novel-files')(event())

    expect(result).toEqual({
      success: false,
      error: '所选文件数量超过导入上限（最多 5000 个）。',
    })
    expect(readText).not.toHaveBeenCalled()
    expect(grants.activeCount()).toBe(0)
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
    register(fileSystem, filePath => ({ canonicalLocation: filePath }))
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: selected })

    const result = await handler('dialog:select-novel-files')(event())

    expect(result).toEqual({
      success: false,
      error: '拆分后的章节数超过导入上限（最多 5000 章）。',
    })
    expect(readText).toHaveBeenCalledTimes(1)
    expect(readText.mock.calls[0][0].relativePath).toBe('chapters-a.txt')
    expect(grants.activeCount()).toBe(0)
  })
})

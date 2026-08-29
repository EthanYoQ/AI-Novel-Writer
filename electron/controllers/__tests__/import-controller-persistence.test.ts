import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  showOpenDialog: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US' },
  dialog: { showOpenDialog: mocks.showOpenDialog },
  ipcMain: { handle: vi.fn((channel: string, handler: IpcHandler) => mocks.handlers.set(channel, handler)) },
}))

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { projectAccess } from '../../services/project-access'
import { ExternalFileGrantService } from '../../services/external-file-grant-service'
import { ImportInspectionStore } from '../../services/import-inspection-store'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import type { WindowsSafeFileSystem } from '../../security/windows-safe-file-system'
import { registerImportController } from '../import-controller'

let parent = ''
let projectRoot = ''
let session: { projectId: string; leaseId: string; projectPath: string }
const secret = Buffer.alloc(32, 44)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

function openNewProject(name: string) {
  closeProjectDatabase()
  const project = projectAccess.createProject(parent, name)
  const lease = projectAccess.beginSession(project)
  initProjectDatabase(lease.rootPath, secret)
  return lease.rootPath
}

function reopenProject(rootPath: string) {
  closeProjectDatabase()
  const project = projectAccess.probeExistingProject(rootPath)
  if (project.kind !== 'manifest') throw new Error('Expected a manifest project')
  projectAccess.beginSession(project)
  initProjectDatabase(project.rootPath, secret)
}

function importRows() {
  return {
    runs: getProjectDb()!.prepare('SELECT id, stage, status FROM import_runs ORDER BY id').all(),
    sources: getProjectDb()!.prepare('SELECT run_id, status FROM import_run_sources ORDER BY source_index').all(),
  }
}

beforeEach(() => {
  mocks.handlers.clear()
  mocks.showOpenDialog.mockReset()
  parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-import-persist-'))
  const project = projectAccess.createProject(parent, 'novel')
  const lease = projectAccess.beginSession(project)
  projectRoot = lease.rootPath
  session = { projectId: lease.projectId, leaseId: lease.leaseId, projectPath: lease.rootPath }
  initProjectDatabase(projectRoot, secret)
})

afterEach(() => {
  closeProjectDatabase()
  projectAccess.invalidateCurrentSession()
  fs.rmSync(parent, { recursive: true, force: true })
})

describe('current-project import parsing persistence', () => {
  it.each([
    {
      kind: 'source count', locale: 'zh-CN', limits: { maxSourceFiles: 1 },
      expected: '所选文件数量超过导入上限（最多 1 个）。',
    },
    {
      kind: 'source count', locale: 'en-US', limits: { maxSourceFiles: 1 },
      expected: 'The import source-file limit was exceeded (limit: 1).',
    },
    {
      kind: 'total bytes', locale: 'zh-CN', limits: { maxTotalBytes: 10 },
      expected: '所选文件总大小超过导入上限（最多 10 字节）。',
    },
    {
      kind: 'total bytes', locale: 'en-US', limits: { maxTotalBytes: 10 },
      expected: 'The import source-size limit was exceeded (limit: 10 bytes).',
    },
    {
      kind: 'chapter count', locale: 'zh-CN', limits: { maxChapters: 1 },
      expected: '拆分后的章节数超过导入上限（最多 1 章）。',
    },
    {
      kind: 'chapter count', locale: 'en-US', limits: { maxChapters: 1 },
      expected: 'The import chapter limit was exceeded (limit: 1).',
    },
  ] as const)('returns the frozen $locale copy for the $kind limit', async ({ kind, locale, limits, expected }) => {
    const sourceA = path.join(parent, `limit-${kind}-a.txt`)
    const sourceB = path.join(parent, `limit-${kind}-b.txt`)
    const content = kind === 'total bytes'
      ? '12345678901'
      : kind === 'chapter count'
        ? 'Chapter 1 One\nbody one\nChapter 2 Two\nbody two'
        : 'body'
    fs.writeFileSync(sourceA, content, 'utf8')
    fs.writeFileSync(sourceB, 'body', 'utf8')
    mocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: kind === 'source count' ? [sourceA, sourceB] : [sourceA],
    })
    registerImportController(
      undefined,
      filePath => ({ canonicalLocation: filePath, fileIdentity: `file:${path.basename(filePath)}` }),
      limits,
      new ExternalFileGrantService(),
      new ImportInspectionStore(),
      secret,
    )

    await expect(mocks.handlers.get('dialog:select-novel-files')!(
      { sender: { id: 54, once: vi.fn() } },
      { runId: `limit-${kind}-${locale}`, purpose: 'reference', locale, expectedProjectPath: projectRoot },
      session,
    )).resolves.toEqual({ success: false, error: expected })
  })

  it('does not create an import run when the project changes while the file picker is open', async () => {
    const source = path.join(parent, 'picker.txt')
    fs.writeFileSync(source, 'Chapter 1 Picker\nalpha', 'utf8')
    const picker = deferred<{ canceled: boolean; filePaths: string[] }>()
    mocks.showOpenDialog.mockReturnValue(picker.promise)
    registerImportController(
      undefined,
      filePath => ({ canonicalLocation: filePath, fileIdentity: `file:${path.basename(filePath)}` }),
      {},
      new ExternalFileGrantService(),
      new ImportInspectionStore(),
      secret,
    )
    const pending = mocks.handlers.get('dialog:select-novel-files')!(
      { sender: { id: 56, once: vi.fn() } },
      { runId: 'picker-switch', purpose: 'reference', locale: 'en-US', expectedProjectPath: projectRoot },
      session,
    )

    openNewProject('other-picker-project')
    picker.resolve({ canceled: false, filePaths: [source] })

    await expect(pending).resolves.toMatchObject({ success: false })
    expect(importRows()).toEqual({ runs: [], sources: [] })
    reopenProject(projectRoot)
    expect(importRows()).toEqual({ runs: [], sources: [] })
  })

  it('does not write a completed or failed source into another project when a single read returns after a switch', async () => {
    const source = path.join(parent, 'single.txt')
    fs.writeFileSync(source, 'x', 'utf8')
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [source] })
    const read = deferred<string>()
    const fileSystem = { readText: vi.fn(() => read.promise) } as unknown as WindowsSafeFileSystem
    registerImportController(
      fileSystem,
      filePath => ({ canonicalLocation: filePath, fileIdentity: `file:${path.basename(filePath)}` }),
      {},
      new ExternalFileGrantService(),
      new ImportInspectionStore(),
      secret,
    )
    const pending = mocks.handlers.get('dialog:select-novel-files')!(
      { sender: { id: 57, once: vi.fn() } },
      { runId: 'single-read-switch', purpose: 'reference', locale: 'en-US', expectedProjectPath: projectRoot },
      session,
    )
    await vi.waitFor(() => expect(fileSystem.readText).toHaveBeenCalledOnce())

    openNewProject('other-single-project')
    read.resolve('Chapter 1 Single\nalpha')

    await expect(pending).resolves.toMatchObject({ success: false })
    expect(importRows()).toEqual({ runs: [], sources: [] })
    reopenProject(projectRoot)
    expect(importRows()).toEqual({
      runs: [{ id: 'single-read-switch', stage: 'parsing', status: 'ready' }],
      sources: [{ run_id: 'single-read-switch', status: 'pending' }],
    })
  })

  it('keeps multi-file progress in the original project when a later read returns after a switch', async () => {
    const sourceA = path.join(parent, 'multi-a.txt')
    const sourceB = path.join(parent, 'multi-b.txt')
    fs.writeFileSync(sourceA, 'a', 'utf8')
    fs.writeFileSync(sourceB, 'b', 'utf8')
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [sourceA, sourceB] })
    const secondRead = deferred<string>()
    const fileSystem = {
      readText: vi.fn(async (capability: { relativePath: string }) => (
        capability.relativePath.endsWith('multi-a.txt')
          ? 'Chapter 1 A\nalpha'
          : secondRead.promise
      )),
    } as unknown as WindowsSafeFileSystem
    registerImportController(
      fileSystem,
      filePath => ({ canonicalLocation: filePath, fileIdentity: `file:${path.basename(filePath)}` }),
      {},
      new ExternalFileGrantService(),
      new ImportInspectionStore(),
      secret,
    )
    const pending = mocks.handlers.get('dialog:select-novel-files')!(
      { sender: { id: 58, once: vi.fn() } },
      { runId: 'multi-read-switch', purpose: 'reference', locale: 'en-US', expectedProjectPath: projectRoot },
      session,
    )
    await vi.waitFor(() => expect(fileSystem.readText).toHaveBeenCalledTimes(2))

    openNewProject('other-multi-project')
    secondRead.resolve('Chapter 2 B\nbeta')

    await expect(pending).resolves.toMatchObject({ success: false })
    expect(importRows()).toEqual({ runs: [], sources: [] })
    reopenProject(projectRoot)
    expect(importRows()).toEqual({
      runs: [{ id: 'multi-read-switch', stage: 'parsing', status: 'ready' }],
      sources: [
        { run_id: 'multi-read-switch', status: 'completed' },
        { run_id: 'multi-read-switch', status: 'pending' },
      ],
    })
  })

  it('creates the parsing run before first read and resumes without rereading a completed source', async () => {
    const sourceA = path.join(parent, 'a.txt')
    const sourceB = path.join(parent, 'b.txt')
    fs.writeFileSync(sourceA, 'Chapter 1 A\nalpha', 'utf8')
    fs.writeFileSync(sourceB, 'Chapter 2 B\nbeta', 'utf8')
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [sourceA, sourceB] })

    const reads: string[] = []
    let failB = true
    const fileSystem = {
      readText: vi.fn(async (capability: { rootPath: string; relativePath: string }) => {
        const run = getProjectDb()!.prepare(`SELECT stage FROM import_runs WHERE id = 'parse-before-read'`).get()
        expect(run).toEqual({ stage: 'parsing' })
        reads.push(path.join(capability.rootPath, capability.relativePath))
        if (capability.relativePath.endsWith('b.txt') && failB) throw new Error('simulated read crash')
        return fs.readFileSync(path.join(capability.rootPath, capability.relativePath), 'utf8')
      }),
    } as unknown as WindowsSafeFileSystem
    registerImportController(
      fileSystem,
      filePath => ({ canonicalLocation: filePath, fileIdentity: `file:${path.basename(filePath)}` }),
      {},
      new ExternalFileGrantService(),
      new ImportInspectionStore(),
      secret,
    )
    const handler = mocks.handlers.get('dialog:select-novel-files')!
    const event = { sender: { id: 55, once: vi.fn() } }
    const request = {
      runId: 'parse-before-read', purpose: 'reference', locale: 'en-US', expectedProjectPath: projectRoot,
    }

    await expect(handler(event, request, session)).resolves.toMatchObject({ success: false })
    expect(getProjectDb()!.prepare(`SELECT status FROM import_run_sources ORDER BY source_index`).all())
      .toEqual([{ status: 'completed' }, { status: 'failed' }])

    failB = false
    reads.length = 0
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [sourceB] })
    await expect(handler(event, request, session)).resolves.toMatchObject({
      success: true,
      preparation: {
        classification: 'new',
        run: { stage: 'prepared' },
        inspection: {
          chapterCount: 2,
          previewRemaining: 0,
          preview: [
            { number: 1, title: 'A', wordCount: 5, targetStatus: 'new' },
            { number: 2, title: 'B', wordCount: 4, targetStatus: 'new' },
          ],
        },
      },
    })
    expect(reads).toHaveLength(1)
    const resumedSource = fs.statSync(reads[0], { bigint: true })
    const expectedSource = fs.statSync(sourceB, { bigint: true })
    expect([resumedSource.dev, resumedSource.ino]).toEqual([expectedSource.dev, expectedSource.ino])
  })

  it('keeps implicit recovery errors in the original locale without persisting private diagnostics', async () => {
    const source = path.join(parent, 'private-source.txt')
    fs.writeFileSync(source, 'Chapter 1 Private\nbody', 'utf8')
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [source] })
    const privateDiagnostic = `ENOENT: no such file or directory, open '${source}'`
    const fileSystem = {
      readText: vi.fn(async () => { throw new Error(privateDiagnostic) }),
    } as unknown as WindowsSafeFileSystem
    registerImportController(
      fileSystem,
      filePath => ({ canonicalLocation: filePath, fileIdentity: `file:${path.basename(filePath)}` }),
      {},
      new ExternalFileGrantService(),
      new ImportInspectionStore(),
      secret,
    )
    const handler = mocks.handlers.get('dialog:select-novel-files')!
    const event = { sender: { id: 64, once: vi.fn() } }
    const expectedSafeError = 'Could not read the selected files. Please choose them again.'

    await expect(handler(event, {
      runId: 'frozen-english-run', purpose: 'reference', locale: 'en-US', expectedProjectPath: projectRoot,
    }, session)).resolves.toEqual({ success: false, error: expectedSafeError })

    // An ordinary re-selection uses a fresh UI run id and current Chinese UI
    // locale, but matching source identity must resume the durable English run.
    await expect(handler(event, {
      runId: 'fresh-chinese-selection', purpose: 'reference', locale: 'zh-CN', expectedProjectPath: projectRoot,
    }, session)).resolves.toEqual({ success: false, error: expectedSafeError })

    reopenProject(projectRoot)
    const snapshots = ImportRunRepository.listResumable()
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({
      id: 'frozen-english-run', locale: 'en-US', lastError: expectedSafeError,
    })
    expect(JSON.stringify(snapshots)).not.toContain(source)
    expect(JSON.stringify(snapshots)).not.toContain(privateDiagnostic)
  })

  it('keeps an empty source retryable and prepares it after the user selects the corrected file again', async () => {
    const source = path.join(parent, 'empty-then-fixed.txt')
    fs.writeFileSync(source, '   ', 'utf8')
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [source] })
    let content = '   \r\n'
    const fileSystem = {
      readText: vi.fn(async () => content),
    } as unknown as WindowsSafeFileSystem
    registerImportController(
      fileSystem,
      filePath => ({ canonicalLocation: filePath, fileIdentity: `file:${path.basename(filePath)}` }),
      {},
      new ExternalFileGrantService(),
      new ImportInspectionStore(),
      secret,
    )
    const handler = mocks.handlers.get('dialog:select-novel-files')!
    const event = { sender: { id: 59, once: vi.fn() } }
    const request = {
      runId: 'empty-retry', purpose: 'reference', locale: 'en-US', expectedProjectPath: projectRoot,
    }

    await expect(handler(event, request, session)).resolves.toEqual({
      success: false,
      error: 'One or more selected files are empty. Add novel text and choose the unfinished files again.',
    })
    expect(importRows()).toEqual({
      runs: [{ id: 'empty-retry', stage: 'parsing', status: 'failed' }],
      sources: [{ run_id: 'empty-retry', status: 'failed' }],
    })
    expect(getProjectDb()!.prepare('SELECT COUNT(*) AS count FROM import_run_source_chapters').get())
      .toEqual({ count: 0 })

    content = 'Chapter 1 Corrected\nThe recovered chapter text.'
    await expect(handler(event, request, session)).resolves.toMatchObject({
      success: true,
      preparation: { classification: 'new', run: { id: 'empty-retry', stage: 'prepared' } },
    })
  })

  it('persists valid files beside a blank file and rereads only the unfinished source', async () => {
    const validSource = path.join(parent, 'a-valid.txt')
    const blankSource = path.join(parent, 'b-blank.txt')
    fs.writeFileSync(validSource, 'valid', 'utf8')
    fs.writeFileSync(blankSource, 'blank', 'utf8')
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [validSource, blankSource] })
    let blankContent = ' \n\t'
    const reads: string[] = []
    const fileSystem = {
      readText: vi.fn(async (capability: { relativePath: string }) => {
        reads.push(capability.relativePath)
        return capability.relativePath === 'a-valid.txt'
          ? '第1章 有效来源\n已保存的正文'
          : blankContent
      }),
    } as unknown as WindowsSafeFileSystem
    registerImportController(
      fileSystem,
      filePath => ({ canonicalLocation: filePath, fileIdentity: `file:${path.basename(filePath)}` }),
      {},
      new ExternalFileGrantService(),
      new ImportInspectionStore(),
      secret,
    )
    const handler = mocks.handlers.get('dialog:select-novel-files')!
    const event = { sender: { id: 60, once: vi.fn() } }
    const request = {
      runId: 'partial-empty-retry', purpose: 'reference', locale: 'zh-CN', expectedProjectPath: projectRoot,
    }

    await expect(handler(event, request, session)).resolves.toEqual({
      success: false,
      error: '一个或多个所选文件为空。请补充小说正文后，重新选择未完成的文件。',
    })
    expect(importRows()).toEqual({
      runs: [{ id: 'partial-empty-retry', stage: 'parsing', status: 'failed' }],
      sources: [
        { run_id: 'partial-empty-retry', status: 'completed' },
        { run_id: 'partial-empty-retry', status: 'failed' },
      ],
    })

    const movedValidSource = path.join(parent, 'a-valid-moved.txt')
    fs.renameSync(validSource, movedValidSource)
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [blankSource] })
    blankContent = '第1章 补全来源\n补全后的正文'
    reads.length = 0
    await expect(handler(event, request, session)).resolves.toMatchObject({
      success: true,
      preparation: { classification: 'new', run: { id: 'partial-empty-retry', stage: 'prepared', totalChapters: 2 } },
    })
    expect(reads).toEqual(['b-blank.txt'])
  })

  it('keeps a title-only source retryable without discarding a valid sibling source', async () => {
    const validSource = path.join(parent, 'a-body.txt')
    const titleOnlySource = path.join(parent, 'b-title-only.txt')
    fs.writeFileSync(validSource, 'Chapter 1 Kept\nSaved body text.', 'utf8')
    fs.writeFileSync(titleOnlySource, 'Chapter 2 Missing body', 'utf8')
    mocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [validSource, titleOnlySource],
    })
    const reads: string[] = []
    const fileSystem = {
      readText: vi.fn(async (capability: { rootPath: string; relativePath: string }) => {
        reads.push(capability.relativePath)
        return fs.readFileSync(path.join(capability.rootPath, capability.relativePath), 'utf8')
      }),
    } as unknown as WindowsSafeFileSystem
    registerImportController(
      fileSystem,
      filePath => ({ canonicalLocation: filePath, fileIdentity: `file:${path.basename(filePath)}` }),
      {},
      new ExternalFileGrantService(),
      new ImportInspectionStore(),
      secret,
    )
    const handler = mocks.handlers.get('dialog:select-novel-files')!
    const event = { sender: { id: 63, once: vi.fn() } }
    const request = {
      runId: 'partial-title-only', purpose: 'reference', locale: 'en-US', expectedProjectPath: projectRoot,
    }

    await expect(handler(event, request, session)).resolves.toEqual({
      success: false,
      error: 'One or more selected files contain chapter headings but no body text. Add novel text and choose the unfinished files again.',
    })
    expect(importRows()).toEqual({
      runs: [{ id: 'partial-title-only', stage: 'parsing', status: 'failed' }],
      sources: [
        { run_id: 'partial-title-only', status: 'completed' },
        { run_id: 'partial-title-only', status: 'failed' },
      ],
    })

    fs.writeFileSync(titleOnlySource, 'Chapter 2 Restored\nRecovered body text.', 'utf8')
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [titleOnlySource] })
    reads.length = 0
    await expect(handler(event, request, session)).resolves.toMatchObject({
      success: true,
      preparation: { classification: 'new', run: { id: 'partial-title-only', stage: 'prepared', totalChapters: 2 } },
    })
    expect(reads).toEqual(['b-title-only.txt'])
  })

  it('leaves an all-title-only import failed and resumable instead of ready with zero chapters', async () => {
    const titleOnlySource = path.join(parent, 'title-only.txt')
    fs.writeFileSync(titleOnlySource, '第1章 只有标题\n第2章 仍然只有标题', 'utf8')
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [titleOnlySource] })
    registerImportController(
      undefined,
      filePath => ({ canonicalLocation: filePath, fileIdentity: `file:${path.basename(filePath)}` }),
      {},
      new ExternalFileGrantService(),
      new ImportInspectionStore(),
      secret,
    )
    const handler = mocks.handlers.get('dialog:select-novel-files')!

    await expect(handler(
      { sender: { id: 64, once: vi.fn() } },
      { runId: 'all-title-only', purpose: 'reference', locale: 'zh-CN', expectedProjectPath: projectRoot },
      session,
    )).resolves.toEqual({
      success: false,
      error: '一个或多个所选文件只有章节标题，没有可导入的正文。请补充小说正文后，重新选择未完成的文件。',
    })
    expect(importRows()).toEqual({
      runs: [{ id: 'all-title-only', stage: 'parsing', status: 'failed' }],
      sources: [{ run_id: 'all-title-only', status: 'failed' }],
    })
    expect(ImportRunRepository.get('all-title-only')).toMatchObject({
      resumable: true,
      totalChapters: 0,
      unfinishedSourceDisplay: [
        { displayName: 'title-only.txt', mediaType: 'text/plain' },
      ],
    })
  })

  it('rejects an injected source when resuming a run and rolls back identity and run writes', async () => {
    const validSource = path.join(parent, 'resume-valid.txt')
    const blankSource = path.join(parent, 'resume-blank.txt')
    const injectedSource = path.join(parent, 'resume-injected.txt')
    fs.writeFileSync(validSource, 'valid', 'utf8')
    fs.writeFileSync(blankSource, 'blank', 'utf8')
    fs.writeFileSync(injectedSource, 'injected', 'utf8')
    mocks.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [validSource, blankSource] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [injectedSource] })
    const fileSystem = {
      readText: vi.fn(async (capability: { relativePath: string }) => (
        capability.relativePath === 'resume-valid.txt'
          ? '第1章 已保存\n已保存正文'
          : ' \n\t'
      )),
    } as unknown as WindowsSafeFileSystem
    registerImportController(
      fileSystem,
      filePath => ({ canonicalLocation: filePath, fileIdentity: `file:${path.basename(filePath)}` }),
      {},
      new ExternalFileGrantService(),
      new ImportInspectionStore(),
      secret,
    )
    const handler = mocks.handlers.get('dialog:select-novel-files')!
    const event = { sender: { id: 61, once: vi.fn() } }
    const request = {
      runId: 'partial-injection', purpose: 'reference', locale: 'zh-CN', expectedProjectPath: projectRoot,
    }

    await expect(handler(event, request, session)).resolves.toMatchObject({ success: false })
    const before = getProjectDb()!.serialize()
    const beforeRows = importRows()
    await expect(handler(event, request, session)).resolves.toMatchObject({ success: false })

    expect(getProjectDb()!.serialize().equals(before)).toBe(true)
    expect(importRows()).toEqual(beforeRows)
  })

  it('counts completed source bytes before reading a partially resumed source', async () => {
    const sourceA = path.join(parent, 'budget-a.txt')
    const sourceB = path.join(parent, 'budget-b.txt')
    fs.writeFileSync(sourceA, 'Chapter 1 A\n1234567890', 'utf8')
    fs.writeFileSync(sourceB, ' ', 'utf8')
    mocks.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [sourceA, sourceB] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [sourceB] })
    const readText = vi.fn(async (capability: { rootPath: string; relativePath: string }) => (
      fs.readFileSync(path.join(capability.rootPath, capability.relativePath), 'utf8')
    ))
    const fileSystem = { readText } as unknown as WindowsSafeFileSystem
    registerImportController(
      fileSystem,
      filePath => ({ canonicalLocation: filePath, fileIdentity: `file:${path.basename(filePath)}` }),
      { maxTotalBytes: 40 },
      new ExternalFileGrantService(),
      new ImportInspectionStore(),
      secret,
    )
    const handler = mocks.handlers.get('dialog:select-novel-files')!
    const event = { sender: { id: 62, once: vi.fn() } }
    const request = {
      runId: 'partial-byte-budget', purpose: 'reference', locale: 'en-US', expectedProjectPath: projectRoot,
    }

    await expect(handler(event, request, session)).resolves.toMatchObject({ success: false })
    const before = getProjectDb()!.serialize()
    const readCount = readText.mock.calls.length
    fs.writeFileSync(sourceB, '12345678901234567890123456789012345', 'utf8')

    await expect(handler(event, request, session)).resolves.toMatchObject({ success: false })
    expect(readText).toHaveBeenCalledTimes(readCount)
    expect(getProjectDb()!.serialize().equals(before)).toBe(true)
  })
})

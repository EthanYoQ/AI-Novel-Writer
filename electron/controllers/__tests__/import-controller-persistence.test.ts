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
    await expect(handler(event, request, session)).resolves.toMatchObject({
      success: true,
      preparation: { classification: 'new', run: { stage: 'prepared' } },
    })
    expect(reads).toEqual([sourceB])
  })
})

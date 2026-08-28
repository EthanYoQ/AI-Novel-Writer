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

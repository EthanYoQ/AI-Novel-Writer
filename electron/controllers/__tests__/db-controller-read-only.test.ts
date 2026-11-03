import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const handlers = new Map<string, IpcHandler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
  },
}))

import { closeProjectDatabase } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { DraftRepository } from '../../repositories/draft-repository'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { projectAccess } from '../../services/project-access'
import { registerDatabaseController } from '../db-controller'

let parentDirectory = ''
let session = { projectId: '', leaseId: '', projectPath: '' }

beforeAll(() => registerDatabaseController())

beforeEach(() => {
  parentDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-db-read-only-'))
  const lease = projectAccess.beginSession(projectAccess.createProject(parentDirectory, 'novel'))
  session = { projectId: lease.projectId, leaseId: lease.leaseId, projectPath: lease.rootPath }
  initProjectDatabase(lease.rootPath)
})

afterEach(() => {
  closeProjectDatabase()
  projectAccess.invalidateCurrentSession()
  fs.rmSync(parentDirectory, { recursive: true, force: true })
})

function finalizedDraft(content: string): number {
  const draftId = DraftRepository.create({ chapterNumber: 1, source: 'write', content, wordCount: content.length })
  FinalizationRepository.commit({
    finalizationId: randomUUID(),
    draftId,
    chapterNumber: 1,
    chapterTitle: '雾钟',
    content,
    contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
    contentRevision: 1,
    targetFileName: `第1章 雾钟 ${draftId}.txt`,
  })
  return draftId
}

function updateContent(draftId: number, content: string) {
  return handlers.get('db:draft-update-content')!({}, draftId, content, content.length, session.projectPath, session)
}

describe('db:draft-update-content 对带定稿收据的稿', () => {
  it('定稿与被替换的旧定稿都返回只读拒绝，正文不变', async () => {
    const replaced = finalizedDraft('第一章旧定稿。')
    const current = finalizedDraft('第一章新定稿。')

    for (const draftId of [current, replaced]) {
      await expect(updateContent(draftId, '覆盖')).resolves.toEqual({
        success: false,
        error: 'Error: DRAFT_FINALIZED_READ_ONLY',
      })
    }
    expect([DraftRepository.getFull(replaced)?.content, DraftRepository.getFull(current)?.content])
      .toEqual(['第一章旧定稿。', '第一章新定稿。'])
  })

  it('工作稿照常保存', async () => {
    const draftId = DraftRepository.create({ chapterNumber: 2, source: 'write', content: '初稿', wordCount: 2 })

    await expect(updateContent(draftId, '改稿')).resolves.toEqual({ success: true })
    expect(DraftRepository.getFull(draftId)?.content).toBe('改稿')
  })
})

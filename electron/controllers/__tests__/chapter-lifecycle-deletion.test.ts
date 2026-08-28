import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const handlers = new Map<string, IpcHandler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
  },
}))

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { addChunks, closeConnection, listDocuments } from '../../vector-store'
import { removeDocument, searchKnowledgeFTS } from '../../knowledge-base'
import { DraftRepository } from '../../repositories/draft-repository'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { PostProcessRepository } from '../../repositories/post-process-repository'
import { projectAccess } from '../../services/project-access'
import { ChapterDeletionService } from '../../services/chapter-deletion-service'
import { publishManuscript, removePublishedManuscript } from '../../services/manuscript-publisher'
import { registerChapterLifecycleController } from '../chapter-lifecycle-controller'

describe('chapter lifecycle deletion IPC', () => {
  let parentDirectory: string
  let projectRoot: string
  let projectSession: { projectId: string; leaseId: string; projectPath: string }
  let draftId: number
  let targetFileName: string

  beforeAll(() => registerChapterLifecycleController())

  beforeEach(async () => {
    parentDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-chapter-delete-'))
    const project = projectAccess.createProject(parentDirectory, 'novel')
    const lease = projectAccess.beginSession(project)
    projectRoot = lease.rootPath
    projectSession = {
      projectId: lease.projectId,
      leaseId: lease.leaseId,
      projectPath: lease.rootPath,
    }
    initProjectDatabase(projectRoot)

    draftId = DraftRepository.create({
      chapterNumber: 1,
      source: 'write',
      content: '目标章节独有关键字',
      wordCount: 9,
    })
    const finalization = FinalizationRepository.commit({
      finalizationId: 'finalization-1',
      draftId,
      chapterNumber: 1,
      chapterTitle: '同名',
      content: '目标章节独有关键字',
      contentHash: 'target-hash',
      contentRevision: 1,
      targetFileName: '第1章 同名.txt',
    })
    targetFileName = finalization.targetFileName
    FinalizationRepository.linkKnowledgeDocument(draftId, 'finalized-document')
    await publishManuscript({
      projectRoot,
      targetFileName,
      chapterNumber: 1,
      chapterTitle: '同名',
      content: '目标章节独有关键字',
    })
    FinalizationRepository.markPublished(finalization.finalizationId)

    PostProcessRepository.createRun({
      triggerSourceType: 'chapter_finalize',
      triggerSourceId: '1',
      sourceLabel: '第1章定稿',
      steps: [{ key: 'kb_import', label: '导入知识库', critical: true }],
    })

    await addChunks(
      projectRoot,
      'finalized-document',
      targetFileName,
      ['目标章节独有关键字'],
    )
    await addChunks(
      projectRoot,
      'reference-document',
      targetFileName,
      ['参考小说应保留关键字'],
    )
  })

  afterEach(async () => {
    closeProjectDatabase()
    projectAccess.invalidateCurrentSession()
    closeConnection(projectRoot)
    fs.rmSync(parentDirectory, { recursive: true, force: true })
  })

  it('removes a finalized chapter and only its frozen derived projections', async () => {
    const rawHandler = handlers.get('chapter:delete-finalized')
    expect(rawHandler).toBeDefined()

    const result = await rawHandler!(
      {},
      { draftId, chapterNumber: 1 },
      projectRoot,
      projectSession,
    ) as {
      success: boolean
      committed: boolean
      operation?: { status: string }
      error?: string
    }

    expect(result).toMatchObject({
      success: true,
      committed: true,
      operation: { status: 'completed' },
    })
    expect(DraftRepository.getFull(draftId)).toBeNull()
    expect(fs.existsSync(path.join(projectRoot, targetFileName))).toBe(false)
    expect(PostProcessRepository.getLatestRun('chapter_finalize', '1')).toBeNull()

    await expect(listDocuments(projectRoot)).resolves.toEqual([
      expect.objectContaining({ id: 'reference-document', fileName: targetFileName }),
    ])
    await expect(searchKnowledgeFTS('目标章节独有关键字', projectRoot)).resolves.toEqual([])
    await expect(searchKnowledgeFTS('参考小说应保留关键字', projectRoot)).resolves.toEqual([
      expect.objectContaining({ fileName: targetFileName }),
    ])
  })

  it('persists a failed projection cleanup and completes it after restart retry', async () => {
    registerChapterLifecycleController(new ChapterDeletionService({
      createOperationId: () => 'deletion-retry-1',
      cleaner: {
        removeManuscript: removePublishedManuscript,
        async removeKnowledgeDocument() {
          throw new Error('simulated knowledge cleanup outage')
        },
      },
    }))
    const deleteHandler = handlers.get('chapter:delete-finalized')!
    const first = await deleteHandler(
      {},
      { draftId, chapterNumber: 1 },
      projectRoot,
      projectSession,
    ) as {
      success: boolean
      committed: boolean
      operation: { operationId: string; status: string; knowledgeStatus: string; knowledgeError: string }
      error?: string
    }

    expect(first).toMatchObject({
      success: false,
      committed: true,
      operation: {
        operationId: 'deletion-retry-1',
        status: 'failed',
        knowledgeStatus: 'failed',
        knowledgeError: 'simulated knowledge cleanup outage',
      },
      error: expect.stringContaining('知识库清理失败'),
    })
    expect(DraftRepository.getFull(draftId)).toBeNull()
    expect(fs.existsSync(path.join(projectRoot, targetFileName))).toBe(false)
    await expect(searchKnowledgeFTS('目标章节独有关键字', projectRoot)).resolves.not.toEqual([])

    closeProjectDatabase()
    projectAccess.invalidateCurrentSession()
    closeConnection(projectRoot)
    const reopened = projectAccess.probeExistingProject(projectRoot)
    if (reopened.kind !== 'manifest') throw new Error('test project manifest missing')
    const replacementLease = projectAccess.beginSession(reopened)
    projectSession = {
      projectId: replacementLease.projectId,
      leaseId: replacementLease.leaseId,
      projectPath: replacementLease.rootPath,
    }
    initProjectDatabase(projectRoot)
    registerChapterLifecycleController(new ChapterDeletionService({
      cleaner: {
        removeManuscript: removePublishedManuscript,
        async removeKnowledgeDocument(root, documentId) {
          if (!await removeDocument(documentId, root)) throw new Error('knowledge cleanup failed')
        },
      },
    }))

    const list = await handlers.get('chapter:list-incomplete-deletions')!(
      {},
      projectRoot,
      projectSession,
    ) as { success: boolean; operations: Array<{ operationId: string; status: string }> }
    expect(list).toEqual({
      success: true,
      operations: [expect.objectContaining({ operationId: 'deletion-retry-1', status: 'failed' })],
    })

    const retried = await handlers.get('chapter:retry-deletion')!(
      {},
      'deletion-retry-1',
      projectRoot,
      projectSession,
    ) as { success: boolean; committed: boolean; operation: { status: string; attemptCount: number } }
    expect(retried).toMatchObject({
      success: true,
      committed: true,
      operation: { status: 'completed', attemptCount: 2 },
    })
    await expect(searchKnowledgeFTS('目标章节独有关键字', projectRoot)).resolves.toEqual([])
    await expect(searchKnowledgeFTS('参考小说应保留关键字', projectRoot)).resolves.not.toEqual([])
  })

  it('persists a failed manuscript cleanup and removes the file on retry', async () => {
    registerChapterLifecycleController(new ChapterDeletionService({
      createOperationId: () => 'manuscript-retry-1',
      cleaner: {
        async removeManuscript() {
          throw new Error('simulated manuscript cleanup outage')
        },
        async removeKnowledgeDocument(root, documentId) {
          if (!await removeDocument(documentId, root)) throw new Error('knowledge cleanup failed')
        },
      },
    }))

    const first = await handlers.get('chapter:delete-finalized')!(
      {},
      { draftId, chapterNumber: 1 },
      projectRoot,
      projectSession,
    ) as {
      success: boolean
      committed: boolean
      operation: { operationId: string; status: string; manuscriptStatus: string; manuscriptError: string }
    }

    expect(first).toMatchObject({
      success: false,
      committed: true,
      operation: {
        operationId: 'manuscript-retry-1',
        status: 'failed',
        manuscriptStatus: 'failed',
        manuscriptError: 'simulated manuscript cleanup outage',
      },
    })
    expect(fs.existsSync(path.join(projectRoot, targetFileName))).toBe(true)
    await expect(searchKnowledgeFTS('目标章节独有关键字', projectRoot)).resolves.toEqual([])
    await expect(searchKnowledgeFTS('参考小说应保留关键字', projectRoot)).resolves.not.toEqual([])

    registerChapterLifecycleController(new ChapterDeletionService())
    const retried = await handlers.get('chapter:retry-deletion')!(
      {},
      'manuscript-retry-1',
      projectRoot,
      projectSession,
    ) as { success: boolean; committed: boolean; operation: { status: string; attemptCount: number } }

    expect(retried).toMatchObject({
      success: true,
      committed: true,
      operation: { status: 'completed', attemptCount: 2 },
    })
    expect(fs.existsSync(path.join(projectRoot, targetFileName))).toBe(false)
    await expect(searchKnowledgeFTS('参考小说应保留关键字', projectRoot)).resolves.not.toEqual([])
  })

  it('rejects stale leases and mismatched chapter identities without deleting anything', async () => {
    const handler = handlers.get('chapter:delete-finalized')!
    const staleSession = projectSession
    const reopened = projectAccess.probeExistingProject(projectRoot)
    if (reopened.kind !== 'manifest') throw new Error('test project manifest missing')
    const replacementLease = projectAccess.beginSession(reopened)
    projectSession = {
      projectId: replacementLease.projectId,
      leaseId: replacementLease.leaseId,
      projectPath: replacementLease.rootPath,
    }

    await expect(handler(
      {},
      { draftId, chapterNumber: 1 },
      projectRoot,
      staleSession,
    )).resolves.toMatchObject({
      success: false,
      committed: false,
      error: expect.stringContaining('会话'),
    })
    await expect(handler(
      {},
      { draftId, chapterNumber: 2 },
      projectRoot,
      projectSession,
    )).resolves.toMatchObject({
      success: false,
      committed: false,
      error: expect.stringContaining('身份不匹配'),
    })
    expect(DraftRepository.getFull(draftId)).not.toBeNull()
    expect(fs.existsSync(path.join(projectRoot, targetFileName))).toBe(true)
    await expect(searchKnowledgeFTS('目标章节独有关键字', projectRoot)).resolves.not.toEqual([])
  })

  it('replays the completed deletion receipt for duplicate requests', async () => {
    registerChapterLifecycleController(new ChapterDeletionService({
      createOperationId: () => 'stable-deletion-operation',
    }))
    const handler = handlers.get('chapter:delete-finalized')!
    const first = await handler(
      {},
      { draftId, chapterNumber: 1 },
      projectRoot,
      projectSession,
    ) as { success: boolean; operation: { operationId: string; attemptCount: number } }
    const duplicate = await handler(
      {},
      { draftId, chapterNumber: 1 },
      projectRoot,
      projectSession,
    ) as { success: boolean; operation: { operationId: string; attemptCount: number } }

    expect(first).toMatchObject({
      success: true,
      operation: { operationId: 'stable-deletion-operation', attemptCount: 1 },
    })
    expect(duplicate).toEqual(first)
  })

  it('rejects a duplicate request when its chapter identity differs from the receipt', async () => {
    registerChapterLifecycleController(new ChapterDeletionService({
      createOperationId: () => 'identity-bound-deletion',
    }))
    const handler = handlers.get('chapter:delete-finalized')!
    const first = await handler(
      {},
      { draftId, chapterNumber: 1 },
      projectRoot,
      projectSession,
    ) as { success: boolean; operation: { attemptCount: number } }

    expect(first).toMatchObject({ success: true, operation: { attemptCount: 1 } })
    await expect(handler(
      {},
      { draftId, chapterNumber: 2 },
      projectRoot,
      projectSession,
    )).resolves.toMatchObject({
      success: false,
      committed: false,
      error: expect.stringContaining('身份不匹配'),
    })
  })

  it('keeps an identical reference document when a legacy finalization lacks reliable provenance', async () => {
    getProjectDb()!.prepare(`
      UPDATE finalization_outbox SET knowledge_document_id = '' WHERE draft_id = ?
    `).run(draftId)
    await removeDocument('finalized-document', projectRoot)
    await removeDocument('reference-document', projectRoot)
    await addChunks(
      projectRoot,
      'identical-reference-document',
      targetFileName,
      ['目标章节独有关键字'],
    )

    const result = await handlers.get('chapter:delete-finalized')!(
      {},
      { draftId, chapterNumber: 1 },
      projectRoot,
      projectSession,
    ) as { success: boolean; committed: boolean; error?: string }

    expect(result).toMatchObject({
      success: false,
      committed: false,
      error: expect.stringContaining('缺少可靠'),
    })
    expect(DraftRepository.getFull(draftId)).not.toBeNull()
    expect(fs.existsSync(path.join(projectRoot, targetFileName))).toBe(true)
    await expect(listDocuments(projectRoot)).resolves.toEqual([
      expect.objectContaining({ id: 'identical-reference-document', fileName: targetFileName }),
    ])
    await expect(searchKnowledgeFTS('目标章节独有关键字', projectRoot)).resolves.not.toEqual([])
  })

  it('keeps the chapter fact when legacy knowledge identity is ambiguous', async () => {
    getProjectDb()!.prepare(`
      UPDATE finalization_outbox SET knowledge_document_id = '' WHERE draft_id = ?
    `).run(draftId)
    await addChunks(
      projectRoot,
      'duplicate-finalized-document',
      targetFileName,
      ['目标章节独有关键字'],
    )

    await expect(handlers.get('chapter:delete-finalized')!(
      {},
      { draftId, chapterNumber: 1 },
      projectRoot,
      projectSession,
    )).resolves.toMatchObject({
      success: false,
      committed: false,
      error: expect.stringContaining('缺少可靠'),
    })
    expect(DraftRepository.getFull(draftId)).not.toBeNull()
    expect(fs.existsSync(path.join(projectRoot, targetFileName))).toBe(true)
  })
})

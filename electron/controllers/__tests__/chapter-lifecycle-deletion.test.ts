import { createHash } from 'node:crypto'
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

import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { addChunks, closeConnection, listDocuments } from '../../vector-store'
import { removeDocument, searchKnowledgeFTS } from '../../knowledge-base'
import { DraftRepository } from '../../repositories/draft-repository'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { PostProcessRepository } from '../../repositories/post-process-repository'
import { projectAccess } from '../../services/project-access'
import * as portableFreeze from '../../services/portable-runtime-freeze'
import { ChapterDeletionRepository } from '../../repositories/chapter-deletion-repository'
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
      contentHash: createHash('sha256').update('目标章节独有关键字').digest('hex'),
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
      undefined,
      undefined,
      { corpusKind: 'project-knowledge' },
    )
    await addChunks(
      projectRoot,
      'reference-document',
      targetFileName,
      ['参考小说应保留关键字'],
      undefined,
      undefined,
      { corpusKind: 'reference', replacementMode: 'stable-id' },
    )
  })

  afterEach(async () => {
    closeProjectDatabase()
    projectAccess.invalidateCurrentSession()
    closeConnection(projectRoot)
    fs.rmSync(parentDirectory, { recursive: true, force: true })
  })

  it('moves a finalized chapter to the trash, removes only its frozen derived projections, and purges it on request', async () => {
    const finalizationId = getProjectDb()!.prepare('SELECT finalization_id FROM finalization_outbox WHERE draft_id=?').pluck().get(draftId) as string
    for (const id of [`finalization:${finalizationId}`, 'finalization:unrelated']) {
      getProjectDb()!.prepare("INSERT INTO post_process_runs(id,trigger_source_type,trigger_source_id) VALUES(?,'chapter_finalize',?)").run(id,id)
      getProjectDb()!.prepare("INSERT INTO post_process_steps(run_id,step_key,label,critical) VALUES(?,'kb_import','知识',1)").run(id)
    }
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
    // 进回收站：按章号登记的后处理改记到这份定稿名下，留到彻底删除，恢复时摘要、角色状态不必重算。
    expect(PostProcessRepository.getLatestRun('chapter_finalize', '1')).toBeNull()
    expect(PostProcessRepository.getLatestRun('chapter_finalize', `finalization:${finalizationId}`)).not.toBeNull()
    expect(PostProcessRepository.getLatestRun('chapter_finalize', 'finalization:unrelated')).not.toBeNull()

    const list = await handlers.get('chapter:trash-list')!({}, projectRoot, projectSession) as { success: boolean; entries: Array<{ deletionId: string; draftId: number; restoreMode: string }> }
    expect(list).toMatchObject({ success: true, entries: [{ draftId, restoreMode: 'into-gap' }], damaged: [] })
    const purged = await handlers.get('chapter:trash-purge')!({}, { deletionIds: [list.entries[0]!.deletionId] }, projectRoot, projectSession)
    expect(purged).toEqual({ success: true, purged: [list.entries[0]!.deletionId], alreadyGone: [] })
    expect(PostProcessRepository.getLatestRun('chapter_finalize', `finalization:${finalizationId}`)).toBeNull()
    expect(PostProcessRepository.getLatestRun('chapter_finalize', 'finalization:unrelated')).not.toBeNull()
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM drafts_all WHERE id=?').pluck().get(draftId)).toBe(0)
    await expect(handlers.get('chapter:trash-list')!({}, projectRoot, projectSession)).resolves.toEqual({ success: true, entries: [], damaged: [] })

    await expect(listDocuments(projectRoot)).resolves.toEqual([
      expect.objectContaining({ id: 'reference-document', fileName: targetFileName }),
    ])
    await expect(searchKnowledgeFTS('目标章节独有关键字', projectRoot)).resolves.toEqual([])
    await expect(searchKnowledgeFTS('参考小说应保留关键字', projectRoot)).resolves.toEqual([
      expect.objectContaining({ fileName: targetFileName }),
    ])
  })

  it('restores a trashed chapter through IPC: republishes the manuscript and leaves knowledge for an explicit re-import', async () => {
    const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args, projectRoot, projectSession)
    await invoke('chapter:delete-finalized', { draftId, chapterNumber: 1 })
    const list = await invoke('chapter:trash-list') as { entries: Array<{ deletionId: string }> }
    const deletionId = list.entries[0]!.deletionId
    expect(fs.existsSync(path.join(projectRoot, targetFileName))).toBe(false)

    const restored = await invoke('chapter:trash-restore', { deletionId, draftId, expectedMode: 'into-gap' })

    expect(restored).toMatchObject({ success: true, outcome: 'restored', chapterNumber: 1, draftId, publicationStatus: 'published' })
    expect(fs.readFileSync(path.join(projectRoot, targetFileName), 'utf8')).toContain('目标章节独有关键字')
    expect(DraftRepository.getMeta(draftId)?.status).toBe('finalized')
    expect(FinalizationRepository.getByDraftId(draftId)).toMatchObject({ knowledgeDocumentId: '', publicationStatus: 'published' })
    await expect(searchKnowledgeFTS('目标章节独有关键字', projectRoot)).resolves.toEqual([])
    await expect(invoke('chapter:trash-list')).resolves.toEqual({ success: true, entries: [], damaged: [] })
    await expect(invoke('chapter:trash-restore', { deletionId, draftId, expectedMode: 'into-gap' }))
      .resolves.toEqual({ success: true, outcome: 'already-restored', chapterNumber: 1, draftId })
    await expect(handlers.get('chapter:trash-restore')!({}, { deletionId, draftId, expectedMode: 'into-gap' }, path.join(projectRoot, 'other'), projectSession))
      .resolves.toMatchObject({ success: false })
  })

  it('treats removing a knowledge document that is already gone as done (G10)', async () => {
    await expect(removeDocument('never-imported', projectRoot)).resolves.toBe(true)
    await expect(removeDocument('finalized-document', projectRoot)).resolves.toBe(true)
    await expect(removeDocument('finalized-document', projectRoot)).resolves.toBe(true)
  })

  it('hides frozen deletion history and does not offer legacy authorization on a refused retry',async()=>{
    const operation=ChapterDeletionRepository.begin({operationId:'frozen-operation',draftId,chapterNumber:1})
    const stored=operation
    const guard=vi.spyOn(portableFreeze,'readPortableRuntimeFreeze').mockReturnValue({active:true,isFrozen:()=>true,assertMutable:()=>{throw new Error('PORTABLE_RUNTIME_FROZEN')}})
    try {
      const service=new ChapterDeletionService()
      expect(service.listIncomplete(projectRoot)).toEqual([])
      const result=await service.retry(projectRoot,stored.operationId)
      expect(result).toMatchObject({success:false,committed:false,error:'CHAPTER_DELETE_LEGACY_OPERATION_FROZEN'})
      expect(result.operation).toBeUndefined()
      expect(ChapterDeletionRepository.get(stored.operationId)).toEqual(stored)
    } finally { guard.mockRestore() }
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
      error: 'CHAPTER_DELETE_CLEANUP_INCOMPLETE',
    })
    expect(DraftRepository.getFull(draftId)).toBeNull()
    expect(fs.existsSync(path.join(projectRoot, targetFileName))).toBe(false)
    await expect(searchKnowledgeFTS('目标章节独有关键字', projectRoot)).resolves.not.toEqual([])

    await expect(handlers.get('chapter:confirm-legacy-knowledge-absent')!(
      {},
      first.operation.operationId,
      projectRoot,
      projectSession,
    )).resolves.toMatchObject({
      success: false,
      committed: false,
      error: 'CHAPTER_DELETE_LEGACY_CONFIRMATION_CONSUMED',
    })

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
      error: 'PROJECT_SESSION_STALE',
    })
    await expect(handler(
      {},
      { draftId, chapterNumber: 2 },
      projectRoot,
      projectSession,
    )).resolves.toMatchObject({
      success: false,
      committed: false,
      error: 'CHAPTER_DELETE_TARGET_MISMATCH',
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
      error: 'CHAPTER_DELETE_REQUEST_MISMATCH',
    })
  })

  it('records an authorization-required receipt without touching an identical reference document', async () => {
    getProjectDb()!.prepare(`
      UPDATE finalization_outbox_all SET knowledge_document_id = '' WHERE draft_id = ?
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
    ) as {
      success: boolean
      committed: boolean
      operation?: { operationId: string; status: string; legacyKnowledgeAuthorization: string }
      error?: string
    }

    expect(result).toMatchObject({
      success: false,
      committed: false,
      operation: {
        status: 'authorization_required',
        legacyKnowledgeAuthorization: 'required',
      },
      error: 'CHAPTER_DELETE_LEGACY_KNOWLEDGE_CHECK_REQUIRED',
    })
    const listed = await handlers.get('chapter:list-incomplete-deletions')!(
      {},
      projectRoot,
      projectSession,
    ) as { success: boolean; operations: Array<{ operationId: string; status: string }> }
    expect(listed).toMatchObject({
      success: true,
      operations: [
        { operationId: result.operation?.operationId, status: 'authorization_required' },
      ],
    })
    expect(DraftRepository.getFull(draftId)).not.toBeNull()
    expect(fs.existsSync(path.join(projectRoot, targetFileName))).toBe(true)
    await expect(listDocuments(projectRoot)).resolves.toEqual([
      expect.objectContaining({ id: 'identical-reference-document', fileName: targetFileName }),
    ])
    await expect(searchKnowledgeFTS('目标章节独有关键字', projectRoot)).resolves.not.toEqual([])
  })

  it('continues a legacy deletion only after explicit knowledge-absence confirmation', async () => {
    getProjectDb()!.prepare(`
      UPDATE finalization_outbox_all SET knowledge_document_id = '' WHERE draft_id = ?
    `).run(draftId)
    await removeDocument('finalized-document', projectRoot)
    await removeDocument('reference-document', projectRoot)
    await addChunks(
      projectRoot,
      'confirmed-identical-reference',
      targetFileName,
      ['目标章节独有关键字'],
    )

    const blocked = await handlers.get('chapter:delete-finalized')!(
      {},
      { draftId, chapterNumber: 1 },
      projectRoot,
      projectSession,
    ) as {
      operation: { operationId: string; legacyKnowledgeAuthorization: string }
    }
    expect(blocked.operation).toMatchObject({ legacyKnowledgeAuthorization: 'required' })

    const confirmed = await handlers.get('chapter:confirm-legacy-knowledge-absent')!(
      {},
      blocked.operation.operationId,
      projectRoot,
      projectSession,
    ) as {
      success: boolean
      committed: boolean
      operation: {
        status: string
        legacyKnowledgeAuthorization: string
        legacyKnowledgeAuthorizedAt: string
      }
    }
    expect(confirmed).toMatchObject({
      success: true,
      committed: true,
      operation: {
        status: 'completed',
        legacyKnowledgeAuthorization: 'consumed',
        legacyKnowledgeAuthorizedAt: expect.any(String),
      },
    })
    expect(confirmed.operation.legacyKnowledgeAuthorizedAt).not.toBe('')
    expect(confirmed.operation).not.toHaveProperty('legacyKnowledgeConfirmedAt')
    expect(confirmed.operation).not.toHaveProperty('legacyKnowledgeConsumedAt')
    expect(DraftRepository.getFull(draftId)).toBeNull()
    expect(fs.existsSync(path.join(projectRoot, targetFileName))).toBe(false)
    await expect(listDocuments(projectRoot)).resolves.toEqual([
      expect.objectContaining({
        id: 'confirmed-identical-reference',
        fileName: targetFileName,
      }),
    ])
    await expect(searchKnowledgeFTS('目标章节独有关键字', projectRoot)).resolves.not.toEqual([])

    await expect(handlers.get('chapter:confirm-legacy-knowledge-absent')!(
      {},
      blocked.operation.operationId,
      projectRoot,
      projectSession,
    )).resolves.toMatchObject({
      success: false,
      committed: false,
      error: 'CHAPTER_DELETE_LEGACY_CONFIRMATION_CONSUMED',
    })
  })

  it('旧版本定稿确认删除后，本章被取代的那一稿认得出的知识库资料一并删掉，来源不明的参考资料不动', async () => {
    registerChapterLifecycleController(new ChapterDeletionService())
    getProjectDb()!.prepare(`UPDATE drafts_all SET status = 'superseded' WHERE id = ?`).run(draftId)
    const legacyDraftId = DraftRepository.create({ chapterNumber: 1, source: 'write', content: '旧版本定稿正文', wordCount: 7 })
    FinalizationRepository.commit({
      finalizationId: 'finalization-legacy',
      draftId: legacyDraftId,
      chapterNumber: 1,
      chapterTitle: '同名',
      content: '旧版本定稿正文',
      contentHash: 'legacy-hash',
      contentRevision: 1,
      targetFileName,
    })

    const blocked = await handlers.get('chapter:delete-finalized')!(
      {}, { draftId: legacyDraftId, chapterNumber: 1 }, projectRoot, projectSession,
    ) as { operation: { operationId: string; legacyKnowledgeAuthorization: string } }
    expect(blocked.operation).toMatchObject({ legacyKnowledgeAuthorization: 'required' })
    await expect(listDocuments(projectRoot)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'finalized-document' }),
    ]))

    await expect(handlers.get('chapter:confirm-legacy-knowledge-absent')!(
      {}, blocked.operation.operationId, projectRoot, projectSession,
    )).resolves.toMatchObject({ success: true, committed: true })
    await expect(listDocuments(projectRoot)).resolves.toEqual([
      expect.objectContaining({ id: 'reference-document' }),
    ])
  })

  it('keeps the chapter fact when legacy knowledge identity is ambiguous', async () => {
    getProjectDb()!.prepare(`
      UPDATE finalization_outbox_all SET knowledge_document_id = '' WHERE draft_id = ?
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
      error: 'CHAPTER_DELETE_LEGACY_KNOWLEDGE_CHECK_REQUIRED',
    })
    expect(DraftRepository.getFull(draftId)).not.toBeNull()
    expect(fs.existsSync(path.join(projectRoot, targetFileName))).toBe(true)
  })
})

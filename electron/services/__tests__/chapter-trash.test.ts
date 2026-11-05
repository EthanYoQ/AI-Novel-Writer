import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { reopenWithContent } from '../../../test/helpers/reopened-draft'
import { countDraftUnits } from '../../../src/shared/draft-units'
import { CHAPTER_RESTORED_REPROJECTION_PENDING } from '../../../src/shared/finalization-step-error'
import { ChapterDeletionRepository } from '../../repositories/chapter-deletion-repository'
import { DraftRepository } from '../../repositories/draft-repository'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { PostProcessRepository } from '../../repositories/post-process-repository'
import { ChapterDeletionService, type ChapterDeletionProjectionCleaner } from '../chapter-deletion-service'
import { FinalizationService } from '../finalization-service'
import { GenerationDraftEffects } from '../generation-draft-effects'
import { serializeManuscript } from '../manuscript-publisher'
import * as portableFreeze from '../portable-runtime-freeze'

// 回收站（#564 PR3）：删除进回收站、恢复（三种方式）、彻底删除，在仓库层与服务层的行为。

let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-trash-'))
  initProjectDatabase(projectRoot)
})

afterEach(() => {
  vi.restoreAllMocks()
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const db = () => getProjectDb()!

function write(chapterNumber: number, content: string): number {
  return DraftRepository.create({ chapterNumber, source: 'write', content, wordCount: countDraftUnits(content) })
}

/** 定稿并登记带知识库导入步骤的后处理；按章号登记模拟旧定稿，按定稿登记模拟新定稿。 */
function finalize(draftId: number, knowledgeDocumentId: string, runKey: 'chapter' | 'finalization' = 'finalization') {
  const draft = DraftRepository.getFull(draftId)!
  const record = FinalizationRepository.commit({
    finalizationId: randomUUID(), draftId, chapterNumber: draft.chapterNumber, chapterTitle: '沉船',
    content: draft.content, contentHash: sha256(draft.content), contentRevision: 1,
    targetFileName: `第${draft.chapterNumber}章 沉船 ${knowledgeDocumentId}.txt`,
  })
  if (knowledgeDocumentId) FinalizationRepository.linkKnowledgeDocument(draftId, knowledgeDocumentId)
  const runId = PostProcessRepository.createRun({
    triggerSourceType: 'chapter_finalize', triggerSourceId: String(draft.chapterNumber),
    sourceLabel: '定稿', steps: [{ key: 'kb_import', label: '导入知识库', critical: true }],
    ...(runKey === 'finalization' ? { finalizedSource: { draftId, chapterNumber: draft.chapterNumber,
      finalizationId: record.finalizationId, contentHash: sha256(draft.content) } } : {}),
  })
  PostProcessRepository.markStepOk(runId, 'kb_import')
  return record
}

function recordingCleaner(failKnowledge: Set<string> = new Set()) {
  const removed = { manuscripts: [] as string[], knowledge: [] as string[] }
  const cleaner: ChapterDeletionProjectionCleaner = {
    async removeManuscript(_root, targetFileName) { removed.manuscripts.push(targetFileName) },
    async removeKnowledgeDocument(_root, documentId) {
      if (failKnowledge.has(documentId)) throw new Error('KB_LOCKED')
      removed.knowledge.push(documentId)
    },
  }
  return { removed, cleaner }
}

function service(options: { failKnowledge?: Set<string>; id?: string } = {}) {
  const { removed, cleaner } = recordingCleaner(options.failKnowledge)
  const retry = vi.fn(async (request: { finalizationId: string }) => ({
    success: true, committed: true, finalizationId: request.finalizationId, publicationStatus: 'published' as const,
  }))
  const ids = [options.id ?? 'delete-a', 'delete-b', 'delete-c', 'delete-d']
  const instance = new ChapterDeletionService({ cleaner, createOperationId: () => ids.shift()!, finalizations: { retry } })
  return { service: instance, removed, retry }
}

/** 第 1、2、3 章都已定稿，第 2 章定稿过两次（一份旧定稿）。 */
function threeChapters() {
  finalize(write(1, '第一章：雾钟。'), 'kb-1')
  const old = write(2, '第二章旧稿：北堤外的沉船。')
  const oldRecord = finalize(old, 'kb-2-old')
  const current = reopenWithContent(2, '第二章新稿：沉船在北堤下翻了个身。')
  const currentRecord = finalize(current, 'kb-2-new')
  finalize(write(3, '第三章：铜钟又响了。'), 'kb-3')
  return { old, oldRecord, current, currentRecord }
}

const continuity = () => db().prepare("SELECT generation, stale_from_chapter FROM continuity_projection_meta WHERE id='main'").get()
const statuses = (...ids: number[]) => ids.map(id => db().prepare('SELECT status FROM drafts_all WHERE id=?').pluck().get(id))

describe('删除进回收站', () => {
  it('本章定稿与旧定稿原样留在回收站，读取路径看不见；水位不推，后面各章的要点与角色状态仍然当前', async () => {
    const { old, current } = threeChapters()
    const before = continuity()
    const { service: s } = service()

    const result = await s.delete(projectRoot, { draftId: current, chapterNumber: 2 })

    expect(result).toMatchObject({ success: true, committed: true })
    expect(statuses(old, current)).toEqual(['deleted', 'deleted'])
    expect(DraftRepository.getMeta(current)).toBeNull()
    expect(DraftRepository.getMaxFinalizedChapter()).toBe(3)
    expect(continuity()).toEqual(before)
    expect(s.listTrash()).toEqual({ success: true, damaged: [], entries: [expect.objectContaining({
      deletionId: 'delete-a', draftId: current, chapterNumber: 2, chapterTitle: '沉船', versionCount: 2,
      cleanup: 'completed', restoreMode: 'into-gap', wordCount: countDraftUnits('第二章新稿：沉船在北堤下翻了个身。'),
    })] })
  })

  it('被删的稿既不能再删成普通稿，也不能再定稿', async () => {
    const { current } = threeChapters()
    await service().service.delete(projectRoot, { draftId: current, chapterNumber: 2 })

    DraftRepository.delete(current)
    expect(statuses(current)).toEqual(['deleted'])
    expect(() => FinalizationRepository.commit({ finalizationId: randomUUID(), draftId: current, chapterNumber: 2,
      chapterTitle: '沉船', content: 'x', contentHash: sha256('x'), contentRevision: 1, targetFileName: 'x.txt' }))
      .toThrow('DRAFT_NOT_FOUND')
  })

  it('补写缺口章定稿不推水位（G8）', async () => {
    const { current } = threeChapters()
    await service().service.delete(projectRoot, { draftId: current, chapterNumber: 2 })
    const before = continuity()

    finalize(write(2, '第二章删后重写。'), 'kb-2-rewrite')

    expect(continuity()).toEqual(before)
  })
})

describe('恢复', () => {
  it('放回原位：两份定稿回到原状态，收据删掉，只把知识库导入标成待重做，重发实体稿', async () => {
    const { old, current, currentRecord } = threeChapters()
    const { service: s, retry } = service()
    await s.delete(projectRoot, { draftId: current, chapterNumber: 2 })
    const before = continuity()

    const restored = await s.restore(projectRoot, 'project', { deletionId: 'delete-a', draftId: current, expectedMode: 'into-gap' })

    expect(restored).toEqual({ success: true, outcome: 'restored', chapterNumber: 2, draftId: current,
      finalizationId: currentRecord.finalizationId, publicationStatus: 'published' })
    expect(statuses(old, current)).toEqual(['superseded', 'finalized'])
    expect(db().prepare("SELECT deletion_id || deleted_from_status || deleted_at FROM drafts_all WHERE id IN (?,?)").pluck().all(old, current)).toEqual(['', ''])
    expect(ChapterDeletionRepository.getByDraftId(current)).toBeNull()
    expect(ChapterDeletionRepository.getByDraftId(old)).toBeNull()
    expect(retry).toHaveBeenCalledWith({ projectRoot, finalizationId: currentRecord.finalizationId })
    expect(FinalizationRepository.getByDraftId(current)).toMatchObject({ knowledgeDocumentId: '', publicationStatus: 'pending' })
    const run = PostProcessRepository.getLatestRun('chapter_finalize', '2')!
    expect(PostProcessRepository.getSteps(run.id)).toEqual([expect.objectContaining({ stepKey: 'kb_import', ok: false,
      errorMsg: CHAPTER_RESTORED_REPROJECTION_PENDING })])
    expect(continuity()).toEqual(before)
    expect(s.listTrash()).toEqual({ success: true, entries: [], damaged: [] })
  })

  it('按章号登记后处理的旧定稿也能标到；恢复后再删不要旧定稿知识授权', async () => {
    finalize(write(1, '第一章。'), 'kb-1')
    const draft = write(2, '第二章旧式定稿。')
    finalize(draft, 'kb-2', 'chapter')
    const { service: s } = service()
    await s.delete(projectRoot, { draftId: draft, chapterNumber: 2 })
    await s.restore(projectRoot, 'project', { deletionId: 'delete-a', draftId: draft, expectedMode: 'into-gap' })
    const run = PostProcessRepository.getLatestRun('chapter_finalize', '2')!
    expect(PostProcessRepository.getSteps(run.id)[0]).toMatchObject({ errorMsg: CHAPTER_RESTORED_REPROJECTION_PENDING })

    const again = await s.delete(projectRoot, { draftId: draft, chapterNumber: 2 })

    expect(again).toMatchObject({ success: true, committed: true })
    expect(again.error).toBeUndefined()
  })

  it('恢复已提交后重发实体稿抛错：仍报恢复成功，实体稿停在待发布，留给章节页的「重试发布」', async () => {
    const { old, current, currentRecord } = threeChapters()
    const { service: s, retry } = service()
    await s.delete(projectRoot, { draftId: current, chapterNumber: 2 })
    retry.mockRejectedValueOnce(new Error('PROJECT_CONTEXT_CHANGED'))

    const restored = await s.restore(projectRoot, 'project', { deletionId: 'delete-a', draftId: current, expectedMode: 'into-gap' })

    expect(restored).toEqual({ success: true, outcome: 'restored', chapterNumber: 2, draftId: current,
      finalizationId: currentRecord.finalizationId, publicationStatus: 'pending', publicationError: 'PROJECT_CONTEXT_CHANGED' })
    expect(statuses(old, current)).toEqual(['superseded', 'finalized'])
    expect(FinalizationRepository.getByDraftId(current)).toMatchObject({ publicationStatus: 'pending' })
  })

  it('删除时本来就没有知识库文档：放回原位后知识库导入步骤原样不动，不标待重做', async () => {
    finalize(write(1, '第一章。'), 'kb-1')
    const draft = write(2, '第二章，从没进过知识库。')
    finalize(draft, '')
    const { service: s } = service()
    await s.delete(projectRoot, { draftId: draft, chapterNumber: 2 })
    const confirmed = await s.confirmLegacyKnowledgeAbsent(projectRoot, 'delete-a')
    expect(confirmed.operation).toMatchObject({ knowledgeDocumentId: '', knowledgeStatus: 'not_required', status: 'completed' })

    await s.restore(projectRoot, 'project', { deletionId: 'delete-a', draftId: draft, expectedMode: 'into-gap' })

    const run = PostProcessRepository.getLatestRun('chapter_finalize', '2')!
    expect(PostProcessRepository.getSteps(run.id)).toEqual([expect.objectContaining({ stepKey: 'kb_import', ok: true })])
  })

  it('本章已经重写定稿时作为旧版本放回，当前定稿不动', async () => {
    const { old, current } = threeChapters()
    const { service: s } = service()
    await s.delete(projectRoot, { draftId: current, chapterNumber: 2 })
    const rewritten = write(2, '第二章删后重写。')
    finalize(rewritten, 'kb-2-rewrite')
    expect(s.listTrash()).toMatchObject({ entries: [{ restoreMode: 'as-history' }] })

    const stale = await s.restore(projectRoot, 'project', { deletionId: 'delete-a', draftId: current, expectedMode: 'into-gap' })
    expect(stale).toEqual({ success: false, error: 'CHAPTER_RESTORE_MODE_CHANGED' })
    expect(statuses(old, current)).toEqual(['deleted', 'deleted'])

    const restored = await s.restore(projectRoot, 'project', { deletionId: 'delete-a', draftId: current, expectedMode: 'as-history' })
    expect(restored).toEqual({ success: true, outcome: 'restored-as-history', chapterNumber: 2, draftId: current })
    expect(statuses(old, current, rewritten)).toEqual(['superseded', 'superseded', 'finalized'])
    expect(FinalizationRepository.getByDraftId(rewritten)).toMatchObject({ knowledgeDocumentId: 'kb-2-rewrite' })
  })

  it('定稿被便携冻结时以被删稿开一份新稿，重复请求不重复建稿，回收站这一项保留', async () => {
    const { current, currentRecord } = threeChapters()
    const { service: s } = service()
    await s.delete(projectRoot, { draftId: current, chapterNumber: 2 })
    const real = portableFreeze.readPortableRuntimeFreeze
    vi.spyOn(portableFreeze, 'readPortableRuntimeFreeze').mockImplementation(root => {
      const freeze = real(root)
      return { ...freeze, isFrozen: (table: portableFreeze.PortableRuntimeFreezeTable, id: string) => (table === 'finalization_outbox' && id === currentRecord.finalizationId) || freeze.isFrozen(table, id) }
    })
    expect(s.listTrash()).toMatchObject({ entries: [{ restoreMode: 'reopen-as-draft' }] })

    const first = await s.restore(projectRoot, 'project', { deletionId: 'delete-a', draftId: current, expectedMode: 'reopen-as-draft' })
    const second = await s.restore(projectRoot, 'project', { deletionId: 'delete-a', draftId: current, expectedMode: 'reopen-as-draft' })

    expect(first).toMatchObject({ success: true, outcome: 'reopened-as-draft', chapterNumber: 2, created: true })
    expect(second).toEqual({ ...first, created: false })
    expect(first.success && DraftRepository.getFull(first.draftId)).toMatchObject({ status: 'draft', content: '第二章新稿：沉船在北堤下翻了个身。' })
    expect(statuses(current)).toEqual(['deleted'])
    expect(s.listTrash()).toMatchObject({ entries: [{ deletionId: 'delete-a' }] })
  })

  it('再点一次恢复返回 already-restored；不在回收站也不是定稿的返回未找到', async () => {
    const { current } = threeChapters()
    const { service: s } = service()
    await s.delete(projectRoot, { draftId: current, chapterNumber: 2 })
    await s.restore(projectRoot, 'project', { deletionId: 'delete-a', draftId: current, expectedMode: 'into-gap' })

    expect(await s.restore(projectRoot, 'project', { deletionId: 'delete-a', draftId: current, expectedMode: 'into-gap' }))
      .toEqual({ success: true, outcome: 'already-restored', chapterNumber: 2, draftId: current })
    expect(await s.restore(projectRoot, 'project', { deletionId: 'nope', draftId: write(4, '工作稿'), expectedMode: 'into-gap' }))
      .toEqual({ success: false, error: 'CHAPTER_RESTORE_NOT_FOUND' })
    expect(await s.restore(projectRoot, 'project', { deletionId: '', draftId: current, expectedMode: 'into-gap' }))
      .toEqual({ success: false, error: 'CHAPTER_RESTORE_REQUEST_INVALID' })
    expect(await s.restore(projectRoot, 'project', null as never)).toEqual({ success: false, error: 'CHAPTER_RESTORE_REQUEST_INVALID' })
  })

  it('这次删除的清理没完成时先续跑；仍失败就拒绝恢复并带回收据，清理成功后再恢复（G2）', async () => {
    const { current } = threeChapters()
    const failKnowledge = new Set(['kb-2-old'])
    const { service: s } = service({ failKnowledge })
    expect(await s.delete(projectRoot, { draftId: current, chapterNumber: 2 })).toMatchObject({ success: false, committed: true })

    const refused = await s.restore(projectRoot, 'project', { deletionId: 'delete-a', draftId: current, expectedMode: 'into-gap' })
    expect(refused).toMatchObject({ success: false, error: 'CHAPTER_RESTORE_CLEANUP_INCOMPLETE', operation: { status: 'failed' } })
    expect(statuses(current)).toEqual(['deleted'])

    failKnowledge.clear()
    expect(await s.restore(projectRoot, 'project', { deletionId: 'delete-a', draftId: current, expectedMode: 'into-gap' }))
      .toMatchObject({ success: true, outcome: 'restored' })
  })

  it('等旧定稿知识授权的删除收据拿来恢复，不续跑清理，活着的定稿的实体稿与知识库都不动', async () => {
    finalize(write(1, '第一章。'), 'kb-1')
    const draft = write(2, '第二章旧式定稿。')
    const record = FinalizationRepository.commit({ finalizationId: randomUUID(), draftId: draft, chapterNumber: 2,
      chapterTitle: '沉船', content: '第二章旧式定稿。', contentHash: sha256('第二章旧式定稿。'), contentRevision: 1, targetFileName: '2.txt' })
    const { service: s, removed } = service()
    expect(await s.delete(projectRoot, { draftId: draft, chapterNumber: 2 })).toMatchObject({ error: 'CHAPTER_DELETE_LEGACY_KNOWLEDGE_CHECK_REQUIRED' })

    const result = await s.restore(projectRoot, 'project', { deletionId: 'delete-a', draftId: draft, expectedMode: 'into-gap' })

    expect(result).toEqual({ success: true, outcome: 'already-restored', chapterNumber: 2, draftId: draft })
    expect(removed).toEqual({ manuscripts: [], knowledge: [] })
    expect(ChapterDeletionRepository.get('delete-a')).toMatchObject({ status: 'authorization_required', manuscriptStatus: 'pending' })
    expect(FinalizationRepository.getByDraftId(draft)).toMatchObject({ finalizationId: record.finalizationId })
    expect(statuses(draft)).toEqual(['finalized'])
  })

  it('本章还在批量写作里时拒绝放回', async () => {
    const { current } = threeChapters()
    const { service: s } = service()
    await s.delete(projectRoot, { draftId: current, chapterNumber: 2 })
    vi.spyOn(GenerationDraftEffects.prototype, 'unfinishedBatchChapters').mockReturnValue(new Set([2]))

    expect(await s.restore(projectRoot, 'project', { deletionId: 'delete-a', draftId: current, expectedMode: 'into-gap' }))
      .toEqual({ success: false, error: 'CHAPTER_RESTORE_BATCH_UNFINISHED' })
    expect(statuses(current)).toEqual(['deleted'])
  })

  it('作者在删除后放了同名的其他文件，放回时换一个实体稿目标，不覆盖那个文件（G9）', async () => {
    const { current, currentRecord } = threeChapters()
    const { service: s } = service()
    await s.delete(projectRoot, { draftId: current, chapterNumber: 2 })
    const occupied = path.join(projectRoot, currentRecord.targetFileName)
    fs.writeFileSync(occupied, '作者自己的笔记')

    await s.restore(projectRoot, 'project', { deletionId: 'delete-a', draftId: current, expectedMode: 'into-gap' })

    const target = FinalizationRepository.getByDraftId(current)!.targetFileName
    expect(target).not.toBe(currentRecord.targetFileName)
    expect(target.startsWith('第2章 沉船')).toBe(true)
    expect(fs.readFileSync(occupied, 'utf8')).toBe('作者自己的笔记')
  })

  it('原目标上已是同一份实体稿时沿用原目标', async () => {
    const { current, currentRecord } = threeChapters()
    const { service: s } = service()
    await s.delete(projectRoot, { draftId: current, chapterNumber: 2 })
    fs.writeFileSync(path.join(projectRoot, currentRecord.targetFileName),
      serializeManuscript({ chapterNumber: 2, chapterTitle: '沉船', content: '第二章新稿：沉船在北堤下翻了个身。' }))

    await s.restore(projectRoot, 'project', { deletionId: 'delete-a', draftId: current, expectedMode: 'into-gap' })

    expect(FinalizationRepository.getByDraftId(current)!.targetFileName).toBe(currentRecord.targetFileName)
  })

  it('恢复事务中途出错时整体回滚：行、收据、后处理都不变', async () => {
    const { old, current } = threeChapters()
    const { service: s } = service()
    await s.delete(projectRoot, { draftId: current, chapterNumber: 2 })
    const snapshot = () => JSON.stringify([
      db().prepare('SELECT id,status,deletion_id,deleted_from_status FROM drafts_all ORDER BY id').all(),
      db().prepare('SELECT * FROM finalization_outbox_all ORDER BY draft_id').all(),
      db().prepare('SELECT operation_id,status FROM chapter_deletion_operations ORDER BY operation_id').all(),
      db().prepare('SELECT run_id,step_key,ok,error_msg FROM post_process_steps ORDER BY id').all(),
    ])
    const before = snapshot()
    // 状态与收据都改完、删收据时才失败：前面的写入都必须一起撤销。
    db().exec("CREATE TRIGGER inject_restore_failure BEFORE DELETE ON chapter_deletion_operations BEGIN SELECT RAISE(ABORT, 'INJECTED_RESTORE_FAILURE'); END")

    const result = await s.restore(projectRoot, 'project', { deletionId: 'delete-a', draftId: current, expectedMode: 'into-gap' })

    expect(result).toEqual({ success: false, error: 'INJECTED_RESTORE_FAILURE' })
    expect(snapshot()).toBe(before)
    expect(statuses(old, current)).toEqual(['deleted', 'deleted'])
    db().exec('DROP TRIGGER inject_restore_failure')
    expect(await s.restore(projectRoot, 'project', { deletionId: 'delete-a', draftId: current, expectedMode: 'into-gap' }))
      .toMatchObject({ success: true, outcome: 'restored' })
  })

  it('事务提交后、重发实体稿前进程中断：重进时报已恢复，实体稿停在待发布，可以照常重试发布', async () => {
    const { current, currentRecord } = threeChapters()
    const { service: s, retry } = service()
    await s.delete(projectRoot, { draftId: current, chapterNumber: 2 })
    let reachedRetry!: () => void
    const reached = new Promise<void>(resolve => { reachedRetry = resolve })
    // 进程停在重发里再也没回来；重启后是一个新的服务实例。
    retry.mockImplementationOnce(() => { reachedRetry(); return new Promise(() => {}) })

    void s.restore(projectRoot, 'project', { deletionId: 'delete-a', draftId: current, expectedMode: 'into-gap' })
    await reached

    expect(statuses(current)).toEqual(['finalized'])
    expect(FinalizationRepository.get(currentRecord.finalizationId)).toMatchObject({ publicationStatus: 'pending' })
    expect(await service().service.restore(projectRoot, 'project', { deletionId: 'delete-a', draftId: current, expectedMode: 'into-gap' }))
      .toEqual({ success: true, outcome: 'already-restored', chapterNumber: 2, draftId: current })
  })

  it('恢复后重发实体稿期间又删这一章：删除排在重发之后，清理删掉的是重发出的那份', async () => {
    const { current } = threeChapters()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const order: string[] = []
    const cleaner: ChapterDeletionProjectionCleaner = {
      async removeManuscript() { order.push('remove-manuscript') },
      async removeKnowledgeDocument() {},
    }
    const retry = vi.fn(async () => { await gate; order.push('republish'); return { success: true, committed: true, publicationStatus: 'published' as const } })
    const ids = ['delete-a', 'delete-b']
    const s = new ChapterDeletionService({ cleaner, createOperationId: () => ids.shift()!, finalizations: { retry } })
    await s.delete(projectRoot, { draftId: current, chapterNumber: 2 })
    order.length = 0

    const restoring = s.restore(projectRoot, 'project', { deletionId: 'delete-a', draftId: current, expectedMode: 'into-gap' })
    const deleting = s.delete(projectRoot, { draftId: current, chapterNumber: 2 })
    await new Promise(resolve => setImmediate(resolve))
    release()

    await expect(restoring).resolves.toMatchObject({ success: true, outcome: 'restored' })
    await expect(deleting).resolves.toMatchObject({ success: true, operation: { operationId: 'delete-b' } })
    // 再删一次清理本章两份定稿（当前定稿与旧定稿）的实体稿，都在重发之后。
    expect(order).toEqual(['republish', 'remove-manuscript', 'remove-manuscript'])
  })
})

describe('彻底删除', () => {
  it('删掉这一项的全部行、正文与后处理，收据留作删除证明；再删一次列为 alreadyGone', async () => {
    const { old, current, oldRecord, currentRecord } = threeChapters()
    const { service: s } = service()
    await s.delete(projectRoot, { draftId: current, chapterNumber: 2 })
    const contents = db().prepare('SELECT content_id FROM drafts_all WHERE id IN (?,?)').pluck().all(old, current)

    expect(await s.purge(projectRoot, { deletionIds: ['delete-a'] })).toEqual({ success: true, purged: ['delete-a'], alreadyGone: [] })

    expect(db().prepare('SELECT COUNT(*) FROM drafts_all WHERE id IN (?,?)').pluck().get(old, current)).toBe(0)
    expect(db().prepare(`SELECT COUNT(*) FROM contents WHERE id IN (${contents.map(() => '?').join(',')})`).pluck().get(...contents)).toBe(0)
    for (const record of [oldRecord, currentRecord]) {
      expect(PostProcessRepository.getLatestRun('chapter_finalize', `finalization:${record.finalizationId}`)).toBeNull()
    }
    expect(ChapterDeletionRepository.getByDraftId(current)).toMatchObject({ status: 'completed' })
    expect(DraftRepository.getMaxFinalizedChapter()).toBe(3)
    expect(await s.purge(projectRoot, { deletionIds: ['delete-a'] })).toEqual({ success: true, purged: [], alreadyGone: ['delete-a'] })
    expect(await s.restore(projectRoot, 'project', { deletionId: 'delete-a', draftId: current, expectedMode: 'into-gap' }))
      .toEqual({ success: false, error: 'CHAPTER_RESTORE_NOT_FOUND' })
  })

  it('清空回收站删掉全部项；请求不合法时什么都不删', async () => {
    threeChapters()
    const { service: s } = service()
    const first = DraftRepository.getMaxFinalizedChapter()
    await s.delete(projectRoot, { draftId: db().prepare("SELECT id FROM drafts WHERE chapter_number=1 AND status='finalized'").pluck().get() as number, chapterNumber: 1 })
    await s.delete(projectRoot, { draftId: db().prepare("SELECT id FROM drafts WHERE chapter_number=3 AND status='finalized'").pluck().get() as number, chapterNumber: 3 })
    expect(first).toBe(3)

    for (const request of [{ deletionIds: [] }, { deletionIds: [''] }, { all: false }, null, 'all']) {
      expect(await s.purge(projectRoot, request as never)).toEqual({ success: false, error: 'CHAPTER_TRASH_REQUEST_INVALID' })
    }
    expect((s.listTrash() as { entries: unknown[] }).entries).toHaveLength(2)

    expect(await s.purge(projectRoot, { all: true })).toEqual({ success: true, purged: ['delete-a', 'delete-b'], alreadyGone: [] })
    expect(s.listTrash()).toEqual({ success: true, entries: [], damaged: [] })
  })

  it('彻底删除事务中途出错时一行都不删；重进后照常删完', async () => {
    threeChapters()
    const { service: s } = service()
    const ids = [1, 3].map(n => db().prepare("SELECT id FROM drafts WHERE chapter_number=? AND status='finalized'").pluck().get(n) as number)
    await s.delete(projectRoot, { draftId: ids[0]!, chapterNumber: 1 })
    await s.delete(projectRoot, { draftId: ids[1]!, chapterNumber: 3 })
    db().exec(`CREATE TRIGGER inject_purge_failure BEFORE DELETE ON drafts_all WHEN old.id = ${ids[1]} BEGIN SELECT RAISE(ABORT, 'INJECTED_PURGE_FAILURE'); END`)

    expect(await s.purge(projectRoot, { all: true })).toEqual({ success: false, error: 'INJECTED_PURGE_FAILURE' })
    expect(statuses(...ids)).toEqual(['deleted', 'deleted'])

    db().exec('DROP TRIGGER inject_purge_failure')
    expect(await s.purge(projectRoot, { all: true })).toEqual({ success: true, purged: ['delete-a', 'delete-b'], alreadyGone: [] })
  })
})

describe('回收站列表', () => {
  it('一项残缺只单列这一项，其余照常列出', async () => {
    threeChapters()
    const { service: s } = service()
    const ids = [1, 3].map(n => db().prepare("SELECT id FROM drafts WHERE chapter_number=? AND status='finalized'").pluck().get(n) as number)
    await s.delete(projectRoot, { draftId: ids[0]!, chapterNumber: 1 })
    await s.delete(projectRoot, { draftId: ids[1]!, chapterNumber: 3 })
    db().prepare("DELETE FROM chapter_deletion_operations WHERE operation_id='delete-a'").run()

    expect(s.listTrash()).toEqual({ success: true,
      entries: [expect.objectContaining({ deletionId: 'delete-b', chapterNumber: 3 })],
      damaged: [{ deletionId: 'delete-a', error: 'CHAPTER_TRASH_RECEIPT_MISSING' }] })
    expect(await s.restore(projectRoot, 'project', { deletionId: 'delete-a', draftId: ids[0]!, expectedMode: 'into-gap' }))
      .toEqual({ success: false, error: 'CHAPTER_TRASH_RECEIPT_MISSING' })
  })
})

describe('排队的回收站操作跨作品切换', () => {
  it('A 作品删除卡在清理时排队的「全部彻底删除」，切到 B 作品后被拒绝，B 的回收站原样保留', async () => {
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-trash-b-'))
    try {
      initProjectDatabase(otherRoot)
      const otherDraft = write(1, 'B 作品第一章。')
      finalize(otherDraft, 'kb-b-1')
      await service({ id: 'delete-b-1' }).service.delete(otherRoot, { draftId: otherDraft, chapterNumber: 1 })

      initProjectDatabase(projectRoot)
      const draft = write(1, 'A 作品第一章。')
      finalize(draft, 'kb-a-1')
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const s = new ChapterDeletionService({
        cleaner: {
          async removeManuscript() {},
          async removeKnowledgeDocument() { await gate },
        },
        createOperationId: () => 'delete-a-1',
        finalizations: { retry: vi.fn() },
      })

      const deleting = s.delete(projectRoot, { draftId: draft, chapterNumber: 1 })
      const purging = s.purge(projectRoot, { all: true })
      await new Promise(resolve => setImmediate(resolve))
      initProjectDatabase(otherRoot)
      release()
      await deleting.catch(() => undefined)

      await expect(purging).rejects.toThrow('PROJECT_CONTEXT_CHANGED')
      expect(s.listTrash()).toMatchObject({ success: true, entries: [{ deletionId: 'delete-b-1', chapterNumber: 1 }] })
    } finally {
      closeProjectDatabase()
      fs.rmSync(otherRoot, { recursive: true, force: true })
    }
  })

  /** 另开一部作品 B（模拟复制出来的作品：收据或定稿 ID 与 A 相同），返回它的根目录。 */
  function otherProject(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-trash-b-'))
    others.push(root)
    initProjectDatabase(root)
    return root
  }
  const others: string[] = []
  afterEach(() => { closeProjectDatabase(); for (const root of others.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

  function barrier() {
    let release!: () => void, reach!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const reached = new Promise<void>(resolve => { reach = resolve })
    return { release, reached, wait: async () => { reach(); await gate } }
  }

  it('删除清理等清理器期间切到 B 作品：清理结果不记进 B 的库，A 的收据停在待续跑，回到 A 照常补完', async () => {
    const otherRoot = otherProject()
    const otherDraft = write(1, 'B 作品第一章。')
    finalize(otherDraft, 'kb-b-1')
    await service({ id: 'delete-a', failKnowledge: new Set(['kb-b-1']) }).service.delete(otherRoot, { draftId: otherDraft, chapterNumber: 1 })
    const otherBefore = ChapterDeletionRepository.get('delete-a')

    initProjectDatabase(projectRoot)
    const draft = write(1, 'A 作品第一章。')
    finalize(draft, 'kb-a-1')
    const cleanup = barrier()
    const s = new ChapterDeletionService({
      cleaner: { async removeManuscript() { await cleanup.wait() }, async removeKnowledgeDocument() {} },
      createOperationId: () => 'delete-a',
      finalizations: { retry: vi.fn() },
    })
    const deleting = s.delete(projectRoot, { draftId: draft, chapterNumber: 1 })
    await cleanup.reached
    initProjectDatabase(otherRoot)
    cleanup.release()

    await expect(deleting).rejects.toThrow('PROJECT_CONTEXT_CHANGED')
    expect(ChapterDeletionRepository.get('delete-a')).toEqual(otherBefore)

    initProjectDatabase(projectRoot)
    expect(ChapterDeletionRepository.get('delete-a')).toMatchObject({ status: 'pending', manuscriptStatus: 'pending', knowledgeStatus: 'pending' })
    expect(await s.retry(projectRoot, 'delete-a')).toMatchObject({ success: true, operation: { status: 'completed' } })
  })

  it('恢复后重发实体稿期间切到 B 作品：发布结果不记进 B 里同 ID 的定稿，恢复照报成功、实体稿待发布', async () => {
    const draft = write(1, 'A 作品第一章。')
    const record = finalize(draft, 'kb-a-1')
    await service().service.delete(projectRoot, { draftId: draft, chapterNumber: 1 })

    const otherRoot = otherProject()
    const otherDraft = write(1, 'B 作品第一章。')
    FinalizationRepository.commit({ finalizationId: record.finalizationId, draftId: otherDraft, chapterNumber: 1, chapterTitle: '沉船',
      content: 'B 作品第一章。', contentHash: sha256('B 作品第一章。'), contentRevision: 1, targetFileName: '第1章 沉船.txt' })
    const otherBefore = FinalizationRepository.get(record.finalizationId)

    initProjectDatabase(projectRoot)
    const publish = barrier()
    const s = new ChapterDeletionService({
      cleaner: recordingCleaner().cleaner,
      finalizations: new FinalizationService({ publisher: { publish: () => publish.wait() } }),
    })
    const restoring = s.restore(projectRoot, 'project', { deletionId: 'delete-a', draftId: draft, expectedMode: 'into-gap' })
    await publish.reached
    initProjectDatabase(otherRoot)
    publish.release()

    expect(await restoring).toMatchObject({ success: true, outcome: 'restored', publicationStatus: 'pending',
      publicationError: expect.stringContaining('PROJECT_CONTEXT_CHANGED') })
    expect(FinalizationRepository.get(record.finalizationId)).toEqual(otherBefore)
    initProjectDatabase(projectRoot)
    expect(FinalizationRepository.get(record.finalizationId)).toMatchObject({ publicationStatus: 'pending' })
  })
})

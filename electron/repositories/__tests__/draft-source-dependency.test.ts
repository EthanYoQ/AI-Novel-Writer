import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { DraftRepository } from '../draft-repository'
import { FinalizationRepository } from '../finalization-repository'

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function finalize(draftId: number, chapterNumber: number, content: string, finalizationId: string): void {
  FinalizationRepository.commit({
    finalizationId,
    draftId,
    chapterNumber,
    chapterTitle: `第${chapterNumber}章`,
    content,
    contentHash: sha256(content),
    contentRevision: 1,
    targetFileName: `chapter-${chapterNumber}.md`,
  })
}

function finalizedDependency(
  draftId: number,
  chapterNumber: number,
  content: string,
  finalizationId: string,
) {
  return {
    kind: 'finalized' as const,
    draftId,
    chapterNumber,
    finalizationId,
    contentHash: sha256(content),
  }
}

let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-draft-dependency-'))
  initProjectDatabase(projectRoot)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

describe('draft source dependencies', () => {
  it('persists ordered source identities and keeps the downstream draft while marking changed prose stale', () => {
    const firstContent = '第一章候选原文。'
    const secondContent = '第二章候选原文。'
    const firstId = DraftRepository.create({
      chapterNumber: 1, source: 'write', content: firstContent, wordCount: 8,
    })
    const secondId = DraftRepository.create({
      chapterNumber: 2, source: 'write', content: secondContent, wordCount: 8,
    })
    const dependencies = [
      { draftId: secondId, contentHash: sha256(secondContent) },
      { draftId: firstId, contentHash: sha256(firstContent) },
    ]
    const downstreamId = DraftRepository.create({
      chapterNumber: 3,
      source: 'write',
      content: '第三章基于前两章候选。',
      wordCount: 11,
      sourceDependencies: dependencies,
    })

    expect(DraftRepository.getMeta(downstreamId)).toMatchObject({
      sourceDependencies: dependencies,
      dependenciesStale: false,
    })

    DraftRepository.updateContent(firstId, '第一章候选正文已由作者修改。', 14)
    expect(DraftRepository.getMeta(downstreamId)).toMatchObject({
      id: downstreamId,
      sourceDependencies: dependencies,
      dependenciesStale: true,
    })

    closeProjectDatabase()
    initProjectDatabase(projectRoot)
    expect(DraftRepository.getFull(downstreamId)).toMatchObject({
      content: '第三章基于前两章候选。',
      dependenciesStale: true,
    })
  })

  it('revalidates claimed dependencies at the main-process repository boundary', () => {
    const sourceContent = '被冻结的候选正文。'
    const sourceId = DraftRepository.create({
      chapterNumber: 1, source: 'write', content: sourceContent, wordCount: 9,
    })
    DraftRepository.updateContent(sourceId, '候选正文已变化。', 8)

    expect(() => DraftRepository.create({
      chapterNumber: 2,
      source: 'write',
      content: '不应保存的下游草稿。',
      wordCount: 10,
      sourceDependencies: [{ draftId: sourceId, contentHash: sha256(sourceContent) }],
    })).toThrow(/来源依赖已变化/u)
    expect(DraftRepository.listByChapter(2)).toEqual([])
  })

  it('migrates legacy drafts as source-unknown without claiming stale evidence', () => {
    const sourceId = DraftRepository.create({
      chapterNumber: 1, source: 'write', content: '旧草稿。', wordCount: 4,
    })
    getProjectDb()!.exec('ALTER TABLE drafts DROP COLUMN source_dependencies')
    closeProjectDatabase()
    initProjectDatabase(projectRoot)

    expect(DraftRepository.getMeta(sourceId)).toMatchObject({
      sourceDependencies: [],
      dependenciesStale: false,
    })
  })

  it('rejects an in-flight save after the frozen finalized source is replaced with identical prose', () => {
    const content = '不可变的第一章正文。'
    const sourceId = DraftRepository.create({
      chapterNumber: 1, source: 'write', content, wordCount: 10,
    })
    finalize(sourceId, 1, content, 'finalization-1')
    const dependency = finalizedDependency(sourceId, 1, content, 'finalization-1')

    const replacementId = DraftRepository.create({
      chapterNumber: 1, source: 'rewrite', content, wordCount: 10,
    })
    finalize(replacementId, 1, content, 'finalization-2')

    expect(() => DraftRepository.create({
      chapterNumber: 2,
      source: 'write',
      content: '不应落盘的第二章。',
      wordCount: 9,
      sourceDependencies: [dependency],
    })).toThrow(/不再是当前定稿/u)
    expect(DraftRepository.listByChapter(2)).toEqual([])
  })

  it('keeps a saved downstream draft but marks it stale when the source loses finalized identity', () => {
    const content = '第一章定稿正文保持不变。'
    const sourceId = DraftRepository.create({
      chapterNumber: 1, source: 'write', content, wordCount: 12,
    })
    finalize(sourceId, 1, content, 'finalization-1')
    const downstreamId = DraftRepository.create({
      chapterNumber: 2,
      source: 'write',
      content: '第二章正文。',
      wordCount: 6,
      sourceDependencies: [finalizedDependency(sourceId, 1, content, 'finalization-1')],
    })

    getProjectDb()!.prepare("UPDATE drafts SET status = 'archived' WHERE id = ?").run(sourceId)

    expect(DraftRepository.getMeta(downstreamId)).toMatchObject({
      id: downstreamId,
      dependenciesStale: true,
    })
  })

  it('keeps a saved downstream draft but marks it stale when finalized prose changes', () => {
    const content = '第一章定稿正文。'
    const sourceId = DraftRepository.create({
      chapterNumber: 1, source: 'write', content, wordCount: 9,
    })
    finalize(sourceId, 1, content, 'finalization-1')
    const downstreamId = DraftRepository.create({
      chapterNumber: 2,
      source: 'write',
      content: '第二章正文。',
      wordCount: 6,
      sourceDependencies: [finalizedDependency(sourceId, 1, content, 'finalization-1')],
    })
    const sourceContentId = getProjectDb()!.prepare('SELECT content_id AS contentId FROM drafts WHERE id = ?')
      .get(sourceId) as { contentId: number }

    getProjectDb()!.prepare('UPDATE contents SET body = ? WHERE id = ?')
      .run('第一章定稿正文已变更。', sourceContentId.contentId)

    expect(DraftRepository.getMeta(downstreamId)).toMatchObject({
      id: downstreamId,
      dependenciesStale: true,
    })
  })

  it('marks a saved downstream draft stale after same-prose replacement or source deletion', () => {
    const content = '第一章定稿正文。'
    const sourceId = DraftRepository.create({
      chapterNumber: 1, source: 'write', content, wordCount: 9,
    })
    finalize(sourceId, 1, content, 'finalization-1')
    const downstreamId = DraftRepository.create({
      chapterNumber: 2,
      source: 'write',
      content: '第二章正文。',
      wordCount: 6,
      sourceDependencies: [finalizedDependency(sourceId, 1, content, 'finalization-1')],
    })

    const replacementId = DraftRepository.create({
      chapterNumber: 1, source: 'rewrite', content, wordCount: 9,
    })
    finalize(replacementId, 1, content, 'finalization-2')
    expect(DraftRepository.getMeta(downstreamId)?.dependenciesStale).toBe(true)

    getProjectDb()!.prepare('DELETE FROM drafts WHERE id = ?').run(sourceId)
    expect(DraftRepository.getFull(downstreamId)).toMatchObject({
      content: '第二章正文。',
      dependenciesStale: true,
    })
  })

  it('records receipt-less legacy finalized identity without inventing a receipt', () => {
    const content = '旧项目定稿正文。'
    const sourceId = DraftRepository.create({
      chapterNumber: 1, source: 'write', content, wordCount: 8,
    })
    getProjectDb()!.prepare("UPDATE drafts SET status = 'finalized' WHERE id = ?").run(sourceId)
    const dependency = {
      kind: 'legacy-finalized' as const,
      draftId: sourceId,
      chapterNumber: 1,
      contentHash: sha256(content),
    }
    const downstreamId = DraftRepository.create({
      chapterNumber: 2,
      source: 'write',
      content: '第二章正文。',
      wordCount: 6,
      sourceDependencies: [dependency],
    })

    expect(DraftRepository.getMeta(downstreamId)).toMatchObject({
      sourceDependencies: [dependency],
      dependenciesStale: false,
    })
  })
})

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { DraftRepository } from '../draft-repository'

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
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
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { countDraftUnits } from '../../../src/shared/draft-units'
import type { ImportRunPrepareRequest } from '../../../src/shared/import-run'
import { DraftRepository } from '../draft-repository'
import { FinalizationRepository } from '../finalization-repository'
import { FinalizedDraftImportRepository } from '../finalized-draft-import-repository'
import { ImportRunRepository } from '../import-run-repository'

let root = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-import-superseded-'))
  initProjectDatabase(root)
}, 20_000)

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(root, { recursive: true, force: true })
})

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

function importChapter(chapterNumber: number, content: string) {
  return { chapterNumber, title: `第${chapterNumber}章`, content, wordCount: countDraftUnits(content) }
}

function replaceChapter(chapterNumber: number, content: string): number {
  const draftId = DraftRepository.create({ chapterNumber, source: 'rewrite', content, wordCount: countDraftUnits(content) })
  FinalizationRepository.commit({
    finalizationId: randomUUID(), draftId, chapterNumber, chapterTitle: `第${chapterNumber}章`,
    content, contentHash: sha256(content), contentRevision: 1, targetFileName: `第${chapterNumber}章-新.txt`,
  })
  return draftId
}

const finalizedRows = () => getProjectDb()!.prepare("SELECT COUNT(*) FROM drafts WHERE status = 'finalized'").pluck().get()

describe('作者原稿导入与被替换的定稿', () => {
  it('不带指纹的导入也不能写进已有定稿的章号', () => {
    replaceChapter(1, '第一章：作者自己写的定稿。')

    expect(() => FinalizedDraftImportRepository.commit(root, {
      operationId: 'import-without-fingerprint',
      chapters: [importChapter(1, '第一章：导入的另一份正文。')],
    })).toThrow('FINALIZED_IMPORT_CHAPTER_ALREADY_FINALIZED')
    expect(finalizedRows()).toBe(1)
  })

  it('导入提交后替换其中一章，同一运行仍能读出收据并续跑', () => {
    const content = '第一章：作者原稿。'
    const imported = {
      number: 1, title: '第1章', content,
      contentFingerprint: createHash('sha256').update(content).digest('hex'),
      contentSize: Buffer.byteLength(content, 'utf8'),
    }
    const preview = FinalizedDraftImportRepository.preview([importChapter(1, content)].map(chapter => ({ ...chapter, title: '第1章' })))
    const runId = 'author-run-replaced'
    const request: ImportRunPrepareRequest = {
      runId, purpose: 'author-manuscript', sourceFingerprint: 'c'.repeat(64),
      sourceDisplay: [{ displayName: 'author.txt', mediaType: 'text/plain', size: 42 }],
      locale: 'zh-CN', chapters: [imported],
      authorityFingerprint: preview.authorityFingerprint,
      expectedManifestFingerprint: preview.manifestFingerprint,
    }
    ImportRunRepository.prepare(request)
    let execution = ImportRunRepository.startOrResume(runId, 'before-replace').execution
    ImportRunRepository.prepareEffectReceipt({
      runId, stage: 'author-commit', batchId: 'done',
      effectKey: 'author-finalized-batch', kind: 'author-finalized-batch',
      payload: {
        operationId: `author-import:${runId}`, runId,
        authorityFingerprint: preview.authorityFingerprint, manifestFingerprint: preview.manifestFingerprint,
      },
    }, execution)
    ImportRunRepository.commitEffectReceipt(runId, 'author-commit', 'done', execution)
    ImportRunRepository.advanceStage(runId, 'author-commit', 'author-publish', execution)
    ImportRunRepository.fail(runId, 'author-publish', 'publication unavailable', execution)

    replaceChapter(1, '第一章：作者回退后重新定稿。')

    execution = ImportRunRepository.startOrResume(runId, 'after-replace').execution
    expect({
      execution: execution.owner,
      receipt: ImportRunRepository.getEffectReceipt(runId, 'author-commit', 'done'),
    }).toMatchObject({
      execution: 'after-replace',
      receipt: { state: 'committed', effectReceipt: { chapterNumbers: [1] } },
    })
  })
})

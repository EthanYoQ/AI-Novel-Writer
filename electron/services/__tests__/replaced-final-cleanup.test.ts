import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeProjectDatabase } from '../../database'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { reopenWithContent } from '../../../test/helpers/reopened-draft'
import { countDraftUnits } from '../../../src/shared/draft-units'
import { describeFinalizationStepError } from '../../../src/shared/finalization-step-error'
import { DraftRepository } from '../../repositories/draft-repository'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { publishManuscript } from '../manuscript-publisher'
import { removeReplacedKnowledge, removeReplacedManuscripts, type ReplacedKnowledgeStore } from '../replaced-final-cleanup'

let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-replaced-'))
  openCanonicalProjectFixture(projectRoot)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

const TITLE = '雾钟'
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const zh = (zhCNText: string) => zhCNText
const file = (name: string) => path.join(projectRoot, name)

async function finalVersion(content: string, targetFileName: string, { publish = true } = {}): Promise<number> {
  const draftId = DraftRepository.getFinalizedByChapter(1)
    ? reopenWithContent(1, content)
    : DraftRepository.create({ chapterNumber: 1, source: 'write', content, wordCount: countDraftUnits(content) })
  const { finalizationId } = FinalizationRepository.commit({
    finalizationId: randomUUID(),
    draftId,
    chapterNumber: 1,
    chapterTitle: TITLE,
    content,
    contentHash: sha256(content),
    contentRevision: 1,
    targetFileName,
  })
  if (publish) {
    await publishManuscript({ projectRoot, targetFileName, chapterNumber: 1, chapterTitle: TITLE, content })
    FinalizationRepository.markPublished(finalizationId)
  }
  return draftId
}

async function failure(run: Promise<void>): Promise<string> {
  const message = await run.then(() => '', (error: Error) => error.message)
  expect(message).not.toBe('')
  expect(describeFinalizationStepError(message, zh)).not.toBe(message)
  return message
}

describe('替换后删除旧版本的正文文件', () => {
  it('旧文件还是当初发布的样子：删除；新定稿的文件不动；再跑一次照样成功', async () => {
    await finalVersion('雾从海面上升起来。', '第1章 雾钟.txt')
    const current = await finalVersion('雾从海面上升起来，钟声提前了一刻。', '第1章 雾钟 (2).txt')

    await removeReplacedManuscripts(projectRoot, current)
    await removeReplacedManuscripts(projectRoot, current)

    expect(fs.existsSync(file('第1章 雾钟.txt'))).toBe(false)
    expect(fs.readFileSync(file('第1章 雾钟 (2).txt'), 'utf8')).toBe('第1章 雾钟\n\n雾从海面上升起来，钟声提前了一刻。')
  })

  it('作者改过旧文件：保留，报出文件名；作者自己删掉或改名后再试就通过', async () => {
    await finalVersion('雾从海面上升起来。', '第1章 雾钟.txt')
    const current = await finalVersion('钟声提前了一刻。', '第1章 雾钟 (2).txt')
    fs.appendFileSync(file('第1章 雾钟.txt'), '\n作者在应用外补的一段。', 'utf8')

    const message = await failure(removeReplacedManuscripts(projectRoot, current))

    expect(message).toBe('FINALIZATION_REPLACED_MANUSCRIPT_KEPT:["第1章 雾钟.txt"]')
    expect(describeFinalizationStepError(message, zh)).toContain('「第1章 雾钟.txt」')
    expect(fs.readFileSync(file('第1章 雾钟.txt'), 'utf8')).toContain('作者在应用外补的一段。')
    fs.renameSync(file('第1章 雾钟.txt'), file('第1章 雾钟 作者留底.txt'))
    await removeReplacedManuscripts(projectRoot, current)
    expect(fs.existsSync(file('第1章 雾钟 作者留底.txt'))).toBe(true)
  })

  it('新定稿的正文文件还没写入时，旧文件先留着', async () => {
    await finalVersion('雾从海面上升起来。', '第1章 雾钟.txt')
    const current = await finalVersion('钟声提前了一刻。', '第1章 雾钟 (2).txt', { publish: false })

    expect(await failure(removeReplacedManuscripts(projectRoot, current))).toBe('FINALIZATION_REPLACED_MANUSCRIPT_PUBLICATION_REQUIRED')
    expect(fs.existsSync(file('第1章 雾钟.txt'))).toBe(true)
  })

  it('同名文件先后属于两份旧定稿：按其中任一份的发布内容认，不误报改过；和当前定稿同名的不动', async () => {
    await finalVersion('第一版。', '第1章 雾钟.txt')
    await finalVersion('第二版。', '第1章 雾钟 (2).txt')
    const third = await finalVersion('第三版。', '第1章 雾钟 (3).txt')
    await removeReplacedManuscripts(projectRoot, third)
    const fourth = await finalVersion('第四版。', '第1章 雾钟.txt')
    await removeReplacedManuscripts(projectRoot, fourth)
    expect(fs.readFileSync(file('第1章 雾钟.txt'), 'utf8')).toBe('第1章 雾钟\n\n第四版。')

    const fifth = await finalVersion('第五版。', '第1章 雾钟 (5).txt')
    await removeReplacedManuscripts(projectRoot, fifth)

    expect(fs.readdirSync(projectRoot).filter(name => name.endsWith('.txt'))).toEqual(['第1章 雾钟 (5).txt'])
  })

  it('旧文件被其他程序占着删不掉：报占用或只读并列出文件名，文件留着；放开以后再试就删掉', async () => {
    await finalVersion('雾从海面上升起来。', '第1章 雾钟.txt')
    const current = await finalVersion('钟声提前了一刻。', '第1章 雾钟 (2).txt')
    const unlink = fs.unlinkSync
    const held = vi.spyOn(fs, 'unlinkSync').mockImplementation(target => {
      if (String(target) === file('第1章 雾钟.txt')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      unlink(target)
    })

    const message = await failure(removeReplacedManuscripts(projectRoot, current))

    expect(message).toBe('FINALIZATION_REPLACED_MANUSCRIPT_BUSY:["第1章 雾钟.txt"]')
    expect(describeFinalizationStepError(message, zh)).toContain('被其他程序占用或只读')
    expect(fs.existsSync(file('第1章 雾钟.txt'))).toBe(true)
    held.mockRestore()
    await removeReplacedManuscripts(projectRoot, current)
    expect(fs.existsSync(file('第1章 雾钟.txt'))).toBe(false)
  })
})

function knowledge(copies: Record<string, { content: string; edited?: boolean } | null>) {
  const removed: string[] = []
  const store: ReplacedKnowledgeStore = {
    async readCopy(_root, documentId) {
      const copy = copies[documentId]
      return copy ? { available: true, contentHash: sha256(copy.content), edited: copy.edited ?? false } : { available: false }
    },
    async remove(_root, documentId) {
      removed.push(documentId)
      delete copies[documentId]
    },
  }
  return { store, removed, copies }
}

describe('替换后删除旧版本收进知识库的文档', () => {
  it('新定稿的文档登记之前，旧文档先留着', async () => {
    FinalizationRepository.linkKnowledgeDocument(await finalVersion('雾从海面上升起来。', '第1章 雾钟.txt'), 'doc-1')
    const current = await finalVersion('钟声提前了一刻。', '第1章 雾钟 (2).txt')
    const kb = knowledge({ 'doc-1': { content: '雾从海面上升起来。' } })

    expect(await failure(removeReplacedKnowledge(projectRoot, current, kb.store))).toBe('FINALIZATION_REPLACED_KNOWLEDGE_IMPORT_REQUIRED')
    expect(kb.removed).toEqual([])
  })

  it('旧文档副本和旧定稿正文一致就删除，没有完整副本的也删除；当前定稿的文档不动', async () => {
    FinalizationRepository.linkKnowledgeDocument(await finalVersion('第一版。', '第1章 雾钟.txt'), 'doc-1')
    FinalizationRepository.linkKnowledgeDocument(await finalVersion('第二版。', '第1章 雾钟 (2).txt'), 'doc-2')
    const current = await finalVersion('第三版。', '第1章 雾钟 (3).txt')
    FinalizationRepository.linkKnowledgeDocument(current, 'doc-3')
    const kb = knowledge({ 'doc-1': null, 'doc-2': { content: '第二版。' }, 'doc-3': { content: '第三版。' } })

    await removeReplacedKnowledge(projectRoot, current, kb.store)

    expect(kb.removed).toEqual(['doc-1', 'doc-2'])
    expect(Object.keys(kb.copies)).toEqual(['doc-3'])
  })

  it('副本改过或和旧定稿正文对不上：保留并说明，其余旧文档照删；再试结果一样', async () => {
    FinalizationRepository.linkKnowledgeDocument(await finalVersion('第一版。', '第1章 雾钟.txt'), 'doc-1')
    FinalizationRepository.linkKnowledgeDocument(await finalVersion('第二版。', '第1章 雾钟 (2).txt'), 'doc-2')
    FinalizationRepository.linkKnowledgeDocument(await finalVersion('第三版。', '第1章 雾钟 (3).txt'), 'doc-3')
    const current = await finalVersion('第四版。', '第1章 雾钟 (4).txt')
    FinalizationRepository.linkKnowledgeDocument(current, 'doc-4')
    const kb = knowledge({
      'doc-1': { content: '第一版。', edited: true },
      'doc-2': { content: '第二版，后来补了一句。' },
      'doc-3': { content: '第三版。' },
      'doc-4': { content: '第四版。' },
    })

    expect(await failure(removeReplacedKnowledge(projectRoot, current, kb.store))).toBe('FINALIZATION_REPLACED_KNOWLEDGE_EDITED')
    expect(kb.removed).toEqual(['doc-3'])
    expect(Object.keys(kb.copies).sort()).toEqual(['doc-1', 'doc-2', 'doc-4'])

    expect(await failure(removeReplacedKnowledge(projectRoot, current, kb.store))).toBe('FINALIZATION_REPLACED_KNOWLEDGE_EDITED')
    expect(Object.keys(kb.copies).sort()).toEqual(['doc-1', 'doc-2', 'doc-4'])
  })
})

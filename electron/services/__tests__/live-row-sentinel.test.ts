import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, createProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { DraftRepository } from '../../repositories/draft-repository'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { NarrativeThreadRepository } from '../../repositories/narrative-thread-repository'
import { SummaryRepository } from '../../repositories/summary-repository'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { removeDirectoryWithWindowsRetry } from '../../utils/remove-directory'
import { buildGenerationSourceBinding, type GenerationSourceBindingInput } from '../generation-source-binding'
import { ProjectPeekService } from '../project-peek'

// 回收站（#564）G7：被删行原地留在原表，任何读取路径都不能看见它。
// PR2 还不产生 deleted 行，这里直接改原表造一行，正文、要点、线索证据都带哨兵串。
const SENTINEL = '回收站哨兵串-7f3c9e'
const DELETED_BODY = `第二章：${SENTINEL}，沉船里的铜钟响了。`
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

let root = ''
let projectId = ''

function finalizeChapter(id: number, chapterNumber: number, body: string): string {
  const db = getProjectDb()!
  db.prepare('INSERT INTO contents(id,body) VALUES(?,?)').run(id, body)
  db.prepare("INSERT INTO drafts_all(id,chapter_number,version,status,content_id,word_count) VALUES(?,?,1,'draft',?,0)")
    .run(id, chapterNumber, id)
  const finalizationId = `finalization-${chapterNumber}`
  FinalizationRepository.commit({ finalizationId, draftId: id, chapterNumber, chapterTitle: `第${chapterNumber}章`,
    content: body, contentHash: sha256(body), contentRevision: 1, targetFileName: `${chapterNumber}.md` })
  return finalizationId
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-row-sentinel-'))
  projectId = randomUUID()
  fs.mkdirSync(path.join(root, '.ai-novel'), { recursive: true })
  fs.writeFileSync(path.join(root, '.ai-novel', 'project.json'), JSON.stringify(createCanonicalProjectManifest({
    projectId, createdAt: '2026-11-05T00:00:00.000Z',
  })))
  createProjectDatabase(root, Buffer.alloc(32, 7))
  initProjectDatabase(root)
  const db = getProjectDb()!
  db.prepare("INSERT INTO project_core(id,project_name,writing_language) VALUES('main','哨兵','zh-CN')").run()
  db.prepare("INSERT INTO blueprints(chapter_number,title,user_guidance) VALUES(1,'第一章',''),(2,'第二章',''),(3,'第三章','')").run()

  finalizeChapter(1, 1, '第一章：雾从海面升起。')
  const deletedFinalization = finalizeChapter(2, 2, DELETED_BODY)
  db.prepare(`INSERT INTO summary_snapshots_all(draft_id,chapter_number,chapter_notes,source_finalization_id,source_content_hash,projection_generation)
    VALUES(2,2,?,?,?,0)`).run(`要点：${SENTINEL}`, deletedFinalization, sha256(DELETED_BODY))
  db.prepare("UPDATE finalization_outbox_all SET knowledge_document_id='doc-deleted' WHERE draft_id=2").run()
  const plan = NarrativeThreadRepository.createPlan({ title: '铜钟', type: '伏笔', targetStartChapter: 1, targetEndChapter: 5, authorIntent: '调查铜钟' })
  db.prepare("INSERT INTO narrative_thread_confirmations_all(plan_id,draft_id,event_type,evidence,reason) VALUES(?,2,'planted',?,'')")
    .run(plan.id, SENTINEL)

  db.prepare(`UPDATE drafts_all SET status='deleted', deletion_id='deletion-sentinel', deleted_from_status='finalized',
    deleted_at='2026-11-05T00:00:00.000Z' WHERE id=2`).run()
})

afterEach(async () => {
  closeProjectDatabase()
  await removeDirectoryWithWindowsRetry(root)
})

function bindingFor(chapterNumber: number): string {
  const h = sha256('model')
  const input: GenerationSourceBindingInput = { projectId, epoch: 'e', operation: 'chapter-draft', chapterNumber,
    selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: ['draft'], skillStages: ['drafting'],
    modelReceipt: { modelId: 'model', provider: 'openai', protocol: 'openai', modelName: 'synthetic', modelRevision: h,
      endpointFingerprint: h, capabilityEvidence: { source: { contextWindowTokens: 'unknown', maxOutputTokens: 'user-operational-cap',
        featureFlags: 'unknown' }, subjectFingerprint: h, contextWindowTokens: 8000, maxOutputTokens: 1000, reasoning: false,
      structuredOutput: false, usage: true } },
    policy: { version: 'fixture-v1', maxPhysicalRequests: 2 }, outputContract: 'visible-text' }
  const globalDataRoot = path.join(root, 'global')
  fs.mkdirSync(globalDataRoot, { recursive: true })
  const result = buildGenerationSourceBinding({ db: getProjectDb()!, projectStorageRoot: path.join(root, '.ai-novel'), globalDataRoot,
    readBuiltinPrompt: () => JSON.stringify({ key: 'draft', content: 'builtin', systemRole: 'contract' }) }, input)
  return JSON.stringify({ materials: result.materials, sources: result.context.sources })
}

describe('被删行对读取路径不可见（哨兵串）', () => {
  it('哨兵行确实留在原表里', () => {
    const db = getProjectDb()!
    expect(db.prepare('SELECT status FROM drafts_all WHERE id=2').pluck().get()).toBe('deleted')
    expect(db.prepare('SELECT 1 FROM drafts WHERE id=2').get()).toBeUndefined()
    expect(db.prepare('SELECT body FROM contents WHERE id=2').pluck().get()).toContain(SENTINEL)
  })

  it('写作取材与生成来源绑定看不见被删章的正文、要点与线索', () => {
    for (const chapterNumber of [2, 3]) {
      const binding = bindingFor(chapterNumber)
      expect(binding, `第 ${chapterNumber} 章`).not.toContain(SENTINEL)
      expect(binding, `第 ${chapterNumber} 章`).not.toContain(sha256(DELETED_BODY))
    }
  })

  it('导出、连续性、知识库映射、线索、草稿与项目预览都看不见被删章', () => {
    expect(FinalizationRepository.listAuthoritativeForExport().map(item => item.chapterNumber)).toEqual([1])
    expect(JSON.stringify(SummaryRepository.listFinalizedContinuityBefore(3))).not.toContain(SENTINEL)
    expect([...FinalizationRepository.knowledgeDocumentChapters().keys()]).not.toContain('doc-deleted')
    expect(JSON.stringify(NarrativeThreadRepository.list())).not.toContain(SENTINEL)
    expect(DraftRepository.getMaxFinalizedChapter()).toBe(1)
    expect(DraftRepository.getNextVersion(2)).toBe(2)
    expect(JSON.stringify(new ProjectPeekService().readCurrent(projectId, getProjectDb()!))).not.toContain(SENTINEL)
  })
})

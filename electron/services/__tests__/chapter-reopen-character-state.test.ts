import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, createProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { BlueprintRepository } from '../../repositories/blueprint-repository'
import { DraftRepository } from '../../repositories/draft-repository'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { SummaryRepository } from '../../repositories/summary-repository'
import { refreshCharacterIdentityProjection } from '../../repositories/character-roster-repository'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { parseFinalizedCharacterStateResponse } from '../../../src/shared/finalized-continuity'
import { currentDerivedCharacterFields } from '../current-character-projection'
import { removeDirectoryWithWindowsRetry } from '../../utils/remove-directory'

const roots: string[] = []
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const CHARACTER_ID = '66666666-6666-4666-8666-666666666666'
const PROJECT_ID = randomUUID()

afterEach(async () => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) await removeDirectoryWithWindowsRetry(root)
})

function openProject(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-state-'))
  roots.push(root)
  fs.mkdirSync(path.join(root, '.ai-novel'), { recursive: true })
  fs.writeFileSync(path.join(root, '.ai-novel', 'project.json'), JSON.stringify(createCanonicalProjectManifest({
    projectId: PROJECT_ID, createdAt: '2026-11-01T00:00:00.000Z',
  })))
  createProjectDatabase(root, Buffer.alloc(32, 7))
  initProjectDatabase(root)
  BlueprintRepository.listPendingCharacterSyncOperations()
  const db = getProjectDb()!
  db.prepare("INSERT INTO project_core(id,project_name,writing_language) VALUES('main','重开','zh-CN')").run()
  db.prepare(`INSERT INTO characters(character_id,static_provenance,identity_revision,retired,name,role)
    VALUES(?,'{"kind":"author"}',0,0,'林岚','protagonist')`).run(CHARACTER_ID)
  db.transaction(() => refreshCharacterIdentityProjection(db))()
}

function commitFinal(draftId: number, chapterNumber: number, body: string): void {
  const db = getProjectDb()!
  db.prepare('INSERT OR IGNORE INTO blueprints(chapter_number,title) VALUES(?,?)').run(chapterNumber, `第${chapterNumber}章`)
  FinalizationRepository.commit({ finalizationId: `finalization-${randomUUID()}`, draftId, chapterNumber,
    chapterTitle: `第${chapterNumber}章`, content: body, contentHash: sha256(body), contentRevision: 1,
    targetFileName: `${chapterNumber}-${draftId}.md` })
  const context = SummaryRepository.readFinalizedCharacterContext(draftId, { projectId: PROJECT_ID, epoch: 'session' }, db)
  SummaryRepository.saveFinalizedContinuity({ draftId, chapterNumber, chapterNotes: `第${chapterNumber}章摘要`, facts: [],
    source: context.source, projectionGeneration: context.projectionGeneration }, db)
}

function finalizeNew(chapterNumber: number, body: string): number {
  const draftId = DraftRepository.create({ chapterNumber, source: 'write', content: body, wordCount: body.length })
  commitFinal(draftId, chapterNumber, body)
  return draftId
}

function derive(draftId: number, currentState: Record<string, string>, evidence: string) {
  const db = getProjectDb()!
  const context = SummaryRepository.readFinalizedCharacterContext(draftId, { projectId: PROJECT_ID, epoch: 'session' }, db)
  const response = parseFinalizedCharacterStateResponse(JSON.stringify({ updates: [{ characterId: CHARACTER_ID, currentState,
    evidence: { text: evidence } }] }), context)
  return SummaryRepository.commitFinalizedCharacterStates(context, response, db)
}

const derivedFields = () => currentDerivedCharacterFields(getProjectDb()!, PROJECT_ID)[CHARACTER_ID] ?? []

describe('替换中间一章后的派生角色状态（维护者问题 12）', () => {
  it('后续章的派生字段仍进写作提示，被替换那章自己的字段等重跑后再绑定新定稿', () => {
    openProject()
    const one = finalizeNew(1, '第一章：林岚在北塔顶层找到铜钥匙。')
    derive(one, { keyItems: '铜钥匙' }, '林岚在北塔顶层找到铜钥匙')
    const two = finalizeNew(2, '第二章：林岚离开北塔，住进南港旅店。')
    derive(two, { location: '南港旅店' }, '住进南港旅店')
    const three = finalizeNew(3, '第三章：林岚在南港旅店收到师父的来信。')
    derive(three, { recentEvents: '收到师父的来信' }, '收到师父的来信')
    expect(derivedFields()).toEqual(['location', 'keyItems', 'recentEvents'])

    const opened = FinalizationRepository.reopen({ chapterNumber: 2 })
    if (!opened.success) throw new Error('reopen failed')
    const revised = '第二章：林岚离开北塔，住进西城客栈。'
    DraftRepository.updateContent(opened.draftId, revised, revised.length)
    commitFinal(opened.draftId, 2, revised)

    expect(derivedFields()).toEqual(['keyItems', 'recentEvents'])
    expect(derive(opened.draftId, { location: '西城客栈' }, '住进西城客栈')).toMatchObject({ applied: 1 })
    expect(derivedFields()).toEqual(['location', 'keyItems', 'recentEvents'])
  })
})

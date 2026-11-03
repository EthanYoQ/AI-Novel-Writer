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
import { captureFinalizationGenerationContext, finalizationGenerationTask } from '../finalization-generation-source'
import { getBuiltinPromptTemplate } from '../../../src/services/builtin-prompt-templates'
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
const stateColumn = (column: 'cs_location' | 'cs_physical_state' | 'cs_recent_events') =>
  getProjectDb()!.prepare(`SELECT ${column} FROM characters WHERE character_id=?`).pluck().get(CHARACTER_ID)

function replaceFinal(chapterNumber: number, body: string): number {
  const opened = FinalizationRepository.reopen({ chapterNumber })
  if (!opened.success) throw new Error('reopen failed')
  DraftRepository.updateContent(opened.draftId, body, body.length)
  commitFinal(opened.draftId, chapterNumber, body)
  return opened.draftId
}

/** 三章都定稿并派生了角色状态（位置来自第 2 章，近况来自第 3 章），然后重开第 2 章、把旅店改成西城客栈再定稿。 */
function replaceMiddleChapter() {
  openProject()
  const one = finalizeNew(1, '第一章：林岚在北塔顶层找到铜钥匙。')
  derive(one, { keyItems: '铜钥匙' }, '林岚在北塔顶层找到铜钥匙')
  const two = finalizeNew(2, '第二章：林岚离开北塔，住进南港旅店。')
  derive(two, { location: '南港旅店' }, '住进南港旅店')
  const three = finalizeNew(3, '第三章：林岚在南港旅店收到师父的来信。')
  derive(three, { recentEvents: '收到师父的来信' }, '收到师父的来信')
  expect(derivedFields()).toEqual(['location', 'keyItems', 'recentEvents'])
  return { three, replacement: replaceFinal(2, '第二章：林岚离开北塔，住进西城客栈。') }
}

function authorSets(field: 'physicalState', value: string, chapterNumber: number): void {
  const db = getProjectDb()!
  const provenance = JSON.parse(db.prepare('SELECT cs_provenance FROM characters WHERE character_id=?').pluck().get(CHARACTER_ID) as string || '{}')
  provenance[field] = { kind: 'author', chapterNumber, revision: 1 }
  db.prepare('UPDATE characters SET cs_physical_state=?,cs_provenance=? WHERE character_id=?').run(value, JSON.stringify(provenance), CHARACTER_ID)
}

function characterPrompt(draftId: number, language: 'zh-CN' | 'en-US' = 'zh-CN'): string {
  const db = getProjectDb()!
  const scope = { projectId: PROJECT_ID, epoch: 'session' }
  const { source } = SummaryRepository.readFinalizedCharacterContext(draftId, scope, db)
  const context = captureFinalizationGenerationContext(db, { source, stepKey: 'character_cards' }, scope, language,
    getBuiltinPromptTemplate('update_character_cards', language)!)
  return String(finalizationGenerationTask(context).messages.at(-1)!.content)
}

describe('替换中间一章后的派生角色状态（维护者问题 12）', () => {
  it('后续章的派生字段仍进写作提示，被替换那章自己的字段等重跑后再绑定新定稿', () => {
    const { replacement } = replaceMiddleChapter()

    expect(derivedFields()).toEqual(['keyItems', 'recentEvents'])
    expect(derive(replacement, { location: '西城客栈' }, '住进西城客栈')).toMatchObject({ applied: 1 })
    expect(derivedFields()).toEqual(['location', 'keyItems', 'recentEvents'])
  })

  it('重跑被替换的一章时，后续章说了算的字段跳过并留着原值，整步不失败', () => {
    const { replacement } = replaceMiddleChapter()

    expect(derive(replacement, { location: '西城客栈', recentEvents: '住进西城客栈' }, '住进西城客栈'))
      .toMatchObject({ applied: 1, unchanged: 1, candidates: [] })
    expect(stateColumn('cs_recent_events')).toBe('收到师父的来信')
    expect(stateColumn('cs_location')).toBe('西城客栈')
    expect(derivedFields()).toEqual(['location', 'keyItems', 'recentEvents'])
  })

  it('后续章的来源自己也被替换、不再是权威定稿时，按这一章的新值写入', () => {
    const { replacement } = replaceMiddleChapter()
    replaceFinal(3, '第三章：林岚在西城客栈收到师父的来信。')
    expect(derivedFields()).toEqual(['keyItems'])

    expect(derive(replacement, { recentEvents: '住进西城客栈' }, '住进西城客栈')).toMatchObject({ applied: 1, unchanged: 0 })
    expect(stateColumn('cs_recent_events')).toBe('住进西城客栈')
  })

  it.each([
    { chapterNumber: 3, candidates: 0, outcome: '跳过' },
    { chapterNumber: 2, candidates: 1, outcome: '留给作者确认' },
  ])('作者把字段写在第 $chapterNumber 章：重跑第 2 章时$outcome，当前值不倒回', ({ chapterNumber, candidates }) => {
    const { replacement } = replaceMiddleChapter()
    authorSets('physicalState', '右臂受伤', chapterNumber)

    const receipt = derive(replacement, { location: '西城客栈', physicalState: '安然无恙' }, '住进西城客栈')
    expect(receipt.candidates).toHaveLength(candidates)
    expect(receipt.applied).toBe(1)
    expect(stateColumn('cs_physical_state')).toBe('右臂受伤')
  })

  it('替换后重跑角色状态的提示：列出来自旧定稿的字段，要求逐项重新给出；重新绑定后不再列出', () => {
    const { three, replacement } = replaceMiddleChapter()

    const prompt = characterPrompt(replacement)
    const restatement = prompt.slice(prompt.indexOf('【本章替换了旧定稿'))
    expect(restatement).toContain(`林岚（characterId：${CHARACTER_ID}）：location`)
    expect(restatement).not.toMatch(/keyItems|recentEvents/u)
    expect(restatement).toContain('与现有角色卡相同也要列出')
    const english = characterPrompt(replacement, 'en-US')
    const englishRestatement = english.slice(english.indexOf('[This chapter replaced an earlier final'))
    expect(englishRestatement).toContain(`林岚 (characterId: ${CHARACTER_ID}): location`)
    expect(englishRestatement).toContain('even when it is the same as the existing card')
    expect(englishRestatement.replace('林岚', '')).not.toMatch(/\p{Script=Han}/u)
    expect(characterPrompt(three)).not.toContain('【本章替换了旧定稿')

    derive(replacement, { location: '西城客栈' }, '住进西城客栈')
    expect(characterPrompt(replacement)).not.toContain('【本章替换了旧定稿')
  })
})

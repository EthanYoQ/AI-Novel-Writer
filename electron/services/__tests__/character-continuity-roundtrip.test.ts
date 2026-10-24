import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, createProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { BlueprintRepository } from '../../repositories/blueprint-repository'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { SummaryRepository } from '../../repositories/summary-repository'
import { refreshCharacterIdentityProjection } from '../../repositories/character-roster-repository'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { parseFinalizedCharacterStateResponse } from '../../../src/shared/finalized-continuity'
import { exportPortableProject } from '../project-archive-service'
import { restorePortableProject } from '../project-restore-service'
import { readPortableCurrentAuthority } from '../portable-current-authority'
import { currentDerivedCharacterFields } from '../current-character-projection'

const roots: string[] = []
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const CHARACTER_ID = '55555555-5555-4555-8555-555555555555'

afterEach(() => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

interface OpenProject { root: string; projectId: string; originProjectId?: string }

function createSourceProject(base: string): OpenProject {
  const root = path.join(base, 'A-原项目')
  const projectId = randomUUID()
  fs.mkdirSync(path.join(root, '.ai-novel'), { recursive: true })
  fs.writeFileSync(path.join(root, '.ai-novel', 'project.json'), JSON.stringify(createCanonicalProjectManifest({
    projectId, createdAt: '2026-10-01T00:00:00.000Z',
  })))
  createProjectDatabase(root, Buffer.alloc(32, 9))
  initProjectDatabase(root)
  BlueprintRepository.listPendingCharacterSyncOperations()
  const db = getProjectDb()!
  db.prepare("INSERT INTO project_core(id,project_name,writing_language) VALUES('main','两台电脑','zh-CN')").run()
  db.prepare(`INSERT INTO characters(character_id,static_provenance,identity_revision,retired,name,role)
    VALUES(?,'{"kind":"author"}',0,0,'林岚','protagonist')`).run(CHARACTER_ID)
  db.transaction(() => refreshCharacterIdentityProjection(db))()
  return { root, projectId }
}

function openProject(root: string, projectId: string): OpenProject {
  initProjectDatabase(root)
  const authority = readPortableCurrentAuthority({
    database: getProjectDb()!, projectStorageRoot: path.join(root, '.ai-novel'), projectId,
  })
  return { root, projectId, originProjectId: authority?.originProjectId }
}

function finalizeChapter(project: OpenProject, draftId: number, chapterNumber: number, body: string): void {
  const db = getProjectDb()!
  db.prepare('INSERT OR IGNORE INTO blueprints(chapter_number,title) VALUES(?,?)').run(chapterNumber, `第${chapterNumber}章`)
  db.prepare('INSERT INTO contents(id,body) VALUES(?,?)').run(draftId, '尚未定稿')
  db.prepare("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(?,?,1,'draft',?,0)")
    .run(draftId, chapterNumber, draftId)
  FinalizationRepository.commit({ finalizationId: `finalization-${randomUUID()}`, draftId, chapterNumber,
    chapterTitle: `第${chapterNumber}章`, content: body, contentHash: sha256(body), contentRevision: 1,
    targetFileName: `${chapterNumber}.md` })
  const context = SummaryRepository.readFinalizedCharacterContext(draftId, { projectId: project.projectId, epoch: 'session' }, db)
  SummaryRepository.saveFinalizedContinuity({ draftId, chapterNumber, chapterNotes: `第${chapterNumber}章摘要`, facts: [],
    source: context.source, projectionGeneration: context.projectionGeneration }, db)
}

function deriveCharacterState(project: OpenProject, draftId: number, currentState: Record<string, string>, evidence: string) {
  const db = getProjectDb()!
  const context = SummaryRepository.readFinalizedCharacterContext(draftId, { projectId: project.projectId, epoch: 'session' }, db)
  const response = parseFinalizedCharacterStateResponse(JSON.stringify({ updates: [{ characterId: CHARACTER_ID, currentState,
    evidence: { text: evidence } }] }), context)
  return SummaryRepository.commitFinalizedCharacterStates(context, response, db, project.originProjectId)
}

function derivedFields(project: OpenProject): string[] {
  return currentDerivedCharacterFields(getProjectDb()!, project.projectId, project.originProjectId)[CHARACTER_ID] ?? []
}

function characterRow(): Record<string, unknown> {
  return getProjectDb()!.prepare('SELECT * FROM characters WHERE character_id=?').get(CHARACTER_ID) as Record<string, unknown>
}

async function exportAndRestore(base: string, project: OpenProject, label: string): Promise<OpenProject> {
  closeProjectDatabase()
  const archive = path.join(base, `${label}.ainovel`)
  const attempts = path.join(base, `${label}-attempts`)
  fs.mkdirSync(attempts)
  await exportPortableProject({
    sourceProjectRoot: project.root,
    projectSession: { projectId: project.projectId, projectPath: project.root, leaseId: `lease-${label}` },
    targetArchivePath: archive,
    attemptParentPath: attempts,
    assertCurrentContext: () => undefined,
    assets: { snapshot: () => ({ files: [], verifyUnchanged: () => undefined }) },
    snapshotGeneration: `roundtrip-${label}`,
  })
  const target = path.join(base, `${label}-恢复`)
  const receipt = await restorePortableProject({ archivePath: archive, targetProjectRoot: target })
  return openProject(target, receipt.targetProjectId)
}

const CHAPTER_1 = '第一章：林岚在北塔顶层找到铜钥匙。'
const CHAPTER_2 = '第二章：林岚离开北塔，住进南港旅店。'
const CHAPTER_3 = '第三章：林岚在南港旅店收到师父的来信。'

describe('#491 角色状态来源经过多次备份往返', { timeout: 30_000 }, () => {
  it('导出→恢复→再导出→再恢复后，定稿派生字段仍是当前来源，最新章定稿可提交', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f491-'))
    roots.push(base)
    const a = createSourceProject(base)
    finalizeChapter(a, 1, 1, CHAPTER_1)
    expect(deriveCharacterState(a, 1, { location: '北塔顶层', keyItems: '铜钥匙', recentEvents: '找到铜钥匙' }, '林岚在北塔顶层找到铜钥匙'))
      .toMatchObject({ applied: 3 })
    const before = characterRow()
    expect(derivedFields(a)).toEqual(['location', 'keyItems', 'recentEvents'])

    const first = await exportAndRestore(base, a, 'round-1')
    expect(characterRow()).toMatchObject({ cs_location: before.cs_location, cs_key_items: before.cs_key_items })
    expect(derivedFields(first)).toEqual(['location', 'keyItems', 'recentEvents'])

    const second = await exportAndRestore(base, first, 'round-2')
    expect(characterRow()).toMatchObject({ cs_location: before.cs_location, cs_key_items: before.cs_key_items })
    expect.soft(derivedFields(second)).toEqual(['location', 'keyItems', 'recentEvents'])

    finalizeChapter(second, 2, 2, CHAPTER_2)
    expect(deriveCharacterState(second, 2, { location: '南港旅店', recentEvents: '住进南港旅店' }, '住进南港旅店'))
      .toMatchObject({ applied: 2 })
    expect(characterRow()).toMatchObject({ cs_location: '南港旅店', cs_key_items: '铜钥匙', cs_recent_events: '住进南港旅店' })
  })

  it('A 导出、B 恢复并续写再导出、A 恢复：未被新章更新的派生字段仍是当前来源，最新章定稿可提交', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f491-'))
    roots.push(base)
    const a = createSourceProject(base)
    finalizeChapter(a, 1, 1, CHAPTER_1)
    deriveCharacterState(a, 1, { location: '北塔顶层', keyItems: '铜钥匙', recentEvents: '找到铜钥匙' }, '林岚在北塔顶层找到铜钥匙')

    const b = await exportAndRestore(base, a, 'a-to-b')
    finalizeChapter(b, 2, 2, CHAPTER_2)
    expect(deriveCharacterState(b, 2, { location: '南港旅店', recentEvents: '住进南港旅店' }, '住进南港旅店'))
      .toMatchObject({ applied: 2 })

    const backOnA = await exportAndRestore(base, b, 'b-to-a')
    expect.soft(derivedFields(backOnA)).toEqual(['location', 'keyItems', 'recentEvents'])
    finalizeChapter(backOnA, 3, 3, CHAPTER_3)
    expect(deriveCharacterState(backOnA, 3, { keyItems: '铜钥匙、师父的来信', recentEvents: '收到师父的来信' }, '收到师父的来信'))
      .toMatchObject({ applied: 2 })
    expect(characterRow()).toMatchObject({ cs_location: '南港旅店', cs_key_items: '铜钥匙、师父的来信', cs_recent_events: '收到师父的来信' })
  })
})

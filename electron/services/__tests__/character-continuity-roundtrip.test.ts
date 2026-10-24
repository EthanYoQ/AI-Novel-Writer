import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, createProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { BlueprintRepository } from '../../repositories/blueprint-repository'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { SummaryRepository } from '../../repositories/summary-repository'
import { CharacterRosterRepository, refreshCharacterIdentityProjection } from '../../repositories/character-roster-repository'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { parseFinalizedCharacterStateResponse } from '../../../src/shared/finalized-continuity'
import { exportPortableProject } from '../project-archive-service'
import { restorePortableProject } from '../project-restore-service'
import { readPortableCurrentAuthority } from '../portable-current-authority'
import { currentDerivedCharacterFields } from '../current-character-projection'
import { adoptTransferredCharacterContinuityOnOpen } from '../transferred-character-continuity'

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

/** release 为 '1.3.2' 时模拟旧版本打开：不做续写纪元改记。 */
function openProject(root: string, projectId: string, release: 'fixed' | '1.3.2' = 'fixed'): OpenProject {
  initProjectDatabase(root)
  const database = getProjectDb()!
  if (release === 'fixed') adoptTransferredCharacterContinuityOnOpen({ database, projectRoot: root, projectId })
  const authority = readPortableCurrentAuthority({ database, projectStorageRoot: path.join(root, '.ai-novel'), projectId })
  return { root, projectId, originProjectId: authority?.originProjectId }
}

function finalizeChapter(project: OpenProject, draftId: number, chapterNumber: number, body: string, version = 1): void {
  const db = getProjectDb()!
  db.prepare('INSERT OR IGNORE INTO blueprints(chapter_number,title) VALUES(?,?)').run(chapterNumber, `第${chapterNumber}章`)
  db.prepare('INSERT INTO contents(id,body) VALUES(?,?)').run(draftId, '尚未定稿')
  db.prepare("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(?,?,?,'draft',?,0)")
    .run(draftId, chapterNumber, version, draftId)
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

async function exportAndRestore(base: string, project: OpenProject, label: string, release: 'fixed' | '1.3.2' = 'fixed'): Promise<OpenProject> {
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
  return openProject(target, receipt.targetProjectId, release)
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
    expect(derivedFields(second)).toEqual(['location', 'keyItems', 'recentEvents'])

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
    expect(derivedFields(backOnA)).toEqual(['location', 'keyItems', 'recentEvents'])
    finalizeChapter(backOnA, 3, 3, CHAPTER_3)
    expect(deriveCharacterState(backOnA, 3, { keyItems: '铜钥匙、师父的来信', recentEvents: '收到师父的来信' }, '收到师父的来信'))
      .toMatchObject({ applied: 2 })
    expect(characterRow()).toMatchObject({ cs_location: '南港旅店', cs_key_items: '铜钥匙、师父的来信', cs_recent_events: '收到师父的来信' })
  })

  it('旧版本往返造成的损坏项目在打开时自动修复：值不变、可重复执行、名单仍可编辑，最新章定稿可提交', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f491-'))
    roots.push(base)
    const a = createSourceProject(base)
    finalizeChapter(a, 1, 1, CHAPTER_1)
    deriveCharacterState(a, 1, { location: '北塔顶层', keyItems: '铜钥匙', recentEvents: '找到铜钥匙' }, '林岚在北塔顶层找到铜钥匙')
    const b = await exportAndRestore(base, a, 'old-a-to-b', '1.3.2')
    const damaged = await exportAndRestore(base, b, 'old-b-to-a', '1.3.2')
    expect(derivedFields(damaged)).toEqual([])
    const values = characterRow()
    closeProjectDatabase()

    const repaired = openProject(damaged.root, damaged.projectId)
    expect(derivedFields(repaired)).toEqual(['location', 'keyItems', 'recentEvents'])
    const after = characterRow()
    expect(after).toMatchObject({ cs_location: values.cs_location, cs_key_items: values.cs_key_items, cs_recent_events: values.cs_recent_events })
    const sources = (raw: unknown) => Object.values(JSON.parse(String(raw)) as Record<string, { source: unknown }>).map(entry => entry.source)
    expect(sources(after.cs_provenance)).toEqual(sources(values.cs_provenance))
    expect(CharacterRosterRepository.read(getProjectDb()!).status).toBe('ready')
    expect(adoptTransferredCharacterContinuityOnOpen({ database: getProjectDb()!,
      projectRoot: repaired.root, projectId: repaired.projectId })).toBe(0)
    expect(characterRow().cs_provenance).toBe(after.cs_provenance)

    finalizeChapter(repaired, 2, 2, CHAPTER_2)
    expect(deriveCharacterState(repaired, 2, { location: '南港旅店', keyItems: '铜钥匙', recentEvents: '住进南港旅店' }, '住进南港旅店'))
      .toMatchObject({ applied: 3 })
  })

  it('来源章节已重新定稿的旧派生字段经两次往返后仍显示为历史，但后续章节能照常更新它', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f491-'))
    roots.push(base)
    const a = createSourceProject(base)
    finalizeChapter(a, 1, 1, CHAPTER_1)
    deriveCharacterState(a, 1, { keyItems: '铜钥匙' }, '林岚在北塔顶层找到铜钥匙')
    finalizeChapter(a, 2, 1, `${CHAPTER_1}她把钥匙藏进袖口。`, 2)
    expect(derivedFields(a)).toEqual([])

    const second = await exportAndRestore(base, await exportAndRestore(base, a, 'stale-1'), 'stale-2')
    expect(derivedFields(second)).toEqual([])
    expect(characterRow().cs_key_items).toBe('铜钥匙')
    finalizeChapter(second, 3, 2, CHAPTER_2)
    expect(deriveCharacterState(second, 3, { keyItems: '铜钥匙、旅店房卡' }, '住进南港旅店')).toMatchObject({ applied: 1 })
  })

  it('修复后真正的来源冲突仍然拦下：后面章节已更新过的字段，不接受重新定稿的前面章节覆盖', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f491-'))
    roots.push(base)
    const a = createSourceProject(base)
    finalizeChapter(a, 1, 1, CHAPTER_1)
    deriveCharacterState(a, 1, { location: '北塔顶层' }, '林岚在北塔顶层找到铜钥匙')
    finalizeChapter(a, 2, 2, CHAPTER_2)
    deriveCharacterState(a, 2, { location: '南港旅店' }, '住进南港旅店')
    const damaged = await exportAndRestore(base, await exportAndRestore(base, a, 'conflict-1', '1.3.2'), 'conflict-2', '1.3.2')
    closeProjectDatabase()
    const repaired = openProject(damaged.root, damaged.projectId)
    expect(derivedFields(repaired)).toEqual(['location'])

    finalizeChapter(repaired, 3, 1, `${CHAPTER_1}她在塔顶等到天亮。`, 2)
    expect(() => deriveCharacterState(repaired, 3, { location: '北塔塔顶' }, '她在塔顶等到天亮'))
      .toThrow('FINALIZED_CHARACTER_SOURCE_CONFLICT')
    expect(characterRow().cs_location).toBe('南港旅店')
  })

  it('不是经验证转移来的项目、或来源不在本库的派生字段，打开时都不改写', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f491-'))
    roots.push(base)
    const a = createSourceProject(base)
    finalizeChapter(a, 1, 1, CHAPTER_1)
    deriveCharacterState(a, 1, { location: '北塔顶层', keyItems: '铜钥匙' }, '林岚在北塔顶层找到铜钥匙')
    const db = getProjectDb()!
    const forged = JSON.parse(String(characterRow().cs_provenance)) as Record<string, { source: Record<string, unknown>; sourceOrder: Record<string, unknown> }>
    forged.location.sourceOrder.continuityEpoch = `${randomUUID()}:0`
    forged.keyItems.sourceOrder.continuityEpoch = `${randomUUID()}:0`
    forged.keyItems.source.finalizationId = 'finalization-not-in-this-project'
    db.prepare('UPDATE characters SET cs_provenance=? WHERE character_id=?').run(JSON.stringify(forged), CHARACTER_ID)
    const stored = characterRow().cs_provenance
    expect(adoptTransferredCharacterContinuityOnOpen({ database: db, projectRoot: a.root, projectId: a.projectId })).toBe(0)
    expect(characterRow().cs_provenance).toBe(stored)

    const restored = await exportAndRestore(base, a, 'forged')
    const provenance = JSON.parse(String(characterRow().cs_provenance)) as Record<string, { sourceOrder: { continuityEpoch: string } }>
    expect(provenance.location.sourceOrder.continuityEpoch).toBe(`${restored.projectId}:0`)
    expect(provenance.keyItems.sourceOrder.continuityEpoch).toBe(forged.keyItems.sourceOrder.continuityEpoch)
  })
})

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
import { removeDirectoryWithWindowsRetry } from '../../utils/remove-directory'
import { ChapterDeletionService } from '../chapter-deletion-service'
import { ProjectClearRepository } from '../../repositories/project-clear-repository'

const roots: string[] = []
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const CHARACTER_ID = '55555555-5555-4555-8555-555555555555'

afterEach(async () => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) await removeDirectoryWithWindowsRetry(root)
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

  it('别的角色有一条格式损坏的来源记录时，跳过它，其余角色照常修复', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f491-'))
    roots.push(base)
    const a = createSourceProject(base)
    finalizeChapter(a, 1, 1, CHAPTER_1)
    deriveCharacterState(a, 1, { location: '北塔顶层', keyItems: '铜钥匙' }, '林岚在北塔顶层找到铜钥匙')
    const damaged = await exportAndRestore(base, await exportAndRestore(base, a, 'malformed-1', '1.3.2'), 'malformed-2', '1.3.2')
    const good = JSON.parse(String(characterRow().cs_provenance)) as Record<string, { source: Record<string, unknown> }>
    const broken = { location: { ...good.location, source: { ...good.location.source, finalizationId: 42 } } }
    getProjectDb()!.prepare(`INSERT INTO characters(character_id,static_provenance,identity_revision,retired,name,role,cs_location,cs_provenance)
      VALUES(?,'{"kind":"author"}',0,0,'周研','supporting','旧站',?)`).run(randomUUID(), JSON.stringify(broken))
    closeProjectDatabase()

    const repaired = openProject(damaged.root, damaged.projectId)
    expect(derivedFields(repaired)).toEqual(['location', 'keyItems'])
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

/** 走界面删除定稿章节的同一服务；正文文件与知识库投影换成空操作。 */
async function deleteFinalizedChapter(project: OpenProject, draftId: number, chapterNumber: number): Promise<void> {
  const service = new ChapterDeletionService({ cleaner: { removeManuscript: async () => undefined, removeKnowledgeDocument: async () => undefined } })
  let result = await service.delete(project.root, { draftId, chapterNumber })
  if (result.error === 'CHAPTER_DELETE_LEGACY_KNOWLEDGE_CHECK_REQUIRED') result = await service.confirmLegacyKnowledgeAbsent(project.root, result.operation!.operationId)
  expect(result).toMatchObject({ success: true, committed: true })
  expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM finalization_outbox WHERE draft_id=?').pluck().get(draftId)).toBe(0)
}

describe('#484 写入派生字段的章节已删除后再定稿后面的章节', { timeout: 30_000 }, () => {
  it('原项目：删掉第 1 章后定稿第 2 章，地点按第 2 章更新', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f484-'))
    roots.push(base)
    const a = createSourceProject(base)
    finalizeChapter(a, 1, 1, CHAPTER_1)
    deriveCharacterState(a, 1, { location: '北塔顶层' }, '林岚在北塔顶层找到铜钥匙')
    await deleteFinalizedChapter(a, 1, 1)
    finalizeChapter(a, 2, 2, CHAPTER_2)
    expect(deriveCharacterState(a, 2, { location: '南港旅店' }, '住进南港旅店')).toMatchObject({ applied: 1 })
    expect(characterRow().cs_location).toBe('南港旅店')
  })

  it('删掉第 1 章后恢复一次：定稿第 2 章，地点按第 2 章更新', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f484-'))
    roots.push(base)
    const a = createSourceProject(base)
    finalizeChapter(a, 1, 1, CHAPTER_1)
    deriveCharacterState(a, 1, { location: '北塔顶层' }, '林岚在北塔顶层找到铜钥匙')
    await deleteFinalizedChapter(a, 1, 1)
    const b = await exportAndRestore(base, a, 'deleted-1')
    finalizeChapter(b, 2, 2, CHAPTER_2)
    expect(deriveCharacterState(b, 2, { location: '南港旅店' }, '住进南港旅店')).toMatchObject({ applied: 1 })
    expect(characterRow().cs_location).toBe('南港旅店')
  })

  it('删掉第 1 章后恢复两次：定稿第 2 章应与原项目一样按第 2 章更新地点', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f484-'))
    roots.push(base)
    const a = createSourceProject(base)
    finalizeChapter(a, 1, 1, CHAPTER_1)
    deriveCharacterState(a, 1, { location: '北塔顶层' }, '林岚在北塔顶层找到铜钥匙')
    await deleteFinalizedChapter(a, 1, 1)
    const c = await exportAndRestore(base, await exportAndRestore(base, a, 'deleted-2a'), 'deleted-2b')
    finalizeChapter(c, 2, 2, CHAPTER_2)
    expect(deriveCharacterState(c, 2, { location: '南港旅店' }, '住进南港旅店')).toMatchObject({ applied: 1 })
    expect(characterRow().cs_location).toBe('南港旅店')
  })

  it('恢复两次后才删掉第 1 章：定稿第 2 章，地点按第 2 章更新', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f484-'))
    roots.push(base)
    const a = createSourceProject(base)
    finalizeChapter(a, 1, 1, CHAPTER_1)
    deriveCharacterState(a, 1, { location: '北塔顶层' }, '林岚在北塔顶层找到铜钥匙')
    const c = await exportAndRestore(base, await exportAndRestore(base, a, 'later-a'), 'later-b')
    await deleteFinalizedChapter(c, 1, 1)
    finalizeChapter(c, 2, 2, CHAPTER_2)
    expect(deriveCharacterState(c, 2, { location: '南港旅店' }, '住进南港旅店')).toMatchObject({ applied: 1 })
    expect(characterRow().cs_location).toBe('南港旅店')
  })
})

type Attempt = number | string

/** 定稿一章并提交地点；成功返回改写的字段数，被拒返回错误码。 */
function finalizeLocation(project: OpenProject, chapterNumber: number, body: string, location: string): Attempt {
  finalizeChapter(project, chapterNumber, chapterNumber, body)
  try {
    return deriveCharacterState(project, chapterNumber, { location }, body).applied
  } catch (error) {
    return (error as Error).message
  }
}

function authorEditsLocation(value: string): void {
  getProjectDb()!.prepare('UPDATE characters SET cs_location=?, cs_provenance=? WHERE character_id=?')
    .run(value, JSON.stringify({ location: { kind: 'author', chapterNumber: 0, revision: 5 } }), CHARACTER_ID)
}

interface ParityScenario {
  name: string
  removeChapter1: (project: OpenProject) => Promise<void>
  continueWriting: (project: OpenProject) => Attempt[]
  knownGap?: string
}

const PARITY_SCENARIOS: ParityScenario[] = [
  {
    name: '删掉第 1 章后定稿第 2 章',
    removeChapter1: project => deleteFinalizedChapter(project, 1, 1),
    continueWriting: project => [finalizeLocation(project, 2, CHAPTER_2, '南港旅店')],
  },
  {
    name: '删掉第 1 章后先定稿第 3 章，再回头定稿第 2 章',
    removeChapter1: project => deleteFinalizedChapter(project, 1, 1),
    continueWriting: project => [finalizeLocation(project, 3, CHAPTER_3, '南港码头'), finalizeLocation(project, 2, CHAPTER_2, '南港旅店')],
  },
  {
    name: '删掉第 1 章后作者手改地点，再定稿第 2 章',
    removeChapter1: project => deleteFinalizedChapter(project, 1, 1),
    continueWriting: project => {
      authorEditsLocation('作者写的地点')
      return [finalizeLocation(project, 2, CHAPTER_2, '南港旅店')]
    },
  },
  {
    name: '清空生成正文后定稿第 2 章',
    removeChapter1: async () => { ProjectClearRepository.clearGeneratedData({ generatedText: true }) },
    continueWriting: project => [finalizeLocation(project, 2, CHAPTER_2, '南港旅店')],
    knownGap: '清空生成正文不留删章记录，来源已删的派生字段在本库没有可用的来源证明，恢复两次以上仍报来源冲突，作者手改一次该字段可绕过',
  },
]

const RESTORE_PATHS: Array<[string, (base: string, project: OpenProject) => Promise<OpenProject>]> = [
  ['新版本恢复一次', (base, a) => exportAndRestore(base, a, 'fixed-1')],
  ['新版本恢复两次', async (base, a) => exportAndRestore(base, await exportAndRestore(base, a, 'fixed-1'), 'fixed-2')],
  ['新版本恢复三次', async (base, a) => exportAndRestore(base,
    await exportAndRestore(base, await exportAndRestore(base, a, 'fixed-1'), 'fixed-2'), 'fixed-3')],
  ['1.3.2 恢复两次后用新版本打开', async (base, a) => {
    const c = await exportAndRestore(base, await exportAndRestore(base, a, 'old-1', '1.3.2'), 'old-2', '1.3.2')
    closeProjectDatabase()
    return openProject(c.root, c.projectId)
  }],
  ['新版本恢复一次后再用 1.3.2 恢复一次', async (base, a) => exportAndRestore(base, await exportAndRestore(base, a, 'fixed-1'), 'old-2', '1.3.2')],
]

async function outcomeOn(scenario: ParityScenario, restore?: (base: string, project: OpenProject) => Promise<OpenProject>) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f484-parity-'))
  roots.push(base)
  const a = createSourceProject(base)
  finalizeChapter(a, 1, 1, CHAPTER_1)
  deriveCharacterState(a, 1, { location: '北塔顶层' }, '林岚在北塔顶层找到铜钥匙')
  await scenario.removeChapter1(a)
  const project = restore ? await restore(base, a) : a
  const currentBeforeWriting = derivedFields(project)
  const attempts = scenario.continueWriting(project)
  const outcome = { currentBeforeWriting, attempts, location: characterRow().cs_location, currentAfterWriting: derivedFields(project) }
  closeProjectDatabase()
  return outcome
}

describe.each(PARITY_SCENARIOS)('#484 对照：$name，恢复过的项目与原项目结果一致', scenario => {
  (scenario.knownGap ? it.todo : it).each(RESTORE_PATHS)('%s', { timeout: 60_000 }, async (_label, restore) => {
    const original = await outcomeOn(scenario)
    expect(await outcomeOn(scenario, restore)).toEqual(original)
  })
})

describe('#484 删章记录作为来源证明的边界', { timeout: 60_000 }, () => {
  it('1.3.2 方式恢复两次后用新版本打开：前缀一步改记为当前项目，再打开返回 0，第 2 章可定稿', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f484-'))
    roots.push(base)
    const a = createSourceProject(base)
    finalizeChapter(a, 1, 1, CHAPTER_1)
    deriveCharacterState(a, 1, { location: '北塔顶层' }, '林岚在北塔顶层找到铜钥匙')
    await deleteFinalizedChapter(a, 1, 1)
    const c = await exportAndRestore(base, await exportAndRestore(base, a, 'legacy-1', '1.3.2'), 'legacy-2', '1.3.2')
    expect(String(characterRow().cs_provenance)).toContain(a.projectId)
    closeProjectDatabase()

    const opened = openProject(c.root, c.projectId)
    const adopted = String(characterRow().cs_provenance)
    expect(adopted).toContain(`${c.projectId}:`)
    expect(adopted).not.toContain(a.projectId)
    expect(adoptTransferredCharacterContinuityOnOpen({ database: getProjectDb()!, projectRoot: c.root, projectId: c.projectId })).toBe(0)
    expect(characterRow().cs_provenance).toBe(adopted)
    finalizeChapter(opened, 2, 2, CHAPTER_2)
    expect(deriveCharacterState(opened, 2, { location: '南港旅店' }, '住进南港旅店')).toMatchObject({ applied: 1 })
  })

  it('删章后恢复两次，章节顺序仍然生效：先定稿第 3 章，再回头定稿第 2 章报来源冲突', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f484-'))
    roots.push(base)
    const a = createSourceProject(base)
    finalizeChapter(a, 1, 1, CHAPTER_1)
    deriveCharacterState(a, 1, { location: '北塔顶层' }, '林岚在北塔顶层找到铜钥匙')
    await deleteFinalizedChapter(a, 1, 1)
    const c = await exportAndRestore(base, await exportAndRestore(base, a, 'order-1'), 'order-2')
    finalizeChapter(c, 3, 3, CHAPTER_3)
    expect(deriveCharacterState(c, 3, { location: '南港码头' }, '收到师父的来信')).toMatchObject({ applied: 1 })
    finalizeChapter(c, 2, 2, CHAPTER_2)
    expect(() => deriveCharacterState(c, 2, { location: '南港旅店' }, '住进南港旅店')).toThrow('FINALIZED_CHARACTER_SOURCE_CONFLICT')
    expect(characterRow().cs_location).toBe('南港码头')
  })

  it('删章后恢复两次，作者手改过的地点不被定稿覆盖', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f484-'))
    roots.push(base)
    const a = createSourceProject(base)
    finalizeChapter(a, 1, 1, CHAPTER_1)
    deriveCharacterState(a, 1, { location: '北塔顶层' }, '林岚在北塔顶层找到铜钥匙')
    await deleteFinalizedChapter(a, 1, 1)
    const c = await exportAndRestore(base, await exportAndRestore(base, a, 'author-1'), 'author-2')
    authorEditsLocation('作者写的地点')
    finalizeChapter(c, 2, 2, CHAPTER_2)
    expect(deriveCharacterState(c, 2, { location: '南港旅店' }, '住进南港旅店')).toMatchObject({ applied: 0 })
    expect(characterRow().cs_location).toBe('作者写的地点')
  })

  it('来源定稿 ID 既没有收据也没有删章记录：恢复两次后前缀不改记，定稿仍报来源冲突', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f484-'))
    roots.push(base)
    const a = createSourceProject(base)
    finalizeChapter(a, 1, 1, CHAPTER_1)
    deriveCharacterState(a, 1, { location: '北塔顶层' }, '林岚在北塔顶层找到铜钥匙')
    await deleteFinalizedChapter(a, 1, 1)
    const forged = JSON.parse(String(characterRow().cs_provenance)) as Record<string, { source: Record<string, unknown> }>
    forged.location.source.finalizationId = 'finalization-forged'
    getProjectDb()!.prepare('UPDATE characters SET cs_provenance=? WHERE character_id=?').run(JSON.stringify(forged), CHARACTER_ID)
    const c = await exportAndRestore(base, await exportAndRestore(base, a, 'forged-1'), 'forged-2')
    expect(String(characterRow().cs_provenance)).toContain(a.projectId)
    finalizeChapter(c, 2, 2, CHAPTER_2)
    expect(() => deriveCharacterState(c, 2, { location: '南港旅店' }, '住进南港旅店')).toThrow('FINALIZED_CHARACTER_SOURCE_CONFLICT')
  })
})

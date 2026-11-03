import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, createProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { BlueprintRepository } from '../../repositories/blueprint-repository'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { exportPortableProject } from '../project-archive-service'
import { restorePortableProject } from '../project-restore-service'
import { readPortableCurrentAuthority } from '../portable-current-authority'
import { ChapterDeletionService } from '../chapter-deletion-service'
import { removeDirectoryWithWindowsRetry } from '../../utils/remove-directory'

const roots: string[] = []
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

afterEach(async () => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) await removeDirectoryWithWindowsRetry(root)
})

interface OpenProject { root: string; projectId: string }

function createSourceProject(base: string): OpenProject {
  const root = path.join(base, 'A')
  const projectId = randomUUID()
  fs.mkdirSync(path.join(root, '.ai-novel'), { recursive: true })
  fs.writeFileSync(path.join(root, '.ai-novel', 'project.json'), JSON.stringify(createCanonicalProjectManifest({
    projectId, createdAt: '2026-10-01T00:00:00.000Z',
  })))
  createProjectDatabase(root, Buffer.alloc(32, 9))
  initProjectDatabase(root)
  BlueprintRepository.listPendingCharacterSyncOperations()
  getProjectDb()!.prepare("INSERT INTO project_core(id,project_name,writing_language) VALUES('main','替换章节','zh-CN')").run()
  return { root, projectId }
}

function finalizeChapter(draftId: number, chapterNumber: number, body: string, version: number): void {
  const db = getProjectDb()!
  db.prepare('INSERT INTO contents(id,body) VALUES(?,?)').run(draftId, '尚未定稿')
  db.prepare("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(?,?,?,'draft',?,0)")
    .run(draftId, chapterNumber, version, draftId)
  FinalizationRepository.commit({ finalizationId: `finalization-${randomUUID()}`, draftId, chapterNumber,
    chapterTitle: `第${chapterNumber}章`, content: body, contentHash: sha256(body), contentRevision: 1,
    targetFileName: `${chapterNumber}-${draftId}.md` })
}

function currentAuthority(project: OpenProject) {
  return readPortableCurrentAuthority({ database: getProjectDb()!, projectStorageRoot: path.join(project.root, '.ai-novel'), projectId: project.projectId })
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
    snapshotGeneration: `superseded-${label}`,
  })
  const target = path.join(base, `${label}-恢复`)
  const receipt = await restorePortableProject({ archivePath: archive, targetProjectRoot: target })
  initProjectDatabase(target)
  return { root: target, projectId: receipt.targetProjectId }
}

async function restoredProject(label: string): Promise<{ base: string; restored: OpenProject }> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'superseded-portable-'))
  roots.push(base)
  const source = createSourceProject(base)
  finalizeChapter(1, 1, '第一章：雾从海面升起。', 1)
  finalizeChapter(2, 2, '第二章：北堤外的沉船。', 1)
  return { base, restored: await exportAndRestore(base, source, label) }
}

describe('备份恢复的项目替换一章定稿', { timeout: 60_000 }, () => {
  it('替换后转移授权仍可读，后续章节可写，可以再导出备份', async () => {
    const { base, restored } = await restoredProject('replace')
    expect(currentAuthority(restored)).not.toBeNull()

    finalizeChapter(10, 1, '第一章新稿：钟声提前了一刻。', 2)
    expect(currentAuthority(restored)).not.toBeNull()
    finalizeChapter(11, 3, '第三章：沉船里的铜钟。', 1)

    const again = await exportAndRestore(base, restored, 'after-replace')
    expect(currentAuthority(again)).not.toBeNull()
  })

  it('替换后再删除这一章，转移授权仍可读、可以导出备份', async () => {
    const { base, restored } = await restoredProject('replace-delete')
    finalizeChapter(10, 2, '第二章新稿：沉船翻了个身。', 2)
    const service = new ChapterDeletionService({ cleaner: { removeManuscript: async () => undefined, removeKnowledgeDocument: async () => undefined } })
    let result = await service.delete(restored.root, { draftId: 10, chapterNumber: 2 })
    if (result.error === 'CHAPTER_DELETE_LEGACY_KNOWLEDGE_CHECK_REQUIRED') result = await service.confirmLegacyKnowledgeAbsent(restored.root, result.operation!.operationId)
    expect(result).toMatchObject({ success: true, committed: true })

    expect(currentAuthority(restored)).not.toBeNull()
    await expect(exportAndRestore(base, restored, 'after-delete')).resolves.toBeTruthy()
  })

  it('改定较低版本的旧稿替换了较高版本的定稿，转移授权仍可读', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'superseded-portable-'))
    roots.push(base)
    const source = createSourceProject(base)
    const olderBody = '第一章初稿：雾从海面升起。'
    getProjectDb()!.prepare('INSERT INTO contents(id,body) VALUES(3,?)').run(olderBody)
    getProjectDb()!.prepare("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(3,1,1,'draft',3,0)").run()
    finalizeChapter(4, 1, '第一章改稿：雾从海面一层一层爬上来。', 2)
    const restored = await exportAndRestore(base, source, 'older-version')

    FinalizationRepository.commit({ finalizationId: `finalization-${randomUUID()}`, draftId: 3, chapterNumber: 1,
      chapterTitle: '第1章', content: olderBody, contentHash: sha256(olderBody), contentRevision: 1, targetFileName: '1-3.md' })

    expect(getProjectDb()!.prepare('SELECT id, status FROM drafts WHERE chapter_number = 1 ORDER BY id').all())
      .toEqual([{ id: 3, status: 'finalized' }, { id: 4, status: 'superseded' }])
    expect(currentAuthority(restored)).not.toBeNull()
  })

  it('被替换的旧定稿正文被改过时，转移授权校验仍然拒绝', async () => {
    const { restored } = await restoredProject('tamper')
    finalizeChapter(10, 1, '第一章新稿：钟声提前了一刻。', 2)
    getProjectDb()!.prepare('UPDATE contents SET body = ? WHERE id = 1').run('改过的旧定稿')

    expect(() => currentAuthority(restored)).toThrow()
  })
})

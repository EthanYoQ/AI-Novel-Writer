import { access, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  migrateV1NovelProject,
  previewV1NovelMigration,
} from '../src/novel-migration.ts'
import { openNovelStore } from '../src/novel-store.ts'
import { makeTestWorkspace } from './test-workspace.ts'

const signal = new AbortController().signal
const workspaceId = WorkspaceId('123e4567-e89b-42d3-a456-426614174201')
const projectId = '123e4567-e89b-42d3-a456-426614174000'
const openedStores: Array<Awaited<ReturnType<typeof openNovelStore>>> = []

async function write(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text, 'utf8')
}

async function createV1Project(root: string): Promise<void> {
  await write(join(root, '.ai-novel', 'project.json'), `${JSON.stringify({
    formatVersion: 1,
    kind: 'harness-novel-project',
    projectId,
    title: '潮汐来信',
    language: 'zh-CN',
    genre: '奇幻悬疑',
    plannedChapters: 12,
    targetWordsPerChapter: 3000,
    creativeStrategy: 'consistency-first',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
  }, null, 2)}\n`)
  await write(join(root, '.ai-novel', 'characters.json'), `${JSON.stringify({
    characters: [
      {
        id: 'lin-xia',
        name: '林夏',
        role: '主角',
        summary: '追查未来信件的记者。',
        goal: '找回失踪的弟弟。',
        relationships: [{ characterId: 'zhou-yao', type: '合作', summary: '共同调查潮汐站。' }],
        notes: '保留完整记忆。',
      },
      {
        id: 'zhou-yao',
        name: '周遥',
        role: '搭档',
        summary: '谨慎的调查员。',
        goal: '公开旧案真相。',
        relationships: [],
        notes: '随身携带青铜铃。',
      },
    ],
  }, null, 2)}\n`)
  await write(join(root, '.ai-novel', 'blueprints', 'story.json'), `${JSON.stringify({
    premise: '退潮后出现来自未来的信件。',
    themes: ['记忆', '责任'],
    world: '近未来海港城。',
    mainPlot: '两名调查者追查潮汐站旧案。',
    endingGoal: '公开真相并阻止下一次事故。',
  }, null, 2)}\n`)
  await write(join(root, '.ai-novel', 'blueprints', 'chapters', '0001.json'), `${JSON.stringify({
    chapter: 1,
    title: '退潮来信',
    purpose: '让林夏收到第一封未来信件。',
    beats: ['夜潮退去', '海床显出信匣'],
    characterIds: ['lin-xia', 'zhou-yao'],
    continuityNotes: ['灯塔主灯在午夜熄灭'],
    status: 'drafted',
  }, null, 2)}\n`)
  await write(join(root, 'chapters', '0001.md'), '# 第一章\n\n潮水退去时，信匣露出了海面。\n')
}

async function openStore(root: string) {
  const store = await openNovelStore(root, workspaceId)
  openedStores.push(store)
  return store
}

async function sourceBytes(root: string): Promise<Record<string, string>> {
  const files = [
    '.ai-novel/project.json',
    '.ai-novel/characters.json',
    '.ai-novel/blueprints/story.json',
    '.ai-novel/blueprints/chapters/0001.json',
    'chapters/0001.md',
  ]
  return Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(join(root, file), 'utf8')])))
}

afterEach(async () => {
  await Promise.all(openedStores.map(store => store.dispose()))
  openedStores.length = 0
})

describe('explicit V1 migration', () => {
  it('previews and migrates all five V1 assets into one reopenable V2 store', async () => {
    const root = await makeTestWorkspace('v1-migrate-complete-')
    await createV1Project(root)
    const before = await sourceBytes(root)

    const preview = await previewV1NovelMigration(root, signal)
    expect(preview).toMatchObject({
      projectId,
      alreadyMigrated: false,
      resumable: false,
      sourceCount: 5,
      characterCount: 2,
      relationshipCount: 1,
      chapterCount: 1,
      draftCount: 1,
    })
    expect(preview.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(preview.sources.map(source => source.source)).toEqual([
      '.ai-novel/blueprints/chapters/0001.json',
      '.ai-novel/blueprints/story.json',
      '.ai-novel/characters.json',
      '.ai-novel/project.json',
      'chapters/0001.md',
    ])
    await expect(access(join(root, '.ai-novel', 'novel.db'))).rejects.toThrow()

    const receipt = await migrateV1NovelProject(root, workspaceId, preview.fingerprint, signal)
    expect(receipt).toEqual({
      projectId,
      fingerprint: preview.fingerprint,
      archivePath: `.ai-novel/v1-archive/${preview.fingerprint}`,
      sourceCount: 5,
      chapterCount: 1,
      draftCount: 1,
      migratedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    })
    expect(await sourceBytes(root)).toEqual(before)

    const archiveRoot = join(root, '.ai-novel', 'v1-archive', preview.fingerprint)
    for (const file of Object.keys(before)) {
      await expect(readFile(join(archiveRoot, file), 'utf8')).resolves.toBe(before[file])
    }
    await expect(access(join(root, '.ai-novel', 'novel.db-journal'))).rejects.toThrow()
    await expect(access(join(root, '.ai-novel', 'novel.db-wal'))).rejects.toThrow()
    await expect(access(join(root, '.ai-novel', 'novel.db-shm'))).rejects.toThrow()

    const store = await openStore(root)
    const state = await store.read(signal)
    expect(state.migration).toEqual(receipt)
    expect(state.project).toMatchObject({
      title: '潮汐来信',
      language: 'zh-CN',
      genre: '奇幻悬疑',
      plannedChapters: 12,
      targetWordsPerChapter: 3000,
      creativeStrategy: 'consistency-first',
      structureMode: 'three-act',
      narrativePov: 'third-limited',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z',
    })
    expect(state.architecture).toMatchObject({
      premise: '退潮后出现来自未来的信件。',
      world: '近未来海港城。',
      plotOutline: '两名调查者追查潮汐站旧案。',
    })
    expect(state.characters.items).toHaveLength(2)
    expect(state.characters.relationships).toEqual([{
      fromCharacterId: 'lin-xia',
      toCharacterId: 'zhou-yao',
      relation: '合作',
      notes: '共同调查潮汐站。',
    }])
    expect(state.chapters).toEqual([{
      revision: 0,
      chapter: 1,
      title: '退潮来信',
      purpose: '让林夏收到第一封未来信件。',
      plotBeats: ['夜潮退去', '海床显出信匣'],
      characters: ['lin-xia', 'zhou-yao'],
      keyEvents: [],
      suspense: '',
      status: 'reviewing',
    }])
    expect(state.artifacts).toEqual([expect.objectContaining({
      artifactId: `v1-draft-${preview.fingerprint}-chapter-1`,
      chapter: 1,
      kind: 'draft',
      content: '# 第一章\n\n潮水退去时，信匣露出了海面。\n',
      summary: 'Migrated V1 draft.',
    })])
    expect(state.chapterFinals).toEqual([])

    await store.dispose()
    openedStores.length = 0
    await expect(previewV1NovelMigration(root, signal)).resolves.toMatchObject({
      fingerprint: preview.fingerprint,
      alreadyMigrated: true,
      receipt,
    })
  })

  it('requires the fingerprint shown to the user and rejects an invalid preview fingerprint', async () => {
    const root = await makeTestWorkspace('v1-migrate-preview-guard-')
    await createV1Project(root)
    const preview = await previewV1NovelMigration(root, signal)

    await expect(migrateV1NovelProject(root, workspaceId, '0'.repeat(64), signal)).rejects.toMatchObject({
      code: 'STALE_REVISION',
    })
    await expect(access(join(root, '.ai-novel', 'novel.db'))).rejects.toThrow()
    await expect(migrateV1NovelProject(root, workspaceId, preview.fingerprint, signal)).resolves.toMatchObject({
      fingerprint: preview.fingerprint,
    })
  })

  it('recovers idempotently when the archive was published but the database was not', async () => {
    const root = await makeTestWorkspace('v1-migrate-recovery-')
    await createV1Project(root)
    const preview = await previewV1NovelMigration(root, signal)
    await migrateV1NovelProject(root, workspaceId, preview.fingerprint, signal)
    await Promise.all(openedStores.map(store => store.dispose()))
    openedStores.length = 0
    await rm(join(root, '.ai-novel', 'novel.db'))

    const resumedPreview = await previewV1NovelMigration(root, signal)
    expect(resumedPreview).toMatchObject({ fingerprint: preview.fingerprint, resumable: true })
    const receipt = await migrateV1NovelProject(root, workspaceId, resumedPreview.fingerprint, signal)
    expect(receipt.fingerprint).toBe(preview.fingerprint)

    const store = await openStore(root)
    await expect(store.read(signal)).resolves.toMatchObject({ migration: receipt })
  })

  it('fails loud when V1 sources drift after the archive or database was published', async () => {
    const root = await makeTestWorkspace('v1-migrate-drift-')
    await createV1Project(root)
    const preview = await previewV1NovelMigration(root, signal)
    await migrateV1NovelProject(root, workspaceId, preview.fingerprint, signal)
    await Promise.all(openedStores.map(store => store.dispose()))
    openedStores.length = 0
    const storyPath = join(root, '.ai-novel', 'blueprints', 'story.json')
    await writeFile(storyPath, `${JSON.stringify({
      premise: 'changed',
      themes: ['记忆'],
      world: '近未来海港城。',
      mainPlot: '两名调查者追查潮汐站旧案。',
      endingGoal: '公开真相并阻止下一次事故。',
    }, null, 2)}\n`, 'utf8')

    await expect(previewV1NovelMigration(root, signal)).rejects.toMatchObject({ code: 'STALE_REVISION' })
    await expect(migrateV1NovelProject(root, workspaceId, preview.fingerprint, signal)).rejects.toMatchObject({
      code: 'STALE_REVISION',
    })

    await rm(join(root, '.ai-novel', 'novel.db'))
    await expect(previewV1NovelMigration(root, signal)).rejects.toMatchObject({
      code: 'STALE_REVISION',
    })
    await expect(migrateV1NovelProject(root, workspaceId, preview.fingerprint, signal)).rejects.toMatchObject({
      code: 'STALE_REVISION',
    })
  })

  it('rejects invalid V1 content before publishing a database or changing source files', async () => {
    const root = await makeTestWorkspace('v1-migrate-invalid-')
    await createV1Project(root)
    const chapterPath = join(root, '.ai-novel', 'blueprints', 'chapters', '0001.json')
    const invalid = JSON.parse(await readFile(chapterPath, 'utf8')) as Record<string, unknown>
    invalid.characterIds = ['missing-character']
    await writeFile(chapterPath, `${JSON.stringify(invalid, null, 2)}\n`, 'utf8')

    await expect(previewV1NovelMigration(root, signal)).rejects.toMatchObject({ code: 'INVALID_CONTENT' })
    await expect(migrateV1NovelProject(root, workspaceId, 'a'.repeat(64), signal)).rejects.toMatchObject({
      code: 'INVALID_CONTENT',
    })
    await expect(access(join(root, '.ai-novel', 'novel.db'))).rejects.toThrow()
    await expect(access(join(root, '.ai-novel', 'v1-archive'))).rejects.toThrow()
  })

  it('does not read a desktop .vela project as V1', async () => {
    const root = await makeTestWorkspace('v1-migrate-vela-')
    await write(join(root, '.vela', 'project.json'), '{ invalid json')

    await expect(previewV1NovelMigration(root, signal)).rejects.toMatchObject({ code: 'NOT_INITIALIZED' })
    await expect(migrateV1NovelProject(root, workspaceId, 'b'.repeat(64), signal)).rejects.toMatchObject({
      code: 'NOT_INITIALIZED',
    })
  })

  it('rejects a symlinked workspace root', async () => {
    const root = await makeTestWorkspace('v1-migrate-root-symlink-')
    await createV1Project(root)
    const alias = `${root}-alias`
    await symlink(root, alias, 'dir')

    await expect(previewV1NovelMigration(alias, signal)).rejects.toMatchObject({
      code: 'PATH_REJECTED',
    })
  })

  it('rejects a V2 database without a migration receipt as an unsupported format', async () => {
    const root = await makeTestWorkspace('v1-migrate-non-migration-db-')
    const store = await openNovelStore(root, workspaceId)
    try {
      await store.initialize({
        workspaceId,
        title: '原生 V2 项目',
        language: 'zh-CN',
        genre: '奇幻',
        plannedChapters: 8,
        targetWordsPerChapter: 2_000,
        creativeStrategy: 'consistency-first',
        structureMode: 'three-act',
        narrativePov: 'third-limited',
        globalGuidance: '',
      }, signal)
    } finally {
      await store.dispose()
    }

    await expect(previewV1NovelMigration(root, signal)).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
    })
  })
})

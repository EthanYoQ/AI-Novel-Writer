import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

const linkHook = vi.hoisted(() => ({
  mode: 'disabled' as 'disabled' | 'drift-source' | 'corrupt-published-database',
  root: '',
}))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const actualLink = actual.link
  return {
    ...actual,
    link: async (source: Parameters<typeof actualLink>[0], destination: Parameters<typeof actualLink>[1]) => {
      await actualLink(source, destination)
      const destinationPath = destination.toString()
      if (
        linkHook.mode === 'drift-source'
        && destinationPath.includes(`${join('.ai-novel', 'v1-archive')}`)
        && destinationPath.endsWith(join('.ai-novel', 'project.json'))
      ) {
        await actual.writeFile(join(linkHook.root, '.ai-novel', 'project.json'), JSON.stringify({
          formatVersion: 1,
          kind: 'harness-novel-project',
          projectId: '123e4567-e89b-42d3-a456-426614174000',
          title: '并发修改后的标题',
          language: 'zh-CN',
          genre: '奇幻悬疑',
          plannedChapters: 12,
          targetWordsPerChapter: 3000,
          creativeStrategy: 'consistency-first',
          createdAt: '2026-08-16T00:00:00.000Z',
          updatedAt: '2026-08-17T00:00:00.000Z',
        }, null, 2), 'utf8')
      }
      if (linkHook.mode === 'corrupt-published-database' && destinationPath.endsWith('novel.db')) {
        await actual.writeFile(destination, 'not a sqlite database\n', 'utf8')
      }
    },
  }
})

const signal = new AbortController().signal
const workspaceId = WorkspaceId('123e4567-e89b-42d3-a456-426614174201')

async function createMinimalV1Project(root: string): Promise<void> {
  await mkdir(join(root, '.ai-novel', 'blueprints', 'chapters'), { recursive: true })
  await mkdir(join(root, 'chapters'), { recursive: true })
  await writeFile(join(root, '.ai-novel', 'project.json'), `${JSON.stringify({
    formatVersion: 1,
    kind: 'harness-novel-project',
    projectId: '123e4567-e89b-42d3-a456-426614174000',
    title: '潮汐来信',
    language: 'zh-CN',
    genre: '奇幻悬疑',
    plannedChapters: 12,
    targetWordsPerChapter: 3000,
    creativeStrategy: 'consistency-first',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
  }, null, 2)}\n`, 'utf8')
}

afterEach(() => {
  linkHook.mode = 'disabled'
  linkHook.root = ''
})

describe('explicit V1 migration publication races', () => {
  it('rejects source drift that occurs after the source snapshot is archived', async () => {
    const { migrateV1NovelProject, previewV1NovelMigration } = await import('../src/novel-migration.ts')
    const root = await import('./test-workspace.ts').then(module => module.makeTestWorkspace('v1-race-drift-'))
    await createMinimalV1Project(root)
    const preview = await previewV1NovelMigration(root, signal)
    linkHook.mode = 'drift-source'
    linkHook.root = root

    await expect(migrateV1NovelProject(root, workspaceId, preview.fingerprint, signal)).rejects.toMatchObject({
      code: 'STALE_REVISION',
    })
    await expect(access(join(root, '.ai-novel', 'novel.db'))).rejects.toThrow()
  })

  it('preserves the published database when post-publication verification fails', async () => {
    const { migrateV1NovelProject, previewV1NovelMigration } = await import('../src/novel-migration.ts')
    const root = await import('./test-workspace.ts').then(module => module.makeTestWorkspace('v1-race-published-'))
    await createMinimalV1Project(root)
    const preview = await previewV1NovelMigration(root, signal)
    linkHook.mode = 'corrupt-published-database'

    await expect(migrateV1NovelProject(root, workspaceId, preview.fingerprint, signal)).rejects.toThrow()
    await expect(access(join(root, '.ai-novel', 'novel.db'))).resolves.toBeUndefined()
  })
})

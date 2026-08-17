import { access, mkdir, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { openNovelProject } from '../src/novel-project.ts'
import { NovelProjectError } from '../src/types.ts'
import type { NovelProject, Revision } from '../src/types.ts'
import { makeTestWorkspace, TEST_INITIALIZATION_IDENTITY } from './test-workspace.ts'

const signal = new AbortController().signal

async function initializedProject(): Promise<{ root: string; project: NovelProject }> {
  const root = await makeTestWorkspace('replace-')
  const project = openNovelProject(root)
  await project.apply({
    ...TEST_INITIALIZATION_IDENTITY,
    kind: 'initialize',
    title: '雾中灯塔',
    language: 'zh-CN',
    genre: '悬疑',
    plannedChapters: 12,
    targetWordsPerChapter: 3_000,
    creativeStrategy: 'consistency-first',
  }, signal)
  return { root, project }
}

describe('NovelProject single-asset replacement', () => {
  let root: string
  let project: NovelProject

  beforeEach(async () => {
    ({ root, project } = await initializedProject())
  })

  it('treats a missing non-manifest file as an empty asset', async () => {
    await expect(project.read({ kind: 'asset', target: { kind: 'characters' } }, signal)).resolves.toEqual({
      kind: 'asset',
      target: { kind: 'characters' },
      source: '.ai-novel/characters.json',
      revision: 'absent',
      text: '',
      bytes: 0,
      truncated: false,
      omitted: false,
    })
  })

  it('canonicalizes and atomically creates one structured asset', async () => {
    const replacement = JSON.stringify({ characters: [{
      id: 'lin-wan',
      name: '林晚',
      role: '主角',
      summary: '守塔人。',
      goal: '找出失踪船只的真相。',
      relationships: [],
      notes: '',
    }] })

    const receipt = await project.apply({
      kind: 'replace',
      target: { kind: 'characters' },
      baseRevision: 'absent',
      replacement,
      summary: '建立主角人物卡',
    }, signal)

    expect(receipt.target).toEqual({ kind: 'characters' })
    expect(receipt.oldRevision).toBe('absent')
    expect(receipt.newRevision).toMatch(/^[a-f0-9]{64}$/)
    const disk = await readFile(join(root, '.ai-novel', 'characters.json'), 'utf8')
    expect(disk).toBe(`${JSON.stringify(JSON.parse(replacement), null, 2)}\n`)
    const read = await project.read({ kind: 'asset', target: { kind: 'characters' } }, signal)
    expect(read).toMatchObject({ kind: 'asset', text: disk, revision: receipt.newRevision })
  })

  it('rejects a stale SHA-256 revision and accepts the current revision', async () => {
    const read = await project.read({ kind: 'asset', target: { kind: 'project' } }, signal)
    if (read.kind !== 'asset') throw new Error('expected one project asset')
    const replacement = JSON.stringify({
      ...JSON.parse(read.text) as Record<string, unknown>,
      title: '雾海灯塔',
      updatedAt: '2026-08-16T01:02:04.000Z',
    })

    await expect(project.apply({
      kind: 'replace',
      target: { kind: 'project' },
      baseRevision: 'a'.repeat(64) as Revision,
      replacement,
      summary: '使用过期 revision 更新标题',
    }, signal)).rejects.toMatchObject({ code: 'STALE_REVISION' })

    const receipt = await project.apply({
      kind: 'replace',
      target: { kind: 'project' },
      baseRevision: read.revision,
      replacement,
      summary: '更新项目标题',
    }, signal)

    expect(receipt.oldRevision).toBe(read.revision)
    await expect(project.read({ kind: 'asset', target: { kind: 'project' } }, signal)).resolves.toMatchObject({
      kind: 'asset',
      revision: receipt.newRevision,
      text: expect.stringContaining('"title": "雾海灯塔"'),
    })
  })

  it('uses the matching SHA-256 revision without requiring the model to echo long base text', async () => {
    const read = await project.read({ kind: 'asset', target: { kind: 'project' } }, signal)
    if (read.kind !== 'asset') throw new Error('expected one project asset')
    const replacement = JSON.stringify({
      ...JSON.parse(read.text) as Record<string, unknown>,
      title: '雾海问道',
      updatedAt: '2026-08-16T01:02:05.000Z',
    })

    const receipt = await project.apply({
      kind: 'replace', target: { kind: 'project' }, baseRevision: read.revision,
      replacement, summary: '更新项目标题',
    }, signal)

    expect(receipt.oldRevision).toBe(read.revision)
    await expect(project.read({ kind: 'asset', target: { kind: 'project' } }, signal)).resolves.toMatchObject({
      kind: 'asset', revision: receipt.newRevision, text: expect.stringContaining('"title": "雾海问道"'),
    })
  })

  it('rejects a project replacement that changes only hidden update metadata', async () => {
    const read = await project.read({ kind: 'asset', target: { kind: 'project' } }, signal)
    if (read.kind !== 'asset') throw new Error('expected one project asset')
    const replacement = JSON.stringify({
      ...JSON.parse(read.text) as Record<string, unknown>,
      updatedAt: '2026-08-16T01:02:04.000Z',
    })

    await expect(project.apply({
      kind: 'replace',
      target: { kind: 'project' },
      baseRevision: read.revision,
      replacement,
      summary: 'AI 生成项目设置',
    }, signal)).rejects.toMatchObject({
      code: 'INVALID_CONTENT',
      message: 'project settings replacement must change at least one visible field',
    })

    await expect(project.read({ kind: 'asset', target: { kind: 'project' } }, signal)).resolves.toMatchObject({
      revision: read.revision,
      text: read.text,
    })
  })

  it('fails closed when the revision is stale', async () => {
    const firstText = '# 第一章\n\n海雾吞没了灯塔。\n'
    const first = await project.apply({
      kind: 'replace',
      target: { kind: 'chapter-draft', chapter: 1 },
      baseRevision: 'absent',
      replacement: firstText,
      summary: '起草第一章',
    }, signal)

    await expect(project.apply({
      kind: 'replace',
      target: { kind: 'chapter-draft', chapter: 1 },
      baseRevision: 'absent',
      replacement: '覆盖内容',
      summary: '使用旧版本覆盖',
    }, signal)).rejects.toMatchObject({ code: 'STALE_REVISION' })

    const read = await project.read({ kind: 'asset', target: { kind: 'chapter-draft', chapter: 1 } }, signal)
    expect(read).toMatchObject({ text: firstText, revision: first.newRevision })
  })

  it('rejects stale input before creating a generated parent directory', async () => {
    const parent = join(root, '.ai-novel', 'blueprints')

    await expect(project.apply({
      kind: 'replace', target: { kind: 'chapter-blueprint', chapter: 1 },
      baseRevision: 'a'.repeat(64) as Revision,
      replacement: JSON.stringify({
        chapter: 1, title: '潮声', purpose: '建立冲突', beats: ['发现信号'],
        characterIds: [], continuityNotes: [], status: 'planned',
      }), summary: '使用过期版本建立蓝图',
    }, signal)).rejects.toMatchObject({ code: 'STALE_REVISION' })

    await expect(access(parent)).rejects.toThrow()
  })

  it('serializes structured assets in schema-defined key order', async () => {
    const replacement = JSON.stringify({
      endingGoal: '回到家园。', mainPlot: '追查信号。', world: '潮汐锁定星球。',
      themes: ['选择'], premise: '失联飞船收到未来求救。',
    })
    await project.apply({
      kind: 'replace', target: { kind: 'story-blueprint' }, baseRevision: 'absent',
      replacement, summary: '建立故事蓝图',
    }, signal)

    await expect(readFile(join(root, '.ai-novel', 'blueprints', 'story.json'), 'utf8')).resolves.toBe(
      `${JSON.stringify({
        premise: '失联飞船收到未来求救。', themes: ['选择'], world: '潮汐锁定星球。',
        mainPlot: '追查信号。', endingGoal: '回到家园。',
      }, null, 2)}\n`,
    )
  })

  it('rejects invalid schema, unsafe chapter ids, oversize writes, and cancellation', async () => {
    await expect(project.apply({
      kind: 'replace', target: { kind: 'characters' }, baseRevision: 'absent',
      replacement: '{"characters":[{"name":"missing fields"}]}', summary: '无效人物表',
    }, signal)).rejects.toMatchObject({ code: 'INVALID_CONTENT' })

    await expect(project.read(
      { kind: 'asset', target: { kind: 'chapter-draft', chapter: 0 } }, signal,
    )).rejects.toMatchObject({ code: 'PATH_REJECTED' })

    await expect(project.apply({
      kind: 'replace', target: { kind: 'chapter-draft', chapter: 1 },
      baseRevision: 'absent', replacement: 'x'.repeat(512 * 1024 + 1), summary: '超限',
    }, signal)).rejects.toMatchObject({ code: 'SIZE_LIMIT_EXCEEDED' })

    const cancelled = new AbortController()
    cancelled.abort()
    await expect(project.read(
      { kind: 'asset', target: { kind: 'project' } }, cancelled.signal,
    )).rejects.toBeInstanceOf(NovelProjectError)
  })

  it('requires a real 64-character revision rather than an arbitrary string', async () => {
    await expect(project.apply({
      kind: 'replace', target: { kind: 'chapter-draft', chapter: 1 },
      baseRevision: 'not-a-revision' as Revision, replacement: '正文', summary: '伪造 revision',
    }, signal)).rejects.toMatchObject({ code: 'INVALID_CONTENT' })
  })

  it('rejects a symlink in any generated asset path before touching its target', async () => {
    const outside = await makeTestWorkspace('outside-')
    const link = join(root, '.ai-novel', 'blueprints')
    await mkdir(outside, { recursive: true })
    await symlink(outside, link, 'junction')

    await expect(project.apply({
      kind: 'replace', target: { kind: 'chapter-blueprint', chapter: 1 },
      baseRevision: 'absent',
      replacement: JSON.stringify({
        chapter: 1, title: '潮声', purpose: '建立冲突', beats: ['发现信号'],
        characterIds: [], continuityNotes: [], status: 'planned',
      }), summary: '建立第一章蓝图',
    }, signal)).rejects.toMatchObject({ code: 'PATH_REJECTED' })

    await expect(access(join(outside, 'chapters'))).rejects.toThrow()
  })
})

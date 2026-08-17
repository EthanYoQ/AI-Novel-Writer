import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openNovelProject } from '../src/novel-project.ts'
import { makeTestWorkspace, TEST_INITIALIZATION_IDENTITY } from './test-workspace.ts'

const signal = new AbortController().signal

async function initialize(root: string): Promise<void> {
  await openNovelProject(root).apply({
    ...TEST_INITIALIZATION_IDENTITY,
    kind: 'initialize', title: '群星归途', language: 'zh-CN', genre: '科幻',
    plannedChapters: 8, targetWordsPerChapter: 2_500, creativeStrategy: 'deep-planning',
  }, signal)
}

describe('NovelProject bounded reads', () => {
  it('returns a deterministic chapter working set with explicit budget omissions', async () => {
    const root = await makeTestWorkspace('working-set-')
    await initialize(root)
    const writer = openNovelProject(root)
    await writer.apply({
      kind: 'replace', target: { kind: 'story-blueprint' }, baseRevision: 'absent',
      replacement: JSON.stringify({
        premise: '失联飞船在返航时收到来自未来的求救。', themes: ['选择', '记忆'],
        world: '近未来太阳系。', mainPlot: '船员追查信号来源。', endingGoal: '决定是否改变历史。',
      }), summary: '建立故事蓝图',
    }, signal)
    await writer.apply({
      kind: 'replace', target: { kind: 'chapter-blueprint', chapter: 1 }, baseRevision: 'absent',
      replacement: JSON.stringify({
        chapter: 1, title: '回声', purpose: '发现未来信号', beats: ['接收信号', '识别自己的声音'],
        characterIds: [], continuityNotes: ['飞船时钟慢七秒'], status: 'planned',
      }), summary: '建立第一章蓝图',
    }, signal)
    await writer.apply({
      kind: 'replace', target: { kind: 'chapter-draft', chapter: 1 }, baseRevision: 'absent',
      replacement: '# 回声\n\n求救信号来自七小时后的飞船。\n', summary: '起草第一章',
    }, signal)

    const full = await writer.read({ kind: 'working-set', chapter: 1 }, signal)
    expect(full.kind).toBe('working-set')
    if (full.kind !== 'working-set') throw new Error('expected a working set')
    expect(full.assets.map(asset => asset.source)).toEqual([
      '.ai-novel/project.json',
      '.ai-novel/characters.json',
      '.ai-novel/blueprints/story.json',
      '.ai-novel/blueprints/chapters/0001.json',
      'chapters/0001.md',
    ])
    expect(full.truncated).toBe(false)

    const bounded = await openNovelProject(root, { workingSetBytes: 120 }).read(
      { kind: 'working-set', chapter: 1 }, signal,
    )
    expect(bounded).toMatchObject({ kind: 'working-set', bytes: 120, truncated: true })
    if (bounded.kind !== 'working-set') throw new Error('expected a working set')
    expect(bounded.omittedSources.length).toBeGreaterThan(0)
    expect(bounded.assets[0]).toMatchObject({ source: '.ai-novel/project.json', truncated: true })
  })

  it('queries only recognized core assets with a deterministic result cap', async () => {
    const root = await makeTestWorkspace('query-')
    await initialize(root)
    const project = openNovelProject(root)
    await project.apply({
      kind: 'replace', target: { kind: 'chapter-draft', chapter: 1 }, baseRevision: 'absent',
      replacement: '灯塔第一次亮起。\n灯塔照见了归航船。\n', summary: '写入第一章',
    }, signal)
    await project.apply({
      kind: 'replace', target: { kind: 'chapter-draft', chapter: 2 }, baseRevision: 'absent',
      replacement: '第二座灯塔没有影子。\n', summary: '写入第二章',
    }, signal)
    await mkdir(join(root, '.vela'), { recursive: true })
    await writeFile(join(root, '.vela', 'secret.md'), '灯塔不应被查询')

    const result = await project.read({ kind: 'query', text: '灯塔', limit: 2 }, signal)
    expect(result.kind).toBe('query')
    if (result.kind !== 'query') throw new Error('expected query result')
    expect(result.matches).toHaveLength(2)
    expect(result.matches.every(match => match.source === 'chapters/0001.md')).toBe(true)
    expect(result.matches.every(match => /^[a-f0-9]{64}$/.test(match.revision))).toBe(true)
    expect(result.truncated).toBe(true)
  })

  it('never recognizes a legacy .vela folder as a Harness novel project', async () => {
    const root = await makeTestWorkspace('legacy-')
    await mkdir(join(root, '.vela'), { recursive: true })
    await writeFile(join(root, '.vela', 'project.json'), '{}')
    await expect(openNovelProject(root).read(
      { kind: 'asset', target: { kind: 'project' } }, signal,
    )).rejects.toMatchObject({ code: 'NOT_INITIALIZED' })
  })

  it('marks a shortened query excerpt and the containing result as truncated', async () => {
    const root = await makeTestWorkspace('query-excerpt-')
    await initialize(root)
    const project = openNovelProject(root)
    await project.apply({
      kind: 'replace', target: { kind: 'chapter-draft', chapter: 1 }, baseRevision: 'absent',
      replacement: `灯塔${'很远'.repeat(160)}\n`, summary: '写入长行',
    }, signal)

    const result = await project.read({ kind: 'query', text: '灯塔' }, signal)
    expect(result.kind).toBe('query')
    if (result.kind !== 'query') throw new Error('expected query result')
    expect(result.matches[0]).toMatchObject({ source: 'chapters/0001.md', truncated: true })
    expect(result.truncated).toBe(true)
  })

  it('rejects a domain query cap above the protocol maximum', async () => {
    const root = await makeTestWorkspace('query-limit-')
    expect(() => openNovelProject(root, { queryMatches: 21 }))
      .toThrow(expect.objectContaining({ code: 'INVALID_CONTENT' }))
  })

  it('validates structured assets again when reading authoritative disk state', async () => {
    const root = await makeTestWorkspace('read-schema-')
    await initialize(root)
    await writeFile(join(root, '.ai-novel', 'characters.json'), '{"characters":[{"name":"字段缺失"}]}\n')

    await expect(openNovelProject(root).read(
      { kind: 'asset', target: { kind: 'characters' } }, signal,
    )).rejects.toMatchObject({ code: 'INVALID_CONTENT' })
  })
})

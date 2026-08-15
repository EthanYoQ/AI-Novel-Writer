import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openNovelProject } from '../src/novel-project.ts'
import { makeTestWorkspace, TEST_INITIALIZATION_IDENTITY } from './test-workspace.ts'

describe('NovelProject initialization', () => {
  it('creates only the manifest and reads the same revision after reopening', async () => {
    const root = await makeTestWorkspace('initialize-')
    const signal = new AbortController().signal
    const project = openNovelProject(root)

    const receipt = await project.apply({
      ...TEST_INITIALIZATION_IDENTITY,
      kind: 'initialize',
      title: '雾中灯塔',
      language: 'zh-CN',
      genre: '悬疑',
      plannedChapters: 12,
      targetWordsPerChapter: 3_000,
      creativeStrategy: 'consistency-first',
    }, signal)

    expect(receipt.target).toEqual({ kind: 'project' })
    expect(receipt.oldRevision).toBe('absent')
    expect(receipt.newRevision).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt.bytes).toBeGreaterThan(0)
    await expect(access(join(root, '.ai-novel', 'characters.json'))).rejects.toThrow()

    const first = await project.read({ kind: 'asset', target: { kind: 'project' } }, signal)
    const reopened = await openNovelProject(root).read(
      { kind: 'asset', target: { kind: 'project' } },
      signal,
    )

    expect(first.kind).toBe('asset')
    if (first.kind !== 'asset') throw new Error('expected an asset result')
    expect(first.revision).toBe(receipt.newRevision)
    expect(reopened).toEqual(first)
    expect(first.text).toContain('"kind": "harness-novel-project"')
    expect(first.text).toContain('"creativeStrategy": "consistency-first"')
  })

  it('rejects a second initialization without changing the manifest', async () => {
    const root = await makeTestWorkspace('duplicate-')
    const project = openNovelProject(root)
    const request = {
      ...TEST_INITIALIZATION_IDENTITY,
      kind: 'initialize' as const,
      title: '雾中灯塔',
      language: 'zh-CN',
      genre: '悬疑',
      plannedChapters: 12,
      targetWordsPerChapter: 3_000,
      creativeStrategy: 'consistency-first' as const,
    }
    await project.apply(request, new AbortController().signal)
    const filename = join(root, '.ai-novel', 'project.json')
    const before = await readFile(filename, 'utf8')

    await expect(project.apply(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'ALREADY_INITIALIZED',
    })
    await expect(readFile(filename, 'utf8')).resolves.toBe(before)
  })

  it('rejects an unsupported manifest version', async () => {
    const root = await makeTestWorkspace('version-')
    const signal = new AbortController().signal
    const project = openNovelProject(root)
    await project.apply({
      ...TEST_INITIALIZATION_IDENTITY,
      kind: 'initialize', title: '雾中灯塔', language: 'zh-CN', genre: '悬疑',
      plannedChapters: 12, targetWordsPerChapter: 3_000, creativeStrategy: 'auto',
    }, signal)
    const filename = join(root, '.ai-novel', 'project.json')
    const manifest = JSON.parse(await readFile(filename, 'utf8')) as Record<string, unknown>
    manifest.formatVersion = 2
    await writeFile(filename, `${JSON.stringify(manifest, null, 2)}\n`)

    await expect(project.read(
      { kind: 'asset', target: { kind: 'project' } }, signal,
    )).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' })
  })

  it('enforces the asset byte limit before creating the manifest', async () => {
    const root = await makeTestWorkspace('initialize-size-')
    const project = openNovelProject(root, { assetBytes: 200 })

    await expect(project.apply({
      ...TEST_INITIALIZATION_IDENTITY,
      kind: 'initialize', title: '潮'.repeat(200), language: 'zh-CN', genre: '奇幻',
      plannedChapters: 6, targetWordsPerChapter: 2_000, creativeStrategy: 'auto',
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'SIZE_LIMIT_EXCEEDED' })
    await expect(access(join(root, '.ai-novel', 'project.json'))).rejects.toThrow()
  })

  it.each([
    { createdAt: 'now', updatedAt: 'now' },
    { createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:01.000Z' },
  ])('rejects invalid initialization timestamps before creating the manifest', async timestamps => {
    const root = await makeTestWorkspace('initialize-time-')

    await expect(openNovelProject(root).apply({
      ...TEST_INITIALIZATION_IDENTITY,
      ...timestamps,
      kind: 'initialize', title: '雾中灯塔', language: 'zh-CN', genre: '悬疑',
      plannedChapters: 12, targetWordsPerChapter: 3_000, creativeStrategy: 'auto',
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_CONTENT' })
    await expect(access(join(root, '.ai-novel', 'project.json'))).rejects.toThrow()
  })
})

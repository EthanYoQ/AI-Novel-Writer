import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type AtomicWrite = typeof import('@deepseek-ai/dsh-atomic-write').writeFileAtomic

const atomic = vi.hoisted(() => ({
  actual: undefined as AtomicWrite | undefined,
  write: vi.fn<AtomicWrite>(),
}))

vi.mock('@deepseek-ai/dsh-atomic-write', async importOriginal => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  atomic.actual = actual.writeFileAtomic
  return { ...actual, writeFileAtomic: atomic.write }
})

import { openNovelProject } from '../src/novel-project.ts'
import { makeTestWorkspace, TEST_INITIALIZATION_IDENTITY } from './test-workspace.ts'

const initialize = {
  ...TEST_INITIALIZATION_IDENTITY,
  kind: 'initialize' as const,
  title: '潮汐信',
  language: 'zh-CN',
  genre: '奇幻',
  plannedChapters: 6,
  targetWordsPerChapter: 2_000,
  creativeStrategy: 'auto' as const,
}

describe('NovelProject commit semantics', () => {
  beforeEach(() => {
    if (atomic.actual === undefined) throw new Error('atomic write module was not initialized')
    atomic.write.mockReset()
    atomic.write.mockImplementation(atomic.actual)
  })

  it('maps an atomic write failure to WRITE_FAILED without creating the asset', async () => {
    const root = await makeTestWorkspace('write-failure-')
    const project = openNovelProject(root)
    atomic.write.mockRejectedValueOnce(new Error('simulated disk failure'))

    await expect(project.apply(initialize, new AbortController().signal)).rejects.toMatchObject({
      code: 'WRITE_FAILED',
    })
    await expect(access(join(root, '.ai-novel', 'project.json'))).rejects.toThrow()
  })

  it('returns a receipt when cancellation arrives after the atomic commit point', async () => {
    const root = await makeTestWorkspace('commit-cancel-')
    const project = openNovelProject(root)
    await project.apply(initialize, new AbortController().signal)
    const controller = new AbortController()
    atomic.write.mockImplementationOnce(async (...args) => {
      controller.abort()
      if (atomic.actual === undefined) throw new Error('atomic write module was not initialized')
      return atomic.actual(...args)
    })

    const receipt = await project.apply({
      kind: 'replace', target: { kind: 'chapter-draft', chapter: 1 },
      baseRevision: 'absent', replacement: '# 第一章\n', summary: '写入第一章',
    }, controller.signal)

    await expect(readFile(join(root, 'chapters', '0001.md'), 'utf8')).resolves.toBe('# 第一章\n')
    expect(receipt).toMatchObject({
      target: { kind: 'chapter-draft', chapter: 1 },
      oldRevision: 'absent',
      bytes: Buffer.byteLength('# 第一章\n', 'utf8'),
    })
  })
})

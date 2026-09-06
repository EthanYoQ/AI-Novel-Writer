import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { exportNovel } from '../export-service'
import { ipc } from '../ipc-client'
import { setActiveProjectSessionContext } from '../../shared/project-session-context'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { useLocaleStore } from '../../stores/locale-store'

vi.mock('../ipc-client', () => ({
  ipc: {
    invoke: vi.fn(),
    invokeWithProjectSession: vi.fn(),
  },
}))

const addLog = vi.fn()
const projectPath = 'C:/novels/project-a'
const projectSession: ProjectSessionContext = {
  projectId: 'project-a',
  leaseId: 'lease-a',
  projectPath,
}
const projectSnapshot = {
  id: projectSession.projectId,
  sessionLease: projectSession.leaseId,
  path: projectPath,
  name: 'Project A',
  novelConfig: {
    genre: 'fantasy',
    targetAudience: 'general',
    writingLanguage: 'zh-CN' as const,
  },
}
const authority = (draftId: number) => ({
  finalizationId: `finalization-${draftId}`,
  contentHash: 'a'.repeat(64),
})

vi.mock('../../stores/project-store', () => ({
  useProjectStore: {
    getState: vi.fn(() => ({ currentProject: projectSnapshot })),
  },
}))

vi.mock('../../stores/workflow-store', () => ({
  useWorkflowStore: {
    getState: vi.fn(() => ({ addLog })),
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  useLocaleStore.setState({ locale: 'zh-CN' })
  setActiveProjectSessionContext(projectSession)
  vi.mocked(ipc.invoke).mockResolvedValue({ success: true } as never)
  vi.mocked(ipc.invokeWithProjectSession).mockImplementation((async (_session: ProjectSessionContext, channel: string) => {
    if (channel === 'db:draft-export-snapshot') return [{
      draftId: 1,
      chapterNumber: 1,
      version: 1,
      title: '',
      content: 'Final chapter',
      finalizationId: 'finalization-1',
      contentHash: 'a'.repeat(64),
    }] as never
    if (channel === 'db:draft-export-authority-current') return true as never
    if (channel === 'db:project-core-get') return { synopsis: 'Synopsis' } as never
    throw new Error(`Unexpected channel: ${channel}`)
  }) as never)
})

afterEach(() => {
  setActiveProjectSessionContext(null)
})

describe('exportNovel project session ownership', () => {
  it('freezes the English UI locale for export logs while the request is running', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    let resolveSnapshot: ((value: unknown[]) => void) | undefined
    vi.mocked(ipc.invokeWithProjectSession).mockImplementationOnce(() =>
      new Promise((resolve) => { resolveSnapshot = resolve }),
    )

    const exporting = exportNovel(
      { format: 'merged-md', grantId: 'export-grant' },
      projectSnapshot,
      projectSession,
    )
    await vi.waitFor(() => expect(resolveSnapshot).toBeTypeOf('function'))
    useLocaleStore.setState({ locale: 'zh-CN' })
    resolveSnapshot!([])

    await expect(exporting).resolves.toEqual({
      success: false,
      error: 'There are no finalized chapters to export.',
    })
    expect(addLog).toHaveBeenCalledWith('info', 'Starting export (Merged Markdown)...', 'en-US')
  })

  it('uses an English action and fallback when an export write fails', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    vi.mocked(ipc.invoke).mockResolvedValueOnce({ success: false } as never)

    await expect(exportNovel(
      { format: 'txt', grantId: 'export-grant' },
      projectSnapshot,
      projectSession,
    )).resolves.toEqual({
      success: false,
      error: 'Error: Failed to write the exported file.',
    })
    expect(addLog).toHaveBeenLastCalledWith(
      'error',
      'Export failed: Error: Failed to write the exported file.',
      'en-US',
    )
  })

  it.each(['merged-md', 'txt'] as const)(
    '%s 导出写入结果未知时提示可能已写入且禁止盲目重试',
    async (format) => {
      vi.mocked(ipc.invoke).mockResolvedValueOnce({
        success: false,
        commitState: 'unknown',
        error: '外部文件授权操作失败。',
      } as never)

      await expect(exportNovel(
        { format, grantId: 'export-grant' },
        projectSnapshot,
        projectSession,
      )).resolves.toEqual({
        success: false,
        error: expect.stringMatching(/Project A\.(?:md|txt).*可能已写入.*不要盲目重试/u),
      })
    },
  )

  it('reads project data through the frozen session and writes only through the granted directory capability', async () => {
    await expect(exportNovel(
      { format: 'merged-md', grantId: 'export-grant', includeOutline: true },
      projectSnapshot,
      projectSession,
    )).resolves.toEqual({ success: true, path: 'Project A.md' })

    expect(ipc.invoke).toHaveBeenCalledWith(
      'fs:grant-write-file',
      'export-grant',
      'Project A.md',
      expect.stringContaining('Final chapter'),
    )
    expect(ipc.invokeWithProjectSession).toHaveBeenNthCalledWith(
      1,
      projectSession,
      'db:draft-export-snapshot',
      projectPath,
    )
  })

  it('passes mixed UTF-8 finalized prose to the export capability without transcoding', async () => {
    const finalizedContent = 'The sign reads “夜航 Café” — déjà vu.'
    vi.mocked(ipc.invokeWithProjectSession).mockImplementation((async (_session: ProjectSessionContext, channel: string) => {
      if (channel === 'db:draft-export-snapshot') return [{
        draftId: 1, chapterNumber: 1, version: 1, title: '', content: finalizedContent,
        finalizationId: 'finalization-1', contentHash: 'a'.repeat(64),
      }] as never
      if (channel === 'db:draft-export-authority-current') return true as never
      throw new Error(`Unexpected channel: ${channel}`)
    }) as never)

    await expect(exportNovel(
      { format: 'merged-md', grantId: 'export-grant' },
      projectSnapshot,
      projectSession,
    )).resolves.toEqual({ success: true, path: 'Project A.md' })

    const writeCall = vi.mocked(ipc.invoke).mock.calls.find(([channel]) => channel === 'fs:grant-write-file')
    const exportedContent = writeCall?.[3]
    expect(exportedContent).toEqual(expect.stringContaining(finalizedContent))
    const exportedFact = (exportedContent as string).slice(
      (exportedContent as string).indexOf(finalizedContent),
      (exportedContent as string).indexOf(finalizedContent) + finalizedContent.length,
    )
    expect(new TextEncoder().encode(exportedFact)).toEqual(new TextEncoder().encode(finalizedContent))
  })

  it.each([
    {
      writingLanguage: 'zh-CN' as const,
      title: '夜航',
      expectedHeading: '第1章 夜航',
    },
    {
      writingLanguage: 'en-US' as const,
      title: 'Night Flight',
      expectedHeading: 'Chapter 1 Night Flight',
    },
  ])('includes localized chapter titles in TXT exports for $writingLanguage projects', async ({
    writingLanguage,
    title,
    expectedHeading,
  }) => {
    vi.mocked(ipc.invokeWithProjectSession).mockImplementation((async (_session: ProjectSessionContext, channel: string) => {
      if (channel === 'db:draft-export-snapshot') return [{
        draftId: 1, chapterNumber: 1, version: 1, title, content: 'Final chapter',
        finalizationId: 'finalization-1', contentHash: 'a'.repeat(64),
      }] as never
      if (channel === 'db:draft-export-authority-current') return true as never
      throw new Error(`Unexpected channel: ${channel}`)
    }) as never)

    await expect(exportNovel(
      { format: 'txt', grantId: 'export-grant' },
      {
        ...projectSnapshot,
        novelConfig: { ...projectSnapshot.novelConfig, writingLanguage },
      },
      projectSession,
    )).resolves.toEqual({ success: true, path: 'Project A.txt' })

    expect(ipc.invoke).toHaveBeenCalledWith(
      'fs:grant-write-file',
      'export-grant',
      'Project A.txt',
      expect.stringContaining(`${expectedHeading}\n\nFinal chapter`),
    )
  })

  it.each([
    { format: 'merged-md' as const, writingLanguage: 'zh-CN' as const, title: '起航', expectedHeading: '# 第1章 起航' },
    { format: 'split-md' as const, writingLanguage: 'zh-CN' as const, title: '起航', expectedHeading: '# 第1章 起航' },
    { format: 'merged-md' as const, writingLanguage: 'en-US' as const, title: 'Departure', expectedHeading: '# Chapter 1 Departure' },
    { format: 'split-md' as const, writingLanguage: 'en-US' as const, title: 'Departure', expectedHeading: '# Chapter 1 Departure' },
  ])('$format 导出显示 $writingLanguage 项目的权威章标题', async ({
    format,
    writingLanguage,
    title,
    expectedHeading,
  }) => {
    vi.mocked(ipc.invokeWithProjectSession).mockResolvedValueOnce([{
      draftId: 1,
      chapterNumber: 1,
      version: 1,
      title,
      content: '风从海上来',
      ...authority(1),
    }] as never)

    await expect(exportNovel(
      { format, grantId: 'export-grant' },
      {
        ...projectSnapshot,
        novelConfig: { ...projectSnapshot.novelConfig, writingLanguage },
      },
      projectSession,
    )).resolves.toMatchObject({ success: true })

    const writeCall = vi.mocked(ipc.invoke).mock.calls.find(([channel]) => channel === 'fs:grant-write-file')
    expect(writeCall?.[3]).toEqual(expect.stringContaining(`${expectedHeading}\n\n风从海上来`))
  })

  it.each(['merged-md', 'split-md'] as const)(
    '%s 导出只保留一个与权威标题等价的首行 ATX 标题',
    async (format) => {
      const expectedHeading = '# 第1章 起航'
      vi.mocked(ipc.invokeWithProjectSession).mockResolvedValueOnce([{
        draftId: 1,
        chapterNumber: 1,
        version: 1,
        title: '起航',
        content: `${expectedHeading}\n\n风从海上来`,
        ...authority(1),
      }] as never)

      await expect(exportNovel(
        { format, grantId: 'export-grant' },
        projectSnapshot,
        projectSession,
      )).resolves.toMatchObject({ success: true })

      const writeCall = vi.mocked(ipc.invoke).mock.calls.find(([channel]) => channel === 'fs:grant-write-file')
      expect((writeCall?.[3] as string).match(/# 第1章 起航/gu)).toHaveLength(1)
      expect(writeCall?.[3]).toEqual(expect.stringContaining(`${expectedHeading}\n\n风从海上来`))
    },
  )

  it.each(['merged-md', 'split-md'] as const)(
    '%s 导出在作者首标题不等价时同时保留权威标题和作者正文',
    async (format) => {
      vi.mocked(ipc.invokeWithProjectSession).mockResolvedValueOnce([{
        draftId: 1,
        chapterNumber: 1,
        version: 1,
        title: '起航',
        content: '# 船员日志\n\n风从海上来',
        ...authority(1),
      }] as never)

      await expect(exportNovel(
        { format, grantId: 'export-grant' },
        projectSnapshot,
        projectSession,
      )).resolves.toMatchObject({ success: true })

      const writeCall = vi.mocked(ipc.invoke).mock.calls.find(([channel]) => channel === 'fs:grant-write-file')
      expect(writeCall?.[3]).toEqual(expect.stringContaining('# 第1章 起航\n\n# 船员日志\n\n风从海上来'))
    },
  )

  it('stops after the directory-selection export becomes stale on a same-path reopen', async () => {
    let resolveSnapshot: ((value: unknown[]) => void) | undefined
    vi.mocked(ipc.invokeWithProjectSession).mockImplementationOnce(() =>
      new Promise((resolve) => { resolveSnapshot = resolve }),
    )

    const exporting = exportNovel(
      { format: 'merged-md', grantId: 'export-grant' },
      projectSnapshot,
      projectSession,
    )
    await vi.waitFor(() => expect(resolveSnapshot).toBeTypeOf('function'))
    setActiveProjectSessionContext({ ...projectSession, leaseId: 'lease-b' })
    resolveSnapshot!([])

    await expect(exporting).resolves.toEqual({
      success: false,
      error: expect.stringContaining('项目会话'),
    })
    expect(ipc.invokeWithProjectSession).toHaveBeenCalledOnce()
    expect(ipc.invoke).not.toHaveBeenCalled()
  })

  it.each(['merged-md', 'split-md', 'txt'] as const)(
    'exports sparse finalized snapshots in %s without consulting blueprints',
    async (format) => {
      vi.mocked(ipc.invokeWithProjectSession).mockResolvedValueOnce([
        { draftId: 7, chapterNumber: 1, version: 2, title: '起航', content: '第一章权威定稿', ...authority(7) },
        { draftId: 19, chapterNumber: 4, version: 3, title: '归来', content: '第四章权威定稿', ...authority(19) },
      ] as never)

      await expect(exportNovel(
        { format, grantId: 'export-grant' },
        projectSnapshot,
        projectSession,
      )).resolves.toMatchObject({ success: true })

      expect(ipc.invokeWithProjectSession).toHaveBeenCalledWith(
        projectSession,
        'db:draft-export-snapshot',
        projectPath,
      )
      expect(ipc.invokeWithProjectSession).not.toHaveBeenCalledWith(
        projectSession,
        'db:blueprint-get-all',
        expect.anything(),
      )
      const writes = vi.mocked(ipc.invoke).mock.calls.filter(([channel]) => channel === 'fs:grant-write-file')
      expect(writes.map(call => call[3]).join('\n')).toContain('第一章权威定稿')
      expect(writes.map(call => call[3]).join('\n')).toContain('第四章权威定稿')
    },
  )

  it.each([
    { label: 'missing body', row: { draftId: 7, chapterNumber: 1, version: 2, title: '', content: '', ...authority(7) } },
    { label: 'wrong draft id', row: { draftId: 0, chapterNumber: 1, version: 2, title: '', content: '正文', ...authority(7) } },
    { label: 'wrong version', row: { draftId: 7, chapterNumber: 1, version: 0, title: '', content: '正文', ...authority(7) } },
  ])('rejects an invalid authoritative snapshot: $label', async ({ row }) => {
    vi.mocked(ipc.invokeWithProjectSession).mockResolvedValueOnce([row] as never)

    await expect(exportNovel(
      { format: 'merged-md', grantId: 'export-grant' },
      projectSnapshot,
      projectSession,
    )).resolves.toMatchObject({ success: false })
    expect(ipc.invoke).not.toHaveBeenCalled()
  })

  it('requires reconfirmation when finalized authority changes before a single-file write', async () => {
    vi.mocked(ipc.invokeWithProjectSession)
      .mockResolvedValueOnce([{
        draftId: 1, chapterNumber: 1, version: 1, title: '', content: 'one',
        ...authority(1),
      }] as never)
      .mockResolvedValueOnce(false as never)

    await expect(exportNovel(
      { format: 'merged-md', grantId: 'export-grant' },
      projectSnapshot,
      projectSession,
    )).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/定稿章节已变化.*重新确认导出/u),
    })
    expect(ipc.invoke).not.toHaveBeenCalledWith(
      'fs:grant-write-file',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
  })

  it('reports confirmed split files when finalized authority changes before the next write', async () => {
    vi.mocked(ipc.invokeWithProjectSession)
      .mockResolvedValueOnce([
        { draftId: 1, chapterNumber: 1, version: 1, title: '', content: 'one', ...authority(1) },
        { draftId: 2, chapterNumber: 2, version: 1, title: '', content: 'two', ...authority(2) },
      ] as never)
      .mockResolvedValueOnce(true as never)
      .mockResolvedValueOnce(true as never)
      .mockResolvedValueOnce(false as never)

    await expect(exportNovel(
      { format: 'split-md', grantId: 'export-grant' },
      projectSnapshot,
      projectSession,
    )).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/重新确认导出.*已确认写入: Project A\/chapter_1\.md.*可能已写入: 无/u),
    })
    expect(vi.mocked(ipc.invoke).mock.calls
      .filter(([channel]) => channel === 'fs:grant-write-file')
      .map(call => call[2]))
      .toEqual(['Project A/chapter_1.md'])
  })

  it('reports files already written when a split export fails partway through', async () => {
    vi.mocked(ipc.invokeWithProjectSession).mockResolvedValueOnce([
      { draftId: 1, chapterNumber: 1, version: 1, title: '', content: 'one', ...authority(1) },
      { draftId: 2, chapterNumber: 2, version: 1, title: '', content: 'two', ...authority(2) },
      { draftId: 3, chapterNumber: 3, version: 1, title: '', content: 'three', ...authority(3) },
    ] as never)
    vi.mocked(ipc.invoke)
      .mockResolvedValueOnce({ success: true } as never)
      .mockResolvedValueOnce({ success: true } as never)
      .mockResolvedValueOnce({ success: false, commitState: 'not_committed', error: 'disk full' } as never)

    await expect(exportNovel(
      { format: 'split-md', grantId: 'export-grant' },
      projectSnapshot,
      projectSession,
    )).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/已确认写入: Project A\/chapter_1\.md.*可能已写入: 无.*确定写入失败: Project A\/chapter_2\.md/u),
    })

    const writePaths = vi.mocked(ipc.invoke).mock.calls
      .filter(([channel]) => channel === 'fs:grant-write-file')
      .map(call => call[2])
    expect(writePaths).toEqual([
      'Project A/chapter_1.md',
      'Project A/chapter_2.md',
    ])
  })

  it('分章导出把未知回执与已确认写入、确定失败分开，并停止后续写入', async () => {
    vi.mocked(ipc.invokeWithProjectSession).mockResolvedValueOnce([
      { draftId: 1, chapterNumber: 1, version: 1, title: '', content: 'one', ...authority(1) },
      { draftId: 2, chapterNumber: 2, version: 1, title: '', content: 'two', ...authority(2) },
      { draftId: 3, chapterNumber: 3, version: 1, title: '', content: 'three', ...authority(3) },
    ] as never)
    vi.mocked(ipc.invoke)
      .mockResolvedValueOnce({ success: true } as never)
      .mockResolvedValueOnce({ success: true } as never)
      .mockResolvedValueOnce({
        success: false,
        commitState: 'unknown',
        error: '外部文件授权操作失败。',
      } as never)

    await expect(exportNovel(
      { format: 'split-md', grantId: 'export-grant' },
      projectSnapshot,
      projectSession,
    )).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/已确认写入: Project A\/chapter_1\.md.*可能已写入: Project A\/chapter_2\.md.*确定写入失败: 无.*不要盲目重试/u),
    })

    expect(vi.mocked(ipc.invoke).mock.calls
      .filter(([channel]) => channel === 'fs:grant-write-file')
      .map(call => call[2]))
      .toEqual(['Project A/chapter_1.md', 'Project A/chapter_2.md'])
  })

  it('reports the committed split file when the project session expires after its write receipt', async () => {
    vi.mocked(ipc.invokeWithProjectSession).mockResolvedValueOnce([
      { draftId: 1, chapterNumber: 1, version: 1, title: '', content: 'one', ...authority(1) },
      { draftId: 2, chapterNumber: 2, version: 1, title: '', content: 'two', ...authority(2) },
    ] as never)
    vi.mocked(ipc.invoke)
      .mockResolvedValueOnce({ success: true } as never)
      .mockImplementationOnce(async () => {
        setActiveProjectSessionContext({ ...projectSession, leaseId: 'lease-b' })
        return { success: true } as never
      })

    await expect(exportNovel(
      { format: 'split-md', grantId: 'export-grant' },
      projectSnapshot,
      projectSession,
    )).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/项目会话.*chapter_1\.md/u),
    })

    expect(vi.mocked(ipc.invoke).mock.calls
      .filter(([channel]) => channel === 'fs:grant-write-file')).toHaveLength(1)
  })

  it('keeps the partial-write list when a later split write fails as the session expires', async () => {
    vi.mocked(ipc.invokeWithProjectSession).mockResolvedValueOnce([
      { draftId: 1, chapterNumber: 1, version: 1, title: '', content: 'one', ...authority(1) },
      { draftId: 2, chapterNumber: 2, version: 1, title: '', content: 'two', ...authority(2) },
    ] as never)
    vi.mocked(ipc.invoke)
      .mockResolvedValueOnce({ success: true } as never)
      .mockResolvedValueOnce({ success: true } as never)
      .mockImplementationOnce(async () => {
        setActiveProjectSessionContext({ ...projectSession, leaseId: 'lease-b' })
        return { success: false, error: 'disk full' } as never
      })

    await expect(exportNovel(
      { format: 'split-md', grantId: 'export-grant' },
      projectSnapshot,
      projectSession,
    )).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/项目会话.*chapter_1\.md/u),
    })
  })
})

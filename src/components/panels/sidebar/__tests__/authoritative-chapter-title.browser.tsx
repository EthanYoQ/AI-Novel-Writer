import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DraftMeta } from '../../../../stores/draft-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import DraftBoxGroup from '../DraftBoxGroup'
import ManuscriptGroup from '../ManuscriptGroup'
import { clearChapterTitleCache } from '../manuscript-title-cache'

const PROJECT_PATH = 'C:\\novels\\authoritative-titles'
const OTHER_PROJECT_PATH = 'C:\\novels\\other-authoritative-titles'
const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface TestVelaApi {
  invoke: ReturnType<typeof vi.fn>
  on: () => () => void
  once: () => void
  send: () => void
  setZoomLevel: () => void
  setZoomFactor: () => void
  getZoomLevel: () => number
}

let root: Root | undefined
let container: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn>

function draft(
  id: number,
  chapterNumber: number,
  chapterTitle?: string,
  status: DraftMeta['status'] = 'finalized',
): DraftMeta {
  return {
    id,
    chapterNumber,
    ...(chapterTitle ? { chapterTitle } : {}),
    version: 1,
    status,
    source: 'write',
    wordCount: 12,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
    fileName: 'draft_v1.md',
    filePath: `vela://draft/${id}`,
  }
}

function switchProject(path: string, id: string): void {
  useProjectStore.setState({
    currentProject: {
      id,
      sessionLease: `${id}-lease`,
      name: id,
      path,
      novelConfig: {},
    } as never,
  })
}

beforeEach(() => {
  clearChapterTitleCache()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({
    currentProject: {
      id: 'authoritative-titles',
      sessionLease: 'authoritative-titles-lease',
      name: 'Authoritative titles',
      path: PROJECT_PATH,
      novelConfig: {},
    } as never,
  })
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'db:blueprint-get') {
      if (args[0] === 1 && args[1] === PROJECT_PATH) return { chapterNumber: 1, title: '旧码头的红钟' }
      if (args[0] === 3) return { chapterNumber: 3, title: '计划中的第三章' }
      if (args[0] === 4) return { chapterNumber: 4, title: '旧项目第四章' }
      return null
    }
    if (channel === 'chapter:list-incomplete-deletions') return { success: true, operations: [] }
    if (channel === 'db:draft-get-full') {
      return { id: args[0], content: '# 不应读取的正文首行' }
    }
    throw new Error(`Unexpected IPC channel: ${channel}`)
  })
  ;(window as unknown as { velaAPI: TestVelaApi }).velaAPI = {
    invoke,
    on: () => () => {},
    once: () => {},
    send: () => {},
    setZoomLevel: () => {},
    setZoomFactor: () => {},
    getZoomLevel: () => 0,
  }
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  clearChapterTitleCache()
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  delete (window as unknown as { velaAPI?: TestVelaApi }).velaAPI
})

describe('authoritative finalized chapter titles', () => {
  it('never leaks a blueprint fallback when the next project has no chapter title', async () => {
    const projectADraft = draft(1, 1)
    const projectBDraft = draft(1, 1)
    const manuscriptFile = {
      path: 'vela://manuscript/1',
      name: 'chapter_1.md',
      isDir: false,
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <>
          <DraftBoxGroup draftsByChapter={{ 1: [projectADraft] }} />
          <ManuscriptGroup files={[manuscriptFile]} projectPath={PROJECT_PATH} />
        </>,
      )
    })
    await vi.waitFor(() => {
      expect(container?.textContent?.match(/旧码头的红钟/gu)).toHaveLength(2)
    })

    await act(async () => {
      switchProject(OTHER_PROJECT_PATH, 'other-blueprint-fallback')
      root?.render(
        <>
          <DraftBoxGroup draftsByChapter={{ 1: [projectBDraft] }} />
          <ManuscriptGroup files={[manuscriptFile]} projectPath={OTHER_PROJECT_PATH} />
        </>,
      )
    })

    expect(container?.textContent).not.toContain('旧码头的红钟')
    expect(container?.textContent?.match(/第1章/gu)).toHaveLength(2)
  })

  it('never leaks cached chapter titles when switching projects with the same draft identity', async () => {
    const projectADraft = draft(1, 1, '项目甲标题')
    const projectBDraft = draft(1, 1, '项目乙标题')
    const manuscriptFile = (chapterTitle: string) => ({
      path: 'vela://manuscript/1',
      name: 'chapter_1.md',
      isDir: false,
      chapterTitle,
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <>
          <DraftBoxGroup draftsByChapter={{ 1: [projectADraft] }} />
          <ManuscriptGroup files={[manuscriptFile('项目甲标题')]} projectPath={PROJECT_PATH} />
        </>,
      )
    })
    await vi.waitFor(() => {
      expect(container?.textContent?.match(/项目甲标题/gu)).toHaveLength(2)
    })

    await act(async () => {
      switchProject(OTHER_PROJECT_PATH, 'other-authoritative-titles')
      root?.render(
        <>
          <DraftBoxGroup draftsByChapter={{ 1: [projectBDraft] }} />
          <ManuscriptGroup files={[manuscriptFile('项目乙标题')]} projectPath={OTHER_PROJECT_PATH} />
        </>,
      )
    })

    expect(container?.textContent).not.toContain('项目甲标题')
    expect(container?.textContent?.match(/项目乙标题/gu)).toHaveLength(2)
  })

  it('keeps author outbox titles in both finalized surfaces despite missing or conflicting reference blueprints', async () => {
    const chapterOne = draft(1, 1, '蓝镜初亮')
    const chapterTwo = draft(2, 2, '潮线回声')
    const manuscriptFiles = [chapterOne, chapterTwo].map(item => ({
      path: `vela://manuscript/${item.id}`,
      name: `chapter_${item.chapterNumber}.md`,
      isDir: false,
      chapterTitle: item.chapterTitle,
    }))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <>
          <DraftBoxGroup draftsByChapter={{ 1: [chapterOne], 2: [chapterTwo] }} />
          <ManuscriptGroup files={manuscriptFiles} projectPath={PROJECT_PATH} />
        </>,
      )
    })

    await vi.waitFor(() => {
      expect(container?.textContent?.match(/蓝镜初亮/gu)).toHaveLength(2)
      expect(container?.textContent?.match(/潮线回声/gu)).toHaveLength(2)
      expect(container?.textContent).not.toContain('旧码头的红钟')
      expect(container?.textContent).not.toContain('不应读取的正文首行')
    })
  })

  it('keeps blueprint fallback for unfinalized drafts and finalized drafts without an outbox title', async () => {
    const pendingDraft = draft(3, 3, undefined, 'draft')
    const legacyFinalized = draft(4, 4)
    const manuscriptFiles = [{
      path: 'vela://manuscript/4',
      name: 'chapter_4.md',
      isDir: false,
    }]
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <>
          <DraftBoxGroup draftsByChapter={{ 3: [pendingDraft], 4: [legacyFinalized] }} />
          <ManuscriptGroup files={manuscriptFiles} projectPath={PROJECT_PATH} />
        </>,
      )
    })

    await vi.waitFor(() => {
      expect(container?.textContent).toContain('第3章 计划中的第三章')
      expect(container?.textContent).toContain('第4章 旧项目第四章')
    })
  })
})

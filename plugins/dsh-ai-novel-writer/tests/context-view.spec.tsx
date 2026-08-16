// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconListPenOutline16: () => <span aria-hidden="true" />,
}))
import { renderToStaticMarkup } from 'react-dom/server'
import {
  installDrawerKeyboardScope,
  installWorkbenchLayoutReservation,
  NovelWorkbenchBody,
} from '../src/client/context-view.tsx'
import type { NovelWorkbenchState } from '../src/client/workbench-store.ts'
import { installNovelContextStyle, novelContextCss } from '../src/client/setup-style.ts'
import type { NovelProjectId } from '../src/types.ts'

const PROJECT_ID = '123e4567-e89b-42d3-a456-426614174000' as NovelProjectId

const states: readonly [NovelWorkbenchState, string][] = [
  [{ status: 'loading', open: true }, '正在读取小说工作台'],
  [{ status: 'empty', open: true }, '当前没有属于已注册工作区的会话'],
  [{
    status: 'not-initialized', open: true,
    initialization: {
      phase: 'editing',
      draft: {
        title: '', language: 'zh-CN', genre: '', plannedChapters: '20',
        targetWordsPerChapter: '3000', creativeStrategy: 'auto',
      },
    },
  }, '初始化小说项目'],
  [{ status: 'error', open: true, message: 'invalid project' }, 'invalid project'],
  [{ status: 'disconnected', open: true }, 'Harness 连接已断开'],
]

function renderBody(state: NovelWorkbenchState): string {
  return renderToStaticMarkup(<NovelWorkbenchBody
    state={state}
    refresh={vi.fn()}
    selectChapter={vi.fn()}
    updateInitialization={vi.fn()}
    updateInitializationGenerationBrief={vi.fn()}
    generateInitialization={vi.fn()}
    previewInitialization={vi.fn()}
    submitInitialization={vi.fn()}
    openAsset={vi.fn()}
    backToAssets={vi.fn()}
    updateProjectSettings={vi.fn()}
    updateStoryBlueprint={vi.fn()}
    updateChapterBlueprint={vi.fn()}
    updateChapterDraft={vi.fn()}
    updateAssetSummary={vi.fn()}
    updateAssetGenerationBrief={vi.fn()}
    generateAsset={vi.fn()}
    previewAssetChange={vi.fn()}
    submitAssetChange={vi.fn()}
    discardAssetChanges={vi.fn()}
    reloadStaleAsset={vi.fn()}
    setCharacterSearch={vi.fn()}
    selectCharacter={vi.fn()}
    createCharacter={vi.fn()}
    updateCharacter={vi.fn()}
    deleteCharacter={vi.fn()}
  />)
}

describe('novel workbench context summary', () => {
  it('contains Tab focus and restores the invoking control on disposal', () => {
    const returnFocus = document.createElement('button')
    const drawer = document.createElement('div')
    const first = document.createElement('button')
    const last = document.createElement('input')
    drawer.append(first, last)
    document.body.append(returnFocus, drawer)

    const dispose = installDrawerKeyboardScope(drawer, first, returnFocus, vi.fn())
    expect(document.activeElement).toBe(first)
    last.focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(first)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(last)

    dispose()
    expect(document.activeElement).toBe(returnFocus)
    drawer.remove()
    returnFocus.remove()
  })

  it.each(states)('renders state %# with an explicit recovery path', (state, text) => {
    const html = renderBody(state)
    expect(html).toContain(text)
    expect(html).not.toContain('批准修改')
  })

  it('renders identity, strategy, progress, plans, characters, and a bounded prose preview', () => {
    const state: NovelWorkbenchState = {
      status: 'ready', open: true,
      project: {
        projectId: PROJECT_ID, title: '潮汐来信', language: 'zh-CN', genre: '悬疑',
        plannedChapters: 3, targetWordsPerChapter: 2_000, creativeStrategy: 'consistency-first',
        updatedAt: '2026-08-16T00:00:00.000Z',
      },
      progress: { selectedChapter: 1, plannedChapters: 3, status: 'drafted', draftPresent: true, draftBytes: 48 },
      characters: [{ id: 'lin-xia', name: '林夏', role: '灯塔管理员', summary: '守护退潮后的信匣。' }],
      storyBlueprint: {
        premise: '退潮后出现来自明日的信。', themes: ['选择'], world: '海岛灯塔',
        mainPlot: '林夏追查信件来源。', endingGoal: '决定是否改变弟弟的命运。',
      },
      chapterBlueprint: {
        chapter: 1, title: '退潮', purpose: '发现第一封未来信', beats: ['灯灭', '取信'],
        characterIds: ['lin-xia'], continuityNotes: ['午夜退潮'], status: 'drafted',
      },
      draft: { revision: 'absent', preview: '# 退潮\n\n第一封信。', bytes: 48, truncated: true },
      omittedSources: ['.ai-novel/characters.json'],
      screen: { kind: 'root' },
    }

    const html = renderBody(state)
    for (const text of ['潮汐来信', 'consistency-first', '第 1 / 3 章', '林夏', '退潮后出现', '第一封信', '预览已截断']) {
      expect(html).toContain(text)
    }
    expect(html).toContain('type="number"')
    expect(html).toContain(PROJECT_ID)
    expect(html).not.toContain('path=')
  })

  it('defines a side drawer on wide screens and a full-width narrow layout', () => {
    const overlay = document.createElement('div')
    overlay.className = 'aiNovelContextOverlay'
    const drawer = document.createElement('div')
    drawer.className = 'aiNovelContextDrawer'
    overlay.appendChild(drawer)
    document.body.appendChild(overlay)
    const dispose = installNovelContextStyle(document)
    try {
      expect(novelContextCss).toContain('pointer-events:none')
      expect(getComputedStyle(overlay).zIndex).toBe('2147483001')
      expect(getComputedStyle(drawer).boxSizing).toBe('border-box')
      expect(getComputedStyle(drawer).width).toBe('440px')
      expect(getComputedStyle(drawer).minWidth).toBe('400px')
      expect(novelContextCss).toMatch(/@media\(max-width:899px\)/)
      expect(novelContextCss).toContain('width:100%')
    } finally {
      dispose()
      overlay.remove()
    }
  })

  it('reserves and restores a wide-screen conversation column through the native overlay owner', () => {
    const frame = document.createElement('div')
    const overlay = document.createElement('div')
    const drawer = document.createElement('div')
    overlay.dataset.shellOverlay = ''
    overlay.appendChild(drawer)
    frame.appendChild(overlay)
    document.body.appendChild(frame)

    const release = installWorkbenchLayoutReservation(drawer)
    expect(frame.classList.contains('aiNovelWorkbenchFrameOpen')).toBe(true)
    const disposeStyle = installNovelContextStyle(document)
    expect(getComputedStyle(frame).paddingRight).toBe('440px')
    release()
    expect(frame.classList.contains('aiNovelWorkbenchFrameOpen')).toBe(false)

    disposeStyle()
    frame.remove()
  })
})

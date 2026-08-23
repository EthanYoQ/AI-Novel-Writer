// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronLeftOutline14: () => <span aria-hidden="true" />,
  IconListPenOutline16: () => <span aria-hidden="true" />,
}))
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  installDrawerKeyboardScope,
  installWorkbenchLayoutReservation,
  NovelPluginStatusCard,
  NovelWorkbenchBody,
  NovelWorkbenchOverlay,
  NovelWorkbenchTrigger,
} from '../src/client/context-view.tsx'
import type { NovelWorkbenchState } from '../src/client/workbench-store.ts'
import { NovelWorkbenchRouteController } from '../src/client/workbench-v2-observer.ts'
import { EMPTY_V2_AUTHORING } from '../src/client/v2-authoring.ts'
import type { NovelV2WorkbenchState } from '../src/client/workbench-v2.ts'
import { installNovelContextStyle, novelContextCss } from '../src/client/setup-style.ts'
import type { NovelProjectId } from '../src/types.ts'

const PROJECT_ID = '123e4567-e89b-42d3-a456-426614174000' as NovelProjectId

const domTestCleanups: Array<() => void | Promise<void>> = []
let previousReactActEnvironment: boolean | undefined
let domTestActEnvironmentSet = false

function trackDomTestCleanup(cleanup: () => void | Promise<void>): void {
  domTestCleanups.push(cleanup)
}

function mountDomTestRoot(): { readonly container: HTMLDivElement; readonly root: ReturnType<typeof createRoot> } {
  if (!domTestActEnvironmentSet) {
    previousReactActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    domTestActEnvironmentSet = true
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  trackDomTestCleanup(async () => {
    await act(async () => { root.unmount() })
    container.remove()
  })
  return { container, root }
}

afterEach(async () => {
  while (domTestCleanups.length > 0) await domTestCleanups.pop()!()
  if (domTestActEnvironmentSet) {
    if (previousReactActEnvironment === undefined) delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
    else (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousReactActEnvironment
  }
  previousReactActEnvironment = undefined
  domTestActEnvironmentSet = false
})

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
  it('opens the first-use setup drawer from either entry for an unknown Preset without opening either workbench', async () => {
    const route = new NovelWorkbenchRouteController()
    trackDomTestCleanup(() => { route.dispose() })
    const listeners = new Set<() => void>()
    let v1State: NovelWorkbenchState = { status: 'empty', open: false }
    const v1Listeners = new Set<() => void>()
    const v1 = {
      getSnapshot: () => v1State,
      subscribe: (listener: () => void) => { v1Listeners.add(listener); return () => { v1Listeners.delete(listener) } },
      open: vi.fn(async () => {
        v1State = { ...v1State, open: true }
        for (const listener of v1Listeners) listener()
      }),
      close: vi.fn(() => {
        v1State = { ...v1State, open: false }
        for (const listener of v1Listeners) listener()
      }),
      inspect: vi.fn(), refresh: vi.fn(),
    }
    let v2State = {
      status: 'idle' as const, open: false, workspace: undefined,
      proposals: { phase: 'ready' as const, items: [], selectedId: undefined, selectedChange: undefined, message: undefined },
      tasks: { items: [], selectedId: undefined, message: undefined },
      chapters: { selected: undefined, items: [] },
      editor: { target: undefined, phase: 'idle' as const, current: '', next: undefined, aggregateRevision: undefined, draft: '', message: undefined },
    }
    const v2 = {
      getSnapshot: () => v2State,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      open: vi.fn(async () => {
        v2State = { ...v2State, open: true }
        for (const listener of listeners) listener()
      }),
      close: vi.fn(), refresh: vi.fn(), selectProposal: vi.fn(), openProposalChange: vi.fn(), applySelectedProposal: vi.fn(),
      retryProposalItem: vi.fn(), discardProposalItem: vi.fn(), regenerateProposalItem: vi.fn(),
      selectTask: vi.fn(), selectChapter: vi.fn(), openAsset: vi.fn(), updateEditor: vi.fn(), discardEditor: vi.fn(),
    }
    const setupListeners = new Set<() => void>()
    let setupState = { status: 'not-installed' as const, open: false }
    const notifySetup = (): void => { for (const listener of setupListeners) listener() }
    const setup = {
      getSnapshot: () => setupState,
      subscribe: (listener: () => void) => { setupListeners.add(listener); return () => { setupListeners.delete(listener) } },
      open: vi.fn(() => {
        setupState = { ...setupState, open: true }
        notifySetup()
      }),
      close: vi.fn(() => {
        setupState = { ...setupState, open: false }
        notifySetup()
      }),
      load: vi.fn(async () => {}), install: vi.fn(async () => {}),
    }
    const standard = {
      useSessions: (() => undefined) as never,
      useWorkspaces: (() => undefined) as never,
    }
    const acquireSidebarRail = vi.fn(() => vi.fn())
    route.setPreset('other-preset')
    const { container, root } = mountDomTestRoot()
    container.dataset.shellOverlay = ''
    await act(async () => {
      root.render(<>
        <NovelWorkbenchTrigger wide {...standard} workbenchController={v1 as never} v2WorkbenchController={v2 as never} workbenchRoute={route} setupController={setup as never} acquireSidebarRail={acquireSidebarRail} />
        <NovelPluginStatusCard workbenchController={v1 as never} v2WorkbenchController={v2 as never} workbenchRoute={route} setupController={setup as never} acquireSidebarRail={acquireSidebarRail} />
        <NovelWorkbenchOverlay {...standard} workbenchController={v1 as never} v2WorkbenchController={v2 as never} workbenchRoute={route} setupController={setup as never} acquireSidebarRail={acquireSidebarRail} />
      </>)
    })

    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!
    const cardOpen = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === '打开小说工作台')!
    expect(route.getSnapshot()).toBe('none')
    expect(trigger.disabled).toBe(false)
    expect(cardOpen.disabled).toBe(false)
    expect(container.textContent).toContain('未绑定小说会话')
    setup.open.mockClear()
    setup.close.mockClear()
    setup.load.mockClear()
    trigger.focus()
    await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(setup.open).toHaveBeenCalledOnce()
    expect(setup.load).toHaveBeenCalledOnce()
    expect(v1.open).not.toHaveBeenCalled()
    expect(v2.open).not.toHaveBeenCalled()
    const firstUseDrawer = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const firstUseGuide = firstUseDrawer.querySelector<HTMLElement>('[aria-labelledby="ai-novel-first-use-title"]')!
    expect(firstUseDrawer.getAttribute('aria-modal')).toBe('false')
    expect(firstUseDrawer.textContent).toContain('首次使用小说工作台')
    expect(firstUseGuide.textContent).toContain('刷新当前页面')
    expect(firstUseDrawer.textContent).toContain('AI 小说作家 V2')
    expect(firstUseDrawer.textContent).toContain('安装 AI 小说作家 Preset')
    expect(document.activeElement).toBe(firstUseDrawer.querySelector('[aria-label="关闭小说工作台"]'))
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(setup.close).toHaveBeenCalledOnce()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    setup.open.mockClear()
    setup.close.mockClear()
    setup.load.mockClear()
    cardOpen.focus()
    await act(async () => { cardOpen.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(setup.open).toHaveBeenCalledOnce()
    expect(setup.load).toHaveBeenCalledOnce()
    expect(v1.open).not.toHaveBeenCalled()
    expect(v2.open).not.toHaveBeenCalled()
    const cardDrawer = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    expect(cardDrawer.textContent).toContain('首次使用小说工作台')
    await act(async () => {
      cardDrawer.querySelector<HTMLButtonElement>('[aria-label="关闭小说工作台"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(setup.close).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(cardOpen)

    await act(async () => { route.setPreset('ai-novel-writer') })
    expect(trigger.disabled).toBe(false)
    await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(v1.open).toHaveBeenCalledOnce()
    expect(v2.open).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    await act(async () => { v1.close() })

    await act(async () => { route.setPreset('ai-novel-writer-v2') })
    await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(v2.open).toHaveBeenCalledOnce()
    expect(v1.open).toHaveBeenCalledOnce()
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()

  })

  it('keeps real V2 overlay focus on the author-first overview while proposal review or stage selection changes', async () => {
    const route = new NovelWorkbenchRouteController()
    trackDomTestCleanup(() => { route.dispose() })
    route.setPreset('ai-novel-writer-v2')
    const releases: Array<ReturnType<typeof vi.fn>> = []
    const acquireSidebarRail = vi.fn(() => {
      const release = vi.fn()
      releases.push(release)
      return release
    })
    const v2Listeners = new Set<() => void>()
    const notifyV2 = (): void => { for (const listener of v2Listeners) listener() }
    let v2State: NovelV2WorkbenchState = {
      status: 'ready', open: true,
      workspace: {
        workspaceId: 'workspace-1' as never,
        project: { title: '潮汐来信', genre: '悬疑' } as never,
        globalRevision: 7, readOnly: true,
        snapshot: {
          architecture: { premise: '', characterGraph: '', world: '', plotOutline: '', styleConstraints: '', referenceWorks: [] },
        } as never,
      },
      proposals: {
        phase: 'ready', selectedId: 'proposal-1', selectedChange: undefined, message: undefined,
        items: [{
          proposalId: 'proposal-1', status: 'pending', items: [
            {
              itemId: 'proposal-1-item-1', itemOrder: 1, status: 'pending', attemptCount: 0,
              change: { changeSetId: 'project-change-1', aggregate: { kind: 'project' }, baseGlobalRevision: 7 },
            },
            {
              itemId: 'proposal-1-item-2', itemOrder: 2, status: 'pending', attemptCount: 0,
              change: { changeSetId: 'project-change-2', aggregate: { kind: 'project' }, baseGlobalRevision: 7 },
            },
          ],
        }] as never,
      },
      tasks: { items: [], selectedId: undefined, message: undefined },
      chapters: { selected: undefined, items: [] },
      authoring: EMPTY_V2_AUTHORING,
    }
    const v2 = {
      getSnapshot: () => v2State,
      subscribe: (listener: () => void) => { v2Listeners.add(listener); return () => { v2Listeners.delete(listener) } },
      open: vi.fn(), close: vi.fn(), refresh: vi.fn(), selectProposal: vi.fn(), applySelectedProposal: vi.fn(),
      retryProposalItem: vi.fn(), discardProposalItem: vi.fn(), regenerateProposalItem: vi.fn(),
      selectTask: vi.fn(), selectChapter: vi.fn(),
      openProposalChange: vi.fn((index: number) => {
        v2State = {
          ...v2State,
          proposals: { ...v2State.proposals, selectedChange: index },
        }
        notifyV2()
      }),
      prepareAuthoring: vi.fn((stage: 'architecture') => {
        v2State = { ...v2State, authoring: { ...EMPTY_V2_AUTHORING, stage, phase: 'editing' } }
        notifyV2()
      }),
      authoringBlocker: vi.fn(() => undefined), updateDraftBrief: vi.fn(), startDraft: vi.fn(), updateAuthoringInput: vi.fn(),
      reproposeManualDraft: vi.fn(), selectArtifact: vi.fn(), selectFinal: vi.fn(), updateInitialization: vi.fn(), initializeWorkspace: vi.fn(),
    }
    let v1State: NovelWorkbenchState = { status: 'empty', open: false }
    const v1 = { getSnapshot: () => v1State, subscribe: () => () => {}, close: vi.fn() }
    const setupState = { status: 'installed' as const, open: false, changed: false }
    const setup = { getSnapshot: () => setupState, subscribe: () => () => {}, close: vi.fn() }
    const standard = { useSessions: (() => undefined) as never, useWorkspaces: (() => undefined) as never }
    const { container, root } = mountDomTestRoot()
    container.dataset.shellOverlay = ''
    await act(async () => {
      root.render(<NovelWorkbenchOverlay
        {...standard} workbenchController={v1 as never} v2WorkbenchController={v2 as never}
        workbenchRoute={route} setupController={setup as never} acquireSidebarRail={acquireSidebarRail}
      />)
    })

    const drawer = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    expect(acquireSidebarRail).toHaveBeenCalledOnce()
    expect(releases).toHaveLength(1)
    expect(drawer.querySelectorAll('[data-ai-novel-screen-focus]')).toHaveLength(1)
    expect(drawer.querySelector('[data-ai-novel-screen-focus]')?.textContent).toBe('项目概览')
    const proposalChanges = [...drawer.querySelectorAll<HTMLButtonElement>('button')]
      .filter(button => button.textContent?.includes('查看 项目设置建议'))
    const proposalChange = proposalChanges[0]!
    proposalChange.focus()
    await act(async () => { proposalChange.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const proposalFocus = drawer.querySelector<HTMLElement>('[data-ai-novel-screen-focus]')!
    expect(drawer.querySelectorAll('[data-ai-novel-screen-focus]')).toHaveLength(1)
    expect(proposalFocus.textContent).toBe('项目概览')
    expect(document.activeElement).toBe(proposalFocus)

    const sameAggregateProposalChange = proposalChanges[1]!
    sameAggregateProposalChange.focus()
    await act(async () => { sameAggregateProposalChange.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const sameAggregateFocus = drawer.querySelector<HTMLElement>('[data-ai-novel-screen-focus]')!
    expect(sameAggregateFocus.textContent).toBe('项目概览')
    expect(document.activeElement).toBe(sameAggregateFocus)

    const architecture = [...drawer.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === '故事架构')!
    await act(async () => { architecture.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const assetFocus = drawer.querySelector<HTMLElement>('[data-ai-novel-screen-focus]')!
    expect(drawer.querySelectorAll('[data-ai-novel-screen-focus]')).toHaveLength(1)
    expect(assetFocus.textContent).toBe('项目概览')
    expect(document.activeElement).toBe(assetFocus)
    expect(acquireSidebarRail).toHaveBeenCalledOnce()

    await act(async () => {
      v2State = { ...v2State, open: false }
      notifyV2()
    })
    expect(releases[0]).toHaveBeenCalledOnce()
    await act(async () => {
      v1State = { status: 'empty', open: true }
      route.setPreset('ai-novel-writer')
    })
    expect(acquireSidebarRail).toHaveBeenCalledOnce()
    await act(async () => {
      v1State = { status: 'empty', open: false }
      route.setPreset('ai-novel-writer-v2')
      v2State = { ...v2State, open: true }
      notifyV2()
    })
    expect(acquireSidebarRail).toHaveBeenCalledTimes(2)
    const reopenedDrawer = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const reopenedFocus = reopenedDrawer.querySelector<HTMLElement>('[data-ai-novel-screen-focus]')!
    expect(reopenedFocus.textContent).toBe('项目概览')
    expect(document.activeElement).toBe(reopenedFocus)

    await act(async () => {
      v2State = {
        status: 'error', open: true, workspace: undefined,
        proposals: { phase: 'failed', items: [], selectedId: undefined, selectedChange: undefined, message: '连接已断开' },
        tasks: { items: [], selectedId: undefined, message: undefined },
        chapters: { selected: undefined, items: [] },
        authoring: EMPTY_V2_AUTHORING,
        message: 'Harness 连接已断开',
      }
      notifyV2()
    })
    const errorDrawer = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const errorFocus = errorDrawer.querySelector<HTMLElement>('[data-ai-novel-screen-focus]')!
    expect(errorFocus.textContent).toBe('工作台读取失败')
    expect(document.activeElement).toBe(errorFocus)
    expect(acquireSidebarRail).toHaveBeenCalledTimes(2)

    await act(async () => { root.unmount() })
    expect(releases[1]).toHaveBeenCalledOnce()

  })

  it('forwards pending-draft replacement eligibility to the V2 controller', async () => {
    const route = new NovelWorkbenchRouteController()
    trackDomTestCleanup(() => { route.dispose() })
    route.setPreset('ai-novel-writer-v2')
    const listeners = new Set<() => void>()
    const v2State: NovelV2WorkbenchState = {
      status: 'ready', open: true,
      workspace: {
        workspaceId: 'workspace-pending-draft' as never,
        project: { title: '待审初稿', genre: '悬疑', plannedChapters: 1 } as never,
        globalRevision: 1, readOnly: false,
        snapshot: {
          architecture: { premise: '一个待审核初稿', characterGraph: '', world: '', plotOutline: '第一章', styleConstraints: '', referenceWorks: [] },
          chapters: [{ chapter: 1, title: '第一章', purpose: '测试替换', plotBeats: [], characters: [], keyEvents: [], suspense: '', status: 'drafting' }],
          artifacts: [], chapterFinals: [],
        } as never,
      },
      proposals: {
        phase: 'ready', selectedId: 'other-proposal', selectedChange: undefined, message: undefined,
        items: [{
          proposalId: 'pending-draft-proposal', status: 'pending', items: [{
            itemId: 'pending-draft-item', itemOrder: 1, status: 'pending', attemptCount: 0,
            change: { kind: 'artifact/draft', artifactId: 'pending-draft', chapter: 1, content: 'AI 初稿', summary: '待审核初稿' },
          }],
        }] as never,
      },
      tasks: { items: [], selectedId: undefined, message: undefined },
      chapters: { selected: 1, items: [{ chapter: 1, title: '第一章', purpose: '测试替换', plotBeats: [], characters: [], keyEvents: [], suspense: '', status: 'drafting' }] as never },
      authoring: {
        ...EMPTY_V2_AUTHORING,
        stage: 'draft', chapter: 1, phase: 'editing', input: { kind: 'prose', content: 'AI 初稿' },
        pendingProposalItem: { proposalId: 'pending-draft-proposal', itemId: 'pending-draft-item' },
      },
    }
    const authoringBlocker = vi.fn((_stage: string, _chapter: number | undefined, replacingPendingDraft?: boolean) => {
      return replacingPendingDraft === true ? undefined : '已有待审核建议'
    })
    const v2 = {
      getSnapshot: () => v2State,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      open: vi.fn(), close: vi.fn(), refresh: vi.fn(), selectProposal: vi.fn(), openProposalChange: vi.fn(), applySelectedProposal: vi.fn(),
      retryProposalItem: vi.fn(), discardProposalItem: vi.fn(), regenerateProposalItem: vi.fn(),
      selectTask: vi.fn(), selectChapter: vi.fn(), prepareAuthoring: vi.fn(), authoringBlocker,
      updateDraftBrief: vi.fn(), startDraft: vi.fn(), updateAuthoringInput: vi.fn(), reproposeManualDraft: vi.fn(),
      selectArtifact: vi.fn(), selectFinal: vi.fn(), updateInitialization: vi.fn(), initializeWorkspace: vi.fn(),
    }
    const v1State: NovelWorkbenchState = { status: 'empty', open: false }
    const setupState = { status: 'installed' as const, open: false, changed: false }
    const v1 = { getSnapshot: () => v1State, subscribe: () => () => {}, close: vi.fn() }
    const setup = { getSnapshot: () => setupState, subscribe: () => () => {}, close: vi.fn() }
    const { container, root } = mountDomTestRoot()
    container.dataset.shellOverlay = ''
    await act(async () => {
      root.render(<NovelWorkbenchOverlay
        useSessions={(() => undefined) as never} useWorkspaces={(() => undefined) as never}
        workbenchController={v1 as never} v2WorkbenchController={v2 as never} workbenchRoute={route}
        setupController={setup as never} acquireSidebarRail={vi.fn(() => vi.fn())}
      />)
    })

    const replacement = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === '用人工修改替换待审核初稿')!
    expect(replacement.disabled).toBe(false)
    expect(authoringBlocker).toHaveBeenCalledWith('draft', 1, true)
  })

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
    expect(html).not.toContain(PROJECT_ID)
    expect(html).not.toContain('path=')
  })

  it('defines a focused V2 layout without borrowing Host sidebar state', () => {
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
      expect(novelContextCss).toContain('.aiNovelContextOverlayV2{left:386px}')
      expect(novelContextCss).toContain('.aiNovelContextOverlayV2{left:56px}')
      expect(novelContextCss).toContain('.aiNovelV2StageShell,.aiNovelV2AssetNav{grid-template-columns:1fr}')
      expect(novelContextCss).toContain('.aiNovelV2Review[data-ai-novel-proposal-dock]{align-self:stretch}')
      expect(novelContextCss).not.toContain('toggleSidebar')
      expect(novelContextCss).toMatch(/@media\(max-width:1023px\)/)
      expect(novelContextCss).toContain('width:100%')
      expect(novelContextCss).toContain('.aiNovelV2Workbench')
      expect(novelContextCss).toContain('.aiNovelV2Editor textarea{width:100%;min-height:360px')
      expect(novelContextCss).toMatch(/\.aiNovelV2CommandDiff pre,\.aiNovelV2Diff pre\{(?=[^}]*max-width:100%)(?=[^}]*max-height:240px)(?=[^}]*overflow:auto)(?=[^}]*white-space:pre-wrap)[^}]*\}/)
    } finally {
      dispose()
      overlay.remove()
    }
  })

  it('reserves and restores only the plugin drawer space through the native overlay owner', () => {
    const frame = document.createElement('div')
    const overlay = document.createElement('div')
    const drawer = document.createElement('div')
    overlay.dataset.shellOverlay = ''
    overlay.appendChild(drawer)
    frame.appendChild(overlay)
    document.body.appendChild(frame)

    const release = installWorkbenchLayoutReservation(drawer, true)
    expect(frame.classList.contains('aiNovelWorkbenchFrameOpen')).toBe(true)
    expect(frame.classList.contains('aiNovelWorkbenchFrameOpenV2')).toBe(true)
    const disposeStyle = installNovelContextStyle(document)
    expect(getComputedStyle(frame).paddingRight).toBe('440px')
    release()
    expect(frame.classList.contains('aiNovelWorkbenchFrameOpen')).toBe(false)
    expect(frame.classList.contains('aiNovelWorkbenchFrameOpenV2')).toBe(false)

    disposeStyle()
    frame.remove()
  })
})

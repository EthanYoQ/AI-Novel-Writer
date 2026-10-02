/**
 * 书脊栏目路由的契约测试。
 *
 * 这一层是「正文栏 = 统一标签容器」的中枢：点栏目要落到正确的页面，
 * 页面换人要让侧栏语境跟上，且同一个编辑器绝不能开出两个标签
 * （标签 id 一旦漂移，章节蓝图的后台草稿账本就会失联）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useProjectStore } from '../../../../stores/project-store'
import { goRail, railForTabType, syncRailForTab } from '../rail-routing'

/** 只为「有没有项目」这一项判定用的最小项目对象。 */
const OPEN_PROJECT = {
  id: 'rail-routing-project',
  path: 'C:\\novels\\rail-routing',
  sessionLease: 'rail-routing-lease',
  name: 'Rail routing',
} as never

function reset(): void {
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useLayoutStore.setState({
    sidebarView: 'project',
    activeRailItem: 'project',
    sidebarOpen: true,
    aiPanelOpen: true,
    focusMode: false,
  })
  // 这里讲的是「已经打开作品之后」的栏目行为；没打开作品的情形另有专门的用例。
  useProjectStore.setState({ currentProject: OPEN_PROJECT })
}

const tabIds = () => useEditorStore.getState().tabs.map((tab) => tab.id)
/**
 * 标签 id 会带上项目路径后缀（同一编辑器在不同作品里互不干扰），
 * 这里要验的契约是**前缀** —— id 前缀一旦漂移，章节蓝图的后台草稿账本就失联了。
 */
const tabBaseIds = () => tabIds().map((id) => id.split(':')[0])

describe('页面类型 → 栏目', () => {
  it('人物、知识库、设定集、伏笔、蓝图各归自己的栏目', () => {
    expect(railForTabType('character')).toBe('characters')
    expect(railForTabType('knowledge')).toBe('knowledge')
    expect(railForTabType('world-setting')).toBe('world')
    expect(railForTabType('narrative-thread')).toBe('plot-tree')
    expect(railForTabType('chapter-card')).toBe('blueprint')
  })

  it('故事架构（world-building）归目录，不许抢「设定」栏目', () => {
    // 先生：从目录点「故事架构」时侧栏必须留在目录。
    // 它原先映射到 'world'，于是侧栏被抢到设定栏目 —— 那就是当初那个 bug。
    expect(railForTabType('world-building')).toBe('project')
  })

  it('写作案卷（草稿 / 配置 / 审稿 / 版本 / 架构文件）都归目录', () => {
    for (const type of ['chapter', 'config', 'review-report', 'version-history', 'arch-file', 'outline'] as const) {
      expect(railForTabType(type)).toBe('project')
    }
  })
})

describe('切栏目', () => {
  beforeEach(reset)

  it('点书架：中央回到书架首页，焦点清空，但标签一个不少', () => {
    goRail('characters')
    expect(useEditorStore.getState().activeTabId).toMatch(/^character-editor/)

    goRail('home')

    expect(useEditorStore.getState().activeTabId).toBeNull()
    expect(useLayoutStore.getState().sidebarView).toBe('home')
    expect(tabBaseIds()).toEqual(['character-editor'])
  })

  it('点人物：打开人物档案并以标签承载，侧栏切到人物', () => {
    goRail('characters')

    const state = useEditorStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]).toMatchObject({ type: 'character' })
    expect(state.tabs[0].id).toMatch(/^character-editor/)
    expect(state.activeTabId).toMatch(/^character-editor/)
    expect(useLayoutStore.getState().sidebarView).toBe('characters')
    expect(useLayoutStore.getState().activeRailItem).toBe('characters')
  })

  it('重复进出同一栏目不会堆出第二个标签', () => {
    goRail('characters')
    goRail('project')
    goRail('characters')
    expect(useEditorStore.getState().tabs.filter((tab) => tab.type === 'character')).toHaveLength(1)
  })

  it('点目录：正文栏落在这部作品的小说配置上（先生：目录继承书架，是第二个位）', () => {
    useEditorStore.setState({
      tabs: [
        { id: 'character-editor', name: '人物档案', type: 'character' },
        { id: 'config', name: '小说配置', type: 'config' },
        { id: 'knowledge-editor', name: '知识库', type: 'knowledge' },
      ],
      activeTabId: 'knowledge-editor',
    })

    goRail('project')

    expect(useEditorStore.getState().activeTabId).toMatch(/^config/)
    expect(useLayoutStore.getState().activeRailItem).toBe('project')
  })

  it('目录没有配置标签时会补开一个小说配置，而不是留空态', () => {
    useEditorStore.setState({
      tabs: [{ id: 'knowledge-editor', name: '知识库', type: 'knowledge' }],
      activeTabId: 'knowledge-editor',
    })

    goRail('project')

    const state = useEditorStore.getState()
    expect(state.tabs.some((tab) => tab.type === 'config')).toBe(true)
    expect(state.activeTabId).toMatch(/^config/)
  })

  it('蓝图标签沿用 chapter-card-editor（它的后台草稿账本以此为键）', () => {
    goRail('blueprint')
    expect(tabBaseIds()).toEqual(['chapter-card-editor'])
  })

  it('伏笔沿用既有入口；「设定」开的是设定集，不再是故事架构', () => {
    goRail('plot-tree')
    expect(tabBaseIds()).toEqual(['narrative-thread-editor'])

    goRail('world')
    expect(tabBaseIds()).toContain('world-setting-editor')
    expect(useEditorStore.getState().tabs.at(-1)).toMatchObject({ type: 'world-setting' })
  })

  it('知识库成为标签而不是盖住正文区的子面板', () => {
    goRail('knowledge')
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ type: 'knowledge' })
    expect(useEditorStore.getState().tabs[0].id).toMatch(/^knowledge-editor/)
    expect(useEditorStore.getState().activeTabId).toMatch(/^knowledge-editor/)
  })

  it('还没打开作品时：点栏目只切侧栏，绝不打开任何页面', () => {
    useProjectStore.setState({ currentProject: null as never })

    goRail('knowledge')
    goRail('characters')
    goRail('blueprint')

    // 一个标签都不许留下 —— 否则用户之后打开作品时，这些页面会一齐冒到正文栏上
    expect(useEditorStore.getState().tabs).toHaveLength(0)
    expect(useEditorStore.getState().activeTabId).toBeNull()
    // 侧栏仍然跟着栏目走（显示该栏目的图标 + 请先打开项目）
    expect(useLayoutStore.getState().activeRailItem).toBe('blueprint')
    expect(useLayoutStore.getState().sidebarView).toBe('project')
  })
})

describe('中央页面换人后同步侧栏语境', () => {
  beforeEach(reset)

  it('跨栏目时跟过去，避免「高亮一个栏目、显示另一个页面」', () => {
    useEditorStore.setState({
      tabs: [{ id: 'character-editor', name: '人物档案', type: 'character' }],
      activeTabId: 'character-editor',
    })
    useLayoutStore.setState({ sidebarView: 'knowledge', activeRailItem: 'knowledge' })

    syncRailForTab('character-editor')

    expect(useLayoutStore.getState().sidebarView).toBe('characters')
    expect(useLayoutStore.getState().activeRailItem).toBe('characters')
  })

  it('同栏目内不动侧栏，点标签不会把侧栏内容抖掉', () => {
    useEditorStore.setState({
      tabs: [{ id: 'draft-1', name: '第 1 章', type: 'chapter' }],
      activeTabId: 'draft-1',
    })

    syncRailForTab('draft-1')

    expect(useLayoutStore.getState().sidebarView).toBe('project')
  })

  it('焦点为空或标签不存在时什么都不做', () => {
    useLayoutStore.setState({ sidebarView: 'knowledge', activeRailItem: 'knowledge' })
    syncRailForTab(null)
    syncRailForTab('missing-tab')
    expect(useLayoutStore.getState().sidebarView).toBe('knowledge')
  })
})

describe('沉浸写作与侧栏 / 助手互斥', () => {
  beforeEach(reset)

  it('进入时收起侧栏与助手，退出时把侧栏放回来', () => {
    useLayoutStore.getState().toggleFocusMode()
    expect(useLayoutStore.getState().focusMode).toBe(true)
    expect(useLayoutStore.getState().sidebarOpen).toBe(false)
    expect(useLayoutStore.getState().aiPanelOpen).toBe(false)

    useLayoutStore.getState().toggleFocusMode()
    expect(useLayoutStore.getState().focusMode).toBe(false)
    expect(useLayoutStore.getState().sidebarOpen).toBe(true)
  })

  it('沉浸态下显式打开侧栏会退出沉浸态，不会出现「点了没反应」', () => {
    useLayoutStore.getState().toggleFocusMode()
    useLayoutStore.getState().toggleSidebar()
    expect(useLayoutStore.getState().sidebarOpen).toBe(true)
    expect(useLayoutStore.getState().focusMode).toBe(false)
  })

  it('沉浸态下打开设置等其他入口也会退出沉浸态（切栏目同理）', () => {
    useLayoutStore.getState().toggleFocusMode()
    goRail('characters')
    expect(useLayoutStore.getState().focusMode).toBe(false)
    expect(useLayoutStore.getState().sidebarOpen).toBe(true)
  })
})

/**
 * 书脊栏目路由（v2）。
 *
 * demo 的中央纸面只有一条规则：
 *
 *     中央纸面 = activeTab 指向的页面（书架栏目除外）。
 *
 * 人物档案 / 关系图谱 / 世界词条 / 知识库 / 伏笔一律以 tab 承载，谁要显示就激活谁的
 * tab —— 不存在「盖在别人上面、绕过标签栏」的子面板。切栏目（demo 的 navGo）时把焦点
 * 带到该栏目的落点页，而不是让上一个栏目里打开过的页面赖着不走。
 *
 * 本文件只负责「栏目 ↔ 页面」的换算与跳转，不持有任何状态：
 * 侧栏内容与高亮仍由 layout-store.sidebarView / activeRailItem 决定，
 * 页面焦点仍由 editor-store.activeTabId 决定。
 */

import { useLayoutStore, type LeftRailItem, type SidebarView } from '../../../stores/layout-store'
import { useEditorStore, type EditorTab } from '../../../stores/editor-store'
import { useProjectStore } from '../../../stores/project-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useUiVersionStore, isMagazine } from '../../../stores/ui-version-store'
import { useMagOpenerStore } from '../../../stores/mag-opener-store'
import { shouldPlaySectionSweep, type SectionKey } from '../../../shared/section-opener'
import { openBuiltinEditor } from '../../panels/sidebar/sidebar-file-openers'

/**
 * 书脊栏目（产品在 demo 六项之外另有「蓝图」独立入口）。
 *
 * 类型直接取自 shared/section-opener —— 「书脊能点的栏目」与「有开篇页的栏目」
 * 从此是同一份定义，不会各自漂移。
 */
export type RailKey = SectionKey

interface RailTarget {
  /** 该栏目下侧边栏显示什么 */
  view: SidebarView
  /** 左侧导航栏高亮的按钮 */
  railItem: LeftRailItem
}

const RAIL_TARGETS: Record<RailKey, RailTarget> = {
  home: { view: 'home', railItem: 'home' },
  project: { view: 'project', railItem: 'project' },
  characters: { view: 'characters', railItem: 'characters' },
  knowledge: { view: 'knowledge', railItem: 'knowledge' },
  world: { view: 'world', railItem: 'world' },
  'plot-tree': { view: 'project', railItem: 'plot-tree' },
  blueprint: { view: 'project', railItem: 'blueprint' },
}

/**
 * 页面类型 → 所属栏目（对齐 demo 的 spineForTabType）。
 *
 * 草稿、审稿、配置、版本、架构文件等写作案卷都归「目录」；蓝图在产品里有独立入口，
 * 因此单列，保证「高亮的按钮 = 正在看的页面」。
 */
const RAIL_BY_TAB_TYPE: Partial<Record<EditorTab['type'], RailKey>> = {
  character: 'characters',
  'relationship-graph': 'characters',
  knowledge: 'knowledge',
  /**
   * 先生：这里**故意不放** 'world-building'。
   *
   * 'world-building' 是**故事架构**编辑器（四段式架构文件：故事前提 / 角色图谱 /
   * 世界观 / 情节大纲），由目录里的「故事架构」入口打开，属于目录的写作案卷。
   * 原先把它映射到 'world'，于是「从目录点故事架构 → 侧栏被抢到世界栏目」——
   * 那就是先生看到的「面板自己切到世界观设定去了」。现在它落回默认的 'project'，
   * 点故事架构时侧栏老老实实留在目录。
   *
   * 「世界」栏目改由独立的 'world-setting' 页面承载（将来放世界观、势力等设定内容）。
   */
  'world-setting': 'world',
  'narrative-thread': 'plot-tree',
  'chapter-card': 'blueprint',
}

export function railForTabType(type: EditorTab['type']): RailKey {
  return RAIL_BY_TAB_TYPE[type] ?? 'project'
}

/** 打开（或激活）某栏目的落点页 —— 对齐 demo 的 ensureTab：同一页面只留一个标签。 */
export function openRailLandingPage(key: RailKey): void {
  const text = useLocaleStore.getState().text
  switch (key) {
    case 'characters':
      openBuiltinEditor('character-editor', text('人物档案', 'Character profiles'), 'character')
      return
    case 'knowledge':
      openBuiltinEditor('knowledge-editor', text('知识库', 'Knowledge base'), 'knowledge')
      return
    case 'world':
      /**
       * 先生：这个按钮承载的是「世界观设定」（将来放世界观、势力、各种设定条目），
       * **不是**故事架构。原先它借用了 'world-building-editor'，等于把故事架构当成
       * 世界观设定在弹 —— 现在换成独立的 'world-setting-editor'。
       *
       * 故事架构仍由目录里的「故事架构」入口打开（同一个 world-building-editor）。
       */
      openBuiltinEditor('world-setting-editor', text('设定集', 'World building'), 'world-setting')
      return
    case 'plot-tree':
      // id 必须是 'narrative-thread-editor'：ProjectTree / LeftToolWindowBar 都用它，
      // 换 id 会让同一个编辑器开出两个标签。
      openBuiltinEditor(
        'narrative-thread-editor',
        text('剧情树与伏笔', 'Plot tree & foreshadowing'),
        'narrative-thread',
        'plot-tree',
      )
      return
    case 'blueprint':
      // id 必须是 CHAPTER_CARD_TAB_ID（'chapter-card-editor'）：章节蓝图的后台草稿账本
      // 以这个 id 为键，换 id 会丢未保存内容。
      openBuiltinEditor('chapter-card-editor', text('章节蓝图', 'Chapter blueprint'), 'chapter-card')
      return
    default:
      return
  }
}

/**
 * 切栏目时要不要扫一道线（v3 时尚杂志专属）。
 *
 * 触发点选在这里而不是「监听 activeRailItem 变化」，是因为两者语义不同：
 *   · 打开作品时 EditorArea 自动同步到「目录」—— 那是自动的，不扫
 *   · 点标签页也会同步栏目 —— 那是栏内换页，更不扫
 *   · 只有 goRail（书脊点击、刊头回书架、书架卡片的入口按钮）才是「翻到新一栏」
 * 用**动作**触发，而不是用**状态变化**触发。
 *
 * 注意：栏目**背景**是常驻的（ShellV2 挂 data-sec，CSS 200ms 换色），
 * 不经过这里；本函数只管那一道 300ms 的扫线。
 * 三个闸门见 shared/section-opener.ts 的 shouldPlaySectionSweep（那里有理由）。
 */
function maybePlaySectionSweep(key: RailKey): void {
  const layout = useLayoutStore.getState()
  const target = RAIL_TARGETS[key]
  const opened = shouldPlaySectionSweep({
    magazine: isMagazine(useUiVersionStore.getState().uiVersion),
    hasProject: !!useProjectStore.getState().currentProject,
    // 「同一个按钮再点一次」在 layout-store 里的语义是折叠 / 展开侧栏，不是切栏目
    sameButton: layout.sidebarView === target.view && layout.activeRailItem === target.railItem,
  })
  if (!opened) return
  useMagOpenerStore.getState().open(key)
}

/**
 * 切换栏目（demo 的 navGo）。
 *
 * - 书架：中央回到书架首页，焦点清空（书架是栏目首页，不占标签）
 * - 目录：焦点交回最近打开的写作案卷；一个都没有时留空态，不再自作主张开别的页面
 * - 其余栏目：打开或激活该栏目的落点页
 */
export function goRail(key: RailKey): void {
  const layout = useLayoutStore.getState()
  const editor = useEditorStore.getState()
  const target = RAIL_TARGETS[key]

  // 翻开这一栏之前，先扫出那一道栏目色（v3 才会真的演）
  maybePlaySectionSweep(key)

  if (key === 'home') {
    layout.setSidebarView(target.view, target.railItem)
    editor.setActiveTab(null)
    return
  }

  /**
   * 先生：还没打开作品时，点栏目**只切侧栏**（显示该栏目的图标 + 请先打开项目），
   * 绝不打开任何页面。
   *
   * 否则这些点击会偷偷留下标签 —— 正文栏因为「没项目」看不出异样，可一旦用户
   * 之后打开作品，之前点过的页面会一齐冒到正文栏上。用户没进项目，这些窗口
   * 本就不该被打开。
   */
  if (!useProjectStore.getState().currentProject) {
    layout.setSidebarView(target.view, target.railItem)
    return
  }

  if (key === 'project') {
    /**
     * 先生：目录是「继承书架的第二个位」—— 它的正文栏默认就是**小说配置**，
     * 而且无论用户此前停在人物 / 知识库 / 世界 / 伏笔 / 蓝图哪一页，点目录都要能回来。
     *
     * 原先这里找的是「最近打开的写作案卷」，一旦打开过别的页面就可能落空或跳到别处，
     * 那正是「偶尔回不了目录」的来源。现在固定落到小说配置：它同时也是打开作品时的
     * 默认页（EditorArea 打开项目即开它），所以一定存在。
     */
    layout.setSidebarView(target.view, target.railItem)
    const configTab = editor.tabs.find((tab) => tab.type === 'config')
    if (configTab) {
      editor.setActiveTab(configTab.id)
      return
    }
    const projectPath = useProjectStore.getState().currentProject?.path
    if (projectPath) {
      editor.openFile({
        id: 'config',
        name: useLocaleStore.getState().text('小说配置', 'Novel configuration'),
        type: 'config',
        projectKey: projectPath,
      })
      return
    }
    editor.setActiveTab(null)
    return
  }

  layout.setSidebarView(target.view, target.railItem)
  openRailLandingPage(key)
}

/**
 * 中央页面换人后，让侧栏语境跟上（对齐 demo 的 clickTab）。
 *
 * 只同步「哪一栏 + 高亮哪个按钮」，不做 setSidebarView 的「再点一次即折叠」处理，
 * 否则用户点标签时会莫名把侧栏收起来。
 */
export function syncRailForTab(tabId: string | null): void {
  if (!tabId) return
  const tab = useEditorStore.getState().tabs.find((item) => item.id === tabId)
  if (!tab) return
  const target = RAIL_TARGETS[railForTabType(tab.type)]
  useLayoutStore.getState().syncRailForPage(target.view, target.railItem)
}

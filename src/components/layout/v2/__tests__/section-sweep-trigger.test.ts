/**
 * 栏目扫线 · 触发链路与挂载点契约。
 *
 * 这套动效最容易被做坏的地方不是视觉，是**什么时候播**：
 * 播早了（打开作品、点标签页都播）就成了每次操作都糊一脸的阻碍。
 * 所以这里逐条锁住「该播」与「不该播」的边界，另加两条结构事实：
 *   · 栏目背景（data-sec 属性）挂在 ShellV2 的编辑区上
 *   · 扫线只有一个挂载点（不再分散在 EditorArea 的各个 return 分支里）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useMagOpenerStore } from '../../../../stores/mag-opener-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useUiVersionStore } from '../../../../stores/ui-version-store'
import { goRail, syncRailForTab } from '../rail-routing'

/** 只为「有没有项目」这一项判定用的最小项目对象（与 rail-routing.test.ts 同款）。 */
const OPEN_PROJECT = {
  id: 'section-sweep-project',
  path: 'C:\\novels\\section-sweep',
  sessionLease: 'section-sweep-lease',
  name: 'Section sweep',
} as never

const opening = () => useMagOpenerStore.getState().opening

function reset(uiVersion: 'v2' | 'v3', withProject = true): void {
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useLayoutStore.setState({
    sidebarView: 'project',
    activeRailItem: 'project',
    sidebarOpen: true,
    aiPanelOpen: true,
    focusMode: false,
  })
  useUiVersionStore.setState({ uiVersion })
  useMagOpenerStore.setState({ opening: null })
  useProjectStore.setState({ currentProject: withProject ? OPEN_PROJECT : null })
}

describe('切栏目扫一道线', () => {
  beforeEach(() => reset('v3'))

  it('v3 下从目录切到人物 → 扫人物那一栏的色', () => {
    goRail('characters')
    expect(opening()).toEqual({ key: 'characters', token: 1 })
  })

  it('v3 下切回书架 → 扫书架那一栏（书架不占标签，也仍是栏目）', () => {
    goRail('characters')
    goRail('home')
    expect(opening()).toEqual({ key: 'home', token: 2 })
  })

  it('七个栏目各扫自己那一栏', () => {
    for (const key of ['characters', 'world', 'plot-tree', 'blueprint', 'knowledge', 'project'] as const) {
      goRail(key)
      expect(opening()?.key).toBe(key)
    }
  })

  it('连点两栏：后一次覆盖前一次（token 递增）', () => {
    goRail('characters')
    goRail('world')
    expect(opening()).toEqual({ key: 'world', token: 2 })
  })
})

describe('不该扫的四种情形', () => {
  it('v2 墨纸书斋：一次都不扫', () => {
    reset('v2')
    goRail('characters')
    goRail('world')
    expect(opening()).toBeNull()
  })

  it('还没打开作品：点栏目只切侧栏，正文栏不换页，不扫', () => {
    reset('v3', false)
    goRail('characters')
    expect(opening()).toBeNull()
  })

  it('同一个按钮再点一次（语义是折叠侧栏）：不扫', () => {
    reset('v3')
    // 打开作品后 EditorArea 会把栏目同步到「目录」；此刻点「目录」= 折叠侧栏
    useLayoutStore.setState({ sidebarView: 'project', activeRailItem: 'project' })
    goRail('project')
    expect(opening()).toBeNull()
  })

  it('点标签页导致栏目被动同步：不扫', () => {
    reset('v3')
    goRail('characters')
    useMagOpenerStore.setState({ opening: null })
    // 页面上真有这么一个标签，syncRailForTab 才会真的去同步栏目
    useEditorStore.setState({
      tabs: [{
        id: 'knowledge-editor',
        name: '知识库',
        type: 'knowledge',
        projectKey: 'C:\\novels\\section-sweep',
      } as never],
      activeTabId: null,
    })
    // 页面换人时侧栏语境跟随（rail-routing.syncRailForTab），那是栏内换页
    syncRailForTab('knowledge-editor')
    expect(useLayoutStore.getState().activeRailItem).toBe('knowledge')
    expect(opening()).toBeNull()
  })
})

/**
 * 挂载点契约（源码级）。
 *
 * 栏目背景不是「渲染出来的一层」，而是**属性驱动的一层**：
 * ShellV2 把 data-sec / data-sec-no 写到 .editor 上，CSS 负责剩下的一切。
 * 这两条结构事实一旦被改坏（属性没挂、扫线回到多分支挂载），
 * 界面不会报错，只会悄悄退回「切栏目什么都不变」—— 所以拿测试钉住。
 */
describe('挂载点契约', () => {
  const shell = readFileSync(
    resolve(process.cwd(), 'src/components/layout/v2/ShellV2.tsx'),
    'utf8',
  )
  const backdropCss = readFileSync(
    resolve(process.cwd(), 'src/styles/magazine/mag-backdrop.css'),
    'utf8',
  )

  it('编辑区拿到当前栏目的编号与色标（背景与水印全靠它）', () => {
    expect(shell).toContain("'data-sec': String(section.mark)")
    expect(shell).toContain("'data-sec-no': section.no")
    expect(shell).toContain('<section className="editor" {...editorAttrs}>')
  })

  it('栏目背景只在 v3 判定之后才取值（v2 / v1 一个属性都不挂）', () => {
    expect(shell).toContain('isMagazine(uiVersion) ? sectionForRail(activeRailItem) : null')
  })

  it('扫线只挂在编辑区这一层，且只在有栏目时挂出', () => {
    expect(shell).toContain('{section && <SectionSweep />}')
  })

  it('CSS 侧七条栏目色标映射齐全 —— 少一条就有栏目切过去不变色', () => {
    for (const mark of [1, 2, 3, 4, 5, 6, 7]) {
      expect(backdropCss).toContain(`.editor[data-sec='${mark}'] { --mag-sec: var(--mag-sec-${mark}); }`)
    }
  })

  it('巨号水印取自属性而不是 DOM 文本 —— 换栏目不重建任何节点', () => {
    expect(backdropCss).toContain('content: attr(data-sec-no)')
  })
})

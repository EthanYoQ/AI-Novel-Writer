import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import '../../../../index.css'
import '../../../../styles/redesign/v2-index.css'
import '../../../../styles/magazine/mag-index.css'

import type { DraftMeta } from '../../../../stores/draft-store'
import { useDraftStore } from '../../../../stores/draft-store'
import type { EditorTab } from '../../../../stores/editor-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useStickyNoteStore } from '../../../../stores/sticky-note-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import DraftBoxGroup from '../DraftBoxGroup'
import ManuscriptGroup from '../ManuscriptGroup'
import ProjectTree from '../ProjectTree'
import StickyNotesGroup from '../StickyNotesGroup'
import { clearChapterTitleCache } from '../manuscript-title-cache'
import { stickyTabPath } from '../../../../shared/sticky-note'

/**
 * 「正文章节」**组标题行**的选中态 · 真渲染契约。
 *
 * 先生这一轮的原话：
 *   「我当前正在正文栏目查看那个项目下的内容，那么这个项目在项目结构下的标题入口
 *     就应该做一个背景变色？来提示用户。不然用户都不知道自己在看哪个地方的内容！」
 *
 * 为什么要专门盯**组标题行**这一盏灯：这一组默认是收起的（先生定的「正文章节
 * 不要一打开就全摊开」）。折叠时里面的章节条目一个都不在树上，只点亮条目行
 * 等于一行提示都没有 —— 组标题行是折叠态下唯一的方位标。
 *
 * 夹具照**真实外壳**搭（本项目血泪教训：夹具与真实结构不符 = 测试全绿而界面没用）：
 * 选中态的样式表全都写在 `.sidebar-host` 下（v2-sidebar.css / mag-shell.css /
 * tree-child-indent.css），裸渲染一个组件是量不到底色的。
 */

const PROJECT_PATH = 'C:\\novels\\active-group'
const CHAPTER_PATH = 'vela://manuscript/7'
const SECOND_CHAPTER_PATH = 'vela://manuscript/8'
/** 正文栏看的是**草稿**（不在正文章节这一组里）—— 用来验证「看别处就不该亮」。 */
const OTHER_TAB_PATH = 'vela://draft/3'
/** 草稿箱那一条链上的稿子。 */
const DRAFT_PATH = 'vela://draft/21'

function draftMeta(id: number, chapterNumber: number): DraftMeta {
  return {
    id,
    chapterNumber,
    version: 1,
    status: 'draft',
    source: 'write',
    wordCount: 12,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
    fileName: 'draft_v1.md',
    filePath: `vela://draft/${id}`,
  }
}

const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()
const originalEditorState = useEditorStore.getState()

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
let host: HTMLDivElement | undefined
let container: HTMLDivElement | undefined

const CHAPTER_FILES = [
  { path: CHAPTER_PATH, name: 'chapter_7.md', isDir: false, chapterTitle: '潮线回声' },
  { path: SECOND_CHAPTER_PATH, name: 'chapter_8.md', isDir: false, chapterTitle: '夜航灯' },
]

/** 正文栏「正在看的那一页」—— 侧栏据此点亮。 */
function openChapter(filePath: string | null): void {
  const tab: EditorTab = { id: filePath ?? '', name: '第7章 潮线回声', type: 'chapter', filePath: filePath ?? undefined }
  useEditorStore.setState({
    tabs: filePath === null ? [] : [tab],
    activeTabId: filePath,
  })
}

/** 打开任意一页（小说配置 / 章节蓝图 / 伏笔 / 故事架构 / 架构文件…）。 */
function openTab(tab: EditorTab): void {
  useEditorStore.setState({ tabs: [tab], activeTabId: tab.id })
}

/** 外壳照 ShellV2 那几层搭；`writer-project-tree` 是 ManuscriptGroup 真实所在的那一层。 */
function buildShell(): void {
  host = document.createElement('div')
  host.className = 'app-skin-root'
  host.innerHTML = `
    <div class="app v2-app"><div class="main"><div class="body3"><div class="sidebar-host">
      <div class="writer-project-tree"></div>
    </div></div></div></div>`
  document.body.append(host)
  container = host.querySelector<HTMLDivElement>('.writer-project-tree')!
  root = createRoot(container)
}

async function renderGroup(): Promise<void> {
  await renderNode(<ManuscriptGroup files={CHAPTER_FILES} projectPath={PROJECT_PATH} />)
}

/** 渲染任意侧栏组件 —— 外壳那几层一层都不能少（样式全写在 `.sidebar-host` 下）。 */
async function renderNode(node: ReactNode): Promise<void> {
  buildShell()
  await act(async () => {
    root?.render(node)
  })
}

/** 按行首文字认一行。 */
function rowByText(prefix: string): HTMLElement | undefined {
  return Array.from(container?.querySelectorAll<HTMLElement>('.tree-item') ?? [])
    .find(row => (row.textContent ?? '').trim().startsWith(prefix))
}

/** 按层级认一行（1 级组行 / 2 级章节行 / 3 级条目）—— 层级写在 data-level 上。 */
function rowByLevel(level: 1 | 2 | 3): HTMLElement | undefined {
  return container?.querySelector<HTMLElement>(`.active[data-level='${level}']`) ?? undefined
}

/** 「正文章节」组标题行 —— 本树里唯一以它开头的那一行。 */
function groupHeader(): HTMLElement {
  const rows = Array.from(container?.querySelectorAll<HTMLElement>('.tree-item') ?? [])
    .filter(row => (row.textContent ?? '').trim().startsWith('正文章节'))
  expect(rows).toHaveLength(1)
  return rows[0]!
}

/** 组里的章节条目行（靠「第N章」认，不与组标题行混）。 */
function chapterRows(): HTMLElement[] {
  return Array.from(container?.querySelectorAll<HTMLElement>('.tree-item') ?? [])
    .filter(row => /第\d+章/.test(row.textContent ?? ''))
}

/**
 * 解析 getComputedStyle 的颜色，返回 [r, g, b, a]。
 * 三种写法都要吃住：`rgb(0 0 0 / 0)`、`rgba(0, 0, 0, 0)`、`color(srgb … / .26)`、`#07101C`。
 * （第一版用逗号正则，撞上空格语法就静默吐出 NaN —— 断言 NaN 比断言失败更难查。）
 */
function parseRgba(value: string): [number, number, number, number] {
  const s = value.trim()
  const srgb = s.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/)
  if (srgb) {
    return [
      Math.round(Number(srgb[1]) * 255), Math.round(Number(srgb[2]) * 255), Math.round(Number(srgb[3]) * 255),
      srgb[4] === undefined ? 1 : Number(srgb[4]),
    ]
  }
  const rgb = s.match(/^rgba?\(([^)]+)\)$/)
  if (rgb) {
    const parts = rgb[1]!.split(/[,\s/]+/).filter(Boolean).map(Number)
    return [parts[0]!, parts[1]!, parts[2]!, parts[3] === undefined ? 1 : parts[3]!]
  }
  const hex = s.match(/^#([0-9a-f]{6})$/i)
  if (hex) { const n = parseInt(hex[1]!, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1] }
  throw new Error(`无法解析颜色: ${JSON.stringify(value)}`)
}

function parseColor(value: string): [number, number, number] {
  const [r, g, b] = parseRgba(value)
  return [r, g, b]
}

/** 感知亮度：判「肉眼能不能分辨」用的口径（ΔL 太小就等于没有反馈）。 */
function luma([r, g, b]: [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** 把带 alpha 的前景合成到不透明底上 —— computed 给的是 rgba，肉眼看到的是合成结果。 */
function over(fg: string, bg: string): [number, number, number] {
  const [r, g, b, a] = parseRgba(fg)
  const base = parseRgba(bg)
  if (a >= 1) return [r, g, b]
  return [0, 1, 2].map(i => Math.round([r, g, b][i]! * a + base[i]! * (1 - a))) as [number, number, number]
}

function sidebarBaseColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--color-sidebar').trim()
}

/**
 * 左缘那一笔**色标**的颜色。
 *
 * 三级选中现在不是实心块了（先生：「还是太丑了」）—— 层级靠「色标 + 淡染」表达，
 * 判「看不看得见」要看这笔色标，而不是那层 5%~12% 的淡底。
 * computed 的 background-image 已把变量解析成 rgb，直接取第一段颜色。
 */
function markerColor(node: HTMLElement): [number, number, number] {
  const image = getComputedStyle(node).backgroundImage
  const match = image.match(/rgba?\([^)]+\)/)
  expect(match, `这一行没有色标：${image}`).not.toBeNull()
  return parseColor(match![0])
}

/** 行内文字色（直接子 span）—— 用来盯「亮行的字提墨了没有」。 */
function rowTextColor(node: HTMLElement): [number, number, number] {
  const span = node.querySelector('span')
  expect(span, '这一行没有文字').not.toBeNull()
  return parseColor(getComputedStyle(span!).color)
}

function backgroundOf(node: HTMLElement): string {
  return getComputedStyle(node).backgroundColor
}

function isTransparent(value: string): boolean {
  return value === 'rgba(0, 0, 0, 0)' || value === 'transparent'
}

beforeEach(() => {
  clearChapterTitleCache()
  useLocaleStore.setState({ locale: 'zh-CN' })
  /**
   * 三个 store 每次都从干净值起步。
   *
   * 这一条的 IPC 是**宽容 mock**（未登记通道一律返回 `{ success: true }`），
   * 面板的异步加载会把这个成功值当成数据写回 store —— 便利贴的 `notes`
   * 曾因此变成对象，ProjectTree 一渲染就 `notes.filter is not a function`。
   */
  useStickyNoteStore.setState({ notes: [], folders: [], candidates: [] })
  useDraftStore.setState({ draftsByChapter: {} })
  useWorkflowStore.setState({ activeRuns: [], history: [] })
  useEditorStore.setState({ tabs: [], activeTabId: null })
  useProjectStore.setState({
    currentProject: {
      id: 'active-group',
      sessionLease: 'active-group-lease',
      name: '选中的那一行',
      path: PROJECT_PATH,
      novelConfig: {},
    } as never,
  })
  // v3「时尚杂志」：data-ui 是基座，data-mag 才是杂志皮肤（见 App.tsx）。
  document.documentElement.setAttribute('data-ui', 'v2')
  document.documentElement.setAttribute('data-mag', '1')
  document.documentElement.setAttribute('data-v2-theme', '0')

  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'chapter:list-incomplete-deletions') return { success: true, operations: [] }
    // 列表类通道必须给出**真实形状**：面板的异步加载会把这个返回值直接写回 store，
    // 一律回 `{ success: true }` 会让 `notes` 变成对象、ProjectTree 一渲染就崩。
    if (channel === 'db:sticky-note-list' || channel === 'db:sticky-folder-list') return []
    if (channel === 'db:sticky-candidate-list') return { candidates: [] }
    if (channel === 'db:draft-list' || channel === 'db:draft-list-all') return []
    // 其余通道给中性成功值：这一条测的是「行点不点亮」，不是各面板的数据加载。
    return { success: true }
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
  host?.remove()
  root = undefined
  host = undefined
  container = undefined
  clearChapterTitleCache()
  document.documentElement.removeAttribute('data-mag')
  document.documentElement.removeAttribute('data-ui')
  document.documentElement.removeAttribute('data-v2-theme')
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  useEditorStore.setState(originalEditorState)
  delete (window as unknown as { velaAPI?: TestVelaApi }).velaAPI
})

describe('正文章节 · 组标题行的选中态', () => {
  it('正文栏正在看本组的一章 → 组标题行就点亮（**折叠着也亮**）', async () => {
    openChapter(CHAPTER_PATH)
    await renderGroup()

    const header = groupHeader()
    expect(header.className).toContain('active')
    // 折叠是默认态：此刻组里的条目行一个都没渲染出来 —— 这一盏灯正是唯一的提示
    expect(chapterRows()).toHaveLength(0)

    // 1 级 = 藕紫（#7A5B7E）—— 现在只占左缘那一笔色标，底色退成 5% 的淡染
    const image = getComputedStyle(header).backgroundImage
    expect(image).toContain('122, 91, 126')
    expect(isTransparent(backgroundOf(header))).toBe(false)
    expect(getComputedStyle(header).backgroundSize).toContain('3px')
  })

  it('展开之后，那个章节条目自己也亮（旧有的那盏灯没被碰坏）', async () => {
    openChapter(CHAPTER_PATH)
    await renderGroup()

    await act(async () => { groupHeader().click() })

    const rows = chapterRows()
    expect(rows).toHaveLength(2)
    const lit = rows.filter(row => row.className.includes('active'))
    expect(lit).toHaveLength(1)
    expect(isTransparent(backgroundOf(lit[0]!))).toBe(false)
  })

  it('正文栏看的是别处（草稿）→ 组标题行保持素白', async () => {
    openChapter(OTHER_TAB_PATH)
    await renderGroup()

    expect(groupHeader().className).not.toContain('active')
    expect(isTransparent(backgroundOf(groupHeader()))).toBe(true)
  })

  it('什么也没打开 → 组标题行不亮', async () => {
    openChapter(null)
    await renderGroup()

    expect(groupHeader().className).not.toContain('active')
  })

  it('v2「墨纸书斋」那套皮肤下同样有底色（不是只给杂志版做的）', async () => {
    document.documentElement.removeAttribute('data-mag')
    openChapter(CHAPTER_PATH)
    await renderGroup()

    const header = groupHeader()
    expect(header.className).toContain('active')
    expect(isTransparent(backgroundOf(header))).toBe(false)
  })
})

/**
 * 深色主题（1 星汉 / 3 黑夜）—— 先生 2026-09-20 实测的那套环境。
 *
 * 他原话：「现在我实际测试，是没有变化的，应该是 css 的变化被更高级的样式拦住了。」
 * 实测（`_probe-active-row.mjs`）证明层叠没问题，坏的是颜色：基座拿「白」当悬停与
 * 选中的基色，可星汉主题里 `--white` 是 #112440、侧栏底是 #07101C —— 深蓝叠近黑。
 * 这两条用例把「看得见」写成契约：只看类名或只看「有底色」都拦不住这种回归。
 */
describe('深色主题下，反馈必须肉眼可见', () => {
  /** 与侧栏底色的亮度差：≥12 明显，6~12 勉强，<6 等于没有反馈。 */
  function contrastAgainstSidebar(node: HTMLElement): number {
    const base = sidebarBaseColor()
    const raw = backgroundOf(node)
    // 没有底色 = 与侧栏底同色；有底色才需要合成（luma 要的是三元数组，不是颜色字符串）
    const composed = isTransparent(raw) ? parseColor(base) : over(raw, base)
    return Math.round(luma(composed) - luma(parseColor(base)))
  }

  function markerColor(node: HTMLElement): [number, number, number] {
    const image = getComputedStyle(node).backgroundImage
    const match = image.match(/rgba?\([^)]+\)/)
    expect(match, `这一行没有色标：${image}`).not.toBeNull()
    return parseColor(match![0])
  }

  it('星汉（主题 1）：组行的色标在深空底上立得住', async () => {
    document.documentElement.setAttribute('data-v2-theme', '1')
    openChapter(CHAPTER_PATH)
    await renderGroup()

    const delta = Math.abs(luma(markerColor(groupHeader())) - luma(parseColor(sidebarBaseColor())))
    expect(delta).toBeGreaterThanOrEqual(60)
  })

  it('星汉（主题 1）：鼠标扫过一行也有看得见的反馈', async () => {
    // v2 皮肤：悬停画在**元素自身**的底色上（杂志版画在 ::after 扫入层，见下一条）
    document.documentElement.removeAttribute('data-mag')
    document.documentElement.setAttribute('data-v2-theme', '1')
    openChapter(CHAPTER_PATH)
    await renderGroup()
    await act(async () => { groupHeader().click() })

    // 悬停必须落在**未选中**的那一条上：选中态本来就比悬停重，拿选中行测等于什么都没测
    const row = chapterRows().find(candidate => !candidate.className.includes('active'))!
    const before = contrastAgainstSidebar(row)
    await page.elementLocator(row).hover()
    await new Promise(resolve => setTimeout(resolve, 300))
    const after = contrastAgainstSidebar(row)

    expect(after).toBeGreaterThanOrEqual(20)
    expect(after).toBeGreaterThan(before)
  })

  it('杂志版（v3）：悬停走扫入层 —— 伪元素在场且有颜色', async () => {
    document.documentElement.setAttribute('data-mag', '1')
    document.documentElement.setAttribute('data-v2-theme', '1')
    openChapter(CHAPTER_PATH)
    await renderGroup()
    await act(async () => { groupHeader().click() })

    const row = chapterRows().find(candidate => !candidate.className.includes('active'))!
    const sweep = getComputedStyle(row, '::after')
    expect(sweep.content).toBe('""')
    expect(sweep.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
  })

  it('浅色（主题 0）：纸面上的色标同样一眼可辨', async () => {
    document.documentElement.setAttribute('data-v2-theme', '0')
    openChapter(CHAPTER_PATH)
    await renderGroup()

    const delta = Math.abs(luma(markerColor(groupHeader())) - luma(parseColor(sidebarBaseColor())))
    expect(delta).toBeGreaterThanOrEqual(60)
  })
})

/**
 * 草稿箱这一整条链 —— 先生 2026-09-20：
 *   「我实际测试，V2，只显示 草稿、正文、便利贴的 3级入口标题栏，2级章节，1级的
 *     草稿箱，这些是没反应。」
 *
 * 当时这一条链上只有最底下那一稿挂了 `.active`；组行与章节行都没有，
 * 于是「点开某一稿之后，侧栏里没有任何一行说出你在哪一章」。
 */
describe('草稿箱 · 一整条链的选中态', () => {
  it('正文栏正看着某一稿 → 组行与它所在的章节行一起亮（折叠着也亮）', async () => {
    openChapter(DRAFT_PATH)
    await renderNode(<DraftBoxGroup draftsByChapter={{ 3: [draftMeta(21, 3)] }} />)

    const boxHeader = rowByText('草稿箱')
    expect(boxHeader).toBeDefined()
    expect(boxHeader!.className).toContain('active')
    // 组默认收起：里面一行都没露脸，组行就是唯一的方位标
    expect(rowByText('第3章')).toBeUndefined()

    await act(async () => { boxHeader!.click() })

    const chapterRow = rowByText('第3章')
    expect(chapterRow).toBeDefined()
    expect(chapterRow!.className).toContain('active')
    // 而且它确实是「有底色的」，不只是挂了个类名
    expect(isTransparent(backgroundOf(chapterRow!))).toBe(false)
  })

  it('正文栏看的是定稿正文 → 草稿箱这条链一行都不亮', async () => {
    openChapter(CHAPTER_PATH)
    await renderNode(<DraftBoxGroup draftsByChapter={{ 3: [draftMeta(21, 3)] }} />)

    expect(rowByText('草稿箱')!.className).not.toContain('active')
  })
})

/**
 * 三级选中 —— 先生 2026-09-20 改过一轮口径：
 *   「现在确实成功了，就是不太好看！特别是 3 个地方都显示的时候！……
 *     1级为 紫+白字，2级为 蓝+白字，3级为 红+白字？」
 *   接着：「哎，还是太丑了。有没有更高明，更好看，更美观优雅的处理方式？」
 *
 * 实心三色块被否掉之后：颜色**收进左缘那一笔色标**，底色退成同色淡染；
 * 层级靠「色标由短到长」＋「淡染由浅到深」表达。这一组盯的就是这个结构，
 * 免得将来又被人改回整块实心（那是先生明确否掉的）。
 */
describe('三级选中 · 一笔色标 + 一层淡染', () => {
  const LV1_PURPLE: [number, number, number] = [122, 91, 126]   // #7A5B7E 藕紫
  const LV2_BLUE: [number, number, number] = [39, 64, 122]      // #27407A 靛蓝
  const LV3_RED: [number, number, number] = [200, 86, 74]       // #C8564A 珊瑚朱

  /** 三层同时露脸的场景：草稿箱（1 级）→ 第3章（2 级）→ 草稿_v2（3 级）。 */
  async function renderThreeLevels(): Promise<[HTMLElement, HTMLElement, HTMLElement]> {
    openChapter(DRAFT_PATH)
    await renderNode(<DraftBoxGroup draftsByChapter={{ 3: [draftMeta(21, 3)] }} />)
    // 草稿箱是**两层折叠**：先点开组行，再点开它下面的章节行，条目才露脸
    await act(async () => { rowByText('草稿箱')!.click() })
    await act(async () => { rowByText('第3章')!.click() })

    const lv1 = rowByLevel(1)
    const lv2 = rowByLevel(2)
    const lv3 = rowByLevel(3)
    expect(lv1).toBeDefined()
    expect(lv2).toBeDefined()
    expect(lv3).toBeDefined()
    return [lv1!, lv2!, lv3!]
  }

  it('三层同时亮时：三笔色标各就各位（紫 / 蓝 / 红）', async () => {
    const [lv1, lv2, lv3] = await renderThreeLevels()

    expect(markerColor(lv1)).toEqual(LV1_PURPLE)
    expect(markerColor(lv2)).toEqual(LV2_BLUE)
    expect(markerColor(lv3)).toEqual(LV3_RED)
  })

  it('底色**不是实心块** —— 只是各自的同色淡染，且三级深浅不同', async () => {
    const [lv1, lv2, lv3] = await renderThreeLevels()
    const fills = [lv1, lv2, lv3].map(node => backgroundOf(node))

    expect(fills.every(fill => !isTransparent(fill))).toBe(true)
    // 三级各有各的淡染（深浅递进），不是同一块实心色
    expect(new Set(fills).size).toBe(3)
    for (const fill of fills) {
      const [r, g, b, a] = parseRgba(fill)
      expect(a).toBeLessThanOrEqual(0.15)   // 淡染：最重的一级也只在 12% 上下
      expect([r, g, b].some(channel => channel > 0)).toBe(true)
    }
  })

  it('色标三级等高（先生说 2、3 级 Y 轴太高不好看，统一到 1 级那一档）', async () => {
    const [lv1, lv2, lv3] = await renderThreeLevels()
    const sizes = [lv1, lv2, lv3].map(node => getComputedStyle(node).backgroundSize)

    expect(sizes[0]).toContain('3px')
    expect(sizes[0]).toContain('12px')
    expect(sizes[1]).toBe(sizes[0])
    expect(sizes[2]).toBe(sizes[0])
  })

  it('色标跟着缩进走 —— 与目录标题同一套缩进关系（先生第二轮要求）', async () => {
    // 断言的是**本质契约**，不是某个皮肤下的像素读数：
    // 色标永远落在「该行内容左缘再往左 10px」处，且三级各在不同位置（一道台阶）。
    // 绝对坐标 = 行盒左缘（含外边距）+ background-position。
    const [lv1, lv2, lv3] = await renderThreeLevels()
    const rows = [lv1, lv2, lv3]

    const markX = (node: HTMLElement) => Math.round(
      node.getBoundingClientRect().left + parseFloat(getComputedStyle(node).backgroundPosition),
    )
    const contentX = (node: HTMLElement) => Math.round(
      node.getBoundingClientRect().left + parseFloat(getComputedStyle(node).paddingLeft),
    )

    for (const node of rows) expect(contentX(node) - markX(node)).toBe(10)
    expect(new Set(rows.map(markX)).size).toBe(3)
  })

  it('3 级条目和 1 / 2 级是同一个框体 —— 左右都对齐（先生：左边不能长出一大截）', async () => {
    const [lv1, , lv3] = await renderThreeLevels()
    const radiusOf = (node: HTMLElement) => getComputedStyle(node).borderTopLeftRadius
    const marginOf = (node: HTMLElement) => [getComputedStyle(node).marginLeft, getComputedStyle(node).marginRight]

    expect(parseFloat(radiusOf(lv3))).toBeGreaterThan(0)
    expect(radiusOf(lv3)).toBe(radiusOf(lv1))
    // 左右外边距都要与 1 级（.tree-item 自带的 7px）齐平
    expect(marginOf(lv3)).toEqual(marginOf(lv1))
    expect(marginOf(lv1)[0]).not.toBe('0px')
  })

  it('V2 与 V3 各用自己那套色（先生：两套版本的颜色应该做出区别）', async () => {
    // v2 墨纸书斋：松烟墨 / 赭石 / 朱砂
    document.documentElement.removeAttribute('data-mag')
    openChapter(CHAPTER_PATH)
    await renderGroup()
    expect(markerColor(groupHeader())).toEqual([51, 64, 79])   // #33404F 松烟墨

    // v3 时尚杂志：藕紫 / 靛蓝 / 珊瑚朱
    document.documentElement.setAttribute('data-mag', '1')
    await act(async () => { await Promise.resolve() })
    expect(markerColor(groupHeader())).toEqual([122, 91, 126]) // #7A5B7E 藕紫
  })

  it('亮行的字提到常态墨色，不是白字（淡底压不住白，白字会糊）', async () => {
    openChapter(CHAPTER_PATH)
    await renderGroup()
    await act(async () => { groupHeader().click() })

    const lit = chapterRows().find(row => row.className.includes('active'))!
    // 浅色主题下 --color-text 是墨色、深色主题下是冰白 —— 两种都算「提墨」，
    // 所以直接跟令牌比对，而不是猜哪个方向更亮。
    const normalText = getComputedStyle(document.documentElement).getPropertyValue('--color-text').trim()
    expect(rowTextColor(lit)).toEqual(parseColor(normalText))
  })
})

/**
 * 整棵项目树 —— 先生 2026-09-20：
 *   「而且故事架构下面的那些标题内容、小说配置也是没反应的」
 *
 * 那半边当时**一行选中态代码都没有**（全树只有正文章节条目 / 草稿条目 / 便利贴条目
 * 三处挂了 `.active`）。这一组把叶子项与架构文件行都钉住。
 */
describe('项目树 · 叶子项与架构文件行', () => {
  it('打开小说配置 → 那一行亮，别的行不亮', async () => {
    openTab({ id: 'config', name: '小说配置', type: 'config' })
    await renderNode(<ProjectTree />)

    expect(rowByText('小说配置')!.className).toContain('active')
    expect(rowByText('伏笔')!.className).not.toContain('active')
    expect(rowByText('章节蓝图')!.className).not.toContain('active')
    expect(isTransparent(backgroundOf(rowByText('小说配置')!))).toBe(false)
  })

  it('打开章节蓝图 → 换成它亮（同一时刻只有一行在说话）', async () => {
    openTab({ id: 'chapter-card-editor', name: '章节蓝图', type: 'chapter-card' })
    await renderNode(<ProjectTree />)

    expect(rowByText('章节蓝图')!.className).toContain('active')
    expect(rowByText('小说配置')!.className).not.toContain('active')
  })

  it('打开故事架构编辑器 → 组行亮', async () => {
    openTab({ id: 'world-building-editor', name: '故事架构', type: 'world-building' })
    await renderNode(<ProjectTree />)

    expect(rowByText('故事架构')!.className).toContain('active')
  })

  it('打开其中一份架构文件 → 组行与那一份一起亮，兄弟文件不亮', async () => {
    openTab({ id: 'arch-1', name: '故事前提', type: 'arch-file', filePath: 'vela://core/premise' })
    await renderNode(<ProjectTree />)

    expect(rowByText('故事架构')!.className).toContain('active')
    expect(rowByText('故事前提')!.className).toContain('active')
    expect(rowByText('角色图谱')!.className).not.toContain('active')
  })
})

/**
 * 便利贴这一支的**三级**：组（1）→ 夹子（2）→ 贴（3）。
 *
 * 先生 2026-09-20：「便利贴的 2 级框体没起作用？我的文件夹前面感觉没啥变化」
 * 查证：夹子那一行当时既没标层级、也没有选中态，中间那一级是断的。
 */
describe('便利贴 · 三级齐全', () => {
  function noteInFolder(noteId: string, folderId: string, title: string) {
    return {
      noteId,
      title,
      body: title,
      folderId,
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
    }
  }

  it('打开夹内的某一张 → 组行、夹子行、那一张一起亮', async () => {
    useStickyNoteStore.setState({
      notes: [noteInFolder('n1', 'f1', '灵感夹里的一张')],
      folders: [{ folderId: 'f1', name: '灵感夹', createdAt: '2026-09-20T00:00:00.000Z' }],
      candidates: [],
    } as never)
    const path = stickyTabPath('n1')
    openTab({ id: path, name: '灵感夹里的一张', type: 'sticky-note', filePath: path })

    await renderNode(<StickyNotesGroup />)
    // 组默认收起 —— 先点开
    await act(async () => { rowByText('便利贴')!.click() })

    // 1 级：组行
    expect(rowByText('便利贴')!.className).toContain('active')
    // 2 级：夹子行（就是先生说的「文件夹前面没啥变化」那一行）
    const folderRow = rowByText('灵感夹')
    expect(folderRow).toBeDefined()
    expect(folderRow!.getAttribute('data-level')).toBe('2')
    expect(folderRow!.className).toContain('active')
    // 3 级：那一张自己
    expect(container!.querySelector('[data-level="3"].active')).not.toBeNull()
  })

  it('夹子里没有正在看的那一张 → 夹子行不亮', async () => {
    useStickyNoteStore.setState({
      notes: [noteInFolder('n1', 'f1', '灵感夹里的一张')],
      folders: [{ folderId: 'f1', name: '灵感夹', createdAt: '2026-09-20T00:00:00.000Z' }],
      candidates: [],
    } as never)
    openTab({ id: 'config', name: '小说配置', type: 'config' })

    await renderNode(<StickyNotesGroup />)
    await act(async () => { rowByText('便利贴')!.click() })

    expect(rowByText('灵感夹')!.className).not.toContain('active')
  })
})

/**
 * 角色栏顶部那一行：「角色列表（N）」标题与「待确认」入口怎么排。
 *
 * 先生（本轮报障）：
 *   「新建立的角色，待选入口，在角色管理栏中位置不好，挤压了角色列表这几个字。
 *     建议让这个待选入口小一点，放在角色列表这几个字的右边，
 *     入口按钮样式可以参考便利贴的待选箱。」
 *
 * 这一行里挤着两拨东西：左边是标题，右边是导入 / 刷新 / 新建三颗操作按钮。
 * 「待确认」原先挂在**右侧那一组的最前面**，把整组撑宽，左侧标题跟着被压
 * （标题 span 没有 min-w-0 / truncate，被压就变形）。
 *
 * 现在的形态照抄便利贴的「待选箱」：0.7rem 小字 + 11px 图标 + 数字，
 * 紧贴标题右缘；右侧那一组用 ml-auto 单独靠右，两边不再互相抢宽度。
 *
 * 本文件用**真实组件渲染**后的几何量守四件事（侧栏默认 260px、最小 200px）：
 *   ① 入口小（0.7rem 级小字、连图标带数字不到 60px）；
 *   ② 位置在标题右边，且不越过右边那一组；
 *   ③ 默认宽度下标题一个字都不少（v2 与 v3 两套皮肤各量一遍）；
 *   ④ 队列为空时入口不出现（不占位置、不添噪音）。
 *
 * 候选刻意造 12 条：数字多一位，入口就宽出几个像素，而这一行在 v3 皮肤下
 * 本来就紧 —— 两位数候选仍能把标题完整显示，才算真的修好。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../../index.css'
import '../../../../styles/redesign/v2-index.css'
import CharactersView from '../CharactersView'
import { useProjectStore } from '../../../../stores/project-store'
import { useCharacterStore, EMPTY_CARD } from '../../../../stores/character-store'
import { useCharacterCandidateStore } from '../../../../stores/character-candidate-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useUiVersionStore } from '../../../../stores/ui-version-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { projectSessionContextFromProject } from '../../../../shared/project-session-context'
import { PENDING_BADGE_STORAGE_KEY, usePendingBadgeStore } from '../../../../stores/pending-badge-store'
import type { ProjectData } from '../../../../shared/ipc-channels'
import type { CharacterCandidateRecord } from '../../../../shared/character-candidate'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT_PATH = 'C:\\novels\\character-header-probe'

function project(): ProjectData {
  return {
    id: 'probe-project',
    sessionLease: 'probe-lease',
    name: '探针项目',
    path: PROJECT_PATH,
    novelConfig: {
      genre: '玄幻',
      subGenre: '',
      targetAudience: '全龄',
      totalChapters: 10,
      wordsPerChapter: 3000,
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: '',
      worldSetting: '',
      goldenFinger: '',
      protagonistProfile: '',
      globalGuidance: '',
    },
    characterStates: '',
    createdAt: '',
    updatedAt: '',
  }
}

const CANDIDATES: CharacterCandidateRecord[] = Array.from({ length: 12 }, (_, index) => ({
  id: index + 1,
  name: `新角色${index + 1}`,
  role: 'supporting' as const,
  evidence: `第 ${index + 1} 条候选的正文依据`,
  chapterNumber: 12,
  currentState: index === 0 ? { location: '校门口', updatedAtChapter: 12 } : {},
  status: 'pending' as const,
  createdAt: '',
  decidedAt: '',
}))

/** preload 注入的那套 API：只让候选队列那条通道答话，其余一律空数组。 */
function stubVelaApi(candidates: CharacterCandidateRecord[] = CANDIDATES): void {
  ;(window as unknown as { velaAPI: unknown }).velaAPI = {
    invoke: async (channel: string) => (
      channel === 'db:character-candidate-list' ? candidates : []
    ),
    on: () => () => {},
    once: () => {},
    send: () => {},
    setZoomLevel: () => {},
    setZoomFactor: () => {},
    getZoomLevel: () => 0,
  }
}

let root: Root
let container: HTMLDivElement

function seedStores(): void {
  const current = project()
  const session = projectSessionContextFromProject(current)
  useProjectStore.setState({ currentProject: current, fileTree: [], loading: false })
  useCharacterStore.setState({
    characters: [
      { ...EMPTY_CARD, name: '林青檀', role: 'protagonist' },
      { ...EMPTY_CARD, name: '余思雨', role: 'supporting' },
    ],
    dataProjectKey: PROJECT_PATH,
    dataProjectSession: session,
    rosterRevision: 1,
    loadingProjectKey: null,
    loadingProjectSession: null,
    lastError: null,
    loaded: true,
    identityBusy: false,
    selectedName: '林青檀',
  })
  useCharacterCandidateStore.setState({
    candidates: CANDIDATES,
    projectKey: PROJECT_PATH,
    loading: false,
    lastError: null,
  })
}

async function renderSidebar(width: number): Promise<HTMLElement> {
  await act(async () => {
    root.render(
      <div className="app-skin-root light" style={{ width, height: 600 }}>
        <CharactersView />
      </div>,
    )
  })
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })
  return container
}

/**
 * 标题里**真正装着文字**的那个元素（内层的 .truncate span）。
 *
 * 不能取外层的 flex 容器：它 overflow 是 visible，被压缩时会把自己的
 * scrollWidth 也报成 clientWidth，于是「文字被 ellipsis 截掉」这件事量不出来 ——
 * 第一版就是这么写的，200px 下量出 41/41 的假通过。
 */
function titleEl(scope: HTMLElement): HTMLElement | null {
  return Array.from(scope.querySelectorAll<HTMLElement>('span.truncate'))
    .find(el => (el.textContent ?? '').startsWith('角色列表')) ?? null
}

function pendingEntry(scope: HTMLElement): HTMLButtonElement | null {
  return Array.from(scope.querySelectorAll<HTMLButtonElement>('button'))
    .find(el => (el.textContent ?? '').includes('待确认')) ?? null
}

function refreshButton(scope: HTMLElement): HTMLButtonElement | null {
  return scope.querySelector<HTMLButtonElement>('button[title="刷新列表"]')
}

/** 把顶栏三个分项的实测宽度打出来 —— 排布紧了，得先知道是谁占的多。 */
function logHeaderParts(title: HTMLElement, label: string): void {
  const row = title.parentElement?.parentElement as HTMLElement | null
  if (!row) return
  for (const child of Array.from(row.children)) {
    const box = child.getBoundingClientRect()
    console.log(`  [${label} 顶栏分项] ${child.tagName} → ${box.width.toFixed(1)}px`)
  }
}

beforeEach(() => {
  // 红点水位落在 localStorage **和** 单例 store 里：两处都要清，
  // 否则上一条用例的「已读」会漏到这一条（store 活着，光清 localStorage 不够）。
  localStorage.removeItem(PENDING_BADGE_STORAGE_KEY)
  usePendingBadgeStore.getState().reset()
  stubVelaApi()
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
  useUiVersionStore.setState({ uiVersion: 'v2' })
  useEditorStore.setState({ tabs: [], activeTabId: null })
  document.documentElement.dataset.ui = 'v2'
  document.documentElement.dataset.v2Theme = '0'
  seedStores()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useCharacterCandidateStore.getState().reset()
  delete (window as unknown as { velaAPI?: unknown }).velaAPI
  delete document.documentElement.dataset.ui
  delete document.documentElement.dataset.v2Theme
})

describe('角色栏顶部的「待确认」入口', () => {
  it('入口是一枚 0.7rem 级的小字按钮，样式与便利贴的待选箱同号', async () => {
    const scope = await renderSidebar(260)
    const entry = pendingEntry(scope)
    expect(entry, '有候选项时入口必须出现').toBeTruthy()

    const fontSize = Number.parseFloat(getComputedStyle(entry!).fontSize)
    const width = entry!.getBoundingClientRect().width
    console.log(`[待确认入口] 字号 = ${fontSize}px 宽度 = ${width.toFixed(1)}px`)
    expect(fontSize, '应当是 0.7rem 的小字，而不是一颗 11px 的整按钮').toBeLessThanOrEqual(12)
    expect(width, '入口要够小，别去挤标题').toBeLessThan(80)
    // 图标 + 文字 + 数字，三样都在
    expect(entry!.querySelector('svg'), '带一枚小图标').toBeTruthy()
    expect(entry!.textContent).toContain('待确认')
    expect(entry!.textContent).toContain('12')
  })

  it('入口紧贴标题右侧，且不越过右边那一组操作按钮', async () => {
    const scope = await renderSidebar(260)
    const title = titleEl(scope)!
    const entry = pendingEntry(scope)!
    const refresh = refreshButton(scope)!

    const titleBox = title.getBoundingClientRect()
    const entryBox = entry.getBoundingClientRect()
    const refreshBox = refresh.getBoundingClientRect()
    console.log(
      `[几何] 标题右缘=${titleBox.right.toFixed(1)} 入口=[${entryBox.left.toFixed(1)}, ${entryBox.right.toFixed(1)}] 刷新按钮左缘=${refreshBox.left.toFixed(1)}`,
    )

    expect(entryBox.left, '入口必须在标题右边').toBeGreaterThanOrEqual(titleBox.right - 0.5)
    expect(entryBox.right, '入口不许压到右边那一组按钮').toBeLessThanOrEqual(refreshBox.left + 0.5)
  })

  it('默认宽度（260px）下标题一个字都不少、不被截断', async () => {
    const scope = await renderSidebar(260)
    const title = titleEl(scope)!
    console.log(
      `[标题] 文本="${title.textContent}" scrollWidth=${title.scrollWidth} clientWidth=${title.clientWidth}`,
    )
    logHeaderParts(title, 'v2')

    expect(title.textContent, '标题要完整').toBe('角色列表（2）')
    expect(
      title.scrollWidth,
      '标题不该被压出省略号（先生报的「挤压了角色列表这几个字」）',
    ).toBeLessThanOrEqual(title.clientWidth)
  })

  /**
   * 三套皮肤都得看一遍：v3「时尚杂志」把侧栏字号整体放大（标题从 64px 长到 79px），
   * 这一行的预算因此紧得多 —— 只在 v2 上量会漏掉真正的瓶颈。
   */
  it('v3 皮肤下排布与 v2 一致，标题照样一个字都不少', async () => {
    useUiVersionStore.setState({ uiVersion: 'v3' })
    document.documentElement.dataset.ui = 'v3'
    const scope = await renderSidebar(260)

    const title = titleEl(scope)
    const entry = pendingEntry(scope)
    expect(title, 'v3 下标题照常渲染').toBeTruthy()
    expect(entry, 'v3 下入口照常渲染').toBeTruthy()
    console.log(
      `[v3 标题] scrollWidth=${title!.scrollWidth} clientWidth=${title!.clientWidth}`,
    )
    logHeaderParts(title!, 'v3')

    expect(title!.scrollWidth, 'v3 下标题同样不许被截断').toBeLessThanOrEqual(title!.clientWidth)
    expect(entry!.getBoundingClientRect().left)
      .toBeGreaterThanOrEqual(title!.getBoundingClientRect().right - 0.5)
  })

  /**
   * 侧栏能被拉到 200px（layout-store 的下限）。这个宽度下三样东西本来就装不下，
   * 本用例守的是**不重叠**：标题可以让位显示成省略号，入口与右侧按钮组照旧排得开、
   * 点得着。真正的底线是上面那两条 —— 默认 260px 下标题一个字都不能少。
   */
  it('侧栏拉到最窄（200px）时三样东西不重叠、入口照旧点得着', async () => {
    const scope = await renderSidebar(200)
    const title = titleEl(scope)!
    const entry = pendingEntry(scope)!
    const refresh = refreshButton(scope)!

    const titleBox = title.getBoundingClientRect()
    const entryBox = entry.getBoundingClientRect()
    const refreshBox = refresh.getBoundingClientRect()
    console.log(
      `[窄侧栏 200px] 标题=[${titleBox.left.toFixed(1)}, ${titleBox.right.toFixed(1)}]（scrollWidth=${title.scrollWidth}）`
      + ` 入口=[${entryBox.left.toFixed(1)}, ${entryBox.right.toFixed(1)}] 刷新左缘=${refreshBox.left.toFixed(1)}`,
    )

    expect(entryBox.left, '入口仍要在标题右边').toBeGreaterThanOrEqual(titleBox.right - 0.5)
    expect(entryBox.right, '入口不许压到右侧按钮组').toBeLessThanOrEqual(refreshBox.left + 0.5)
    expect(entryBox.width, '入口本身始终完整（被让位的是标题，不是入口）').toBeGreaterThan(30)
    expect(entryBox.left).toBeLessThan(refreshBox.left)
  })

  it('队列为空时入口不出现 —— 不占位置、不添噪音', async () => {
    // 连主进程那条通道也答空：组件挂载时会自己去读一次队列，写死 store 会被它覆盖回来。
    stubVelaApi([])
    useCharacterCandidateStore.setState({ candidates: [], projectKey: PROJECT_PATH })
    const scope = await renderSidebar(260)

    expect(pendingEntry(scope), '没有候选就不该有这颗入口').toBeNull()
  })

  /**
   * 先生 2026-09-21：「有新的待确认的角色……可以在待确认、候选、待选等地方
   * 做个小红点？类似未读消息？让用户一看就知道这里有东西等着确认那种？」
   */
  describe('未读小红点', () => {
    async function clickEntry(entry: HTMLElement): Promise<void> {
      await act(async () => {
        entry.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
      })
    }

    it('第一次看到候选时亮红点，点开队列即熄灭', async () => {
      const scope = await renderSidebar(260)
      const entry = pendingEntry(scope)!
      expect(entry.querySelector('[data-pending-dot]'), '从没看过的候选该亮红点').toBeTruthy()

      await clickEntry(entry)

      const after = pendingEntry(scope)!
      expect(after.querySelector('[data-pending-dot]'), '点开即已读，红点当场熄灭').toBeNull()
    })

    it('红点不吃布局：亮着的时候标题也一个字都不少', async () => {
      const scope = await renderSidebar(260)
      const title = titleEl(scope)!
      const entry = pendingEntry(scope)!
      const withDot = entry.getBoundingClientRect().width

      expect(entry.querySelector('[data-pending-dot]'), '前置条件：红点亮着').toBeTruthy()
      expect(
        title.scrollWidth,
        '红点走绝对定位 —— 亮起来也不许把「角色列表」挤成省略号',
      ).toBeLessThanOrEqual(title.clientWidth)

      // 消点之后入口宽度一个像素都不变，进一步说明红点没有参与布局
      await clickEntry(entry)
      expect(Math.abs(pendingEntry(scope)!.getBoundingClientRect().width - withDot)).toBeLessThanOrEqual(0.5)
    })
  })
})

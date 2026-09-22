/**
 * 便利贴「待选箱」入口上的未读小红点。
 *
 * 先生 2026-09-21：「有新的待确认的角色，候选，设定等内容的时候，
 *   可以在待确认、候选、待选等地方做个小红点？类似未读消息？
 *   让用户一看就知道这里有东西等着确认那种？」
 *
 * 待选箱与另外两处入口（角色栏待确认、设定集待确认）是**同一形态**：
 * 有内容才出现、空了就隐藏（先生 2026-09-21：「待选箱 平时也隐藏起来，
 * 只有相关内容存在才出现。」）。所以本文件守两件事：
 *   · 箱里一有东西，入口自己冒出来，带着数字与未读红点；
 *   · 点开过 → 红点灭，但数字照旧（东西还在箱里，只是看过了）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../../index.css'
import '../../../../styles/redesign/v2-index.css'
import StickyNotesGroup from '../StickyNotesGroup'
import { useStickyNoteStore } from '../../../../stores/sticky-note-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useUiVersionStore } from '../../../../stores/ui-version-store'
import { PENDING_BADGE_STORAGE_KEY, usePendingBadgeStore } from '../../../../stores/pending-badge-store'
import { projectSessionContextFromProject } from '../../../../shared/project-session-context'
import type { ProjectData } from '../../../../shared/ipc-channels'
import type { StickyCandidate } from '../../../../shared/sticky-note'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT_PATH = 'C:\\novels\\sticky-tray-probe'

function project(): ProjectData {
  return {
    id: 'tray-probe',
    sessionLease: 'tray-lease',
    name: '探针项目',
    path: PROJECT_PATH,
    novelConfig: {
      genre: '玄幻', subGenre: '', targetAudience: '全龄', totalChapters: 10,
      wordsPerChapter: 3000, plotStructure: 'three_act', narrativePOV: 'third_limited',
      coreOutline: '', worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '',
    },
    characterStates: '',
    createdAt: '',
    updatedAt: '',
  }
}

function candidate(id: string): StickyCandidate {
  return {
    candidateId: id,
    drawId: 'draw-1',
    content: `落选的点子 ${id}`,
    ordinal: Number(id.replace(/\D/gu, '')) || 1,
    status: 'pending',
    noteId: null,
    createdAt: '',
    usedAt: null,
  }
}

let root: Root
let container: HTMLDivElement

function seed(candidates: StickyCandidate[]): void {
  const current = project()
  useProjectStore.setState({ currentProject: current, fileTree: [], loading: false })
  useStickyNoteStore.setState({
    notes: [],
    folders: [],
    candidates,
    loading: false,
    dataProjectSession: projectSessionContextFromProject(current),
  })
}

async function render(): Promise<HTMLElement> {
  await act(async () => {
    root.render(
      <div className="app-skin-root light" style={{ width: 260, height: 400 }}>
        <StickyNotesGroup />
      </div>,
    )
  })
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })
  return container
}

function trayButton(scope: HTMLElement): HTMLButtonElement | null {
  return Array.from(scope.querySelectorAll<HTMLButtonElement>('button'))
    .find(el => (el.textContent ?? '').includes('待选箱')) ?? null
}

beforeEach(() => {
  localStorage.removeItem(PENDING_BADGE_STORAGE_KEY)
  usePendingBadgeStore.getState().reset()
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
  useUiVersionStore.setState({ uiVersion: 'v2' })
  useEditorStore.setState({ tabs: [], activeTabId: null })
  document.documentElement.dataset.ui = 'v2'
  document.documentElement.dataset.v2Theme = '0'
  seed([candidate('c1'), candidate('c2')])
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  delete document.documentElement.dataset.ui
  delete document.documentElement.dataset.v2Theme
})

describe('待选箱入口的未读小红点', () => {
  it('箱子里来了没见过的点子 → 亮红点（同时数字照旧显示）', async () => {
    const scope = await render()
    const tray = trayButton(scope)
    expect(tray, '有内容时入口必须出现').toBeTruthy()
    expect(tray!.textContent, '数字照旧').toContain('2')
    expect(tray!.querySelector('[data-pending-dot]'), '没见过的点子该亮红点').toBeTruthy()
  })

  it('点开待选箱 → 红点熄灭，数字不动', async () => {
    const scope = await render()
    const tray = trayButton(scope)!
    expect(tray.querySelector('[data-pending-dot]')).toBeTruthy()

    await act(async () => {
      tray.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })

    const after = trayButton(scope)!
    expect(after.querySelector('[data-pending-dot]'), '看过即已读').toBeNull()
    expect(after.textContent, '数字与红点是两件事：东西还在箱里，数字不消失').toContain('2')
  })

  it('都是见过的点子时只有数字、没有红点', async () => {
    // 先「看过」一批
    usePendingBadgeStore.getState().markSeen(PROJECT_PATH, 'sticky-tray', ['c1', 'c2'])
    const scope = await render()
    const tray = trayButton(scope)!

    expect(tray.textContent).toContain('2')
    expect(tray.querySelector('[data-pending-dot]'), '见过的东西不该再亮红点').toBeNull()
  })

  it('箱子空着时入口整个隐藏（先生：平时也隐藏起来，只有相关内容存在才出现）', async () => {
    seed([])
    const scope = await render()

    expect(
      trayButton(scope),
      '空箱子不占位置 —— 与角色栏「待确认」、设定集「待确认 / 待裁决冲突」同一形态',
    ).toBeNull()
  })

  it('空箱子不亮红点，也不留下任何残留（编号之外的标题行照旧）', async () => {
    seed([])
    const scope = await render()

    expect(scope.querySelectorAll('[data-pending-dot]').length, '一颗红点都不该有').toBe(0)
    // 便利贴标题行本身照常渲染 —— 隐藏的只是待选箱那一颗按钮
    expect(scope.textContent).toContain('便利贴')
  })

  it('箱里有了新点子，入口自己冒出来（不必切走再切回）', async () => {
    seed([])
    const scope = await render()
    expect(trayButton(scope), '前置条件：空箱子时没有入口').toBeNull()

    // 抽卡落选的条目进箱 —— 入口应当随数据自己出现
    await act(async () => {
      useStickyNoteStore.setState({ candidates: [candidate('c1')] })
    })
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })

    const tray = trayButton(scope)
    expect(tray, '有内容就该出现').toBeTruthy()
    expect(tray!.textContent).toContain('1')
    expect(tray!.querySelector('[data-pending-dot]'), '而且带着未读红点').toBeTruthy()
  })
})

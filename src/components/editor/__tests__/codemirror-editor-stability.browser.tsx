/* eslint-disable react-refresh/only-export-components -- 浏览器测试文件里同时声明测试外壳组件与辅助函数，本文件不参与 HMR 热更新 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import '../../../index.css'
import '../../../styles/redesign/v2-index.css'

import CodeMirrorEditor from '../CodeMirrorEditor'
import { useLocaleStore } from '../../../stores/locale-store'
import { useUiVersionStore } from '../../../stores/ui-version-store'

/**
 * 先生（打字手感 / 选区反馈）的回归保护。
 *
 * 两个曾经真实发生的缺陷：
 *  1. @uiw/react-codemirror 会把 onUpdate 塞进扩展数组并列为 useLayoutEffect 依赖，
 *     onUpdate 引用一变就重建编辑器状态。父组件（DraftEditor）内联传 onChange，
 *     每次渲染都是新函数 —— 于是每敲一个字都重建一次编辑器，输入法组合被打断、
 *     中文标点重复上屏。修法是把 onUpdate 用 ref 稳定住，本用例锁死这一点：
 *     父组件重渲染后，EditorView 的 state 引用必须原地不动。
 *  2. 选区被 CodeMirror 运行时主题的 --color-hover 压住（同为 !important 但特异性更高），
 *     看起来等于没有选中反馈。本用例直接读 .cm-selectionBackground 的计算样式。
 */

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | undefined
let root: Root | undefined

function Harness({ tick }: { tick: number }) {
  return (
    <CodeMirrorEditor
      mode="prose"
      content={'夜色沉了下来。\n\n他站在门口，没有说话。'}
      editable
      hideStatusBar
      // 刻意内联：模拟 DraftEditor 每次渲染都新建回调的真实情况
      onChange={() => { void tick }}
      onCharCountChange={() => { void tick }}
    />
  )
}

async function renderHarness(tick: number) {
  await act(async () => {
    root?.render(<Harness tick={tick} />)
  })
}

function currentView(): EditorView {
  const dom = container?.querySelector('.cm-editor')
  if (!dom) throw new Error('未找到 .cm-editor')
  const view = EditorView.findFromDOM(dom as HTMLElement)
  if (!view) throw new Error('未能从 DOM 取回 EditorView')
  return view
}

describe('CodeMirrorEditor 打字手感', () => {
  beforeEach(async () => {
    useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
    useUiVersionStore.setState({ uiVersion: 'v2' })
    document.documentElement.dataset.ui = 'v2'
    document.documentElement.dataset.v2Theme = '0'
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await renderHarness(0)
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    container = undefined
    root = undefined
  })

  it('父组件重渲染不会替换编辑器状态（否则输入法组合会被打断）', async () => {
    const view = currentView()
    const stateBefore = view.state

    // 模拟打字引发的连锁：store 更新 → 父组件重渲染 → 内联回调换新引用
    await renderHarness(1)
    await renderHarness(2)
    await renderHarness(3)

    expect(currentView()).toBe(view)
    expect(currentView().state).toBe(stateBefore)
  })

  it('正文内容仍然照常显示与编辑', async () => {
    const view = currentView()
    expect(view.state.doc.toString()).toContain('夜色沉了下来。')

    await act(async () => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: '他走了。' } })
    })
    expect(currentView().state.doc.toString()).toContain('他走了。')
  })

  it('选区有可见的朱砂底，而不是被主题压成浅灰的 --color-hover', async () => {
    const view = currentView()
    await act(async () => {
      // 自绘选区的背景层只在编辑器持有焦点时绘制
      view.focus()
      view.dispatch({ selection: { anchor: 0, head: 4 } })
      // drawSelection 在下一个测量帧才写 DOM，同步查询会扑空
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })

    const selectionLayer = container?.querySelector('.cm-selectionLayer')
    const layer = container?.querySelector('.cm-selectionBackground') as HTMLElement | null
    console.log(
      `诊断：hasFocus=${view.hasFocus} selectionLayer=${selectionLayer ? '有' : '无'} `
      + `selectionBackground=${layer ? '有' : '无'} ranges=${view.state.selection.ranges.length}`,
    )
    expect(layer, `自绘选区层缺失：${selectionLayer ? '' : '连 .cm-selectionLayer 都没有'}`).not.toBeNull()

    const background = getComputedStyle(layer as HTMLElement).backgroundColor
    console.log(`诊断：选区计算样式 background=${background}`)
    // 聚焦态取更实的一档：--seal-rgb 169,50,38 的 40%
    expect(background).toBe('rgba(169, 50, 38, 0.4)')
  })

  /**
   * 先生报的严重问题：编辑器里的字体设置失效。
   * 真凶是 v2 皮肤把 .cm-content/.cm-scroller 的 font-family 写死成 var(--serif)，
   * 而产品是经 theme-store 把写作字体写到 <html> 内联的 --font-writing 上。
   * 本用例模拟设置页切换字体，正文必须跟着走。
   */
  it('正文跟随设置里的写作字体（--font-writing），不被皮肤写死', async () => {
    const content = container?.querySelector('.cm-content') as HTMLElement | null
    expect(content, '未找到 .cm-content').not.toBeNull()

    try {
      await act(async () => {
        document.documentElement.style.setProperty('--font-writing', '"Noto Serif SC", serif')
      })
      const first = getComputedStyle(content as HTMLElement).fontFamily
      console.log(`诊断：写作字体设为思源宋体后，.cm-content 字体 = ${first}`)
      expect(first).toContain('Noto Serif SC')

      await act(async () => {
        document.documentElement.style.setProperty('--font-writing', '"LXGW WenKai", serif')
      })
      const second = getComputedStyle(content as HTMLElement).fontFamily
      console.log(`诊断：写作字体设为霞鹜文楷后，.cm-content 字体 = ${second}`)
      expect(second).toContain('LXGW WenKai')
    } finally {
      document.documentElement.style.removeProperty('--font-writing')
    }
  })

  /**
   * 先生（界面字体）：v2 外壳的 UI 走的是 demo 自带的 --sans，而产品的界面字体
   * 设置写到 --font-sans。两者必须接上，否则侧栏、菜单、按钮都不听设置。
   */
  it('v2 界面元素跟随设置里的界面字体（--font-sans）', async () => {
    const probe = document.createElement('div')
    probe.style.fontFamily = 'var(--sans)'
    document.body.append(probe)

    try {
      await act(async () => {
        document.documentElement.style.setProperty('--font-sans', '"Noto Sans SC", sans-serif')
      })
      const applied = getComputedStyle(probe).fontFamily
      console.log(`诊断：界面字体设为思源黑体后，--sans 解析为 = ${applied}`)
      expect(applied).toContain('Noto Sans SC')

      await act(async () => {
        document.documentElement.style.setProperty('--font-sans', "'Inter', system-ui, sans-serif")
      })
      const switched = getComputedStyle(probe).fontFamily
      console.log(`诊断：界面字体切到 Inter 后，--sans 解析为 = ${switched}`)
      expect(switched).toContain('Inter')

      // 未设置 --font-sans 时必须回落到 demo 原本的系统无衬线栈（默认观感仍是皮肤的样子）
      await act(async () => {
        document.documentElement.style.removeProperty('--font-sans')
      })
      const fallback = getComputedStyle(probe).fontFamily
      console.log(`诊断：未设置界面字体时的回落值 = ${fallback}`)
      expect(fallback).toContain('system-ui')
    } finally {
      document.documentElement.style.removeProperty('--font-sans')
      probe.remove()
    }
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import '../../../../index.css'
import '../../../../styles/redesign/v2-index.css'
import '../../../../styles/magazine/mag-index.css'
import { forceImportant } from '../magazine/force-important'

/**
 * `forceImportant` · 行为契约（真渲染）。
 *
 * 这个工具存在的唯一理由是：**v2 的图谱装帧把关键属性锁了 `!important`**，
 * 而在 CSS 的权重规则里，样式表里的 `!important` 会压过内联的普通声明 ——
 * 所以「写在 style 里」并不等于「一定赢」，只有 `setProperty(..., 'important')` 赢。
 *
 * 这份测试把那条实测结论**固化成断言**：
 *   ① 光写内联普通值 → 压不过（v2 的 !important 赢）
 *   ② 用 forceImportant  → 压得过
 * 顺便证明「React 的 style 对象不支持 !important」这件事（①就是它的后果）。
 */
let host: HTMLDivElement

beforeEach(() => {
  document.documentElement.setAttribute('data-ui', 'v2')
  document.documentElement.setAttribute('data-mag', '1')
  document.documentElement.setAttribute('data-v2-theme', '0')

  host = document.createElement('div')
  host.style.cssText = 'width:600px;height:400px'
  host.innerHTML = `
    <div class="relation-view">
      <main class="relation-main">
        <div class="relation-canvas mg-graph-canvas">
          <div class="relation-stage">
            <div class="relation-node mg-graph-node">
              <div class="portrait mg-node-portrait"></div>
            </div>
          </div>
        </div>
      </main>
    </div>`
  document.body.append(host)
})

afterEach(() => {
  host.remove()
  for (const name of ['data-mag', 'data-ui', 'data-v2-theme']) {
    document.documentElement.removeAttribute(name)
  }
})

const portrait = () => host.querySelector('.mg-node-portrait') as HTMLElement
const canvas = () => host.querySelector('.mg-graph-canvas') as HTMLElement

describe('v2 基线：这些属性确实被 !important 锁着', () => {
  it('节点头像的圆角锁在 50%', () => {
    expect(getComputedStyle(portrait()).borderRadius).toBe('50%')
  })

  it('画布有自己的一层背景', () => {
    expect(getComputedStyle(canvas()).backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
  })
})

describe('光写内联普通值压不过（这就是 React style 对象的下场）', () => {
  it('内联设 borderRadius: 0，实际仍是 50%', () => {
    portrait().style.borderRadius = '0'
    expect(getComputedStyle(portrait()).borderRadius).toBe('50%')
  })

  it('内联设 background: transparent，实际仍是原色', () => {
    canvas().style.background = 'transparent'
    expect(getComputedStyle(canvas()).backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
  })
})

describe('forceImportant 压得过', () => {
  it('圆角归零', () => {
    forceImportant({ 'border-radius': '0' })(portrait())
    expect(getComputedStyle(portrait()).borderRadius).toBe('0px')
  })

  it('画布背景透明 —— 「无感背景」靠的就是这一条', () => {
    forceImportant({ background: 'transparent' })(canvas())
    expect(getComputedStyle(canvas()).backgroundColor).toBe('rgba(0, 0, 0, 0)')
  })

  it('一次可以写多条', () => {
    forceImportant({
      'border-radius': '0',
      border: '2px solid rgb(22, 21, 26)',
    })(portrait())
    const style = getComputedStyle(portrait())
    expect(style.borderRadius).toBe('0px')
    expect(style.borderTopWidth).toBe('2px')
  })

  it('传 null 不炸（React 卸载时会回调 null）', () => {
    expect(() => forceImportant({ 'border-radius': '0' })(null)).not.toThrow()
  })
})

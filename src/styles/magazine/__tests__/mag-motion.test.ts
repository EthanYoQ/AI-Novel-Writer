/**
 * V3 动效层 · 契约测试（node 环境）。
 *
 * 先生对动效只有一句口径：**「这个动画太慢，会让用户觉得卡顿。」**
 * 这一层就是照那句话写的，所以三条纪律必须钉住：
 *   ① 时间短：一律 160–240ms（这条最容易在后续改动里被悄悄拉长）
 *   ② 只做进场，不做退场；且不碰面板宽高（那是拖拽调尺寸的活，加过渡会「粘手」）
 *   ③ 减少动效时整层让路（但状态类的东西不能一起关掉）
 *   ④ 分家：每条规则都带 [data-mag]，v2/v1 的「立刻出现」保持不变
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const motion = readFileSync(
  resolve(process.cwd(), 'src/styles/magazine/mag-motion.css'),
  'utf8',
)
const body = motion.replace(/\/\*[\s\S]*?\*\//g, '')

/** 所有动画时长（毫秒） */
const durations = [...body.matchAll(/(\d+)ms/g)].map((match) => Number(match[1]))

describe('动效层 · 时间', () => {
  it('每一处动画都在 160–240ms 之间 —— 比一次眨眼还短', () => {
    expect(durations.length).toBeGreaterThan(4)
    for (const value of durations) {
      expect(value).toBeGreaterThanOrEqual(160)
      expect(value).toBeLessThanOrEqual(240)
    }
  })

  it('没有任何 300ms 以上的动画（先生判定「卡顿」的那一档）', () => {
    expect(durations.every((value) => value <= 240)).toBe(true)
  })
})

describe('动效层 · 动作', () => {
  it('只做进场：每个 keyframes 都是 from → to，没有往返或延迟', () => {
    const frames = [...body.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g)]
    expect(frames.length).toBeGreaterThanOrEqual(5)
    for (const [, , block] of frames) {
      expect(block).toContain('from')
      expect(block).toContain('to')
      expect(block).not.toContain('50%')
      expect(block).not.toContain('animation-delay')
    }
  })

  it('位移很克制：内容翻页只挪 10px，没有大幅滑入', () => {
    expect(body).toContain('translateX(10px)')
    const shifts = [...body.matchAll(/translate[XY]\((\d+)px\)/g)].map((m) => Number(m[1]))
    for (const shift of shifts) {
      expect(shift).toBeLessThanOrEqual(10)
    }
  })

  it('不碰面板的宽高 —— 加过渡会让拖拽调尺寸「粘手」', () => {
    expect(body).not.toMatch(/transition:[^;]*\b(width|height)\b/)
    expect(body).not.toMatch(/animation:[^;]*\b(width|height)\b/)
  })

  it('编辑区内容只淡入、不做位移（里面有 CodeMirror，位移会让光标抖）', () => {
    const editorContent = body.match(
      /html\[data-ui='v2'\]\[data-mag\]\s*\.edit-body\s*>\s*\*\s*\{([^}]*)\}/,
    )?.[1] ?? ''
    expect(editorContent).toContain('mag-content-in')
    const keyframe = body.match(/@keyframes\s+mag-content-in\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(keyframe).not.toContain('translate')
  })
})

describe('动效层 · 让路与分家', () => {
  it('系统「减少动效」时这一层全部关掉', () => {
    const reduce = body.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*)\}\s*$/)?.[1] ?? ''
    expect(reduce).toContain('animation: none')
    expect(reduce.length).toBeGreaterThan(60)
  })

  it('每一条规则都带 [data-mag]（v2 的「立刻出现」一字未改）', () => {
    const selectors = [...body.matchAll(/(^|\})\s*([^{}@]+)\{/g)]
      .map((match) => match[2].trim())
      // @keyframes 里的 from / to / 百分比不是选择器，跳过
      .filter((selector) => selector.length > 0)
      .filter((selector) => !/^(from|to|[\d.]+%)$/.test(selector))
      .filter((selector) => !selector.startsWith('@'))
    expect(selectors.length).toBeGreaterThan(5)
    for (const selector of selectors) {
      expect(selector).toContain("[data-mag]")
    }
  })
})

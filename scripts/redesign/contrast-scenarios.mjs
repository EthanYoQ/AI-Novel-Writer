// #382 说明文字对比度：走一遍书房、外壳、运行侧页、架构、角色档案、设置，把画面上每一处 --ink-3 文字对它实际底色的对比度收进 measured。
// 普通字号不低于 4.5:1，大字号（24px 起，或 18.66px 起且粗体）不低于 3:1；禁用控件按 WCAG 1.4.3 豁免。全部量完再断言，对照构建上失败时能看到每一处的值。
import assert from 'node:assert/strict'

import * as architecture from './pages/architecture.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

/** 页面上颜色等于 --ink-3 的文字：按类名去重，留最低的一处。底色沿祖先逐层叠加半透明背景求出。 */
export function captionContrast(page) {
  return page.evaluate(() => {
    const parse = value => {
      const numbers = value.match(/[\d.]+/g).map(Number)
      const [r, g, b] = value.startsWith('color(') ? numbers.slice(0, 3).map(channel => channel * 255) : numbers.slice(0, 3)
      return { r, g, b, a: numbers[3] ?? 1 }
    }
    const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a), a: 1 })
    const backdrop = element => {
      const layers = []
      for (let node = element; node; node = node.parentElement) {
        const color = parse(getComputedStyle(node).backgroundColor)
        if (color.a > 0) layers.push(color)
        if (color.a === 1) break
      }
      return layers.reverse().reduce((bottom, top) => over(top, bottom), { r: 255, g: 255, b: 255, a: 1 })
    }
    const luminance = ({ r, g, b }) => [r, g, b].map(value => value / 255)
      .map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
    const ratio = (a, b) => {
      const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (high + 0.05) / (low + 0.05)
    }
    const shell = document.querySelector('[data-shell-presentation="stage"]')
    const probe = document.createElement('span')
    probe.style.color = 'var(--ink-3)'
    shell.append(probe)
    const ink3 = getComputedStyle(probe).color
    probe.remove()
    const lowest = new Map()
    for (const element of document.body.querySelectorAll('*')) {
      const style = getComputedStyle(element)
      if (style.color !== ink3 || style.visibility !== 'visible') continue
      if (![...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) continue
      const rect = element.getBoundingClientRect()
      if (rect.width <= 1 || rect.height <= 1) continue
      if (element.closest(':disabled, [aria-disabled="true"]')) continue
      const size = parseFloat(style.fontSize)
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700)
      const key = typeof element.className === 'string' && element.className.trim()
        ? `.${element.className.trim().split(/\s+/).join('.')}` : `${element.parentElement?.className?.split?.(/\s+/)[0] ?? ''} > ${element.tagName.toLowerCase()}`
      const value = Math.round(ratio(parse(style.color), backdrop(element)) * 100) / 100
      const previous = lowest.get(key)
      if (!previous || value < previous.ratio) {
        lowest.set(key, { key, text: element.textContent.trim().slice(0, 24), size, ratio: value, minimum: large ? 3 : 4.5 })
      }
    }
    return [...lowest.values()].sort((a, b) => a.ratio - b.ratio)
  })
}

export const CONTRAST_SCENARIOS = {
  'caption-contrast': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake, shoot }) => {
    const measured = {}
    const measure = async (where) => {
      await page.waitForTimeout(300)
      measured[where] = await captionContrast(page)
      await shoot(`caption-${where}`)
    }
    await measure('shell')

    fake.gate.hold()
    await blueprint.open(page)
    await blueprint.writeNext(page)
    await runSheet.waitUntilOpen(page)
    await measure('run-active')
    fake.gate.release()
    await runSheet.waitForRunDone(page)
    await measure('run-done')
    await runSheet.tab(page, '历史').click()
    await measure('run-history')

    await architecture.open(page)
    await measure('architecture')
    await architecture.openCast(page)
    await measure('cast')

    await stage.openSettings(page)
    await measure('settings-models')
    await stage.showSettingsPage(page, '外观')
    await measure('settings-appearance')
    await stage.closeSettings(page)

    await stage.backToLibrary(page, STAGE_SAMPLE.name)
    await measure('library')
    await stage.previewBook(page, STAGE_SAMPLE.name)
    await measure('library-preview')

    const failures = Object.entries(measured).flatMap(([where, rows]) => rows.filter(row => row.ratio < row.minimum).map(row => ({ where, ...row })))
    assert.deepEqual(failures, [], `说明文字对比度不足\n${JSON.stringify(measured, null, 1)}`)
    return measured
  } },
}

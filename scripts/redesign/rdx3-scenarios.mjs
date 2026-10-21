// RD-X3 外部审查修复的实机场景：浮层在小窗口里的位置与内部滚动、键盘焦点环、导入对话框的主按钮数、缩窗后的提示栈、长作品名的顶栏。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { FAKE_MODEL } from './fake-model.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as chapter from './pages/chapter.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as materials from './pages/materials.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as project from './pages/project.mjs'
import * as shell from './pages/shell.mjs'
import * as stage from './pages/stage.mjs'
import { decodePng } from './png.mjs'
import { seedWithCandidate } from './run-scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'
import { seedStageSample } from './scenarios.mjs'

const DEAD = ['林岚', '守塔人', '阿潮']
const LONG_NAME = '雾钟每晚提前一刻响起'.repeat(8)

/** 第 3 章的出场人物是三位，主进程的连续性事实写他们都已死：写作弹层里出三条一致性预检提醒。 */
const withThreeFindings = context => seedStageSample(context, { beforeReload: async ({ page, invoke, path: projectPath, session }) => {
  assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber: 3, title: STAGE_SAMPLE.titles[2], role: '发展',
    purpose: '推进灯塔与沉船的线索', keyEvents: '林岚在灯塔里找到新的线索', characters: DEAD, userGuidance: '' }, projectPath, session)).success, true)
} })

async function injectThreeDead(app, names) {
  const wrapped = await app.evaluate(({ ipcMain }, dead) => {
    const handlers = ipcMain._invokeHandlers
    if (!(handlers instanceof Map) || !handlers.has('db:continuity-list-before')) return false
    globalThis.__rdx3ContinuityOriginal = handlers.get('db:continuity-list-before')
    handlers.set('db:continuity-list-before', () => [{
      draftId: 1, chapterNumber: 1, chapterTitle: '旧港', chapterNotes: '风暴之夜。',
      source: { draftId: 1, finalizationId: 'rdx3-fixture', chapterNumber: 1, contentHash: 'a'.repeat(64) },
      sourceStatus: 'current',
      facts: dead.map(name => ({ category: 'character-state', entities: [name], statement: `${name}已经死亡。`, sourceChapter: 1, evidence: `${name}在风暴里没有再回来。` })),
    }])
    return true
  }, names)
  assert.ok(wrapped, '能在主进程里替换连续性事实的读取')
}

const restoreContinuity = app => app.evaluate(({ ipcMain }) => ipcMain._invokeHandlers.set('db:continuity-list-before', globalThis.__rdx3ContinuityOriginal))

/** 主进程里扣住「清除生成内容」，放行时返回给定的失败；原处理记下来由 restoreClear 放回。 */
async function gateClear(app, error) {
  const wrapped = await app.evaluate(({ ipcMain }, message) => {
    const handlers = ipcMain._invokeHandlers
    if (!(handlers instanceof Map) || !handlers.has('db:project-clear-generated-data')) return false
    let release
    const gate = { hit: false, opened: new Promise(resolve => { release = resolve }) }
    gate.release = release
    globalThis.__rdx3ClearGate = gate
    globalThis.__rdx3ClearOriginal = handlers.get('db:project-clear-generated-data')
    handlers.set('db:project-clear-generated-data', async () => {
      gate.hit = true
      await gate.opened
      return { success: false, error: message }
    })
    return true
  }, error)
  assert.ok(wrapped, '能在主进程里替换清除生成内容的处理')
}

const restoreClear = app => app.evaluate(({ ipcMain }) => ipcMain._invokeHandlers.set('db:project-clear-generated-data', globalThis.__rdx3ClearOriginal))

/** 下层露在上层外面的那一点被上层遮罩压住：命中上层的遮罩，截图里比上层纸面暗。 */
function assertCovered(edge, scrim, message) {
  assert.ok(edge, `${message}：下层有露在上层外面的部分`)
  assert.ok(edge.hit.split(' ').includes(scrim) && edge.edgeLuma <= edge.paperLuma - 10, `${message}：${JSON.stringify(edge)}`)
}

/**
 * 退出确认与「清除失败」提示叠放。promptFirst 为 false 时先关窗、退出确认开着时放行失败；为 true 时先放行失败、提示开着时关窗，
 * 失败说明写长，提示比退出确认高，上下沿露在外面。
 */
const promptAndExit = ({ promptFirst }) => ({ model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page, shoot }) => {
  await stage.stageButton(page, '设定').click()
  await stage.dirtySetup(page)
  await gateClear(app, promptFirst ? ['磁盘只读', ...Array.from({ length: 14 }, (_, index) => `第 ${index + 1} 份蓝图没有清除。`)].join('\n') : '磁盘只读')
  await stage.openWorkMenuItem(page, STAGE_SAMPLE.name, '清除生成内容…')
  // 只清蓝图：清故事架构会先被设定里没保存的输入拦下
  const kinds = page.locator('.pi-check-row > .pi-check')
  await kinds.nth(0).click()
  await kinds.nth(2).click()
  await page.getByRole('button', { name: '清除所选' }).click()
  for (const deadline = Date.now() + 10_000; !(await app.evaluate(() => globalThis.__rdx3ClearGate.hit)); await page.waitForTimeout(50)) {
    assert.ok(Date.now() < deadline, '10 秒内没有发出清除')
  }
  const exit = stage.exitDialog(page)
  const prompt = page.locator('[role="alertdialog"]').filter({ hasText: '清除失败' })
  if (promptFirst) {
    await app.evaluate(() => globalThis.__rdx3ClearGate.release())
    await prompt.waitFor({ state: 'visible' })
    await shell.requestWindowClose(app)
    await exit.waitFor({ state: 'visible' })
    const observed = { exitOnTop: await stage.isTopmost(exit), focusInExit: await exit.evaluate(element => element.contains(document.activeElement)) }
    const edge = await stage.exposedEdge(page, prompt, exit)
    assertCovered(edge, 'stage-exit-scrim', '提示开着时弹出的退出确认，遮罩压住提示露在外面的上下沿')
    await shoot('rdx3-exit-over-prompt-stacked')
    await exit.getByText('取消', { exact: true }).click()
    await exit.waitFor({ state: 'detached' })
    observed.promptOnTop = await stage.isTopmost(prompt)
    await prompt.getByRole('button', { name: '确定' }).click({ timeout: 5_000 })
    await prompt.waitFor({ state: 'detached' })
    assert.deepEqual(observed, { exitOnTop: true, focusInExit: true, promptOnTop: true }, '提示开着时关窗：退出确认在上、焦点在它里面，取消后回到提示')
    return { ...observed, edge }
  }
  await shell.requestWindowClose(app)
  await exit.waitFor({ state: 'visible' })
  await app.evaluate(() => globalThis.__rdx3ClearGate.release())
  await prompt.waitFor({ state: 'visible' })
  await shoot('rdx3-prompt-over-exit-alert')
  const observed = { promptOnTop: await stage.isTopmost(prompt) }
  const edge = await stage.exposedEdge(page, exit, prompt)
  assertCovered(edge, 'pi-scrim--prompt', '退出确认开着时到达的提示，遮罩压住退出确认露在外面的上沿')
  await prompt.getByRole('button', { name: '确定' }).click({ timeout: 5_000 })
  await prompt.waitFor({ state: 'detached' })
  observed.exitStillOpen = await exit.isVisible()
  observed.exitOnTop = await stage.isTopmost(exit)
  assert.deepEqual(observed, { promptOnTop: true, exitStillOpen: true, exitOnTop: true }, '退出确认开着时到达的错误提示在它上面、点得到，确定后回到退出确认')
  return { ...observed, edge }
}, after: async ({ app, page }) => {
  await restoreClear(app)
  if (await stage.exitDialog(page).count()) await stage.exitDialog(page).getByText('取消', { exact: true }).click()
  await page.keyboard.press('Escape')
} })

async function setViewport(page, width, height) {
  await page.setViewportSize({ width, height })
  await page.waitForFunction(size => innerWidth === size.width && innerHeight === size.height, { width, height })
}

/** 写作弹层在 width×height 的窗口里：三条预检提醒时停在视口内，内部滚到底点得到「仅本次忽略」，内部滚动不关闭弹层。 */
const popoverIn = (width, height) => ({ model: true, shell: 'stage', setup: withThreeFindings, run: async ({ app, page, shoot }) => {
  await setViewport(page, width, height)
  await injectThreeDead(app, DEAD)
  await blueprint.open(page)
  await blueprint.writeNext(page)
  await blueprint.preflight(page).waitFor({ state: 'visible' })
  await blueprint.popover(page).getByText(/一致性预检 · 3 条线索提醒/).waitFor({ state: 'visible' })
  const layer = blueprint.popover(page)
  const box = await layer.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, viewport: innerHeight, scrolls: element.scrollHeight > element.clientHeight, maxHeight: element.style.maxHeight }
  })
  assert.ok(box.top >= 0 && box.bottom <= box.viewport - 8, `弹层停在视口内：${box.top}–${box.bottom} / ${box.viewport}`)
  assert.ok(box.scrolls, '内容高过可用空间时在弹层内部滚动')
  await shoot(`rdx3-popover-${width}x${height}-top`)
  await layer.evaluate(element => { element.scrollTop = element.scrollHeight })
  await page.waitForTimeout(200)
  assert.equal(await layer.count(), 1, '弹层内部滚动不关闭弹层')
  const ignore = blueprint.preflight(page).getByRole('button', { name: '仅本次忽略' })
  const hit = await ignore.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { inside: rect.bottom <= innerHeight, hit: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === element }
  })
  assert.deepEqual(hit, { inside: true, hit: true }, '滚到底后「仅本次忽略」在视口内且点得到')
  return box
}, after: async ({ app, page }) => {
  await restoreContinuity(app)
  await page.keyboard.press('Escape')
} })

/** 按 Tab 直到焦点落在 target 上，读它的 box-shadow（内容标签的环画在整个标签的 ::after 上，读那条边），截一张它周围的图。 */
async function tabTo(page, target, shoot, name, limit = 60) {
  const handle = await target.elementHandle()
  for (let step = 0; step < limit; step++) {
    if (await handle.evaluate(element => element === document.activeElement)) {
      const ring = await handle.evaluate((element, contentTab) => {
        const tab = element.closest(contentTab)
        const boxShadow = tab ? `${getComputedStyle(tab, '::after').borderTopColor} ${getComputedStyle(tab, '::after').borderTopWidth}` : getComputedStyle(element).boxShadow
        return { boxShadow, focusVisible: element.matches(':focus-visible') }
      }, stage.CONTENT_TAB)
      await shoot(name)
      return ring
    }
    await page.keyboard.press('Tab')
  }
  throw new Error(`${name}：按 ${limit} 次 Tab 没有到达`)
}

const hasRing = ({ boxShadow, focusVisible }, accent) => focusVisible && boxShadow.includes(accent)

/** 主进程里把第 4 章最新稿的读取扣住，直到 release：定稿后自动打开下一章的那一步停在这里，等作者在设置页里改出未保存的输入。 */
async function holdNextChapterLookup(app) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const original = handlers.get('db:draft-get-latest')
    let release
    const gate = { hit: false, released: false, opened: new Promise(resolve => { release = resolve }) }
    gate.release = () => { gate.released = true; release() }
    globalThis.__rdx3NextChapterGate = gate
    handlers.set('db:draft-get-latest', async (event, chapterNumber, ...rest) => {
      if (chapterNumber === 4 && !gate.released) {
        gate.hit = true
        await gate.opened
      }
      return original(event, chapterNumber, ...rest)
    })
  })
}

/** 写作弹层的出现与消失、每次焦点移动，按时间记在页面里。 */
const recordPopoverAndFocus = page => page.evaluate(() => {
  const log = []
  window.__rdx3Log = log
  const describe = element => element === document.body ? 'body' : `${element.tagName.toLowerCase()}「${(element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 16)}」`
  const popoverOf = element => {
    const dialog = element.closest?.('[role="dialog"]')
    const name = dialog && (dialog.getAttribute('aria-label') ?? document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent)
    return name === '本次写作选项' ? dialog : null
  }
  let open = false
  new MutationObserver(() => {
    const now = [...document.querySelectorAll('[role="dialog"]')].some(popoverOf)
    if (now !== open) log.push({ t: Math.round(performance.now()), popover: now })
    open = now
  }).observe(document.body, { childList: true, subtree: true })
  document.addEventListener('focusin', event => log.push({ t: Math.round(performance.now()), focus: describe(event.target), inPopover: Boolean(popoverOf(event.target)) }), true)
  document.addEventListener('focusout', event => { if (!event.relatedTarget) log.push({ t: Math.round(performance.now()), blur: describe(event.target) }) }, true)
})

/** 外壳里 --accent 的计算值，[r, g, b]。 */
const accentColor = page => stage.root(page).evaluate(root => {
  const probe = document.createElement('span')
  probe.style.color = 'var(--accent)'
  root.append(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  return color.match(/\d+/g).slice(0, 3).map(Number)
})

/** 截图里接近 color 的像素数（三通道差之和不超过 60）。 */
function countColor({ pixels }, [r, g, b]) {
  let count = 0
  for (let index = 0; index < pixels.length; index += 4) {
    if (Math.abs(pixels[index] - r) + Math.abs(pixels[index + 1] - g) + Math.abs(pixels[index + 2] - b) <= 60) count++
  }
  return count
}

const describeActive = page => page.evaluate(() => {
  const element = document.activeElement
  if (!element || element === document.body) return 'body'
  return `${element.tagName.toLowerCase()}「${(element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 16)}」`
})

/** 每次焦点移动按时间记在页面里；失焦且没有去处（relatedTarget 为空）单独记一笔。 */
const recordFocusMoves = page => page.evaluate(() => {
  const log = []
  window.__rdx3FocusLog = log
  const describe = element => element === document.body ? 'body' : `${element.tagName.toLowerCase()}「${(element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 16)}」${element.disabled ? '(disabled)' : ''}`
  document.addEventListener('focusin', event => log.push(`${Math.round(performance.now())} in ${describe(event.target)}`), true)
  document.addEventListener('focusout', event => { if (!event.relatedTarget) log.push(`${Math.round(performance.now())} out ${describe(event.target)}`) }, true)
})

export const RDX3_SCENARIOS = {
  'rdx3-popover-1280': popoverIn(1280, 720),
  'rdx3-popover-1024': popoverIn(1024, 640),

  /** 键盘焦点环：运行侧页分段页签的选中项、激活的内容标签、流程脊当前阶段行、拆分主按钮两半。 */
  'rdx3-keyboard': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page, shoot }) => {
    const accent = await stage.root(page).evaluate(root => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--accent)'
      root.append(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    })
    await blueprint.open(page)
    await stage.stageButton(page, '架构').click()
    await stage.stageButton(page, '蓝图').click()
    const rings = {}
    await stage.spine(page).locator('button').first().focus()
    rings.spineCurrent = await tabTo(page, stage.stageButton(page, '蓝图'), shoot, 'rdx3-focus-spine-current')
    rings.activeTab = await tabTo(page, stage.tabList(page).getByRole('tab', { selected: true }), shoot, 'rdx3-focus-active-tab')
    rings.splitMain = await tabTo(page, blueprint.writeButton(page), shoot, 'rdx3-focus-split-main')
    rings.splitToggle = await tabTo(page, blueprint.writeOptions(page), shoot, 'rdx3-focus-split-toggle')
    await runSheet.openFromPalette(page)
    await runSheet.sheet(page).getByRole('heading').first().focus()
    rings.segmentedTab = await tabTo(page, runSheet.sheet(page).getByRole('tab', { selected: true }), shoot, 'rdx3-focus-segmented-tab')
    for (const [name, ring] of Object.entries(rings)) assert.ok(hasRing(ring, accent), `${name} 有可见的焦点环：${JSON.stringify(ring)}`)
    return rings
  } },

  /**
   * 章节规划的当前章行与普通行按 Tab 聚焦：截行四周的图数强调色像素，聚焦时比不聚焦多出一整圈 2px 环，
   * 只选中不聚焦的当前章没有这圈环；`withoutContainment` 是去掉列表项的 content-visibility 后同一行聚焦时的像素数，用来对照是谁裁了环。
   */
  'rdx3-plan-ring': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page, shoot }) => {
    const accent = await accentColor(page)
    await blueprint.open(page)
    await blueprint.planItem(page, 5).click()
    const rows = { current: blueprint.plan(page).locator('[aria-current]').first(), other: blueprint.planItem(page, 6) }
    const results = {}
    for (const [name, row] of Object.entries(rows)) {
      await row.scrollIntoViewIfNeeded()
      const box = await row.boundingBox()
      const clip = { x: box.x - 6, y: box.y - 6, width: box.width + 12, height: box.height + 12 }
      const count = async () => countColor(decodePng(await page.screenshot({ clip, animations: 'disabled' })), accent)
      await page.evaluate(() => document.activeElement?.blur())
      const resting = await count()
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Tab')
      await row.focus()
      const focusVisible = await row.evaluate(element => element.matches(':focus-visible'))
      const focused = await count()
      await shoot(`rdx3-plan-ring-${name}`)
      await row.evaluate(element => { element.parentElement.style.contentVisibility = 'visible' })
      const withoutContainment = await count()
      await row.evaluate(element => { element.parentElement.style.contentVisibility = '' })
      results[name] = { focusVisible, resting, focused, withoutContainment, ringMin: Math.round(4 * (box.width + box.height) * 0.8), size: [box.width, box.height] }
    }
    for (const [name, { focusVisible, resting, focused, ringMin }] of Object.entries(results)) {
      assert.ok(focusVisible && focused - resting >= ringMin, `${name} 聚焦时多出一整圈强调色环：${JSON.stringify(results[name])}`)
    }
    assert.ok(results.current.resting < results.current.ringMin / 10, `当前章只选中时没有这圈环：${JSON.stringify(results.current)}`)
    return results
  } },

  /**
   * 键盘焦点环不被悬停与外壳规则盖掉（#402 OCR #6、#8）：书房里鼠标停在「新建作品」卡上再用 Tab 聚焦它，焦点环立即出现；
   * 打开作品后用键盘打开作品菜单，方向键在菜单项间移动，聚焦项是菜单自己的 2px 内侧环（不是外圈），首项与末项各截一张图。
   */
  'rdx3-hover-focus': { model: false, shell: 'stage', setup: context => seedStageSample(context, { open: false }), run: async ({ page, shoot }) => {
    const accent = (await accentColor(page)).join(', ')
    const ringOf = locator => locator.evaluate(element => ({ focused: element === document.activeElement, focusVisible: element.matches(':focus-visible'), boxShadow: getComputedStyle(element).boxShadow }))
    const start = stage.root(page).getByRole('button', { name: '新建作品', exact: true })
    await start.hover()
    await page.waitForTimeout(300)
    const hovered = await ringOf(start)
    await page.keyboard.press('Shift+Tab')
    for (let step = 0; step < 20 && !(await ringOf(start)).focused; step++) await page.keyboard.press('Tab')
    const startRing = await ringOf(start)
    await shoot('rdx3-hover-focus-start')
    await stage.openFromLibrary(page, STAGE_SAMPLE.name)
    // 打开作品的收尾在文件树读完后还会回到作品一次，界面上没有可等的信号（同 chapter-scenarios 的 afterProjectOpenSettles）
    await page.waitForTimeout(2000)
    const menuButton = stage.root(page).getByRole('banner').getByRole('button', { name: `《${STAGE_SAMPLE.name}》作品菜单` })
    await menuButton.focus()
    await page.keyboard.press('Enter')
    const items = page.getByRole('menuitem')
    await items.first().waitFor({ state: 'visible' })
    const first = await ringOf(items.first())
    await shoot('rdx3-hover-focus-menu-first')
    await page.keyboard.press('ArrowDown')
    const second = await ringOf(items.nth(1))
    await page.keyboard.press('End')
    const last = await ringOf(items.last())
    await shoot('rdx3-hover-focus-menu-last')
    await page.keyboard.press('Escape')
    const inset = `rgb(${accent}) 0px 0px 0px 2px inset`
    const result = { hovered, startRing, first, second, last }
    assert.ok(startRing.focusVisible && startRing.boxShadow.includes(`rgb(${accent}) 0px 0px 0px 4px`), `悬停后再 Tab，起步卡有焦点环：${JSON.stringify(result)}`)
    assert.deepEqual([first, second, last].map(ring => [ring.focused, ring.boxShadow]), [[true, inset], [true, inset], [true, inset]], `菜单项聚焦是内侧环：${JSON.stringify(result)}`)
    return result
  } },

  /** 新外壳里的导入对话框：同屏只有一个上墨的主按钮，用途与目标的选中项是按下的次按钮。 */
  'rdx3-import-dialog': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.root(page).getByRole('banner').getByRole('button', { name: `《${STAGE_SAMPLE.name}》作品菜单` }).click()
    await page.getByRole('menuitem', { name: '小说拆解与仿写…', exact: true }).click()
    const dialog = page.getByRole('dialog').first()
    await dialog.waitFor({ state: 'visible' })
    await page.waitForTimeout(400)
    const buttons = await dialog.evaluate((element, { primary, secondary }) => ({
      primary: [...element.querySelectorAll(primary)].map(button => ({ text: button.textContent, disabled: button.disabled })),
      toggles: [...element.querySelectorAll('button[aria-pressed]')].map(button => ({ text: button.textContent, pressed: button.getAttribute('aria-pressed'), secondary: button.classList.contains(secondary) })),
    }), { primary: stage.PRIMARY_BUTTON, secondary: stage.SECONDARY_BUTTON_CLASS })
    assert.equal(buttons.primary.length, 1, `只有一个主按钮：${JSON.stringify(buttons.primary)}`)
    assert.ok(buttons.toggles.length >= 4 && buttons.toggles.every(toggle => toggle.secondary), `切换按钮都是次按钮：${JSON.stringify(buttons.toggles)}`)
    return buttons
  }, after: async ({ page }) => {
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').first().waitFor({ state: 'hidden' })
  } },

  /** 1440×900 下放得下的 11 条常驻通知，缩到 1100×640 后栈改成可滚动、最新一条露在底部，卡片右缘不因滚动条左移。 */
  'rdx3-toast-resize': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page, shoot }) => {
    const appPath = await app.evaluate(({ app: electronApp }) => electronApp.getAppPath())
    const chunk = fs.readdirSync(path.join(appPath, 'dist', 'assets')).find(name => /^ToastStack-.*\.js$/.test(name))
    assert.ok(chunk, '构建产物里有提示栈模块')
    const pushed = await page.evaluate(async ({ chunkName, count }) => {
      const module = await import(new URL(`./assets/${chunkName}`, location.href).href)
      const push = Object.values(module).find(value => typeof value === 'function' && String(value).includes('exiting:!1'))
      if (!push) return 'no-push'
      for (let i = 1; i <= count; i++) push({ tone: 'danger', message: `第 ${i} 章保存失败`, duration: 0 })
      return 'ok'
    }, { chunkName: chunk, count: 11 })
    assert.equal(pushed, 'ok')
    await page.mouse.move(4, 4)
    await page.waitForTimeout(400)
    const stack = stage.toastStack(page)
    const geometry = () => stack.evaluate((element, liveToast) => {
      const cards = [...element.querySelectorAll(liveToast)]
      const box = element.getBoundingClientRect()
      const newest = cards.at(-1).getBoundingClientRect()
      return { overflow: element.hasAttribute('data-overflow'), scrollbar: element.offsetWidth - element.clientWidth, right: newest.right,
        newestInside: newest.top >= box.top - 0.5 && newest.bottom <= box.bottom + 0.5, marginRight: element.style.marginRight }
    }, stage.LIVE_TOAST)
    const before = await geometry()
    assert.equal(before.overflow, false, `1440×900 下 11 条放得下：${JSON.stringify(before)}`)
    await setViewport(page, 1100, 640)
    await page.waitForTimeout(300)
    const after = await geometry()
    assert.ok(after.overflow, `缩窗后改成可滚动：${JSON.stringify(after)}`)
    assert.ok(after.newestInside, '最新一条露在栈底')
    assert.ok(Math.abs(after.right - (before.right - 340)) <= 0.5, `卡片右缘与窗口右缘的距离不变：${before.right} → ${after.right}`)
    const shift = await stack.evaluate((element, liveToast) => {
      const card = element.querySelector(liveToast)
      const compensated = card.getBoundingClientRect().right
      const saved = element.style.marginRight
      element.style.marginRight = ''
      const uncompensated = card.getBoundingClientRect().right
      element.style.marginRight = saved
      return Math.round((compensated - uncompensated) * 10) / 10
    }, stage.LIVE_TOAST)
    await shoot('rdx3-toast-resize')
    return { before, after, shiftWithoutCompensation: shift }
  } },

  /** 80 个字的作品名：顶栏标题收成省略号，窗口控制按钮仍在窗口内。 */
  'rdx3-long-title': { model: false, shell: 'stage', setup: async context => {
    // 项目文件夹以作品名命名，隔离目录加数据库路径会超出 Windows 路径上限：建普通的示例作品，打开时由主进程把作品名换成长名字
    await seedStageSample(context, { open: false })
    await context.app.evaluate(({ ipcMain }, name) => {
      const handlers = ipcMain._invokeHandlers
      const open = handlers.get('project:open')
      handlers.set('project:open', async (...args) => {
        const result = await open(...args)
        if (result?.project) result.project.name = name
        return result
      })
    }, LONG_NAME)
    await stage.openFromLibrary(context.page, STAGE_SAMPLE.name)
  }, run: async ({ page }) => {
    await setViewport(page, 1024, 640)
    const layout = await stage.root(page).getByRole('banner').evaluate((banner, { workName, windowClose }) => {
      // 修复前作品名直接在按钮里，没有单独的一段：退回按钮本身，先比关闭按钮的位置
      const title = banner.querySelector(workName[0]) ?? banner.querySelector(workName[1])
      const close = banner.querySelector(windowClose).getBoundingClientRect()
      return { title: title.textContent, closeRight: close.right, viewport: innerWidth, ellipsis: getComputedStyle(title).textOverflow, clipped: title.scrollWidth > title.clientWidth }
    }, { workName: stage.WORK_NAME, windowClose: stage.WINDOW_CLOSE })
    assert.ok(layout.closeRight <= layout.viewport, `关闭按钮在窗口内：${layout.closeRight} / ${layout.viewport}`)
    assert.deepEqual([layout.title, layout.ellipsis, layout.clipped], [LONG_NAME, 'ellipsis', true], '作品名以省略号收尾')
    return layout
  } },

  /** 作品菜单打开的导出、小说拆解与仿写、清除生成内容，取消或 Esc 关闭后焦点回到作品菜单按钮。 */
  'rdx3-work-menu-focus': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page, shoot }) => {
    const trigger = stage.root(page).getByRole('banner').getByRole('button', { name: `《${STAGE_SAMPLE.name}》作品菜单` })
    const landed = () => trigger.evaluate(element => element === document.activeElement)
    const dialog = page.getByRole('dialog').first()
    const results = {}
    for (const [item, close] of [
      ['导出…', 'Escape'], ['小说拆解与仿写…', 'Escape'], ['清除生成内容…', 'Escape'], ['清除生成内容…', '取消'], ['导出…', '关闭'],
    ]) {
      await stage.openWorkMenuItem(page, STAGE_SAMPLE.name, item)
      await dialog.waitFor({ state: 'visible' })
      if (close === 'Escape') await page.keyboard.press('Escape')
      else await dialog.getByRole('button', { name: close, exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      results[`${item} ${close}`] = await landed()
    }
    await shoot('rdx3-work-menu-focus')
    assert.deepEqual(Object.values(results), [true, true, true, true, true], `关闭后焦点都回到作品菜单按钮：${JSON.stringify(results)}`)
    return results
  } },

  /** 模态开着时溢出的提示栈用真滚轮滚得动；栈的滚动条是全局 6px 细条。 */
  'rdx3-toast-wheel': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page, shoot }) => {
    const appPath = await app.evaluate(({ app: electronApp }) => electronApp.getAppPath())
    const chunk = fs.readdirSync(path.join(appPath, 'dist', 'assets')).find(name => /^ToastStack-.*\.js$/.test(name))
    await stage.openWorkMenuItem(page, STAGE_SAMPLE.name, '清除生成内容…')
    await page.getByRole('dialog').first().waitFor({ state: 'visible' })
    const pushed = await page.evaluate(async ({ chunkName, count }) => {
      const module = await import(new URL(`./assets/${chunkName}`, location.href).href)
      const push = Object.values(module).find(value => typeof value === 'function' && String(value).includes('exiting:!1'))
      if (!push) return 'no-push'
      for (let i = 1; i <= count; i++) push({ tone: 'danger', message: `第 ${i} 章保存失败`, duration: 0 })
      return 'ok'
    }, { chunkName: chunk, count: 24 })
    assert.equal(pushed, 'ok')
    await page.waitForTimeout(400)
    const stack = stage.toastStack(page)
    const before = await stack.evaluate(element => ({ overflow: element.hasAttribute('data-overflow'), top: element.scrollTop, scrollbar: element.offsetWidth - element.clientWidth }))
    const box = await stack.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -600)
    await page.waitForTimeout(400)
    const after = await stack.evaluate(element => element.scrollTop)
    await shoot('rdx3-toast-wheel')
    assert.equal(before.overflow, true, '24 条时栈可滚动')
    assert.equal(before.scrollbar, 6, `栈的滚动条是 6px：${before.scrollbar}`)
    assert.ok(after < before.top - 100, `模态开着时滚轮把栈往上滚了：${before.top} → ${after}`)
    return { before, after }
  }, after: async ({ page }) => {
    await page.keyboard.press('Escape')
  } },

  /**
   * 就地确认条关掉后焦点回到打开它的按钮：先写一章让诊断分页有日志，「清空日志…」用鼠标点「保留」、按 Esc、键盘打开后 Esc 与回车「保留」；
   * 恢复卡的「放弃…」用鼠标点「保留」与按 Esc。
   */
  'rdx3-inline-confirm-focus': { model: true, shell: 'stage', setup: seedWithCandidate, run: async ({ page, shoot }) => {
    await recordFocusMoves(page)
    await blueprint.open(page)
    await blueprint.writeNext(page)
    await runSheet.waitForRunDone(page)
    await runSheet.tab(page, '诊断').click()
    const clear = runSheet.sheet(page).getByRole('button', { name: '清空日志…', exact: true })
    await runSheet.sheet(page).getByRole('list', { name: '日志内容' }).getByRole('listitem').first().waitFor({ state: 'visible' })
    const confirmBar = runSheet.sheet(page).getByRole('group').filter({ hasText: /^清空后这 \d+ 行日志无法找回。/ })
    const results = {}
    const settle = async (key, trigger) => {
      await confirmBar.waitFor({ state: 'detached' })
      await page.waitForFunction(() => document.activeElement !== document.body || !document.hasFocus(), undefined, { timeout: 2_000 }).catch(() => undefined)
      results[key] = { onTrigger: await trigger.evaluate(element => element === document.activeElement), active: await describeActive(page) }
    }
    const openClear = async how => {
      if (how === 'mouse') await clear.click()
      else { await clear.focus(); await page.keyboard.press('Enter') }
      await confirmBar.waitFor({ state: 'visible' })
    }
    await openClear('mouse')
    results.focusOnKeep = await page.evaluate(() => document.activeElement?.textContent)
    await confirmBar.getByRole('button', { name: '保留', exact: true }).click()
    await settle('clearMouseKeep', clear)
    await openClear('mouse')
    await page.keyboard.press('Escape')
    await settle('clearMouseEsc', clear)
    await openClear('keyboard')
    await page.keyboard.press('Escape')
    await settle('clearKeyEsc', clear)
    await openClear('keyboard')
    await page.keyboard.press('Enter')
    await settle('clearKeyKeep', clear)
    await shoot('rdx3-inline-confirm-focus')

    await runSheet.tab(page, '进行中').click()
    const card = runSheet.recovery(page).getByRole('article', { name: '原始候选 · 第5章 潮汐表' })
    const discard = card.getByRole('button', { name: '放弃…', exact: true })
    const cardBar = card.getByRole('group')
    for (const [key, close] of [['discardMouseKeep', 'keep'], ['discardMouseEsc', 'Escape']]) {
      await discard.click()
      await cardBar.waitFor({ state: 'visible' })
      if (close === 'keep') await cardBar.getByRole('button', { name: '保留', exact: true }).click()
      else await page.keyboard.press('Escape')
      await cardBar.waitFor({ state: 'detached' })
      await page.waitForTimeout(100)
      results[key] = { onTrigger: await discard.evaluate(element => element === document.activeElement), active: await describeActive(page) }
    }
    results.focusLog = await page.evaluate(() => window.__rdx3FocusLog)
    assert.equal(results.focusOnKeep, '保留', '确认条出现时焦点在「保留」')
    const landed = Object.fromEntries(Object.entries(results).filter(([, value]) => value?.onTrigger !== undefined).map(([key, value]) => [key, value.onTrigger]))
    assert.deepEqual(landed, { clearMouseKeep: true, clearMouseEsc: true, clearKeyEsc: true, clearKeyKeep: true, discardMouseKeep: true, discardMouseEsc: true },
      `关掉确认条后焦点回到打开它的按钮：${JSON.stringify(results)}`)
    return results
  } },

  /**
   * 正文编辑区（新外壳单章视图与旧外壳草稿编辑器共用）：末尾补三行，新外壳纸面上分节符整行不缩进、破折号开头的对白缩进；
   * Tab 插两个 em 空格；Esc 后停 2.5 秒再按 Tab 移出编辑区、不插空格；Esc 后按了方向键，Tab 又插空格。两种外壳各跑一次。
   */
  'rdx3-prose-keys': { model: false, setup: seedStageSample, run: async ({ page, shoot }) => {
    const staged = await stage.root(page).count() > 0
    if (staged) await chapterView.open(page, 4)
    else await project.draftOfChapter(page, 4).click()
    const editor = staged ? chapterView.prose(page) : chapter.editor(page)
    await editor.waitFor({ state: 'visible' })
    const inEditor = () => editor.evaluate(element => element.contains(document.activeElement))
    const lastLine = () => editor.evaluate(element => element.lastElementChild?.textContent ?? '')
    await editor.click()
    await page.keyboard.press('Control+End')
    for (const line of ['※※※', '——他说，钟声提前了。', '◇◆◇']) {
      await page.keyboard.press('Enter')
      await page.keyboard.press('Enter')
      await page.keyboard.insertText(line)
    }
    const indents = Object.fromEntries((await chapter.lineIndents(editor)).filter(([text]) => ['※※※', '——他说，钟声提前了。', '◇◆◇'].includes(text)))
    await page.keyboard.press('Tab')
    const afterTab = { line: await lastLine(), inEditor: await inEditor() }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(2500)
    await page.keyboard.press('Tab')
    const afterEscTab = { line: await lastLine(), inEditor: await inEditor() }
    await shoot('rdx3-prose-keys')
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Escape')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Tab')
    const afterEscArrowTab = { line: await lastLine(), inEditor: await inEditor() }
    const result = { shell: staged ? 'stage' : 'writer', indents, afterTab, afterEscTab, afterEscArrowTab }
    // 首行缩进只在新外壳的纸面上显示，旧外壳的编辑器每行都不缩进
    if (staged) assert.deepEqual(indents, { '※※※': '0px', '——他说，钟声提前了。': '36px', '◇◆◇': '0px' }, `分节符行不缩进，破折号开头的对白缩进：${JSON.stringify(result)}`)
    assert.deepEqual([afterTab, afterEscTab, afterEscArrowTab], [
      { line: '◇◆◇\u2003\u2003', inEditor: true },
      { line: '◇◆◇\u2003\u2003', inEditor: false },
      { line: '◇◆◇\u2003\u2003\u2003\u2003', inEditor: true },
    ], `Tab 插空格，Esc 后 Tab 移出，按了别的键 Tab 又插空格：${JSON.stringify(result)}`)
    return result
  } },

  /**
   * 定稿后自动打开下一章遇上设置页里没保存的输入：放弃确认 → 收起设置 → 第 4 章单章视图自动弹出写作弹层。
   * 放弃确认关掉后还焦点不能把刚弹出的写作弹层关掉。
   */
  'rdx3-write-after-discard': writeAfterDiscard(),
  /**
   * 同上，但放弃确认弹出前作者点过运行侧页的「历史」页签（它在确认关掉后还在）：还焦点不抢走写作弹层的焦点。
   * 还焦点与弹层打开谁先谁后不定，所以只断言与先后无关的结果：「历史」若拿到焦点必须在弹层打开之前，弹层打开后焦点没有落到弹层外。
   */
  'rdx3-write-after-discard-sheet': writeAfterDiscard({ focusBefore: page => runSheet.tab(page, '历史').click() }),
  /**
   * 设定里有没保存的输入时只清蓝图，主进程扣住清除；期间关窗弹出退出确认，再放行一个失败：
   * 「清除失败」提示画在退出确认上面、点得到「确定」，确定后退出确认还在。退出确认露在提示外的上沿被提示的遮罩压暗。
   */
  'rdx3-prompt-over-exit': promptAndExit({ promptFirst: false }),
  /**
   * 反过来：清除先失败，「清除失败」提示开着时关窗。退出确认画在提示上面，提示露在退出确认外的上下沿被退出确认的遮罩压暗；
   * 取消退出确认后提示仍在、点得到「确定」。
   */
  'rdx3-exit-over-prompt': promptAndExit({ promptFirst: true }),
  /**
   * 只导入一张角色卡，等出现确认卡后在设置的外观页把界面语言切成英文：运行侧页确认卡写「1 character candidate」。
   */
  'rdx3-candidates-en': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake, shoot }) => {
    fake.replyCharacterCards(1)
    await page.keyboard.press('Control+K')
    await stage.paletteInput(page).fill('角色')
    await stage.palette(page).getByRole('option', { name: /^角色/ }).first().click()
    await materials.importCharacterCards(page, '姓名：守塔人\n身份：灯塔看守，记得每一次钟声。')
    await runSheet.waitUntilOpen(page)
    const summary = runSheet.sheet(page).locator('.run-confirm-summary')
    await summary.waitFor({ state: 'visible', timeout: 60_000 })
    await stage.openSettings(page)
    await stage.showSettingsPage(page, '外观')
    await page.getByLabel('界面语言').selectOption('en-US')
    await page.keyboard.press('Escape')
    await page.getByRole('navigation', { name: 'Settings sections' }).waitFor({ state: 'detached' })
    if (!(await runSheet.sheet(page).isVisible())) {
      await page.keyboard.press('Control+K')
      await page.getByRole('dialog', { name: 'Search and jump' }).getByRole('combobox').fill('Run sheet')
      await page.keyboard.press('Enter')
    }
    await summary.waitFor({ state: 'visible' })
    const observed = { summary: await summary.innerText(), lang: await page.evaluate(() => document.documentElement.lang) }
    await summary.scrollIntoViewIfNeeded()
    await shoot('rdx3-candidates-en-card')
    assert.deepEqual(observed, { summary: '1 character candidate', lang: 'en-US' }, '英文界面里一张候选写单数')
    return observed
  }, after: async ({ page }) => {
    await page.getByRole('navigation', { name: 'Writing flow' }).getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance', exact: true }).click()
    await page.getByLabel('Interface language').selectOption('zh-CN')
    await page.keyboard.press('Escape')
    // 候选还等着确认时关窗会弹「创作任务仍在运行」，退出要等满宽限再强制结束：先把这次运行走完。
    await runSheet.openFromPalette(page)
    const waiting = runSheet.anyCard(page).filter({ hasText: '等你确认' })
    await waiting.getByRole('button', { name: '按当前选择确认', disabled: false }).waitFor({ state: 'visible', timeout: 60_000 })
    await waiting.getByRole('combobox', { name: /^采用方式：守塔人/ }).selectOption('create')
    await waiting.getByRole('button', { name: '按当前选择确认' }).click()
    await runSheet.waitForRunDone(page)
  } },
}

function writeAfterDiscard({ focusBefore } = {}) {
  return { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: async ({ page, invoke, path: projectPath, session }) => {
    assert.equal((await invoke(page, 'config:set', { autoOpenNextChapterAfterFinalize: true })).success, true)
    // 下一章还没动笔，定稿后才会自动弹出写作
    for (const draft of await invoke(page, 'db:draft-list', 4, projectPath, session)) {
      assert.equal((await invoke(page, 'db:draft-delete', draft.id, projectPath, session)).success, true)
    }
  } }), run: async ({ app, page, shoot }) => {
    await holdNextChapterLookup(app)
    await chapterView.open(page, 3)
    await chapterView.finalize(page, 3)
    for (let i = 0; i < 100 && !(await app.evaluate(() => globalThis.__rdx3NextChapterGate.hit)); i++) await page.waitForTimeout(100)
    assert.equal(await app.evaluate(() => globalThis.__rdx3NextChapterGate.hit), true, '定稿后自动打开下一章走到了读取第 4 章')
    await stage.openSettings(page)
    await page.getByRole('button', { name: `编辑「${FAKE_MODEL.name}」` }).click()
    await stage.root(page).getByPlaceholder('如：DeepSeek 主力 / GPT-4o 备用').fill('还没保存的名字')
    await focusBefore?.(page)
    await recordPopoverAndFocus(page)
    await app.evaluate(() => globalThis.__rdx3NextChapterGate.release())
    const discard = page.getByRole('dialog', { name: '放弃未保存的修改？' })
    await discard.waitFor({ state: 'visible' })
    await discard.getByRole('button', { name: '放弃修改', exact: true }).click()
    await blueprint.popover(page).waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined)
    await page.waitForTimeout(1200)
    const popover = blueprint.popover(page)
    const outcome = {
      popover: await popover.count(),
      focusInPopover: await popover.evaluate(element => element.contains(document.activeElement)).catch(() => false),
      log: await page.evaluate(() => window.__rdx3Log),
    }
    await shoot(focusBefore ? 'rdx3-write-after-discard-sheet' : 'rdx3-write-after-discard')
    const opened = outcome.log.findIndex(entry => entry.popover === true)
    const report = JSON.stringify(outcome)
    assert.equal(outcome.popover, 1, `放弃修改后写作弹层还开着：${report}`)
    assert.ok(outcome.focusInPopover, `焦点在写作弹层里：${report}`)
    assert.deepEqual(outcome.log.slice(opened + 1).filter(entry => entry.focus && !entry.inPopover), [], `弹层打开后焦点没有落到弹层外：${report}`)
    if (focusBefore) {
      const history = outcome.log.findIndex(entry => entry.focus?.includes('历史'))
      assert.ok(history < opened, `「历史」若拿到焦点，是在弹层打开之前：${report}`)
    }
    return outcome
  } }
}

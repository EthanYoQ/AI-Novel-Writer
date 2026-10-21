// RD-10 的实机 lane 与功能保全矩阵截图：键盘写一章、打字后立刻 Esc、英文界面全程、1280 与 1920 两种宽度、窄资料栏、标签操作菜单（含标签多到横向滚动时）、恢复候选正文页。
import assert from 'node:assert/strict'

import { FAKE_MODEL, FIXTURE_PROSE } from './fake-model.mjs'
import * as architecture from './pages/architecture.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { seedWithCandidate } from './run-scenarios.mjs'
import { firstLine, seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

/**
 * 当前焦点的可见焦点环：元素按键盘聚焦（:focus-visible），环画在它自己的 box-shadow、outline 上，
 * 内容区标签画在 ::after 的边上；正文编辑区以插入点为焦点标记，记下选区是否落在编辑区里。
 */
const focusRing = page => page.evaluate(() => {
  const element = document.activeElement
  if (!element || element === document.body) return { element: 'body', visible: false }
  const name = `${element.tagName.toLowerCase()}「${(element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 20)}」`
  const probe = document.createElement('span')
  probe.style.color = 'var(--accent)'
  ;(document.querySelector('[data-shell-presentation="stage"]') ?? document.body).append(probe)
  const accent = getComputedStyle(probe).color
  probe.remove()
  if (element.closest('.cm-content')) {
    const selection = window.getSelection()
    return { element: name, editor: true, visible: Boolean(selection?.focusNode && element.contains(selection.focusNode)) }
  }
  const tab = element.closest('.stage-tab')
  const style = getComputedStyle(element)
  const ring = tab ? `${getComputedStyle(tab, '::after').borderTopColor} ${getComputedStyle(tab, '::after').borderTopWidth}`
    : `${style.boxShadow} | ${style.outlineStyle} ${style.outlineColor} ${style.outlineWidth}`
  const focusVisible = element.matches(':focus-visible')
  return { element: name, ring, focusVisible, visible: focusVisible && (ring.includes(accent) || (style.outlineStyle !== 'none' && style.outlineWidth !== '0px')) }
})

/** 只按 Tab 走到 target；每一步都记下焦点落在哪、环是否可见。 */
async function tabTo(page, target, trail, limit = 80) {
  const handle = await target.elementHandle()
  for (let step = 0; step < limit; step++) {
    if (await handle.evaluate(element => element === document.activeElement || element.contains(document.activeElement))) return
    await page.keyboard.press('Tab')
    trail.push(await focusRing(page))
  }
  throw new Error(`按 ${limit} 次 Tab 没有到达目标：${JSON.stringify(trail.slice(-3))}`)
}

/** Ctrl K 输入 query 后回车，交给搜索与跳转（中英文界面的对话框名不同，按其中的组合框找）。 */
async function palette(page, query) {
  await page.keyboard.press('Control+K')
  const input = page.getByRole('dialog').getByRole('combobox')
  await input.waitFor({ state: 'visible' })
  await page.keyboard.type(query)
  await page.keyboard.press('Enter')
  await input.waitFor({ state: 'hidden' })
}

/**
 * 作品里的内容（书名、章名、设定、正文、审稿、角色与头像上的姓、夹具模型名），英文界面里出现它们不算没翻译。
 * 【第N章必现】是角色备注里按字面解析的标记（chapter-goal-review），英文提示也写原样。
 */
const SAMPLE_CONTENT = [
  STAGE_SAMPLE.name, ...STAGE_SAMPLE.titles, ...Object.values(STAGE_SAMPLE.core),
  ...Object.values(STAGE_SAMPLE.finalized).flatMap(text => [text, ...text.split('\n\n')]),
  ...Object.values(STAGE_SAMPLE.drafts).flatMap(draft => [draft.text, ...draft.text.split('\n\n')]),
  ...Object.values(STAGE_SAMPLE.drafts).flatMap(draft => draft.review ? (() => {
    const review = JSON.parse(draft.review)
    return [review.summary, ...review.items.flatMap(item => [item.category, item.description, item.quote].filter(Boolean))]
  })() : []),
  STAGE_SAMPLE.reverted, FIXTURE_PROSE, '林岚', '守塔人', '林', '守', '旧港潮汐记录的测绘师。', '查明失踪地图的来源。', '悬疑', '成年读者',
  FAKE_MODEL.name, '【第N章必现】',
].filter(Boolean).sort((a, b) => b.length - a.length)

/** 界面上还带汉字的文字：可见文字与各控件的可访问名称，去掉作品内容后剩下的行；顶栏的品牌字是装饰（aria-hidden），不算。 */
async function untranslated(page) {
  const { text, brand } = await page.evaluate(() => ({
    brand: document.querySelector('.stage-brand')?.textContent ?? null,
    text: [document.body.innerText, ...[...document.querySelectorAll('button, [role], [aria-label], [title], [placeholder]')].map(element =>
      `${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''} ${element.getAttribute('placeholder') ?? ''}`)].join('\n'),
  }))
  let cleaned = text
  for (const fragment of SAMPLE_CONTENT) cleaned = cleaned.split(fragment).join(' ')
  return [...new Set(cleaned.split('\n').map(line => line.trim()).filter(line => line !== brand && /\p{Script=Han}/u.test(line)))]
}

/**
 * 知识库资料栏里放不下的东西：每个按钮都要留在所在的框里、文字不伸出按钮，分段两项各自不折行，资料栏本身没有横向溢出。
 * 返回资料栏宽度、分段文案与问题清单。
 */
const knowledgeColumn = page => page.evaluate(() => {
  const column = document.querySelector('.stage-kb-docs')
  if (!column) return { missing: true }
  const inner = element => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return { left: rect.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
      right: rect.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight) }
  }
  const problems = []
  for (const button of column.querySelectorAll('button')) {
    const name = button.textContent.trim() || button.getAttribute('aria-label')
    const rect = button.getBoundingClientRect()
    const frame = inner(button.parentElement)
    if (button.scrollWidth > button.clientWidth) problems.push(`${name}：文字伸出按钮 ${button.scrollWidth - button.clientWidth}px`)
    if (rect.left < frame.left - 0.5 || rect.right > frame.right + 0.5) problems.push(`${name}：伸出所在的框`)
  }
  for (const item of column.querySelectorAll('.pi-seg-item')) if (item.scrollHeight > item.clientHeight) problems.push(`${item.textContent}：折行`)
  return { width: Math.round(column.getBoundingClientRect().width), overflow: column.scrollWidth - column.clientWidth, problems,
    segments: [...column.querySelectorAll('.pi-seg-item')].map(item => item.textContent) }
})

const noHorizontalOverflow = page => page.evaluate(() => {
  const scroller = document.scrollingElement
  const root = document.querySelector('[data-shell-presentation="stage"]')
  return { document: scroller.scrollWidth - scroller.clientWidth, shell: root ? root.scrollWidth - root.clientWidth : 0 }
})

export const RD10_SCENARIOS = {
  /**
   * lane 7：只用键盘写一章。Ctrl K 去蓝图，Tab 到下一章的「写第 N 章」（样例里是第 3 章）回车开写，写完 Tab 进正文补一句、Ctrl S 保存，
   * 再按 Esc、Tab 离开编辑区。每一步记下焦点落点与焦点环；`measured.missingRing` 必须为空。
   */
  'rd10-keyboard': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, shoot }) => {
    const trail = []
    await palette(page, '蓝图')
    await blueprint.plan(page).waitFor({ state: 'visible' })
    await tabTo(page, blueprint.writeButton(page), trail)
    const writeButton = await focusRing(page)
    trail.push(writeButton)
    await shoot('rd10-keyboard-write-button')
    await page.keyboard.press('Enter')
    await runSheet.waitUntilOpen(page)
    await runSheet.waitForRunDone(page)
    await stage.waitForProse(page, firstLine(FIXTURE_PROSE))
    await tabTo(page, stage.prose(page), trail)
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('灯塔的钟声在潮水里又响了一次。')
    await stage.saveStatus(page).filter({ hasText: /^未保存$/ }).waitFor({ state: 'visible' })
    await page.keyboard.press('Control+s')
    await stage.saveStatus(page).filter({ hasText: /^已保存$/ }).waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Tab')
    const leftEditor = await focusRing(page)
    trail.push(leftEditor)
    assert.equal(leftEditor.editor, undefined, '先 Esc 再 Tab，焦点离开了编辑区')
    await shoot('rd10-keyboard-saved')
    const missingRing = trail.filter(step => step.element !== 'body' && !step.visible)
    assert.deepEqual(missingRing, [], `焦点环缺失：${JSON.stringify(missingRing)}`)
    return { steps: trail.length, writeButton, leftEditor, missingRing }
  } },

  /**
   * lane 6：英文界面走一遍书房、四个阶段、角色名单、章节、运行侧页、作品资料、作品菜单的对话框与设置各页，
   * 每页去掉作品内容后不剩汉字；`measured.untranslated` 按页列出剩下的行，必须为空。
   */
  'rd10-en': { model: false, shell: 'stage', setup: context => seedStageSample(context, { open: false }), run: async ({ page, invoke, reload, shoot }) => {
    assert.equal((await invoke(page, 'config:set', { locale: 'en-US' })).success, true)
    await reload()
    await page.getByRole('list', { name: 'Recent books' }).waitFor({ state: 'visible' })
    const found = {}
    const check = async name => {
      await page.waitForTimeout(400)
      const lines = await untranslated(page)
      if (lines.length) found[name] = lines
    }
    await check('library')
    await stage.openFromLibraryEn(page, STAGE_SAMPLE.name)
    await page.getByRole('navigation', { name: 'Writing flow' }).waitFor({ state: 'visible' })
    await check('landing')
    for (const [query, name] of [['Setup', 'setup'], ['Architecture', 'architecture'], ['Cast', 'cast'], ['Blueprint', 'blueprint'],
      ['Chapter 3', 'chapter-3'], ['Chapter 1', 'chapter-1'], ['Run sheet', 'run-sheet'], ['Plot & threads', 'plot'],
      ['Knowledge base', 'knowledge'], ['Version history', 'history']]) {
      await palette(page, query)
      await check(name)
    }
    await shoot('rd10-en-history')
    for (const item of ['Export…', 'Clear generated content…']) {
      await stage.root(page).getByRole('banner').getByRole('button', { name: `“${STAGE_SAMPLE.name}” menu` }).click()
      await page.getByRole('menuitem', { name: item }).click()
      await page.getByRole('dialog').waitFor({ state: 'visible' })
      await check(`dialog ${item}`)
      await page.keyboard.press('Escape')
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
    }
    await palette(page, 'Settings')
    const nav = stage.settingsNavElement(page)
    await nav.waitFor({ state: 'visible' })
    const pages = await nav.getByRole('button').evaluateAll(buttons => buttons.map(button => button.textContent.trim()).filter(name => !/^Back to/.test(name)))
    for (const name of pages) {
      await nav.getByRole('button', { name, exact: true }).click()
      await page.waitForTimeout(500)
      await check(`settings ${name}`)
    }
    await nav.getByRole('button', { name: 'Appearance', exact: true }).click()
    await shoot('rd10-en-settings')
    assert.deepEqual(found, {}, `英文界面还有没翻译的文字：${JSON.stringify(found)}`)
    return { checked: ['library', 'landing', 'setup', 'architecture', 'cast', 'blueprint', 'chapter-3', 'chapter-1', 'run-sheet', 'plot', 'knowledge', 'history', 'export', 'clear', ...pages.map(name => `settings ${name}`)], untranslated: found }
  } },

  /**
   * lane 10：1280×900 与 1920×1080 下依次截书房、第 3 章、角色名单、蓝图；文档与外壳都没有横向溢出。
   * 主题由 --theme 决定，浅色与深色各跑一次。
   */
  'rd10-widths': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page, shoot }) => {
    const measured = {}
    for (const [width, height] of [[1280, 900], [1920, 1080]]) {
      await page.setViewportSize({ width, height })
      const views = {
        chapter: async () => { await stage.openChapter(page, 3) },
        cast: async () => { await architecture.open(page); await architecture.openCast(page) },
        blueprint: async () => { await blueprint.open(page) },
        library: async () => { await stage.backToLibrary(page, STAGE_SAMPLE.name) },
      }
      for (const [view, show] of Object.entries(views)) {
        await show()
        await page.waitForTimeout(400)
        measured[`${width}-${view}`] = await noHorizontalOverflow(page)
        await shoot(`rd10-widths-${width}-${view}`)
      }
      await stage.bookMenu(page, STAGE_SAMPLE.name, '回到作品')
      await stage.spine(page).waitFor({ state: 'visible' })
    }
    const overflowing = Object.entries(measured).filter(([, value]) => value.document > 0 || value.shell > 0)
    assert.deepEqual(overflowing, [], `横向溢出：${JSON.stringify(overflowing)}`)
    return measured
  } },

  /**
   * 窄资料栏：1280×900 下打开知识库再展开运行侧页，内容区约 620px、资料栏只剩 200px。中文、英文各量一次，
   * 资料栏里的按钮与分段都不伸出各自的框（`measured.<语言>.problems` 为空），各截一张。
   */
  'rd10-knowledge-narrow': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page, invoke, reload, shoot }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const measured = {}
    for (const [locale, knowledge, sheet] of [['zh-CN', '知识库', '运行侧页'], ['en-US', 'Knowledge base', 'Run sheet']]) {
      if (locale === 'en-US') {
        assert.equal((await invoke(page, 'config:set', { locale })).success, true)
        await reload()
        await page.getByRole('list', { name: 'Recent books' }).waitFor({ state: 'visible' })
        await stage.openFromLibraryEn(page, STAGE_SAMPLE.name)
        await page.getByRole('navigation', { name: 'Writing flow' }).waitFor({ state: 'visible' })
      }
      await palette(page, knowledge)
      await page.locator('.stage-kb-docs .pi-seg-item').first().waitFor({ state: 'visible' })
      await palette(page, sheet)
      await runSheet.sheet(page).waitFor({ state: 'visible' })
      await page.waitForTimeout(400)
      measured[locale] = await knowledgeColumn(page)
      await shoot(`rd10-knowledge-narrow-${locale === 'zh-CN' ? 'zh' : 'en'}`)
    }
    for (const [locale, result] of Object.entries(measured)) {
      assert(!result.missing && result.width >= 190 && result.width <= 210, `${locale} 没有进入窄资料栏：${JSON.stringify(result)}`)
      assert.equal(result.segments.length, 2, `${locale} 资料来源分段不是两项：${JSON.stringify(result)}`)
      assert.deepEqual(result.problems, [], `${locale} 资料栏里有东西伸出去：${JSON.stringify(result)}`)
      assert.equal(result.overflow, 0, `${locale} 资料栏横向溢出 ${result.overflow}px`)
    }
    return measured
  } },

  /**
   * 评审视频（配 --video，约 45 秒）：书房概览，打开作品走四个阶段与角色名单，正文第 3 章与审稿侧页，
   * 设置的外观只有浅色、深色两套（没有皮肤与界面布局），切到深色再切回，回书房。
   */
  'rd10-tour': { model: false, shell: 'stage', setup: context => seedStageSample(context, { open: false }), run: async ({ page }) => {
    const pause = ms => page.waitForTimeout(ms)
    await pause(2500)
    await stage.previewBook(page, STAGE_SAMPLE.name)
    await pause(2500)
    await stage.overview(page, STAGE_SAMPLE.name).getByRole('button', { name: `打开《${STAGE_SAMPLE.name}》` }).click()
    await stage.spine(page).waitFor({ state: 'visible' })
    await pause(2500)
    for (const name of ['设定', '架构', '蓝图']) {
      await stage.stageButton(page, name).click()
      await pause(2200)
    }
    await architecture.open(page)
    await architecture.openCast(page)
    await pause(2500)
    await stage.openChapter(page, 3)
    await pause(3000)
    await stage.openSettings(page)
    await stage.showSettingsPage(page, '外观')
    const themes = page.getByRole('radiogroup', { name: '主题' }).getByRole('radio')
    assert.deepEqual((await themes.allInnerTexts()).map(text => text.split('\n')[0]), ['浅色', '深色'], '外观只有浅色与深色')
    assert.equal(await page.getByRole('group', { name: '界面布局' }).count(), 0, '外观里没有界面布局')
    await pause(2500)
    await themes.filter({ hasText: /^深色/ }).click()
    await pause(3000)
    await themes.filter({ hasText: /^浅色/ }).click()
    await pause(2000)
    await stage.closeSettings(page)
    await stage.backToLibrary(page, STAGE_SAMPLE.name)
    await pause(3000)
  } },

  /** F-183、F-184：打开设定与蓝图共三个标签，展开「标签操作」：已打开的页面与四个关闭动作。 */
  'rd10-tab-menu': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.stageButton(page, '设定').click()
    await blueprint.open(page)
    assert.equal(await stage.tabList(page).getByRole('tab').count(), 3)
    await stage.root(page).getByRole('button', { name: '标签操作', exact: true }).click()
    const menu = page.getByRole('menu')
    await menu.waitFor({ state: 'visible' })
    const items = await menu.getByRole('menuitem').allInnerTexts()
    for (const item of ['关闭当前标签', '关闭其他标签', '关闭右侧标签', '关闭全部标签']) assert.ok(items.some(text => text.includes(item)), `菜单里有「${item}」`)
    return { items }
  }, after: async ({ page }) => {
    await page.keyboard.press('Escape')
  } },

  /**
   * 标签多到横向滚动：1280×900 下开着运行侧页，依次打开作品资料各页与几章，最后打开的标签在最右端处于激活。
   * 「标签操作」按钮中心那一点上要是按钮本身（不被标签盖住），在那里真实点一下打开的是菜单，标签一个不少。
   */
  'rd10-tab-overflow': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page, shoot }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await runSheet.openFromPalette(page)
    for (const name of ['设定', '剧情与伏笔', '知识库', '版本历史']) await palette(page, name)
    // 样例里只有前 4 章有正文，空白章没有编辑区，openChapter 等不到；第 3 章是开局的落点，标签已经开着
    for (const chapter of [1, 2, 4]) await stage.openChapter(page, chapter)
    await blueprint.open(page)
    const tabList = await stage.tabList(page).getByRole('tab').all()
    assert.equal(await tabList.at(-1).getAttribute('aria-selected'), 'true', '最后打开的标签没有激活')
    // 等标签条把激活标签滚进来再量，量到的才是滚到最右端的状态
    await page.waitForTimeout(200)
    const strip = await page.locator('.stage-tabs').evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth, left: element.scrollLeft }))
    assert(strip.scroll > strip.client && strip.left > 0, `标签条没有横向滚动到右端：${JSON.stringify(strip)}`)
    const tabs = await stage.tabList(page).getByRole('tab').count()
    const trigger = stage.root(page).getByRole('button', { name: '标签操作', exact: true })
    const box = await trigger.boundingBox()
    assert(box, `「标签操作」没有布局出来：${JSON.stringify(strip)}`)
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const onTop = await trigger.evaluate((button, point) => {
      const hit = document.elementFromPoint(point.x, point.y)
      return { inside: button.contains(hit), hit: hit?.outerHTML.slice(0, 120) ?? null }
    }, center)
    assert(onTop.inside, `「标签操作」上面压着 ${onTop.hit}`)
    await page.mouse.click(center.x, center.y)
    await page.getByRole('menu').waitFor({ state: 'visible' })
    assert.equal(await stage.tabList(page).getByRole('tab').count(), tabs, '点「标签操作」的位置关掉了标签')
    await shoot('rd10-tab-overflow')
    return { strip, tabs, onTop }
  }, after: async ({ page }) => {
    await page.keyboard.press('Escape')
  } },

  /** F-072：运行侧页可恢复的正文候选「继续编辑」打开纸墨正文页，候选正文在纸面上可编辑。 */
  'rd10-candidate-page': { model: false, shell: 'stage', setup: seedWithCandidate, run: async ({ page }) => {
    await runSheet.openFromPalette(page)
    const card = runSheet.recovery(page).getByRole('article', { name: '原始候选 · 第5章 潮汐表' })
    await card.waitFor({ state: 'visible' })
    await card.getByRole('button', { name: '继续编辑', exact: true }).click()
    await stage.waitForProse(page, '潮水退去，钟声早了一刻。')
    return { tabs: await stage.tabList(page).getByRole('tab').allInnerTexts().catch(() => []) }
  } },
  /**
   * lane 7 补充：三种输入方式（逐键按键、insertText、CDP 模拟的输入法组字）各打几个字后立刻按 Esc、Tab，
   * 焦点都要离开编辑区，正文里不多出全角空格。正文编辑器曾因补全请求未结束时吞掉 Esc 而失败。
   */
  'rd10-esc-after-typing': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.openChapter(page, 4)
    const prose = stage.prose(page)
    const cdp = await page.context().newCDPSession(page)
    const emSpace = String.fromCharCode(0x2003)
    const proseText = () => prose.evaluate(element => element.textContent ?? '')
    const inEditor = () => page.evaluate(() => Boolean(document.activeElement?.closest('.cm-content')))
    const inputs = {
      'key-press': async () => { for (const key of 'abc') await page.keyboard.press(key) },
      'insert-text': async () => { await page.keyboard.insertText('灯塔') },
      'ime-composition': async () => {
        await cdp.send('Input.imeSetComposition', { text: 'deng', selectionStart: 4, selectionEnd: 4 })
        await cdp.send('Input.imeSetComposition', { text: '灯', selectionStart: 1, selectionEnd: 1 })
        await cdp.send('Input.insertText', { text: '灯' })
      },
    }
    const results = []
    for (const [name, input] of Object.entries(inputs)) {
      await prose.click()
      await page.keyboard.press('Control+End')
      const before = await proseText()
      await input()
      const typed = await proseText()
      await page.keyboard.press('Escape')
      await page.keyboard.press('Tab')
      const left = !(await inEditor())
      const after = await proseText()
      results.push({ name, typed: typed.length - before.length, left, emSpacesAdded: after.split(emSpace).length - typed.split(emSpace).length })
    }
    await cdp.detach()
    assert.deepEqual(results.filter(result => result.typed <= 0 || !result.left || result.emSpacesAdded !== 0), [], `打字后立刻 Esc、Tab：${JSON.stringify(results)}`)
    return { results }
  } },
}

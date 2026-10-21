// RD-6 架构阶段与角色名单的实机场景：对应计划 RD-6 的 live lane 1～10、perf 的 arch-timing 与评审视频。
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

import * as arch from './pages/architecture.mjs'
import * as materials from './pages/materials.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { FAKE_MODEL } from './fake-model.mjs'
import { seedStageSample, untilGateHolds } from './scenarios.mjs'
import { STAGE_SAMPLE, stageChapterTitle } from './stage-sample.mjs'

const root = page => stage.root(page)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha = text => createHash('sha256').update(text ?? '').digest('hex').slice(0, 16)

/** 记下界面最近一次打开作品拿到的会话（包一层主进程的 project:open），驱动读库时不必重开作品打断界面。 */
async function trackOpenedSession(app) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const original = handlers.get('project:open')
    handlers.set('project:open', async (event, projectPath, ...rest) => {
      const result = await original(event, projectPath, ...rest)
      if (result?.success) globalThis.__driveOpened = { projectId: result.project.id, projectPath, leaseId: result.project.sessionLease }
      return result
    })
  })
}

/** 从此刻起按通道数主进程收到的 invoke，用来比较打开架构时两边各读了什么。 */
async function countIpc(app) {
  await app.evaluate(({ ipcMain }) => {
    const counts = {}
    globalThis.__driveIpcCounts = counts
    for (const [channel, handler] of ipcMain._invokeHandlers) {
      ipcMain._invokeHandlers.set(channel, (...args) => { counts[channel] = (counts[channel] ?? 0) + 1; return handler(...args) })
    }
  })
}

async function uiSession(app) {
  const session = await app.evaluate(() => globalThis.__driveOpened)
  assert.ok(session?.leaseId, '记下了界面打开作品的会话')
  return session
}

async function readCore({ app, page, invoke }) {
  const session = await uiSession(app)
  return invoke(page, 'db:project-core-get', session.projectPath, session)
}

async function readRoster({ app, page, invoke }) {
  const session = await uiSession(app)
  return invoke(page, 'db:character-roster-read', session.projectPath, session)
}

/** 在预置的林岚之外再加几位角色（名单提交要带当前修订号）。 */
async function addCharacters({ page, invoke, path, session }, names) {
  const roster = await invoke(page, 'db:character-roster-read', path, session)
  const blank = { gender: '', age: '', appearance: '', personality: '', abilities: '', motivation: '', relationships: [], arc: '', notes: '' }
  const added = names.map((name, index) => ({ ...blank, characterId: `draft:${randomUUID()}`, name, role: index % 3 === 0 ? 'antagonist' : 'supporting',
    background: `${name}在旧港住了很多年。` }))
  const committed = await invoke(page, 'db:character-roster-commit', { operationId: randomUUID(), expectedRevision: roster.revision,
    expectedIdentityRevision: roster.identityRevision, schemaVersion: 1, intent: 'manual_edit', entries: [...roster.entries, ...added] }, path, session)
  assert.equal(committed.success, true, committed.error)
}

/**
 * 示例作品「灯塔」，按 clear 清空架构的几节。清空过的作品不等落到第 3 章，等落点定下后从流程脊进架构：
 * 用户决定 B（#394 §6）之后有蓝图与正文的作品打开落在写作位置，之前的版本落在架构，两边都等得到落点。
 * 落在第 4 章时进架构后关掉第 4 章的标签，只剩架构一页，与落在架构的版本截图一致。
 * 会话追踪先挂上，界面重载后打开作品的那次会话就能拿来读库。
 */
function seedArch({ clear = [], totalChapters, characters = [], core = {} } = {}) {
  return async context => {
    await trackOpenedSession(context.app)
    await seedStageSample(context, { totalChapters, landOnChapter3: clear.length === 0, beforeReload: async ({ page, invoke, path, session }) => {
      if (clear.length > 0 || Object.keys(core).length > 0) {
        const cleared = await invoke(page, 'db:project-core-update', { ...Object.fromEntries(clear.map(key => [key, ''])), ...core }, path, session)
        assert.equal(cleared.success, true, cleared.error)
      }
      if (characters.length > 0) await addCharacters({ page, invoke, path, session }, characters)
    } })
    if (clear.length === 0) return
    const { page } = context
    if (await stage.root(page).count() > 0) {
      await page.getByRole('navigation', { name: '位置' }).waitFor({ state: 'visible', timeout: 20_000 })
      await stage.stageButton(page, '架构').click()
    }
    await architectureSurface(page).waitFor({ state: 'visible', timeout: 20_000 })
    const landingTab = stage.closeTabButton(page, `第 4 章 · ${stageChapterTitle(4)}`)
    if (await landingTab.count() > 0) {
      await landingTab.click()
      await stage.tabList(page).waitFor({ state: 'detached' })
    }
  }
}

/** 架构页：head 是架构阶段，trunk 是旧的故事架构总览（trunk 架构没齐时打开作品仍落在这里）。 */
const architectureSurface = page => page.locator('.arch-page').or(page.getByRole('button', { name: 'AI 生成架构' })).first()

async function openArchitecture(page) {
  if (await arch.page(page).count() === 0) await arch.open(page)
  else await arch.waitReady(page)
}

/**
 * #465：窗口 1024 与 1280 宽（后者另测开着运行侧页）、中英文界面下，角色名单页的导入按钮不超出名单栏，
 * 定位下拉框放得下每个选项，档案首行的输入框文字区至少放得下三个字。截图停在角色名单页，返回实测的宽度。
 */
async function castFitAt({ page, invoke, reload }, locale, width, sheet) {
  await page.setViewportSize({ width, height: 768 })
  if (locale === 'en-US') {
    assert.equal((await invoke(page, 'config:set', { locale: 'en-US' })).success, true)
    await reload()
    await stage.openFromLibraryEn(page, '灯塔')
    await page.getByRole('navigation', { name: 'Writing flow' }).getByRole('button', { name: /^Architecture/ }).click()
    await root(page).locator('.arch-page:not([data-loading]):not([data-cast-loading])').waitFor({ state: 'visible', timeout: 30_000 })
    await root(page).getByRole('region', { name: 'Cast', exact: true }).getByRole('button', { name: 'Open cast' }).click()
  } else {
    await openArchitecture(page)
    await arch.openCast(page)
  }
  await root(page).locator('.cast-select').waitFor({ state: 'visible' })
  if (sheet) {
    await page.keyboard.press('Control+K')
    await page.getByRole('dialog').getByRole('combobox').waitFor({ state: 'visible' })
    await page.keyboard.type(locale === 'en-US' ? 'Run sheet' : '运行侧页')
    await page.keyboard.press('Enter')
    await runSheet.sheet(page).waitFor({ state: 'visible' })
    await page.waitForTimeout(400)
  }
  const measured = await page.evaluate(() => {
    const roster = document.querySelector('.cast-roster').getBoundingClientRect()
    const buttons = [...document.querySelectorAll('.cast-roster-actions .pi-btn')].map(button => {
      const box = button.getBoundingClientRect()
      return { label: button.textContent, left: Math.round(box.left), right: Math.round(box.right), height: Math.round(box.height) }
    })
    // 原生下拉框的箭头画在内容区里：同样样式、只含这一个选项、按内容取宽的副本有多宽，选中它时就要多宽才放得下。
    const select = document.querySelector('.cast-select')
    const needed = Object.fromEntries([...select.options].map(option => {
      const probe = select.cloneNode(false)
      probe.append(option.cloneNode(true))
      probe.style.cssText = 'position: absolute; visibility: hidden; width: auto; min-width: 0'
      select.parentElement.append(probe)
      const width = Math.ceil(probe.getBoundingClientRect().width)
      probe.remove()
      return [option.textContent, width]
    }))
    const inputs = Object.fromEntries([...document.querySelectorAll('.cast-row-fields input')].map(input => {
      const style = getComputedStyle(input)
      return [input.closest('.cast-field').querySelector('label').textContent, {
        text: Math.floor(input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)),
        needed: Math.ceil(3 * parseFloat(style.fontSize)),
      }]
    }))
    return {
      page: Math.round(document.querySelector('.cast-body').getBoundingClientRect().width),
      rosterRight: Math.round(roster.right), buttons, role: { width: Math.round(select.getBoundingClientRect().width), needed }, inputs,
    }
  })
  const problems = [
    ...measured.buttons.filter(button => button.right > measured.rosterRight).map(button => `「${button.label}」超出名单栏`),
    ...Object.entries(measured.role.needed).filter(([, needed]) => needed > measured.role.width).map(([option]) => `定位下拉框放不下「${option}」`),
    ...Object.entries(measured.inputs).filter(([, input]) => input.text < input.needed).map(([label]) => `「${label}」输入框太窄`),
  ]
  assert.deepEqual(problems, [], JSON.stringify(measured))
  return measured
}

/** RD-4 的运行侧页在工作流开始后自动打开；trunk 的旧运行面板没有「进行中」分页，调用方改为轮询数据库里的结果。 */
async function waitForRunDone(page, timeout = 120_000) {
  const opened = await runSheet.tab(page, '进行中').waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)
  if (opened) await runSheet.waitForRunDone(page, timeout)
}

async function badges(page) {
  const result = {}
  for (const key of Object.keys(arch.SECTION_NAMES)) result[key] = await arch.badge(page, key).innerText()
  return result
}

/** 情节大纲里每一章的二级标题块，按章号取。 */
function outlineChapters(synopsis) {
  const blocks = {}
  for (const match of synopsis.matchAll(/^## 第(\d+)章：[^\n]*\n[^\n#>]*/gmu)) {
    const number = Number(match[1])
    assert.equal(blocks[number], undefined, `第 ${number} 章出现了两次`)
    blocks[number] = match[0].trim()
  }
  return blocks
}

/**
 * 对比用的文字对比度：普通字号的文字（说明类也算）至少 4.5:1，底色沿祖先叠加求出。
 * 另核对分节卡片的底色来自纸墨令牌 --paper（计算值与令牌的计算值相同）。
 */
async function archContrastFailures(page) {
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
    const checks = [['.arch-title', 4.5], ['.arch-section-title', 4.5], ['.arch-section-summary', 4.5], ['.arch-lede', 4.5],
      ['.arch-eyebrow', 4.5], ['.arch-badge', 4.5], ['.arch-section-num', 4.5], ['.pi-notice-title', 4.5], ['.pi-notice-text', 4.5]]
    const contrast = checks.flatMap(([selector, minimum]) => [...document.querySelectorAll(`[data-shell-presentation="stage"] ${selector}`)].map(element => {
      const value = ratio(parse(getComputedStyle(element).color), backdrop(element))
      return { selector, text: element.textContent.slice(0, 30), ratio: Math.round(value * 100) / 100, minimum }
    }).filter(result => result.ratio < result.minimum))
    const shell = document.querySelector('[data-shell-presentation="stage"]')
    const probe = document.createElement('span')
    shell.append(probe)
    const token = name => { probe.style.backgroundColor = `var(${name})`; return getComputedStyle(probe).backgroundColor }
    const paper = token('--paper')
    probe.remove()
    const surfaces = [...document.querySelectorAll('.arch-section')].map(element => getComputedStyle(element).backgroundColor)
      .filter(color => color !== paper).map(color => ({ selector: '.arch-section', color, expected: paper }))
    return [...contrast, ...surfaces]
  })
}

/** 作者写的短世界观（不足 50 字）与只有序章的大纲（#426、#417）。 */
const SHORT_WORLD = '雾港的钟每晚早响一刻。'
const PROLOGUE_ONLY = `# 情节大纲

## 第0章：序章
${'守塔人在风暴前夜听见第十三声钟，灯塔从那一夜起熄灭。'.repeat(3)}`
const seedShortSections = seedArch({ clear: ['worldbuilding', 'synopsis'], totalChapters: 24, core: { worldbuilding: SHORT_WORLD, synopsis: PROLOGUE_ONLY } })

/** 两个改模型场景共用：生成 1–5 章，续写第 6–to 章时卡在假模型门上，改名保存夹具模型后放行；返回「上一次运行」卡片。 */
async function stallOutlineBatchAndChangeModel(context, to) {
  const { page, invoke, fake } = context
  await openArchitecture(page)
  await arch.primary(page).click()
  await arch.selectOnly(page, ['synopsis'])
  await arch.setRange(page, 1, 5)
  await arch.startGenerate(page)
  await waitForRunDone(page)
  await arch.badge(page, 'synopsis').filter({ hasText: '部分完成 · 5 / 24 章' }).waitFor({ timeout: 30_000 })
  await arch.section(page, 'synopsis').getByRole('button', { name: '续写第 6 章起' }).click()
  await arch.setRange(page, 6, to)
  fake.gate.hold()
  await arch.startGenerate(page)
  await untilGateHolds(fake.gate, 60_000)
  assert.equal((await invoke(page, 'llm:save-model', { ...FAKE_MODEL, modelName: 'gpt-4.1-mini' })).success, true)
  fake.gate.release()
  return runSheet.anyCard(page).filter({ hasText: /^上一次运行/ })
}

export const ARCH_SCENARIOS = {
  /** 短世界观显示内容、徽标为不完整；只有序章的大纲徽标为待生成，页头只数已确认的两节。 */
  'arch-short-sections': { model: false, shell: 'stage', setup: seedShortSections, run: async ({ page }) => {
    await openArchitecture(page)
    assert.equal(await arch.summary(page, 'worldbuilding').innerText(), SHORT_WORLD)
    assert.deepEqual(await badges(page), { premise: '已确认', characters: '已确认', worldbuilding: '不完整', synopsis: '待生成' })
    assert.match(await arch.summary(page, 'synopsis').innerText(), /守塔人在风暴前夜/)
    assert.match(await arch.page(page).locator('.arch-eyebrow').innerText(), /2 \/ 4 已确认/, '页头只数已确认的节，短内容不算已确认')
    assert.equal(await arch.primary(page).innerText(), '继续生成架构')
  } },
  /** 只有序章时生成对话框：默认接在序章之后写，起始章跳过第 1 章时说明要从第 1 章开始。 */
  'arch-prologue-dialog': { model: false, shell: 'stage', setup: seedShortSections, run: async ({ page }) => {
    await openArchitecture(page)
    await arch.primary(page).click()
    await arch.dialog(page).waitFor({ state: 'visible' })
    // 默认勾选与范围在对话框打开后的 effect 里才设好，首帧大纲还显示「将覆盖」：等它变成「续写」再读。
    await arch.mark(page, 'synopsis').filter({ hasText: /^续写$/ }).waitFor()
    assert.equal(await arch.mark(page, 'worldbuilding').innerText(), '将覆盖')
    assert.equal(await arch.dialog(page).locator('.arch-range-effect').innerText(), '接在序章之后写第 1–5 章，序章不动。')
    await arch.dialog(page).getByRole('spinbutton', { name: '本次生成范围的起始章' }).fill('2')
    assert.equal(await arch.dialog(page).locator('.arch-range-issue').innerText(), '已有大纲只有序章，不能跳到第 2 章开始。请从第 1 章起生成，序章会原样保留。')
  }, after: async ({ page }) => {
    await arch.dialog(page).getByRole('button', { name: '取消' }).click()
    await arch.dialog(page).waitFor({ state: 'hidden' })
  } },
  /** lane 1：trunk 与 head 都从架构页用夹具模型生成前提、世界观与大纲（角色名单已预置），记下四份文档。 */
  'arch-regression': { model: true, shell: 'stage', setup: seedArch({ clear: ['premise', 'worldbuilding', 'synopsis'] }), run: async context => {
    const { page } = context
    const head = await page.locator('.arch-page').count() > 0
    if (head) {
      await arch.waitReady(page)
      assert.equal(await arch.primary(page).innerText(), '继续生成架构')
      await arch.primary(page).click()
      await arch.startGenerate(page)
    } else {
      await page.getByRole('button', { name: 'AI 生成架构' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('button', { name: '确认生成（3/4）' }).click()
      await dialog.waitFor({ state: 'hidden' })
    }
    await waitForRunDone(page)
    let core
    for (let attempt = 0; attempt < 240; attempt++) {
      core = await readCore(context)
      if (core?.premise && core?.worldbuilding && core?.synopsis?.includes('第5章')) break
      await pause(500)
    }
    const documents = { premise: core.premise, characters: core.charactersArch, worldbuilding: core.worldbuilding, synopsis: core.synopsis }
    for (const [key, value] of Object.entries(documents)) assert.ok(value?.trim(), `${key} 有内容`)
    if (head) await arch.waitReady(page)
    return { surface: head ? 'head 架构阶段' : 'trunk 故事架构', hashes: Object.fromEntries(Object.entries(documents).map(([key, value]) => [key, sha(value)])), documents }
  } },

  /** lane 2：两节已确认时主按钮是继续生成架构。 */
  'arch-partial': { model: false, shell: 'stage', setup: seedArch({ clear: ['worldbuilding', 'synopsis'] }), run: async ({ page }) => {
    await openArchitecture(page)
    assert.equal(await arch.primary(page).count(), 1, '架构页只有一个主按钮')
    assert.equal(await arch.primary(page).innerText(), '继续生成架构')
    assert.equal(await arch.next(page).isDisabled(), true, '下一步置灰')
    assert.deepEqual(await badges(page), { premise: '已确认', characters: '已确认', worldbuilding: '待生成', synopsis: '待生成' })
    assert.match(await stage.stageButton(page, '架构').innerText(), /2 \/ 4/, '流程脊与页面同为 2 / 4')
    assert.equal(await arch.summary(page, 'characters').innerText(), '1 位角色：林岚')
  } },

  /** lane 3：四节都已确认时主按钮是下一步章节蓝图；after 点它进入蓝图。 */
  'arch-done': { model: false, shell: 'stage', setup: seedArch(), run: async ({ page }) => {
    await openArchitecture(page)
    assert.equal(await arch.primary(page).innerText(), '下一步：章节蓝图')
    assert.deepEqual(Object.values(await badges(page)), ['已确认', '已确认', '已确认', '已确认'])
  }, after: async ({ page }) => {
    await arch.primary(page).click()
    await stage.tab(page, '蓝图').waitFor({ state: 'visible' })
  } },

  /** lane 4：生成架构对话框里，已确认的节勾选为将覆盖、不勾为保留，没有内容的为新生成。 */
  'arch-confirm': { model: false, shell: 'stage', setup: seedArch({ clear: ['worldbuilding', 'synopsis'] }), run: async ({ page }) => {
    await openArchitecture(page)
    await arch.primary(page).click()
    await arch.dialog(page).waitFor({ state: 'visible' })
    await arch.stepCheck(page, 'premise').click()
    const marks = {}
    for (const key of Object.keys(arch.SECTION_NAMES)) marks[key] = await arch.mark(page, key).innerText()
    assert.deepEqual(marks, { premise: '将覆盖', characters: '保留', worldbuilding: '新生成', synopsis: '新生成' })
    assert.equal(await arch.dialog(page).locator('.pi-btn--primary').innerText(), '开始生成 3 项')
  }, after: async ({ page }) => {
    await arch.dialog(page).getByRole('button', { name: '取消' }).click()
    await arch.dialog(page).waitFor({ state: 'hidden' })
  } },

  /** lane 5：大纲先生成 1～10 章，再从提示条续写到 16 章；停在第 17～24 章的续写对话框，after 生成并核对只追加了缺少的章。 */
  'arch-resume': { model: true, shell: 'stage', setup: seedArch({ clear: ['synopsis'], totalChapters: 24 }), run: async context => {
    const { page } = context
    await openArchitecture(page)
    await arch.primary(page).click()
    await arch.selectOnly(page, ['synopsis'])
    await arch.setRange(page, 1, 10)
    await arch.startGenerate(page)
    await waitForRunDone(page)
    await arch.badge(page, 'synopsis').filter({ hasText: '部分完成 · 10 / 24 章' }).waitFor({ timeout: 30_000 })
    await arch.section(page, 'synopsis').getByRole('button', { name: '续写第 11 章起' }).click()
    assert.equal(await arch.dialog(page).getByRole('spinbutton', { name: '本次生成范围的起始章' }).inputValue(), '11')
    await arch.setRange(page, 11, 16)
    await arch.startGenerate(page)
    await waitForRunDone(page)
    await arch.badge(page, 'synopsis').filter({ hasText: '部分完成 · 16 / 24 章' }).waitFor({ timeout: 30_000 })
    const outline = arch.section(page, 'synopsis')
    assert.match(await outline.innerText(), /第 17–24 章还没有大纲/)
    assert.match(await outline.innerText(), /续写只追加缺少的章节/)
    assert.equal(await arch.primary(page).innerText(), '继续生成架构', '部分完成不算已确认')
    assert.equal(await arch.next(page).isDisabled(), true, '下一步置灰')
    assert.match(await arch.page(page).locator('.arch-eyebrow').innerText(), /3 \/ 4 已确认/)
    assert.match(await stage.stageButton(page, '架构').innerText(), /3 \/ 4/, '流程脊与页头同为 3 / 4')
    const drafts = await runSheet.recovery(page).getByRole('article').locator('.run-card-title').allInnerTexts()
    assert.deepEqual(drafts.filter(title => title.startsWith('大纲恢复稿')).sort(), ['大纲恢复稿 · 第 11–16 章', '大纲恢复稿 · 第 1–10 章'], '两批恢复稿按范围区分')
    context.before16 = (await readCore(context)).synopsis
    assert.deepEqual(Object.keys(outlineChapters(context.before16)).map(Number), Array.from({ length: 16 }, (_, index) => index + 1))
    await outline.getByRole('button', { name: '续写第 17 章起' }).click()
    assert.equal(await arch.dialog(page).getByRole('spinbutton', { name: '本次生成范围的起始章' }).inputValue(), '17')
    await arch.setRange(page, 17, 24)
    return { coveredBefore: 16 }
  }, after: async context => {
    const { page } = context
    await arch.startGenerate(page)
    await waitForRunDone(page)
    await arch.badge(page, 'synopsis').filter({ hasText: '已确认' }).waitFor({ timeout: 30_000 })
    const before = outlineChapters(context.before16)
    const after = outlineChapters((await readCore(context)).synopsis)
    assert.deepEqual(Object.keys(after).map(Number), Array.from({ length: 24 }, (_, index) => index + 1), '续写后 1～24 章各一次')
    for (let number = 1; number <= 16; number++) assert.equal(after[number], before[number], `第 ${number} 章没有被改动`)
  } },

  /**
   * #441 #442：续写第 6–10 章时卡住第 6 章，在设置里把同一个模型条目改名保存（与用户现场相同），放行后第 7 章被拒。
   * 上一次运行写明是模型设置变了、停在第 7 章、第 6 章在大纲恢复稿里、正式大纲未被改动，有「打开架构页」，界面不出现原始错误码；
   * 诊断里的 AI 调用记录与真实请求一致（1–5 章与第 6 章）。after 点「打开架构页」，大纲提示只能查看或复制恢复稿，点「从第 6 章重新生成」打开第 6–10 章的对话框，用新模型重新生成到第 10 章。
   */
  'arch-model-change': { model: true, shell: 'stage', setup: seedArch({ clear: ['synopsis'], totalChapters: 24 }), run: async context => {
    const { page } = context
    const last = await stallOutlineBatchAndChangeModel(context, 10)
    await last.getByRole('button', { name: '打开架构页' }).waitFor({ state: 'visible', timeout: 60_000 })
    const notice = await last.innerText()
    assert.match(notice, /生成途中模型设置被修改，这批大纲已在第 7 章停止/)
    assert.match(notice, /本批已生成的第 6 章保留在「大纲恢复稿」中，只能查看或复制，不能覆盖正式内容/)
    assert.match(notice, /正式大纲未被改动。请到「架构」页重新生成情节大纲，从第 6 章开始/)
    assert.doesNotMatch(notice, /GENERATION_SOURCE_CHANGED|Error invoking remote method/, '界面不出现原始错误码')
    assert.equal(await last.getByRole('button', { name: '继续生成情节大纲' }).count(), 0, '不提供必然被拒的断点续写')
    await runSheet.tab(page, '诊断').click()
    const calls = runSheet.sheet(page).getByRole('table').getByRole('row')
    await calls.nth(6).waitFor({ state: 'visible', timeout: 10_000 })
    const rows = await calls.count() - 1
    assert.equal(rows, 6, 'AI 调用记录：第 1–5 章各一次，第 6 章一次，第 7 章没有发出')
    await runSheet.tab(page, '进行中').click()
    return { notice, calls: rows }
  }, after: async context => {
    const { page } = context
    await runSheet.anyCard(page).filter({ hasText: /^上一次运行/ }).getByRole('button', { name: '打开架构页' }).click()
    await arch.waitReady(page)
    const outline = arch.section(page, 'synopsis')
    const restart = outline.getByRole('button', { name: '从第 6 章重新生成' })
    await restart.waitFor({ state: 'visible', timeout: 10_000 })
    const note = await outline.innerText()
    assert.match(note, /只能查看或复制。请从第 6 章重新生成情节大纲/)
    assert.doesNotMatch(note, /续写从停下的地方|可编辑并本地保存/, '恢复稿不能写回时不承诺续写或本地保存')
    assert.equal(await outline.getByRole('button', { name: '编辑恢复稿' }).count(), 0)
    await context.shoot('arch-model-change-architecture')
    await restart.click()
    assert.equal(await arch.dialog(page).getByRole('spinbutton', { name: '本次生成范围的起始章' }).inputValue(), '6', '生成对话框从第 6 章起')
    assert.equal(await arch.dialog(page).getByRole('spinbutton', { name: '本次生成范围的结束章' }).inputValue(), '10', '生成对话框沿用本批范围')
    await context.shoot('arch-model-change-dialog')
    await arch.selectOnly(page, ['synopsis'])
    await arch.startGenerate(page)
    await waitForRunDone(page)
    await arch.badge(page, 'synopsis').filter({ hasText: '部分完成 · 10 / 24 章' }).waitFor({ timeout: 30_000 })
    assert.deepEqual(Object.keys(outlineChapters((await readCore(context)).synopsis)).map(Number), Array.from({ length: 10 }, (_, index) => index + 1))
  } },

  /**
   * #441 后续与 #453 的 CodeRabbit 意见：同 arch-model-change-last，第 6 章（范围 6–6）生成完、正式保存被拒。
   * 从架构页点「查看恢复稿」打开的恢复稿与运行侧页的恢复卡，标题都写「第 6 章」，说明不说已经生成完毕，叫作者从第 6 章重新生成。
   */
  'rst-outline-last-note': { model: true, shell: 'stage', setup: seedArch({ clear: ['synopsis'], totalChapters: 24 }), run: async context => {
    const { page } = context
    const last = await stallOutlineBatchAndChangeModel(context, 6)
    await last.waitFor({ state: 'visible', timeout: 60_000 })
    const card = runSheet.recovery(page).getByRole('article').filter({ hasText: /大纲恢复稿 · 第 6/ })
    await card.waitFor({ state: 'visible', timeout: 10_000 })
    const cardText = await card.innerText()
    assert.match(cardText, /大纲恢复稿 · 第 6 章\n/, '运行侧页恢复卡标题不写「6–6」')
    assert.match(cardText, /请从第 6 章重新生成情节大纲/)
    assert.doesNotMatch(cardText, /已经生成完毕/)
    const titles = await runSheet.recovery(page).getByRole('article').locator('h3').allInnerTexts()
    assert.deepEqual(titles.filter(title => /大纲恢复稿/.test(title)), ['大纲恢复稿 · 第 6 章'], '已原样写进正式大纲的第 1–5 章不列为可恢复（#464）')
    await openArchitecture(page)
    await arch.waitReady(page)
    await arch.section(page, 'synopsis').getByRole('button', { name: '查看恢复稿' }).click()
    const tab = stage.tab(page, '大纲恢复稿 · 第 6 章')
    await tab.waitFor({ state: 'visible', timeout: 10_000 })
    const content = stage.root(page).locator('.stage-content')
    await content.getByText(/请从第 6 章重新生成情节大纲/).waitFor({ state: 'visible', timeout: 10_000 })
    const viewer = await content.innerText()
    assert.doesNotMatch(viewer, /已经生成完毕/, '恢复稿页不说这批已生成完毕')
    assert.match(viewer, /待完成第 6 章，每章目标/, '恢复稿页顶部的待完成范围只剩一章时写「第 6 章」')
    assert.doesNotMatch(viewer, /第 6 至 6 章/)
    return { card: cardText.replace(/\s+/g, ' ').slice(0, 200), viewer: viewer.replace(/\s+/g, ' ').slice(0, 300) }
  } },

  /**
   * #441 双审计 P2：本批最后一章（第 6 章，范围 6–6）生成期间改模型，候选生成完、正式保存被来源检查拒绝。
   * 上一次运行不出现原始错误码；架构页的大纲提示只能查看或复制并给「从第 6 章重新生成」，不再退回续写与「编辑恢复稿」。
   */
  'arch-model-change-last': { model: true, shell: 'stage', setup: seedArch({ clear: ['synopsis'], totalChapters: 24 }), run: async context => {
    const { page } = context
    const last = await stallOutlineBatchAndChangeModel(context, 6)
    await last.waitFor({ state: 'visible', timeout: 60_000 })
    const notice = await last.innerText()
    assert.doesNotMatch(notice, /GENERATION_SOURCE_CHANGED|Error invoking remote method/, '界面不出现原始错误码')
    assert.match(notice, /本批第 6 章大纲已生成完，但保存前[\s\S]*正式保存被拒绝/)
    assert.match(notice, /这批大纲保留在「大纲恢复稿」中，只能查看或复制，不能覆盖正式内容/)
    assert.match(notice, /请到「架构」页重新生成情节大纲，从第 6 章开始/)
    assert.equal(await last.getByRole('button', { name: '继续生成情节大纲' }).count(), 0, '不提供必然被拒的断点续写')
    await openArchitecture(page)
    await arch.waitReady(page)
    const outline = arch.section(page, 'synopsis')
    const restart = outline.getByRole('button', { name: '从第 6 章重新生成' })
    await restart.waitFor({ state: 'visible', timeout: 10_000 })
    const note = await outline.innerText()
    assert.match(note, /只能查看或复制。请从第 6 章重新生成情节大纲/)
    assert.doesNotMatch(note, /续写从停下的地方|可编辑并本地保存|已经生成完毕/, '正式保存被拒时不承诺续写，也不说这批已生成完毕')
    assert.equal(await outline.getByRole('button', { name: '编辑恢复稿' }).count(), 0)
    assert.deepEqual(Object.keys(outlineChapters((await readCore(context)).synopsis)).map(Number), [1, 2, 3, 4, 5], '正式大纲仍停在第 5 章')
    return { notice, note }
  }, after: async context => {
    const { page } = context
    await arch.section(page, 'synopsis').getByRole('button', { name: '从第 6 章重新生成' }).click()
    assert.equal(await arch.dialog(page).getByRole('spinbutton', { name: '本次生成范围的起始章' }).inputValue(), '6', '生成对话框从第 6 章起')
    assert.equal(await arch.dialog(page).getByRole('spinbutton', { name: '本次生成范围的结束章' }).inputValue(), '6', '生成对话框沿用本批范围')
    await arch.selectOnly(page, ['synopsis'])
    await arch.startGenerate(page)
    await waitForRunDone(page)
    await arch.badge(page, 'synopsis').filter({ hasText: '部分完成 · 6 / 24 章' }).waitFor({ timeout: 30_000 })
    assert.deepEqual(Object.keys(outlineChapters((await readCore(context)).synopsis)).map(Number), Array.from({ length: 6 }, (_, index) => index + 1))
  } },

  /**
   * 修复第 2 轮补的 lane：真实主进程下大纲分批写到 16 / 24 章后重写第 1–5 章，对话框标「将覆盖第 1–5 章」并能提交；
   * after 生成并核对第 6 章起的正文逐字不变，大纲仍是部分完成 16 / 24，页头、流程脊同为 3 / 4。
   */
  'arch-rewrite': { model: true, shell: 'stage', setup: seedArch({ clear: ['synopsis'], totalChapters: 24 }), run: async context => {
    const { page } = context
    await openArchitecture(page)
    await arch.primary(page).click()
    await arch.selectOnly(page, ['synopsis'])
    await arch.setRange(page, 1, 10)
    await arch.startGenerate(page)
    await waitForRunDone(page)
    await arch.badge(page, 'synopsis').filter({ hasText: '部分完成 · 10 / 24 章' }).waitFor({ timeout: 30_000 })
    await arch.section(page, 'synopsis').getByRole('button', { name: '续写第 11 章起' }).click()
    await arch.setRange(page, 11, 16)
    await arch.startGenerate(page)
    await waitForRunDone(page)
    await arch.badge(page, 'synopsis').filter({ hasText: '部分完成 · 16 / 24 章' }).waitFor({ timeout: 30_000 })
    // 夹具模型每章的输出固定不变，先把第 1–5 章改成作者的旧稿，重写后才看得出被替换。
    const generated = (await readCore(context)).synopsis
    context.before = generated.replace(/^(## 第[1-5]章：[^\n]*\n[^\n]*)/gmu, '$1（作者旧稿）')
    const session = await uiSession(context.app)
    const saved = await context.invoke(page, 'db:project-core-update', { synopsis: context.before }, session.projectPath, session)
    assert.equal(saved.success, true, saved.error)
    await root(page).getByRole('button', { name: '架构的更多操作' }).click()
    await page.getByRole('menuitem', { name: '刷新状态' }).click()
    await arch.badge(page, 'synopsis').filter({ hasText: '部分完成 · 16 / 24 章' }).waitFor({ timeout: 30_000 })
    await arch.openSectionMenu(page, 'synopsis')
    await page.getByRole('menuitem', { name: 'AI 重新生成此节…' }).click()
    await arch.dialog(page).waitFor({ state: 'visible' })
    assert.equal(await arch.dialog(page).getByRole('spinbutton', { name: '本次生成范围的起始章' }).inputValue(), '17', '默认接着已有大纲往后写')
    await arch.selectOnly(page, ['synopsis'])
    await arch.setRange(page, 1, 5)
    assert.equal(await arch.mark(page, 'synopsis').innerText(), '将覆盖第 1–5 章')
    assert.equal(await arch.dialog(page).locator('.arch-range-effect').innerText(), '第 1–5 章按本次结果替换，第 6–16 章原样保留。')
    assert.equal(await arch.dialog(page).locator('.arch-range-issue').count(), 0, '没有范围无效的提示')
    assert.equal(await arch.dialog(page).getByRole('button', { name: /^开始生成 1 项$/ }).isDisabled(), false, '可以提交')
    return { coveredBefore: 16 }
  }, after: async context => {
    const { page } = context
    await arch.startGenerate(page)
    await waitForRunDone(page)
    let after
    for (let attempt = 0; attempt < 120; attempt++) {
      after = (await readCore(context)).synopsis
      if (after !== context.before) break
      await pause(500)
    }
    assert.notEqual(after, context.before, '第 1–5 章已重写')
    for (let number = 1; number <= 5; number++) assert.doesNotMatch(outlineChapters(after)[number], /作者旧稿/, `第 ${number} 章换成了本次结果`)
    const tail = text => text.slice(text.indexOf('## 第6章：'))
    assert.ok(tail(context.before).length > 0 && context.before.includes('## 第6章：'))
    assert.equal(tail(after), tail(context.before), '第 6 章起（含第 16 章与「已覆盖至第 16 章」说明）逐字不变')
    assert.deepEqual(Object.keys(outlineChapters(after)).map(Number), Array.from({ length: 16 }, (_, index) => index + 1), '仍是第 1–16 章各一次')
    await arch.badge(page, 'synopsis').filter({ hasText: '部分完成 · 16 / 24 章' }).waitFor({ timeout: 30_000 })
    await arch.section(page, 'synopsis').getByRole('button', { name: '续写第 17 章起' }).waitFor({ state: 'visible' })
    await arch.page(page).locator('.arch-eyebrow').filter({ hasText: '3 / 4 已确认' }).waitFor({ timeout: 30_000 })
    assert.match(await stage.stageButton(page, '架构').innerText(), /3 \/ 4/, '流程脊与页头同为 3 / 4')
    assert.equal(await arch.primary(page).innerText(), '继续生成架构')
  } },

  /** 旧外壳（发布默认外壳）侧栏：大纲分批写到 16 / 24 章仍算已生成，行内有清空按钮、右键可清空；名字与新外壳相同。 */
  'arch-legacy-sidebar': { model: false, shell: 'writer', setup: context => seedStageSample(context, { totalChapters: 24, beforeReload: async ({ page, invoke, path, session }) => {
    const body = Array.from({ length: 16 }, (_, index) => `## 第${index + 1}章：灯下第${index + 1}夜\n林岚在第${index + 1}夜核对雾钟与潮位。`).join('\n\n')
    const synopsis = `# 情节大纲\n\n${body}\n\n> 本大纲已覆盖至第 16 章（全书 24 章），其余章节将在后续批次继续生成。`
    const saved = await invoke(page, 'db:project-core-update', { synopsis }, path, session)
    assert.equal(saved.success, true, saved.error)
  } }), run: async ({ page }) => {
    const tree = page.locator('.tree-item')
    await tree.filter({ hasText: /^故事架构/ }).filter({ hasText: '4/4' }).waitFor({ timeout: 20_000 })
    const outline = tree.filter({ hasText: /^情节大纲/ })
    assert.doesNotMatch(await outline.innerText(), /待生成/, '分批大纲不显示待生成')
    assert.equal(await outline.getByRole('button').count(), 1, '行内有清空按钮')
    const names = await tree.allInnerTexts()
    assert.ok(names.some(name => name.startsWith('角色名单')), '侧栏写角色名单')
    assert.ok(!names.some(name => name.includes('角色图谱')), '侧栏没有角色图谱')
    await outline.click({ button: 'right' })
    const clear = page.getByRole('button', { name: '清空情节大纲' }).or(page.getByText('清空情节大纲', { exact: true })).first()
    await clear.waitFor({ state: 'visible' })
    assert.equal(await clear.isDisabled(), false, '右键清空可用')
    return { sidebar: names.slice(0, 8) }
  } },

  /** 英文界面一次：四节名字、名单菜单、名单全文标签与视图头、横幅、名单底栏单复数都与中文同一套说法。 */
  'arch-names-en': { model: false, shell: 'stage', setup: seedArch(), run: async ({ page, invoke, reload }) => {
    assert.equal((await invoke(page, 'config:set', { locale: 'en-US' })).success, true)
    await reload()
    await stage.openFromLibraryEn(page, '灯塔')
    await page.getByRole('navigation', { name: 'Writing flow' }).getByRole('button', { name: /^Architecture/ }).click()
    await root(page).locator('.arch-page:not([data-loading]):not([data-cast-loading])').waitFor({ state: 'visible', timeout: 30_000 })
    const regions = ['Premise', 'Cast', 'World', 'Outline']
    for (const name of regions) await root(page).getByRole('region', { name, exact: true }).waitFor({ state: 'visible' })
    await root(page).getByRole('region', { name: 'Cast', exact: true }).getByRole('button', { name: 'More for Cast' }).click()
    await page.getByRole('menuitem', { name: 'View cast as text' }).click()
    await page.getByRole('tab', { name: 'Cast as text' }).waitFor({ state: 'visible' })
    const viewer = root(page)
    await viewer.getByText('This is the read-only text of the cast, generated from it. Edit identities, profiles and relationships on the Cast page.').waitFor()
    const text = await viewer.innerText()
    assert.doesNotMatch(text, /Character graph|Character map|Character Management|Worldbuilding|Synopsis/, '没有旧名字')
    await page.getByRole('tab', { name: 'Architecture' }).click()
    await root(page).getByRole('region', { name: 'Cast', exact: true }).getByRole('button', { name: 'Open cast' }).click()
    await root(page).locator('.cast-roster-foot').filter({ hasText: '1 character · page 1 / 1' }).waitFor()
    return { regions }
  } },

  ...Object.fromEntries(['zh-CN', 'en-US'].flatMap(locale => [[1024, false], [1280, false], [1280, true]].map(([width, sheet]) =>
    [`cast-fit-${locale === 'en-US' ? 'en' : 'zh'}-${width}${sheet ? '-sheet' : ''}`, { model: false, shell: 'stage', setup: seedArch(), run: context => castFitAt(context, locale, width, sheet) }]))),

  /** lane 6：清空此节出现危险确认；after 取消，界面与数据库里的世界观都没变。 */
  'arch-clear': { model: false, shell: 'stage', setup: seedArch(), run: async context => {
    const { page } = context
    await openArchitecture(page)
    context.worldSummary = await arch.summary(page, 'worldbuilding').innerText()
    await arch.openSectionMenu(page, 'worldbuilding')
    await page.getByRole('menuitem', { name: '清空此节…' }).click()
    const confirm = page.getByRole('dialog', { name: '清空「世界观」？' })
    await confirm.waitFor({ state: 'visible' })
    assert.match(await confirm.innerText(), /无法撤销/)
    assert.equal(await confirm.locator('.pi-btn--danger-solid').innerText(), '清空此节')
  }, after: async context => {
    const { page } = context
    await page.getByRole('dialog', { name: '清空「世界观」？' }).getByRole('button', { name: '取消' }).click()
    await page.getByRole('dialog', { name: '清空「世界观」？' }).waitFor({ state: 'hidden' })
    assert.equal(await arch.summary(page, 'worldbuilding').innerText(), context.worldSummary)
    assert.equal(await arch.badge(page, 'worldbuilding').innerText(), '已确认')
    assert.equal((await readCore(context)).worldbuilding, STAGE_SAMPLE.core.worldbuilding, '取消后世界观没有写入')
  } },

  /** lane 9 补充：导入角色卡对话框与外发确认都是纸墨对话框（同一个对话框的两步），底色来自令牌。停在外发确认一步。 */
  'arch-import-dialog': { model: true, shell: 'stage', setup: seedArch(), run: async ({ page }) => {
    await openArchitecture(page)
    await arch.openCast(page)
    await page.getByRole('button', { name: '粘贴 / 导入角色卡' }).first().click()
    const dialog = page.getByRole('dialog', { name: '粘贴 / 导入角色卡' })
    await dialog.getByLabel('角色卡全文').fill('姓名：守塔人\n身份：灯塔看守，记得每一次钟声。')
    assert.ok(await dialog.evaluate(element => element.classList.contains('pi-dialog') && Boolean(element.closest('.paper-ink'))), '导入对话框在纸墨根下')
    await dialog.getByRole('button', { name: 'AI 提取并预览' }).click()
    const consent = page.getByRole('dialog', { name: 'AI 提取角色卡' })
    await consent.getByRole('button', { name: '发送并提取' }).waitFor({ state: 'visible' })
    assert.match(await consent.innerText(), /端点：/)
    assert.equal(await page.getByRole('dialog').count(), 1, '外发确认是同一个对话框，不另弹旧确认框')
    const surface = await consent.evaluate(element => {
      const probe = document.createElement('span')
      element.append(probe)
      probe.style.backgroundColor = 'var(--layer)'
      const surface = getComputedStyle(probe).backgroundColor
      probe.remove()
      return { surface, dialog: getComputedStyle(element).backgroundColor }
    })
    assert.equal(surface.dialog, surface.surface, '对话框底色是浮笺 --layer（RD-V 起对话框、菜单、通知同一材质）')
  }, after: async ({ page }) => {
    await page.getByRole('dialog').getByRole('button', { name: '返回' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '暂不导入' }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
  } },

  /** lane 7：在角色名单里新建「守塔人」并按 Ctrl S 保存：名单、名单全文投影与架构页的角色名单一节同步。 */
  'arch-cast-save': { model: false, shell: 'stage', setup: seedArch(), run: async context => {
    const { page } = context
    await openArchitecture(page)
    await arch.openCast(page)
    await arch.castRoster(page).getByRole('button', { name: '新建角色' }).click()
    const name = page.getByLabel('姓名', { exact: true })
    await name.fill('守塔人')
    await page.getByLabel('动机', { exact: true }).fill('守住雾钟，等一个三十年前没回来的人。')
    await root(page).locator('.cast-save-state').filter({ hasText: '未保存' }).waitFor()
    await page.keyboard.press('Control+S')
    await root(page).locator('.cast-save-state').filter({ hasText: '已保存' }).waitFor({ timeout: 20_000 })
    assert.deepEqual(await arch.castRoster(page).locator('.cast-row-name').allInnerTexts(), ['林岚', '守塔人'])
    const roster = await readRoster(context)
    assert.equal(roster.status, 'ready')
    assert.match(roster.renderedMarkdown, /守塔人/, '名单全文投影里有守塔人')
    await stage.tab(page, '架构').click()
    await arch.waitReady(page)
    assert.match(await arch.summary(page, 'characters').innerText(), /2 位角色：林岚、守塔人/)
    await arch.openSectionMenu(page, 'characters')
    await page.getByRole('menuitem', { name: '查看角色名单全文' }).click()
    await stage.prose(page).getByText('守塔人').first().waitFor({ state: 'visible' })
    await stage.tab(page, '角色名单全文').waitFor({ state: 'visible' })
    await stage.tabList(page).getByRole('tab', { name: '角色名单', exact: true }).click()
    await arch.castRoster(page).waitFor({ state: 'visible' })
  } },

  /** lane 8：关系图谱可缩放、可拖拽，点节点打开档案。 */
  'arch-graph': { model: false, shell: 'stage', setup: seedArch({ characters: ['守塔人', '沈砚', '何婆婆'] }), run: async context => {
    const { page } = context
    await openArchitecture(page)
    await arch.openCast(page)
    await root(page).getByRole('button', { name: '关系图谱', exact: true }).click()
    const canvas = root(page).locator('.cast-graph canvas')
    await canvas.waitFor({ state: 'visible' })
    const zoom = root(page).locator('.cast-graph').getByText(/^\d+%$/)
    const before = await zoom.innerText()
    await root(page).getByRole('button', { name: '放大关系图谱' }).click()
    assert.notEqual(await zoom.innerText(), before, '放大后缩放比例变化')
    const box = await canvas.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -200)
    const image = () => canvas.evaluate(element => element.toDataURL())
    const beforeDrag = await image()
    await page.mouse.move(box.x + 40, box.y + box.height - 40)
    await page.mouse.down()
    await page.mouse.move(box.x + 140, box.y + box.height - 100, { steps: 8 })
    await page.mouse.up()
    assert.notEqual(await image(), beforeDrag, '拖拽后图谱画面移动')
    await root(page).getByRole('button', { name: '适合视图' }).click()
    context.canvasBox = await canvas.boundingBox()
  }, after: async context => {
    const { page } = context
    await root(page).getByRole('button', { name: '重置图谱布局' }).click()
    const box = context.canvasBox
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await root(page).getByRole('button', { name: '基础设定', pressed: true }).waitFor({ timeout: 5000 })
    assert.ok(['林岚', '守塔人', '沈砚', '何婆婆'].includes(await arch.profileName(page).innerText()), '点中心节点打开了档案')
  } },

  /** lane 9：从角色名单导入两张角色卡，在运行侧页确认后守塔人出现在名单、林岚仍只有一个。 */
  'arch-cards': { model: true, shell: 'stage', setup: seedArch(), run: async ({ page, fake }) => {
    fake.replyCharacterCards()
    await openArchitecture(page)
    await arch.openCast(page)
    await materials.importCharacterCards(page, '姓名：守塔人\n身份：灯塔看守，记得每一次钟声。\n\n姓名：林岚\n身份：旧港潮汐记录的测绘师。')
    await runSheet.waitUntilOpen(page)
    const waiting = runSheet.anyCard(page).filter({ hasText: '等你确认' })
    await waiting.getByRole('button', { name: '按当前选择确认', disabled: false }).waitFor({ state: 'visible', timeout: 60_000 })
    const keeper = waiting.getByRole('combobox', { name: /^采用方式：守塔人/ })
    const lin = waiting.getByRole('combobox', { name: /^采用方式：林岚/ })
    await lin.selectOption(await lin.locator('option').filter({ hasText: /^林岚 ·/ }).getAttribute('value'))
    await keeper.selectOption('create')
    await waiting.getByRole('button', { name: '按当前选择确认' }).click()
    await runSheet.waitForRunDone(page)
    await arch.castRow(page, '守塔人').waitFor({ state: 'visible', timeout: 20_000 })
    assert.equal(await arch.castRoster(page).locator('.cast-row-name').filter({ hasText: /^林岚$/ }).count(), 1, '林岚对应已有角色，没有多出一个')
  } },

  /** lane 10：深色主题下的架构页（含一条大纲提示条）：文字对比度达标，卡片底色来自纸墨令牌。用 --theme dark 跑。 */
  'arch-dark': { model: false, shell: 'stage', setup: seedArch({ clear: ['worldbuilding'] }), run: async ({ page }) => {
    assert.equal(await stage.root(page).getAttribute('data-theme'), 'dark', '用 --theme dark 跑；浅色下这条 lane 测不到深色')
    await openArchitecture(page)
    assert.deepEqual(await archContrastFailures(page), [], '对比度不足或底色不是令牌')
    return { theme: await stage.root(page).getAttribute('data-theme') }
  } },

  /**
   * perf：从点流程脊「架构」到四节可交互的毫秒数（trunk 是旧故事架构标签，head 是架构阶段）：openMs 按动画帧轮询，openDomMs 是 DOM 达到就绪的时刻，
   * 以及 200 位角色时角色列表滚动的帧率（两边都是第 1 页 50 位）。两边都用新外壳跑。
   */
  'arch-timing': { model: false, shell: 'stage', setup: seedArch({ characters: Array.from({ length: 199 }, (_, index) => `角色${String(index + 2).padStart(3, '0')}`) }), run: async ({ page, app }) => {
    await countIpc(app)
    const target = stage.stageButton(page, '架构')
    const handle = await target.elementHandle()
    await page.evaluate(element => {
      let clickedAt = null
      element.addEventListener('click', () => { clickedAt ??= performance.now() }, { capture: true, once: true })
      window.__driveArchReady = new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('架构四节 20 秒内未就绪')), 20_000)
        const ready = () => {
          const content = document.querySelector('.stage-content')
          if (!content) return false
          if (content.querySelector('.arch-page')) return content.querySelectorAll('.arch-section').length === 4 && !content.querySelector('.arch-page[data-loading]')
          return /4\/4\s*已生成/.test(content.textContent ?? '') && !content.querySelector('.animate-spin')
        }
        const mounted = () => Boolean(document.querySelector('.stage-content .arch-page') || /故事架构/.test(document.querySelector('.stage-content')?.textContent ?? ''))
        // 屏幕外窗口被系统判为遮挡时 rAF 会被节流，没有画面变化就迟迟不出帧；另用 MutationObserver 记下 DOM 达到就绪的准确时刻。
        new MutationObserver(() => {
          if (clickedAt !== null && window.__driveArchDomMs === undefined && ready()) window.__driveArchDomMs = Math.round(performance.now() - clickedAt)
        }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
        const tick = () => {
          if (clickedAt !== null && window.__driveArchMountMs === undefined && mounted()) window.__driveArchMountMs = Math.round(performance.now() - clickedAt)
          if (clickedAt !== null && ready()) { clearTimeout(deadline); resolve(Math.round(performance.now() - clickedAt)) } else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
    }, handle)
    await target.click()
    const openMs = await page.evaluate(() => window.__driveArchReady)
    const ipcDuringOpen = await app.evaluate(() => globalThis.__driveIpcCounts)
    const mountMs = await page.evaluate(() => window.__driveArchMountMs)
    const openDomMs = await page.evaluate(() => window.__driveArchDomMs)

    await page.keyboard.press('Control+K')
    await stage.paletteInput(page).fill('角色')
    await stage.palette(page).getByRole('option', { name: /^角色/ }).first().click()
    const list = page.locator('.cast-list, .stage-characters-list .overflow-y-auto').first()
    await list.waitFor({ state: 'visible' })
    await page.waitForFunction(() => document.querySelectorAll('.cast-row, .stage-characters-list [data-character-id], .stage-characters-list [role="button"]').length >= 50)
    const box = await list.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.evaluate(() => {
      window.__driveFrames = []
      const tick = time => { window.__driveFrames.push(time); if (window.__driveFrames.length < 10_000) window.__driveFramesId = requestAnimationFrame(tick) }
      window.__driveFramesId = requestAnimationFrame(tick)
    })
    for (let step = 0; step < 30; step++) {
      await page.mouse.wheel(0, step < 15 ? 120 : -120)
      await pause(33)
    }
    const frames = await page.evaluate(() => { cancelAnimationFrame(window.__driveFramesId); return window.__driveFrames })
    const seconds = (frames.at(-1) - frames[0]) / 1000
    const rows = await page.locator('.cast-row, .stage-characters-list [data-character-id]').count()
    return { surface: await page.locator('.arch-page, .cast-page').count() > 0 ? 'head' : 'trunk', openMs, scrollFps: Math.round((frames.length - 1) / seconds * 10) / 10, rowsOnPage: rows, openDomMs, mountMs, ipcDuringOpen }
  } },

  /** 评审视频：架构四节与主按钮、生成对话框的覆盖与保留、大纲提示条、清空此节的危险确认、角色名单保存与关系图谱。配 --video。 */
  'arch-tour': { model: false, shell: 'stage', setup: seedArch({ clear: ['worldbuilding'], characters: ['守塔人', '沈砚'] }), run: async ({ page }) => {
    await openArchitecture(page)
    await pause(7000)
    await arch.primary(page).click()
    await arch.dialog(page).waitFor({ state: 'visible' })
    await pause(1500)
    await arch.stepCheck(page, 'premise').click()
    await pause(2000)
    await arch.dialog(page).getByRole('button', { name: '取消' }).click()
    await pause(1000)
    await arch.openSectionMenu(page, 'premise')
    await pause(1000)
    await page.getByRole('menuitem', { name: '清空此节…' }).click()
    await pause(2500)
    await page.getByRole('dialog', { name: '清空「故事前提」？' }).getByRole('button', { name: '取消' }).click()
    await pause(1200)
    await arch.openCast(page)
    await pause(2000)
    await arch.castRow(page, '沈砚').click()
    await pause(1200)
    await page.getByLabel('动机', { exact: true }).fill('替母亲把那封信送到。')
    await pause(1000)
    await root(page).getByRole('button', { name: '保存角色' }).click()
    await root(page).locator('.cast-save-state').filter({ hasText: '已保存' }).waitFor({ timeout: 20_000 })
    await pause(1500)
    await root(page).getByRole('button', { name: '关系图谱', exact: true }).click()
    await pause(3500)
    await root(page).getByRole('button', { name: '放大关系图谱' }).click()
    await pause(800)
    await root(page).getByRole('button', { name: '放大关系图谱' }).click()
    await pause(1500)
    await root(page).getByRole('button', { name: '基础设定', exact: true }).click()
    await pause(1200)
    await stage.tab(page, '架构').click()
    await pause(5000)
  } },
}


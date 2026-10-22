// RD-V 统一视觉层的实机场景：危险确认（含清除中）、命令式错误弹框、提示栈（含出错通知）、运行失败提示，以及新外壳下的旧对话框。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import * as blueprint from './pages/blueprint.mjs'
import * as bookshelf from './pages/bookshelf.mjs'
import * as materials from './pages/materials.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { FAKE_MODEL } from './fake-model.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'
import { seedStageSample } from './scenarios.mjs'

async function openWorkMenuItem(page, name) {
  await stage.root(page).getByRole('banner').getByRole('button', { name: `《${STAGE_SAMPLE.name}》作品菜单` }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}

/** 遮罩与对话框的淡入是 220ms，截图前等它走完。 */
const settle = page => page.waitForTimeout(400)

const focusedText = page => page.evaluate(() => document.activeElement?.textContent)

/** 浮层是否渲染进带 .paper-ink 的纸墨根或宿主里：只有那样才取得到纸墨令牌与深色。 */
const inPaperInk = locator => locator.evaluate(element => element.closest('.paper-ink') !== null)

/** 写一章后打开诊断分页，返回第一条调用的「复制安全诊断」按钮。 */
async function diagnosticsCopyButton(page) {
  await blueprint.open(page)
  await blueprint.writeNext(page)
  await runSheet.waitUntilOpen(page)
  await runSheet.waitForRunDone(page)
  await runSheet.tab(page, '诊断').click()
  const copy = runSheet.sheet(page).getByRole('table').getByRole('button', { name: '复制安全诊断' }).first()
  await copy.waitFor({ state: 'visible', timeout: 10_000 })
  return copy
}

/** 剪贴板写入成功或失败：失败时 copySafeDiagnostic 报出错通知。 */
const stubClipboard = (page, ok) => page.evaluate(succeed => {
  navigator.clipboard.writeText = async () => { if (!succeed) throw new Error('clipboard denied') }
}, ok)

const liveToastTitles = page => page.locator('.pi-toast:not([data-exiting]) .pi-toast-title').allInnerTexts()

/** 预置两条调用记录，诊断分页的调用表才有「复制安全诊断」。 */
async function seedCalls({ page, invoke, path: projectPath, session }) {
  for (const [purpose, durationMs] of [['chapter-draft', 41_000], ['review-chapter', 27_000]]) {
    assert.equal((await invoke(page, 'db:log-llm-call', { modelId: FAKE_MODEL.id, modelName: FAKE_MODEL.name, purpose, promptTokens: 4000,
      completionTokens: 1200, totalTokens: 5200, durationMs, success: true }, projectPath, session)).success, true)
  }
}

/** 运行侧页开着时逐页走一遍的页面。被挤到零宽的页面看不见，所以只等它进入 DOM。 */
const attached = locator => locator.first().waitFor({ state: 'attached' })
/** 资料页挂上后经 IPC 读数据，读完前显示「正在读取…」：等页面的内容标记进入 DOM、读取提示消失再量。 */
async function loaded(page, selector) {
  await attached(stage.root(page).locator(selector))
  await page.waitForFunction(() => !document.querySelector('.stage-content')?.innerText.includes('正在读取'))
}
const SHEET_PAGES = [
  ['chapter', async page => {
    const chapterTab = stage.tab(page, /^第 3 章/)
    if (await chapterTab.isVisible()) await chapterTab.click()
    await attached(stage.prose(page))
  }],
  ['setup', async page => { await stage.stageButton(page, '设定').click(); await attached(stage.setupOutline(page)) }],
  ['architecture', async page => { await stage.stageButton(page, '架构').click(); await attached(stage.root(page).locator('.arch-page:not([data-loading]):not([data-cast-loading]) .arch-section')) }],
  ['blueprint', async page => { await stage.stageButton(page, '蓝图').click(); await attached(blueprint.card(page)) }],
  ['characters', async page => {
    await page.keyboard.press('Control+K')
    await stage.paletteInput(page).fill('角色')
    await stage.palette(page).getByRole('option', { name: /^角色/ }).first().click()
    await stage.palette(page).waitFor({ state: 'detached' })
    // 名单读完才列出角色行：等到行出现，免得量到上一页。
    await attached(stage.characterList(page).locator('.cast-row'))
  }],
  ['plot', async page => { await stage.stageButton(page, '剧情与伏笔').click(); await loaded(page, '.stage-plot') }],
  ['knowledge', async page => { await stage.stageButton(page, '知识库').click(); await loaded(page, '.stage-kb-docs') }],
  ['history', async page => { await stage.stageButton(page, '版本历史').click(); await loaded(page, '.stage-hist-chapter') }],
  ['settings', stage.openSettings],
]

/**
 * 主区域里排成一字一行的文字：一段至少三个字的文字排出的行数不少于字数的六成。被挤窄的标题、说明与竖排的状态标签都是这个样子；
 * 正常折行的段落每行有很多字，不会命中。逐个文本节点查，再按直接含文字的元素整体查（「正文 · 定稿」由几个短节点拼成）。
 */
const crushedText = page => page.evaluate(() => {
  const area = document.querySelector('.stage-body')
  const found = new Set()
  const check = (target, text) => {
    const chars = [...text.replace(/\s/g, '')].length
    if (chars < 3) return
    const range = document.createRange()
    range.selectNodeContents(target)
    const lines = new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top))).size
    if (lines >= 3 && lines >= chars * 0.6) found.add(`${text.trim().replace(/\s+/g, ' ').slice(0, 20)}（${chars} 字 ${lines} 行）`)
  }
  const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const owner = node.parentElement
    if (!node.textContent.trim() || owner.closest('.stage-sheet-slot, [hidden]')) continue
    check(node, node.textContent)
    if (!owner.querySelector('div, p, section, article, ul, ol, li, table, textarea, input, button')) check(owner, owner.textContent)
  }
  return [...found]
})

const areaWidths = page => page.evaluate(() => {
  const width = selector => Math.round(document.querySelector(selector)?.getBoundingClientRect().width ?? 0)
  return { body: width('.stage-body'), content: width('.stage-content:not([hidden]), .stage-body > .stage-settings'), sheet: width('.stage-sheet-slot'),
    sheetInner: width('.stage-sheet-slot > .pi-sheet'), overlay: getComputedStyle(document.querySelector('.stage-sheet-slot')).position === 'absolute' }
})

/**
 * 1152×720 与 820×640 是 1440×900、1024×768 的窗口在界面缩放 125% 时的 CSS 视口；683×512 是最小窗口 1024×768 在最大缩放 150% 时的，
 * 也就是主区域能被挤到的最窄处。
 */
const SHEET_VIEWPORTS = [[1440, 900], [1280, 800], [1152, 720], [1024, 768], [820, 640], [683, 512]]

async function resize(page, width, height) {
  await page.setViewportSize({ width, height })
  await page.waitForFunction(expected => innerWidth === expected, width)
}

function openSheetPage(page, name) {
  const entry = SHEET_PAGES.find(([candidate]) => candidate === name)
  if (!entry) throw new Error(`SHEET_PAGES 里没有「${name}」`)
  return entry[1](page)
}

/**
 * 三击选中编辑器里的一行，量选区工具条实际画在哪：工具条用视口坐标定位（底边中点对准选区上方），
 * 实际底边中点与它内联的 top/left 之差就是被祖先包含块带偏的距离。
 */
async function selbarOffset(page, line) {
  // 点行首附近：窄视口里浮起的侧页盖住行的右半边
  await line.click({ clickCount: 3, position: { x: 24, y: 8 } })
  const toolbar = page.getByRole('toolbar', { name: '选中文字的操作' })
  await toolbar.waitFor({ state: 'visible' })
  await page.waitForTimeout(200)
  return toolbar.evaluate(bar => {
    const rect = bar.getBoundingClientRect()
    const selection = window.getSelection().getRangeAt(0).getBoundingClientRect()
    const anchorLeft = parseFloat(bar.style.left)
    const anchorTop = parseFloat(bar.style.top)
    // 没有内联坐标时差值是 NaN，与容差比较恒为假，断言会空过。
    if (!Number.isFinite(anchorLeft) || !Number.isFinite(anchorTop)) throw new Error(`选区工具条没有内联的 left/top：「${bar.style.cssText}」`)
    return {
      dx: Math.round(rect.left + rect.width / 2 - anchorLeft),
      dy: Math.round(rect.bottom - anchorTop),
      gapAboveSelection: Math.round(selection.top - rect.bottom),
    }
  })
}

export const VISUAL_SCENARIOS = {
  // 选区工具条画在选区正上方：正文与架构文档两处编辑器，运行侧页浮起时也一样。
  'rdv-selbar-anchor': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page, shoot }) => {
    const measured = {}
    const failures = []
    const check = async (name, line) => {
      const offset = await selbarOffset(page, line)
      measured[name] = offset
      if (Math.abs(offset.dx) > 2 || Math.abs(offset.dy) > 2) failures.push(`${name}：${JSON.stringify(offset)}`)
      await shoot(`rdv-selbar-${name}`)
    }
    const chapterTab = stage.tab(page, /^第 3 章/)
    if (await chapterTab.isVisible()) await chapterTab.click()
    await check('chapter', stage.prose(page).locator('.cm-line').filter({ hasText: /\S{6}/ }).nth(2))
    await stage.stageButton(page, '架构').click()
    const premise = stage.root(page).getByRole('region', { name: '故事前提', exact: true })
    await premise.getByRole('button', { name: '编辑' }).click()
    const archLine = stage.root(page).locator('.stage-content .cm-content .cm-line').filter({ hasText: /\S{6}/ }).first()
    await archLine.waitFor({ state: 'visible' })
    await check('architecture', archLine)
    await resize(page, 820, 640)
    await runSheet.openFromPalette(page)
    await settle(page)
    await check('architecture-820-sheet', archLine)
    assert.deepEqual(failures, [], '选区工具条的底边中点落在它定位的视口坐标上')
    return measured
  } },

  // 运行侧页的诊断分页开着时，在 SHEET_VIEWPORTS 的每种视口下逐页检查：主区域不被挤到一字一行。
  'rdv-sheet-squeeze': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page, shoot }) => {
    await runSheet.openFromPalette(page)
    await runSheet.tab(page, '诊断').click()
    const measured = {}
    const failures = []
    for (const [width, height] of SHEET_VIEWPORTS) {
      await resize(page, width, height)
      for (const [name, open] of SHEET_PAGES) {
        await open(page)
        await runSheet.sheet(page).waitFor({ state: 'visible' })
        await settle(page)
        const crushed = await crushedText(page)
        measured[`${name}-${width}`] = { ...await areaWidths(page), crushed }
        // 设置页的分组导航固定 232px，最窄视口里留给设置内容的宽度不够；设置导航由另一项工作处理，这里只记录不判失败
        const owned = name === 'settings' && width < 820
        if (crushed.length && !owned) failures.push(`${name} @${width}：${crushed.join('、')}`)
        await shoot(`rdv-sheet-${name}-${width}`)
        // 最窄的视口里侧页浮在设置页上、盖住「返回作品」
        if (name === 'settings') await stage.closeSettings(page, { dispatch: true })
      }
    }
    // 最窄视口里侧页盖住了大半内容区，收起侧页再拍一遍，看内容区自己的窄版排版
    await runSheet.sheet(page).getByRole('button', { name: '收起运行侧页' }).click()
    await runSheet.sheet(page).waitFor({ state: 'detached' })
    for (const [name, open] of SHEET_PAGES.filter(([name]) => name !== 'settings')) {
      await open(page)
      await settle(page)
      await shoot(`rdv-sheet-${name}-683-closed`)
    }
    // 面板 790 宽（1076 视口）：诊断侧页浮在关系图谱上，图谱工具条不画在侧页上面、不截走点击
    await resize(page, 1076, 768)
    // 视图切换按钮在内容区右侧，侧页浮起后被盖住，所以先切到关系图谱再开侧页
    await openSheetPage(page, 'characters')
    await stage.root(page).locator('.cast-view-switch').getByRole('button', { name: '关系图谱' }).click()
    await stage.root(page).locator('.cast-graph canvas').waitFor({ state: 'visible' })
    await runSheet.openFromPalette(page)
    await runSheet.tab(page, '诊断').click()
    await settle(page)
    const toolbarOverSheet = await page.evaluate(() => {
      const slot = document.querySelector('.stage-sheet-slot')
      const sheet = slot.getBoundingClientRect()
      // 只查中心点落在侧页矩形里的按钮；中心在视口外时 elementFromPoint 为 null，不算画在侧页上
      return [...document.querySelectorAll('.cast-graph button')].filter(button => {
        const rect = button.getBoundingClientRect()
        const x = rect.left + rect.width / 2
        const y = rect.top + rect.height / 2
        const hit = rect.width > 0 && x >= sheet.left && x <= sheet.right && y >= sheet.top && y <= sheet.bottom ? document.elementFromPoint(x, y) : null
        return hit !== null && !slot.contains(hit)
      }).map(button => button.getAttribute('aria-label') ?? button.textContent.trim())
    })
    measured['characters-graph-1076'] = { ...await areaWidths(page), toolbarOverSheet }
    if (toolbarOverSheet.length) failures.push(`关系图谱工具条画在浮起的侧页上：${toolbarOverSheet.join('、')}`)
    await shoot('rdv-sheet-characters-graph-1076')
    // 1280 视口开着普通侧页（内容区约 614px）：架构页页头放得下时动作与标题同一行
    await resize(page, 1280, 800)
    await runSheet.tab(page, '进行中').click()
    await openSheetPage(page, 'architecture')
    await settle(page)
    const header = await page.evaluate(() => {
      const box = selector => document.querySelector(selector).getBoundingClientRect()
      return { headingRight: Math.round(box('.arch-heading').right), actionsLeft: Math.round(box('.arch-header-actions').left), sameRow: box('.arch-header-actions').top < box('.arch-heading').bottom }
    })
    measured['architecture-1280-active'] = { ...await areaWidths(page), header }
    if (!header.sameRow) failures.push(`1280 视口开着侧页时架构页页头的动作换到了标题下面：${JSON.stringify(header)}`)
    await shoot('rdv-sheet-architecture-1280-active')
    assert.deepEqual(failures, [], '诊断侧页开着时没有一字一行的文字，浮起的侧页不被内容区的浮层压住，1280 下架构页页头不换行')
    return measured
  } },
  'rdv-clear': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await openWorkMenuItem(page, '清除生成内容…')
    const dialog = page.getByRole('dialog', { name: '清除项目生成内容' })
    await dialog.waitFor({ state: 'visible' })
    assert.equal(await focusedText(page), '取消', '危险确认的焦点在取消')
    assert.equal(await dialog.locator('.pi-check-row').count(), 3, '三类内容是勾选行')
    await dialog.locator('.pi-check-row').first().click()
    assert.match(await dialog.locator('.pi-dialog-consequence > p').first().innerText(), /^将清除 2 类内容/, '后果句随勾选改写')
    assert.ok(await inPaperInk(dialog), '对话框在纸墨根里')
    await settle(page)
  }, after: async ({ page }) => {
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: '清除项目生成内容' }).waitFor({ state: 'hidden' })
  } },

  'rdv-alert': { model: false, shell: 'stage', run: async ({ app, page, roots }) => {
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
    }, roots.projects)
    await bookshelf.createProject(page, '雾岛')
    await stage.spine(page).waitFor({ state: 'visible' })
    await stage.backToLibrary(page, '雾岛')
    // 同一目录里再建一部同名作品，主进程拒绝，界面用命令式 alertError 报错
    await page.getByRole('button', { name: '新建作品', exact: true }).click()
    // RD-5 起新建作品是纸墨对话框（NewWorkDialog）；旧外壳仍是「新建小说项目」
    const form = page.getByRole('dialog', { name: /^(新建小说项目|新建作品)$/ })
    await form.getByRole('textbox').first().fill('雾岛')
    await form.getByRole('button', { name: '选择', exact: true }).click()
    assert.ok(await inPaperInk(form), '新建作品对话框在纸墨根或宿主里')
    await form.getByRole('button', { name: /^(创建项目|创建作品)$/ }).click()
    const alert = page.getByRole('alertdialog')
    await alert.waitFor({ state: 'visible' })
    assert.ok(await inPaperInk(alert), '命令式错误弹框渲染进纸墨宿主')
    assert.equal(await focusedText(page), '确定', '焦点在确定上')
    await settle(page)
  }, after: async ({ page }) => {
    await page.getByRole('alertdialog').getByRole('button', { name: '确定', exact: true }).click()
    await page.getByRole('alertdialog').waitFor({ state: 'hidden' })
  } },

  // #474 B4：主进程只交错误码（PROJECT_DIRECTORY_EXISTS、PROJECT_DIRECTORY_MISSING），英文界面的报错弹框按码写成英文。
  'project-errors-en': { model: false, shell: 'stage', run: async context => {
    const { app, roots, invoke, shoot } = context
    let { page } = context
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
    }, roots.projects)
    await bookshelf.createProject(page, '雾岛')
    await stage.spine(page).waitFor({ state: 'visible' })
    await stage.backToLibrary(page, '雾岛')
    assert.equal((await invoke(page, 'config:set', { locale: 'en-US' })).success, true)
    await context.reload()
    await page.getByRole('list', { name: 'Recent books' }).waitFor({ state: 'visible' })
    const alert = page.getByRole('alertdialog')
    const observed = {}

    await page.getByRole('button', { name: 'New book', exact: true }).click()
    const form = page.getByRole('dialog', { name: 'New book' })
    await form.getByRole('textbox').first().fill('雾岛')
    await form.getByRole('button', { name: 'Choose', exact: true }).click()
    await form.getByRole('button', { name: 'Create book' }).click()
    await alert.waitFor({ state: 'visible' })
    observed.exists = await alert.innerText()
    await settle(page)
    await shoot('project-exists-en')
    await alert.getByRole('button', { name: 'OK', exact: true }).click()
    await alert.waitFor({ state: 'hidden' })
    await page.keyboard.press('Escape')
    await form.waitFor({ state: 'hidden' })

    // 最近作品的文件夹在应用外被移走，再从书房打开。冷重启后作品文件不再被占用；驱动的重启按中文书房判断就绪，先切回中文。
    assert.equal((await invoke(page, 'config:set', { locale: 'zh-CN' })).success, true)
    await context.restart()
    page = context.page
    fs.rmSync(path.join(roots.projects, '雾岛'), { recursive: true, force: true })
    assert.equal((await invoke(page, 'config:set', { locale: 'en-US' })).success, true)
    await context.reload()
    await page.getByRole('list', { name: 'Recent books' }).waitFor({ state: 'visible' })
    await stage.openFromLibraryEn(page, '雾岛')
    const missingAlert = page.getByRole('alertdialog')
    await missingAlert.waitFor({ state: 'visible' })
    observed.missing = await missingAlert.innerText()
    await settle(page)
    await shoot('project-missing-en')

    for (const text of Object.values(observed)) {
      assert.doesNotMatch(text, /\p{Script=Han}/u, '英文界面的报错不带中文')
      assert.doesNotMatch(text, /[A-Z]{3,}_[A-Z]/u, '英文界面的报错不露错误码')
    }
    assert.match(observed.exists, /A folder with this name already exists there, so it was not overwritten\./u)
    assert.match(observed.missing, /The project folder could not be found\./u)
    return observed
  }, after: async ({ page }) => {
    await page.getByRole('alertdialog').getByRole('button', { name: 'OK', exact: true }).click()
    await page.getByRole('alertdialog').waitFor({ state: 'hidden' })
  } },

  // #474 B1：英文界面导入参考小说，参照章节写入知识库前这次导入的执行租约被别处收回（用公开的 db:import-run-cancel-at-boundary
  // 按卡住的请求里的执行身份收回）。主进程的导入运行仓储只交 IMPORT_RUN_EXECUTION_STALE，运行卡片的失败说明是英文、不带汉字与错误码。
  'import-run-error-en': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ app, page, roots, invoke, shoot }) => {
    await stage.openSettings(page)
    await stage.showSettingsPage(page, '外观')
    await page.getByLabel('界面语言').selectOption('en-US')
    await page.keyboard.press('Escape')
    await page.getByRole('navigation', { name: 'Settings sections' }).waitFor({ state: 'detached' })
    const file = path.join(roots.temp, 'reference-novel.txt')
    fs.writeFileSync(file, `第1章 旧港\n旧港的潮水刚退，青石上还留着一层薄薄的盐霜。\n\n第2章 北堤\n北堤上的风很大。\n`)
    assert.ok(await app.evaluate(({ dialog, ipcMain }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
      const handlers = ipcMain._invokeHandlers
      const original = handlers.get('kb:import-reference-text')
      if (!original) return false
      const gate = Promise.withResolvers()
      globalThis.__driveReferenceGate = { release: gate.resolve, held: null }
      handlers.set('kb:import-reference-text', async (event, chapterNumber, runId, authority, session) => {
        globalThis.__driveReferenceGate.held ??= { runId, authority, session }
        await gate.promise
        return original(event, chapterNumber, runId, authority, session)
      })
      return true
    }, file), '能在主进程里卡住参照章节入库')

    await stage.root(page).getByRole('banner').getByRole('button', { name: `“${STAGE_SAMPLE.name}” menu` }).click()
    await page.getByRole('menuitem', { name: 'Novel breakdown & imitation…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Novel analysis and style study' })
    await dialog.getByTestId('import-target-current').click()
    await dialog.getByRole('button', { name: 'Choose', exact: true }).click()
    await dialog.getByRole('button', { name: 'Import into current project (2 chapters)', disabled: false }).click()
    await dialog.waitFor({ state: 'hidden' })

    let held = null
    for (const deadline = Date.now() + 20_000; !held; await new Promise(resolve => setTimeout(resolve, 50))) {
      assert.ok(Date.now() < deadline, '20 秒内参照章节入库没有卡在门上')
      held = await app.evaluate(() => globalThis.__driveReferenceGate.held)
    }
    const lease = { ...held.authority, expiresAt: Date.now() + 60_000 }
    const fenced = await invoke(page, 'db:import-run-cancel-at-boundary', held.runId, lease, held.session.projectPath, held.session)
    assert.equal(fenced.success, true, fenced.error)
    await app.evaluate(() => globalThis.__driveReferenceGate.release())

    const failure = page.getByText('This import was taken over by another window', { exact: false }).first()
    await failure.waitFor({ state: 'visible', timeout: 30_000 })
    const observed = { failure: await failure.innerText(), lang: await page.evaluate(() => document.documentElement.lang) }
    await settle(page)
    await shoot('import-run-error-en')
    assert.equal(observed.lang, 'en-US')
    assert.doesNotMatch(observed.failure, /\p{Script=Han}|IMPORT_RUN_/u, '失败说明不带汉字与错误码')
    return observed
  } },

  // #474 收尾：中文界面导入参考小说，参照章节已入库、批次检查点还没记下时在运行卡片上取消。放行后编排器在安全边界停下，
  // 运行卡片里失败步骤的说明是中文，不再是编排器原先只有英文的那句。卡在章节入库途中取消会走另一条路
  // （主进程拒绝绑定参照章节，交 IMPORT_RUN_REFERENCE_UNBOUND），所以卡在检查点。
  'import-run-cancel-zh': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ app, page, roots, shoot }) => {
    const file = path.join(roots.temp, 'reference-novel.txt')
    fs.writeFileSync(file, `第1章 旧港\n旧港的潮水刚退，青石上还留着一层薄薄的盐霜。\n\n第2章 北堤\n北堤上的风很大。\n`)
    assert.ok(await app.evaluate(({ dialog, ipcMain }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
      const handlers = ipcMain._invokeHandlers
      const original = handlers.get('db:import-run-complete-batch')
      if (!original) return false
      const gate = Promise.withResolvers()
      globalThis.__driveCheckpointGate = { release: gate.resolve, held: false }
      handlers.set('db:import-run-complete-batch', async (event, ...args) => {
        globalThis.__driveCheckpointGate.held = true
        await gate.promise
        return original(event, ...args)
      })
      return true
    }, file), '能在主进程里卡住导入批次检查点')

    await stage.root(page).getByRole('banner').getByRole('button', { name: `《${STAGE_SAMPLE.name}》作品菜单` }).click()
    await page.getByRole('menuitem', { name: '小说拆解与仿写…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '小说拆解与仿写' })
    await dialog.getByTestId('import-target-current').click()
    await dialog.getByRole('button', { name: '选择', exact: true }).click()
    await dialog.getByRole('button', { name: '导入当前项目（2 章）', disabled: false }).click()
    await dialog.waitFor({ state: 'hidden' })

    // 中途任何一步失败都要放开检查点，否则导入一直卡着，应用只能等驱动强制结束。
    try {
      for (const deadline = Date.now() + 20_000; !(await app.evaluate(() => globalThis.__driveCheckpointGate.held)); await new Promise(resolve => setTimeout(resolve, 50))) {
        assert.ok(Date.now() < deadline, '20 秒内导入没有走到批次检查点')
      }
      await runSheet.waitUntilOpen(page)
      await runSheet.sheet(page).getByRole('button', { name: /^取消「小说拆解与仿写/u }).click()
      await runSheet.sheet(page).getByText('正在取消，等当前操作退出').first().waitFor({ state: 'visible' })
    } finally {
      await app.evaluate(() => globalThis.__driveCheckpointGate.release())
    }

    const failedStep = runSheet.sheet(page).locator('.run-step[data-status="failed"] .run-step-row').first()
    await failedStep.waitFor({ state: 'visible', timeout: 30_000 })
    if (await failedStep.getAttribute('aria-expanded') !== 'true') await failedStep.click()
    const stepError = runSheet.sheet(page).locator('.run-step[data-status="failed"] .run-step-error').first()
    await stepError.waitFor({ state: 'visible' })
    const observed = {
      stepError: await stepError.innerText(),
      sheet: await runSheet.sheet(page).innerText(),
      lang: await page.evaluate(() => document.documentElement.lang),
    }
    await settle(page)
    await shoot('import-run-cancel-zh')
    assert.equal(observed.lang, 'zh-CN')
    assert.equal(observed.stepError, '导入已取消，停在了已保存的进度处。')
    assert.doesNotMatch(observed.sheet, /safe boundary|Import cancelled/u, '中文界面的运行侧页不出现编排器的英文说明')
    return observed
  } },

  // #484：中文界面导入参考小说，主进程拒绝开始导入却没给原因时，运行卡片里失败步骤的兜底说明是中文，
  // 不再是导入工作流原先只有英文的那句。主进程正常时总会给原因，所以在主进程里换掉这个通道的处理函数。
  'import-run-start-refused-zh': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ app, page, roots, shoot }) => {
    const file = path.join(roots.temp, 'reference-novel.txt')
    fs.writeFileSync(file, `第1章 旧港\n旧港的潮水刚退，青石上还留着一层薄薄的盐霜。\n\n第2章 北堤\n北堤上的风很大。\n`)
    assert.ok(await app.evaluate(({ dialog, ipcMain }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
      const handlers = ipcMain._invokeHandlers
      if (!handlers.has('db:import-run-start-resume')) return false
      handlers.set('db:import-run-start-resume', async () => ({ success: false }))
      return true
    }, file), '能在主进程里换掉开始导入的处理函数')

    await stage.root(page).getByRole('banner').getByRole('button', { name: `《${STAGE_SAMPLE.name}》作品菜单` }).click()
    await page.getByRole('menuitem', { name: '小说拆解与仿写…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '小说拆解与仿写' })
    await dialog.getByTestId('import-target-current').click()
    await dialog.getByRole('button', { name: '选择', exact: true }).click()
    await dialog.getByRole('button', { name: '导入当前项目（2 章）', disabled: false }).click()
    await dialog.waitFor({ state: 'hidden' })

    await runSheet.waitUntilOpen(page)
    const failedStep = runSheet.sheet(page).locator('.run-step[data-status="failed"] .run-step-row').first()
    await failedStep.waitFor({ state: 'visible', timeout: 30_000 })
    if (await failedStep.getAttribute('aria-expanded') !== 'true') await failedStep.click()
    const stepError = runSheet.sheet(page).locator('.run-step[data-status="failed"] .run-step-error').first()
    await stepError.waitFor({ state: 'visible' })
    const observed = {
      stepError: await stepError.innerText(),
      sheet: await runSheet.sheet(page).innerText(),
      lang: await page.evaluate(() => document.documentElement.lang),
    }
    await settle(page)
    await shoot('import-run-start-refused-zh')
    assert.equal(observed.lang, 'zh-CN')
    assert.equal(observed.stepError, '无法开始或继续这次导入。')
    assert.doesNotMatch(observed.sheet, /Could not start/u, '中文界面的运行侧页不出现导入工作流的英文兜底')
    return observed
  } },

  'rdv-toasts': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: seedCalls }), run: async ({ page }) => {
    const copy = await diagnosticsCopyButton(page)
    await stubClipboard(page, true)
    // 第一条通知会盖住侧页下方的复制按钮，之后都直接派发点击
    for (let i = 0; i < 3; i++) await copy.dispatchEvent('click')
    await stubClipboard(page, false)
    await copy.dispatchEvent('click')
    const stack = page.locator('.pi-toast-stack')
    await stack.locator('.pi-toast[data-tone="danger"]').waitFor({ state: 'visible' })
    await page.waitForTimeout(300)
    assert.equal(await stack.count(), 1, '只有一个提示栈')
    // 写完一章的「已完成」通知带动作，也在栈里
    assert.deepEqual((await liveToastTitles(page)).filter(title => title.includes('安全诊断')), ['已复制安全诊断', '复制安全诊断失败'],
      '同一句话合并成一条，出错的另起一条')
    const boxes = await stack.locator('.pi-toast:not([data-exiting])').evaluateAll(items => items.map(item => item.getBoundingClientRect().toJSON()))
    for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i].top >= boxes[i - 1].bottom, '通知互不重叠')
    assert.ok(await inPaperInk(stack), '提示栈在纸墨宿主里')
    return { toasts: boxes.length }
  } },

  // 常驻与出错不受条数上限约束：24 条出错时栈收在视口内、栈内滚动，最新一条露在底部，滚到顶能关掉最早那条
  'rdv-toast-flood': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page, shoot }) => {
    const appPath = await app.evaluate(({ app: electronApp }) => electronApp.getAppPath())
    const chunk = fs.readdirSync(path.join(appPath, 'dist', 'assets')).find(name => /^ToastStack-.*\.js$/.test(name))
    assert.ok(chunk, '构建产物里有提示栈模块')
    const pushed = await page.evaluate(async ({ chunkName, count }) => {
      // 提示栈模块在新外壳启动时已载入；同一个 URL 再 import 拿到的是同一份栈状态
      const module = await import(new URL(`./assets/${chunkName}`, location.href).href)
      const push = Object.values(module).find(value => typeof value === 'function' && String(value).includes('exiting:!1'))
      if (!push) return 'no-push'
      for (let i = 1; i <= count; i++) push({ tone: 'danger', message: `第 ${i} 章保存失败\n\n磁盘只读，第 ${i} 次重试仍失败`, duration: 0 })
      return 'ok'
    }, { chunkName: chunk, count: 24 })
    assert.equal(pushed, 'ok', '在提示栈模块里找到推入函数并推入 24 条')
    await page.waitForTimeout(600)
    const stack = page.locator('.pi-toast-stack')
    const geometry = () => stack.evaluate(element => {
      const cards = [...element.querySelectorAll('.pi-toast:not([data-exiting])')]
      const box = element.getBoundingClientRect()
      const newest = cards.at(-1).getBoundingClientRect()
      return { count: cards.length, top: box.top, bottom: box.bottom, viewport: innerHeight, overflow: element.hasAttribute('data-overflow'),
        newestInside: newest.top >= box.top - 0.5 && newest.bottom <= box.bottom + 0.5 }
    })
    const flooded = await geometry()
    assert.equal(flooded.count, 24, '24 条都在')
    assert.ok(flooded.top >= 48 && flooded.bottom <= flooded.viewport, `栈收在顶栏以下、视口以内：${flooded.top}–${flooded.bottom}`)
    assert.ok(flooded.overflow, '栈高过上限时改为可滚动')
    assert.ok(flooded.newestInside, '最新一条露在栈底')
    await stack.evaluate(element => { element.scrollTop = 0 })
    await page.waitForTimeout(100)
    assert.equal(await stack.evaluate(element => getComputedStyle(element, '::before').opacity), '0',
      '滚到顶时上沿的淡出带消失（驱动开着减少动态效果，#412）')
    const oldest = stack.locator('.pi-toast', { hasText: '第 1 章保存失败' })
    await shoot('rdv-toast-flood-top')
    await oldest.getByRole('button', { name: '关闭通知' }).click()
    await oldest.waitFor({ state: 'detached' })
    assert.equal((await geometry()).count, 23, '滚到顶能关掉最早那条')
    await stack.evaluate(element => { element.scrollTop = element.scrollHeight })
    return flooded
  } },

  'rdv-toast-error': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: seedCalls }), run: async ({ page }) => {
    // 面板打开后侧页被标 aria-hidden，按角色找不到复制按钮，先拿住元素
    const copy = await (await diagnosticsCopyButton(page)).elementHandle()
    await stubClipboard(page, true)
    await copy.dispatchEvent('click')
    await page.locator('.pi-toast', { hasText: '已复制安全诊断' }).waitFor({ state: 'visible' })
    // 提示栈已在时打开 Ctrl K 面板（Radix 模态），面板开着时复制失败
    await page.keyboard.press('Control+K')
    await stage.paletteInput(page).waitFor({ state: 'visible' })
    await stubClipboard(page, false)
    await copy.dispatchEvent('click')
    const failure = page.locator('.pi-toast[data-tone="danger"]')
    await failure.waitFor({ state: 'visible' })
    assert.equal(await failure.evaluate(element => element.closest('[aria-hidden="true"]') === null && element.closest('[aria-live]')?.id === 'ai-novel-ink-toasts'), true,
      '模态开着时出错通知不在 aria-hidden 子树里，经提示栈挂载点这一个 live region 播报')
    assert.equal(await page.locator('#ai-novel-ink-toasts').evaluate(mount => mount.querySelectorAll('[role="alert"], [role="status"], [aria-live]').length), 0,
      '卡片不再自带播报角色，不会读两遍')
    assert.match(await failure.locator('.pi-toast-mark svg').evaluate(svg => svg.getAttribute('class')), /octagon-alert/, '八角符号')
    assert.ok(await stage.paletteInput(page).isVisible(), '面板仍开着')
    await settle(page)
  }, after: async ({ page }) => {
    await page.keyboard.press('Escape')
  } },

  'rdv-clear-busy': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page }) => {
    // 主进程里的清除处理器换成永不返回，界面停在清除中
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('db:project-clear-generated-data')
      ipcMain.handle('db:project-clear-generated-data', () => new Promise(() => {}))
    })
    await openWorkMenuItem(page, '清除生成内容…')
    const dialog = page.getByRole('dialog', { name: '清除项目生成内容' })
    await dialog.waitFor({ state: 'visible' })
    await dialog.getByRole('button', { name: '清除所选', exact: true }).click()
    const busy = dialog.locator('.pi-dialog-foot [aria-busy="true"]')
    await busy.waitFor({ state: 'visible' })
    assert.equal(await busy.innerText(), '清除中…', '按钮写清除中')
    assert.equal(await busy.isDisabled(), true, '清除中按钮禁用')
    assert.equal(await dialog.locator('.pi-check-input:disabled').count(), 3, '勾选在清除中禁用')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    assert.ok(await dialog.isVisible(), '清除中 Esc 关不掉')
    await busy.hover()
    await settle(page)
  } },

  'rdv-run-failure': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await page.keyboard.press('Control+K')
    await stage.paletteInput(page).fill('角色')
    await stage.palette(page).getByRole('option', { name: /^角色/ }).first().click()
    await materials.importCharacterCards(page, '姓名：守塔人\n身份：灯塔看守，记得每一次钟声。')
    await runSheet.waitUntilOpen(page)
    // 导入对话框还开着时侧页被 Radix 标成 aria-hidden，按角色找不到，所以用类名
    const failure = page.locator('.run-card .pi-notice[data-tone="danger"]').first()
    await failure.waitFor({ state: 'visible', timeout: 60_000 })
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.equal(await failure.evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)', '失败提示没有底色')
  } },

  'rdv-export': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await openWorkMenuItem(page, '导出…')
    const dialog = page.getByRole('dialog', { name: '导出项目' })
    await dialog.waitFor({ state: 'visible' })
    assert.ok(await inPaperInk(dialog), '旧导出对话框 Portal 进纸墨宿主')
    assert.ok(await dialog.evaluate(element => element.classList.contains('pi-dialog')), '外壳是浮笺')
    await settle(page)
  }, after: async ({ page }) => {
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: '导出项目' }).waitFor({ state: 'hidden' })
  } },

  'rdv-import-novel': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await openWorkMenuItem(page, '小说拆解与仿写…')
    const dialog = page.getByRole('dialog').first()
    await dialog.waitFor({ state: 'visible' })
    assert.ok(await inPaperInk(dialog), '旧拆解对话框 Portal 进纸墨宿主')
    await settle(page)
  }, after: async ({ page }) => {
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').first().waitFor({ state: 'hidden' })
  } },

  // RD-5 起设置是整页；项目备份与提示词模板仍是旧面板，用来看旧按钮变体在新外壳下换成纸墨按钮
  'rdv-settings': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page, shoot }) => {
    await stage.openSettings(page)
    await page.getByRole('button', { name: '提示词模板' }).click()
    await settle(page)
    await shoot('rdv-settings-prompts')
    await page.getByRole('button', { name: '项目备份' }).click()
    await settle(page)
  }, after: async ({ page }) => {
    await page.getByRole('button', { name: '返回作品' }).click()
  } },
  'rdv-tour': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: seedCalls }), run: async ({ page }) => {
    const pause = () => page.waitForTimeout(2600)
    await page.evaluate(() => { navigator.clipboard.writeText = async () => {} })
    await pause()
    await openWorkMenuItem(page, '清除生成内容…')
    const clear = page.getByRole('dialog', { name: '清除项目生成内容' })
    await clear.waitFor({ state: 'visible' })
    await pause()
    await clear.locator('.pi-check-row').first().click()
    await pause()
    await page.keyboard.press('Escape')
    await openWorkMenuItem(page, '导出…')
    await page.getByRole('dialog', { name: '导出项目' }).waitFor({ state: 'visible' })
    await pause()
    await page.keyboard.press('Escape')
    await blueprint.open(page)
    await blueprint.writeNext(page)
    await runSheet.waitUntilOpen(page)
    await runSheet.waitForRunDone(page)
    await pause()
    await runSheet.tab(page, '诊断').click()
    const copy = runSheet.sheet(page).getByRole('table').getByRole('button', { name: '复制安全诊断' }).first()
    await copy.waitFor({ state: 'visible', timeout: 10_000 })
    for (let i = 0; i < 2; i++) { await copy.dispatchEvent('click'); await page.waitForTimeout(500) }
    await stubClipboard(page, false)
    await copy.dispatchEvent('click')
    await pause()
    await page.keyboard.press('Control+K')
    await stage.paletteInput(page).fill('角色')
    await stage.palette(page).getByRole('option', { name: /^角色/ }).first().click()
    await materials.importCharacterCards(page, '姓名：守塔人\n身份：灯塔看守，记得每一次钟声。')
    await page.locator('.run-card .pi-notice[data-tone="danger"]').first().waitFor({ state: 'visible', timeout: 60_000 })
    await page.keyboard.press('Escape')
    await pause()
    await pause()
  } },
}

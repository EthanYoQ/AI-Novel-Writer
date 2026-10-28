import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import * as architecture from './pages/architecture.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { FAKE_MODEL } from './fake-model.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'
import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'

export const EMPTY_BOOK = '雨城'
const settle = page => page.waitForTimeout(400)

const INFERRED = Object.freeze({
  novelConfig: {
    genre: '民国悬疑', subGenre: '本格推理', targetAudience: '成年读者', plotStructure: 'three_act', narrativePOV: 'third_limited',
    coreOutline: '前巡捕沈默在雨夜重查一桩旧案，发现当年的证人都在说谎。',
    worldSetting: '民国上海，租界与华界隔着一条河，巡捕房只管河的这一边。',
    goldenFinger: '沈默过目不忘，能复述十年前的卷宗。',
    protagonistProfile: '沈默，前巡捕，冷静而固执。',
    globalGuidance: '对白克制，线索先于解释出现。',
  },
  architectureFiles: {
    premise: '一桩十年前结案的命案在雨夜重新被人提起。',
    worldbuilding: '租界巡捕房与华界警署互不相让，案卷分存两处。',
    synopsis: '沈默从一封匿名信出发，先回到当年的茶馆，向掌柜顾三打听那一夜进出的客人；再翻出巡捕房封存的卷宗，' +
      '逐一对照三位证人的口供，发现他们说的时间彼此错开了一刻钟。周探长出面阻拦，沈默只好绕到华界警署借阅另一半案卷，' +
      '在雨夜的河边拼出当年的路线，最后找到真正的凶手，也明白了自己当年为什么被调离。',
  },
  characterCards: [['沈默', 'protagonist', '前巡捕'], ['顾三', 'supporting', '茶馆掌柜'], ['周探长', 'antagonist', '租界巡捕房探长']].map(([name, role, background]) => ({
    name, role, gender: '男', age: 40,
    appearance: '瘦高', personality: '冷静', background, abilities: '记性好',
    motivation: '查明真相', relationships: [], arc: '与过去和解', notes: '由导入原稿反推',
    currentState: { location: '上海', powerLevel: '普通', physicalState: '正常', mentalState: '警觉', keyItems: '匿名信', recentEvents: '收到匿名信', updatedAtChapter: 1 },
  })),
})
const INFERRED_STYLE = '短句为主，雨声与灯影反复出现，叙述贴近沈默。'
const BLUEPRINT_BATCH = /本批必须且只能完整返回以下 chapterNumber：([\d、]+)。/u

/** 作者原稿反推的三类请求回合法结果，其余请求照常作答。 */
export function inferenceReply(prompt) {
  if (prompt.includes('逆向推演出这部小说的完整设定体系')) return JSON.stringify(INFERRED)
  if (prompt.includes('【风格档案】与【仿写指南】')) return INFERRED_STYLE
  const batch = BLUEPRINT_BATCH.exec(prompt)
  if (!batch) return null
  return JSON.stringify({ blueprints: batch[1].split('、').map(Number).map(chapterNumber => ({
    chapterNumber, title: `反推第${chapterNumber}章`, role: '发展', purpose: '沈默推进旧案调查',
    keyEvents: `第${chapterNumber}章：沈默找到一位证人的破绽`, characters: ['沈默'], relationships: [],
    suspenseHook: '雨夜里又有人敲门',
  })) })
}

export function manuscript(roots, chapters) {
  const file = path.join(roots.temp, 'my-manuscript.txt')
  fs.writeFileSync(file, chapters.map(([number, title]) => (
    `第${number}章 ${title}\n沈默在雨夜里把旧案卷宗摊在桌上，一页一页对照证人的口供。窗外的电车铃响过三遍，他终于在第${number}份口供里找到一个说不通的时间。\n`
  )).join('\n'))
  return file
}

export async function seedEmptyBook(context) {
  const { app, page, roots, invoke, reload } = context
  const created = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, roots.projects)).grantId,
    name: EMPTY_BOOK, genre: '', targetAudience: '', writingLanguage: 'zh-CN' }, randomUUID(), null)
  assert.equal(created.success, true, created.error)
  assert.equal((await invoke(page, 'llm:save-model', FAKE_MODEL)).success, true)
  assert.equal((await invoke(page, 'llm:set-default-model', FAKE_MODEL.id)).success, true)
  await trackOpenedSession(app)
  await reload()
  await stage.openFromLibrary(page, EMPTY_BOOK)
}

/** 从作品菜单打开导入对话框，选「我的原稿」与原稿文件，等预览出来。 */
export async function openAuthorImport(app, page, bookName, file) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, file)
  await stage.root(page).getByRole('banner').getByRole('button', { name: `《${bookName}》作品菜单` }).click()
  await page.getByRole('menuitem', { name: '小说拆解与仿写…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '小说拆解与仿写' })
  await dialog.getByTestId('import-purpose-author').click()
  const imported = page.getByRole('dialog', { name: '导入作者原稿' })
  await imported.getByTestId('import-source-choose').click()
  await imported.getByTestId('author-import-confirmation-summary').waitFor({ state: 'visible' })
  await imported.getByText('预估 AI 消耗').waitFor({ state: 'visible' })
  return imported
}

async function confirmAndWait(page, dialog, chapterCount) {
  assert.equal(await dialog.getByRole('checkbox', { name: /同时反推设定、架构、角色和蓝图/u }).isChecked(), true, '反推默认勾选')
  await dialog.getByRole('button', { name: `确认导入（${chapterCount} 章）`, disabled: false }).click()
  await dialog.waitFor({ state: 'hidden' })
  await runSheet.waitUntilOpen(page)
  await runSheet.waitForRunDone(page, 120_000)
}

/** 记下界面打开作品拿到的会话（包一层主进程的 project:open），驱动读库时不必重开作品。 */
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

async function readBook({ app, page, invoke }) {
  const session = await app.evaluate(() => globalThis.__driveOpened)
  assert.ok(session?.leaseId, '记下了界面打开作品的会话')
  return {
    core: await invoke(page, 'db:project-core-get', session.projectPath, session),
    blueprints: await invoke(page, 'db:blueprint-get-all', session.projectPath, session),
  }
}

/** 角色名单提示条上，导入留下的角色决策写来源与人数，不露操作号。 */
async function assertImportedCastTitle(page) {
  const banner = page.getByRole('region', { name: '待处理的角色建议' })
  await banner.waitFor({ state: 'visible' })
  assert.deepEqual(await banner.locator('[data-kind="decision"] .cast-suggestion-text').allInnerTexts(), ['从导入原稿反推的角色（3 位）'], '导入角色决策写来源与人数')
  assert.equal((await banner.innerText()).includes('novel-import-global'), false, '不露操作号')
}

async function shootStagePage(page, shoot, name, stageName) {
  await stage.stageButton(page, stageName).click()
  await settle(page)
  await shoot(name)
}

export const IMPORT_INFER_SCENARIOS = {
  'import-infer-empty': { model: true, shell: 'stage', setup: seedEmptyBook, run: async context => {
    const { app, page, roots, fake, shoot } = context
    fake.replyReview(inferenceReply)
    const dialog = await openAuthorImport(app, page, EMPTY_BOOK, manuscript(roots, [[1, '匿名信'], [2, '茶馆'], [3, '河对岸']]))
    await settle(page)
    await shoot('import-infer-dialog')
    await confirmAndWait(page, dialog, 3)
    await settle(page)
    await shoot('import-infer-empty-run')

    const { core, blueprints } = await readBook(context)
    assert.equal(core.genre, INFERRED.novelConfig.genre, '空的类型被反推值补上')
    assert.equal(core.premise, INFERRED.architectureFiles.premise, '空的故事前提被补上')
    assert.equal(core.writingStyle, INFERRED_STYLE, '空的文风被补上')
    assert.deepEqual(blueprints.map(item => item.title), ['反推第1章', '反推第2章', '反推第3章'], '每个导入章都有蓝图')
    // 新建作品自带每章字数默认值，它算已有内容；设定与架构的文字字段都是空的，不该有建议。
    const region = runSheet.sheet(page).getByRole('region', { name: '反推建议' })
    await region.waitFor({ state: 'visible' })
    const suggested = await region.locator('.run-suggestion-name').allInnerTexts()
    assert.deepEqual(suggested, ['每章字数'], '空项目只剩新建默认的每章字数可建议')

    await shootStagePage(page, shoot, 'import-infer-empty-setup', '设定')
    await shootStagePage(page, shoot, 'import-infer-empty-architecture', '架构')
    await page.getByRole('button', { name: '打开角色名单' }).click()
    await settle(page)
    await assertImportedCastTitle(page)
    await shoot('import-infer-empty-characters')
    await blueprint.open(page)
    await blueprint.planItem(page, 2).click()
    await settle(page)
    return { core: { genre: core.genre, premise: core.premise, writingStyle: core.writingStyle }, blueprints: blueprints.map(item => item.title) }
  } },

  // 示例作品 1、2 章已定稿，作者原稿只能从第 3 章接着导入；先删掉第 4、5 章的蓝图，让第 3 章代表「已有蓝图」。
  'import-infer-existing': { model: true, shell: 'stage', setup: context => seedStageSample(context, {
    landOnChapter3: false, beforeReload: async ({ page, invoke, path, session }) => {
      for (const chapterNumber of [4, 5]) {
        assert.equal((await invoke(page, 'db:blueprint-delete', chapterNumber, path, session)).success, true)
      }
      await trackOpenedSession(context.app)
    },
  }), run: async context => {
    const { app, page, roots, fake, shoot } = context
    fake.replyReview(inferenceReply)
    const before = await readBook(context)
    const dialog = await openAuthorImport(app, page, STAGE_SAMPLE.name, manuscript(roots, [[3, '雾钟'], [4, '守塔人'], [5, '潮汐表']]))
    await confirmAndWait(page, dialog, 3)
    const suggestions = runSheet.sheet(page).getByRole('region', { name: '反推建议' })
    await suggestions.waitFor({ state: 'visible' })
    await suggestions.scrollIntoViewIfNeeded()
    await settle(page)
    await shoot('import-infer-existing-suggestions')

    const card = name => suggestions.locator('.run-suggestion').filter({ has: page.locator('.run-suggestion-name', { hasText: new RegExp(`^${name}$`, 'u') }) })
    assert.equal(await card('类型').getByRole('button', { name: '展开全文' }).count(), 0, '没被截断的短值没有展开控件')
    const toggle = card('情节大纲').getByRole('button', { name: '展开全文' })
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false', '被截断的长值默认收起')
    await toggle.click()
    const collapse = card('情节大纲').getByRole('button', { name: '收起' })
    assert.equal(await collapse.getAttribute('aria-expanded'), 'true', '展开后按钮变成收起')
    assert.equal((await card('情节大纲').locator('dd').last().innerText()).trim(), INFERRED.architectureFiles.synopsis, '展开后能读到反推的全文')
    await card('情节大纲').scrollIntoViewIfNeeded()
    await settle(page)
    await shoot('import-infer-existing-suggestions-expanded')
    await collapse.click()

    const { core, blueprints } = await readBook(context)
    for (const field of ['genre', 'coreOutline', 'premise', 'worldbuilding', 'synopsis']) {
      assert.equal(core[field], before.core[field], `已有的 ${field} 一字不变`)
    }
    assert.equal(core.writingStyle, INFERRED_STYLE, '示例作品没有文风，空的文风被补上')
    assert.equal(core.goldenFinger, INFERRED.novelConfig.goldenFinger, '示例作品没有金手指，空字段被补上')
    const byChapter = new Map(blueprints.map(item => [item.chapterNumber, item.title]))
    assert.deepEqual([3, 4, 5, 6].map(number => byChapter.get(number)), ['雾钟', '反推第4章', '反推第5章', '第二盏灯'],
      '已有蓝图的章不变，没有的补上，原稿以外的章不动')

    const genre = suggestions.getByRole('button', { name: '采用「类型」的反推结果' })
    await genre.click()
    await genre.waitFor({ state: 'detached' })
    assert.equal((await readBook(context)).core.genre, INFERRED.novelConfig.genre, '采用后写入反推的类型')

    await architecture.open(page)
    await architecture.section(page, 'worldbuilding').getByRole('button', { name: '编辑' }).click()
    const editor = page.locator('.stage-content .cm-content')
    await editor.filter({ hasText: before.core.worldbuilding.slice(0, 12) }).waitFor({ state: 'visible' })
    await runSheet.openFromPalette(page)
    const world = suggestions.getByRole('button', { name: '采用「世界观（架构）」的反推结果' })
    await world.click()
    await world.waitFor({ state: 'detached' })
    await editor.filter({ hasText: INFERRED.architectureFiles.worldbuilding }).waitFor({ state: 'visible' })
    assert.equal(await stage.tabList(page).locator('.stage-tab[data-active][data-dirty]').count(), 0, '采用后的世界观标签不算未保存')
    await settle(page)
    await shoot('import-infer-existing-doc-adopted')

    await shootStagePage(page, shoot, 'import-infer-existing-setup', '设定')
    await stage.stageButton(page, '架构').click()
    await page.getByRole('button', { name: '打开角色名单' }).click()
    await settle(page)
    await assertImportedCastTitle(page)
    await shoot('import-infer-existing-characters')
    await blueprint.open(page)
    await blueprint.planItem(page, 4).click()
    await settle(page)
    return { blueprints: [3, 4, 5, 6].map(number => byChapter.get(number)) }
  } },
}

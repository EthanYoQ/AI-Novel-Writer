// #516 第 2、3 块实机场景（ADR-0024）：已定稿的章重新打开修改，新稿定稿后替换原定稿，后续章节只提示、不跟着改。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import * as blueprint from './pages/blueprint.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as stage from './pages/stage.mjs'
import { characterStateReply, finalizeChapter, openChapter } from './f491-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const FIRST_EDIT = '她在堤脚多站了一会儿，直到潮水漫过最低的那道刻痕。'
const REVISED_LINE = '林岚把那道刻痕的高度记进了测绘本。'
/** 直接修稿的回复：在作者改过的正文后面加一段。夹具默认回的正文比第 2 章短，会被「修稿结果明显短于原稿」拦下。 */
const directRevision = prompt => prompt.includes('以具体、克制的修改') && prompt.includes(FIRST_EDIT)
  ? `${STAGE_SAMPLE.finalized[2]}${FIRST_EDIT}\n\n${REVISED_LINE}` : null
const SECOND_EDIT = '回到旧港时，她在地图背面记下了那道刻痕的高度。'
const running = page => stage.root(page).locator('.stage-capsule:not([data-tone="ok"])')
const ownNotice = (page, chapterNumber) => chapterView.view(page).locator('.pi-notice').filter({ hasText: `第 ${chapterNumber} 章已修改` })

/** 记下界面最近一次打开作品拿到的会话（包一层主进程的 project:open），驱动读知识库时不必重开作品打断界面。 */
async function trackOpenedSession(app) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const original = handlers.get('project:open')
    if (typeof original !== 'function') throw new Error('project:open 未注册，记不下界面会话')
    handlers.set('project:open', async (event, projectPath, ...rest) => {
      const result = await original(event, projectPath, ...rest)
      if (result?.success) globalThis.__driveOpened = { projectId: result.project.id, projectPath, leaseId: result.project.sessionLease }
      return result
    })
  })
}

/** 记下主进程每次答复的替换影响。重启后是新进程，要重新装。 */
async function trackImpactLoads(app) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const original = handlers.get('chapter:replacement-impacts')
    if (typeof original !== 'function') throw new Error('chapter:replacement-impacts 未注册，记不下替换影响的答复')
    globalThis.__driveImpactLoads = []
    handlers.set('chapter:replacement-impacts', async (...args) => {
      const result = await original(...args)
      globalThis.__driveImpactLoads.push(result)
      return result
    })
  })
}

const impactLoadCount = app => app.evaluate(() => globalThis.__driveImpactLoads.length)

/**
 * 等界面在 since 之后读到一次带着第 chapterNumber 章替换的影响，再等界面画两帧。
 * 之后提示还不显示，才是被「知道了」隐藏的，而不是数据还没到。
 */
async function impactLoaded(app, page, since, chapterNumber) {
  const deadline = Date.now() + 30_000
  for (;;) {
    const loads = await app.evaluate((_electron, from) => globalThis.__driveImpactLoads.slice(from), since)
    if (loads.some(result => result?.success && result.impacts.some(impact => impact.chapterNumber === chapterNumber))) break
    assert.ok(Date.now() < deadline, `30 秒内界面没有读到第 ${chapterNumber} 章的替换影响。实际：${JSON.stringify(loads)}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function uiSession(app) {
  const session = await app.evaluate(() => globalThis.__driveOpened)
  assert.ok(session?.leaseId, '记下了界面打开作品的会话')
  return session
}

/** 示例作品去掉第 4 章的草稿：第 3 章定稿后，第 4 章起都只有蓝图，第 4 章就是下一章要写的。 */
async function seedWithoutChapter4(context) {
  await trackOpenedSession(context.app)
  await trackImpactLoads(context.app)
  await seedStageSample(context, { beforeReload: async ({ page, invoke, path: projectPath, session }) => {
    for (const draft of await invoke(page, 'db:draft-list', 4, projectPath, session)) {
      assert.equal((await invoke(page, 'db:draft-delete', draft.id, projectPath, session)).success, true)
    }
  } })
}

/** 定稿后处理列出了角色状态更新，每一步都已成功或失败，且没有进行中的运行。 */
const postProcessSettled = page => page.waitForFunction(() => {
  const rows = [...document.querySelectorAll('[aria-label="定稿后处理"] li')]
  return rows.some(row => row.querySelector('b')?.textContent === '角色状态更新')
    && rows.every(row => row.dataset.state === 'success' || row.dataset.state === 'failed')
    && !document.querySelector('.stage-capsule:not([data-tone="ok"])')
}, null, { timeout: 90_000 })

/** 作品目录下第 n 章的正文文件（定稿发布在作品根目录，同名时带碰撞后缀）。 */
const manuscripts = (projectPath, chapterNumber) => fs.readdirSync(projectPath).filter(name => name.startsWith(`第${chapterNumber}章`)).sort()
/** 知识库里第 n 章定稿导入的文档 id；不传 session 时用界面的会话。 */
async function knowledgeDocuments(context, chapterNumber, session) {
  const active = session ?? await uiSession(context.app)
  const listed = await context.invoke(context.page, 'kb:list-documents', active.projectPath, active)
  assert.equal(Array.isArray(listed), true, JSON.stringify(listed))
  return listed.filter(document => document.finalizedChapter === chapterNumber).map(document => document.id).sort()
}

/** 在定稿页点「重新打开修改」并确认，等重开横幅出现。 */
async function reopen(page, chapterNumber) {
  await chapterView.view(page).getByRole('button', { name: '重新打开修改', exact: true }).click()
  await page.getByRole('dialog', { name: `重新打开第 ${chapterNumber} 章？` }).getByRole('button', { name: '重新打开', exact: true }).click()
  await chapterView.view(page).getByText(`正在修改已定稿的第 ${chapterNumber} 章`).waitFor({ state: 'visible', timeout: 30_000 })
}

/** 在正文末尾加一句并保存。 */
async function appendSentence(page, sentence) {
  await chapterView.prose(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(sentence)
  await stage.saveProse(page)
}

/** 打开定稿确认框（修稿已合并时点主按钮，否则从「更多」里点），交给 inspect 截图、读预览，再确认定稿，等后处理跑完。 */
async function finalizeReopened(page, chapterNumber, inspect) {
  const button = chapterView.view(page).getByRole('button', { name: '定稿', exact: true })
  if (await button.count() > 0) await button.click()
  else await chapterView.more(page, '定稿…')
  const dialog = chapterView.finalizeDialog(page, chapterNumber)
  await dialog.waitFor({ state: 'visible' })
  const observed = await inspect?.(dialog)
  await dialog.getByRole('button', { name: '确认定稿', exact: true }).click()
  await chapterView.view(page).getByText('已定稿，只读', { exact: true }).waitFor({ state: 'visible', timeout: 60_000 })
  await postProcessSettled(page)
  return observed
}

/** 等确认框里的影响预览出现，读出整段文字。 */
async function readPreview(dialog) {
  await dialog.getByText('后面的内容不会跟着改').waitFor({ state: 'visible', timeout: 30_000 })
  return dialog.innerText()
}

/** 驱动自己打开作品读第 n 章：各稿状态、权威正文、知识库文档。界面的会话随之失效，所以放在场景最后。 */
async function readChapter(context, projectPath, chapterNumber) {
  await context.reload()
  const { page, invoke } = context
  const opened = await invoke(page, 'project:open', projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  const session = { projectId: opened.project.id, projectPath, leaseId: opened.project.sessionLease }
  const drafts = await invoke(page, 'db:draft-list', chapterNumber, projectPath, session)
  const final = drafts.find(draft => draft.status === 'finalized')
  const full = final ? await invoke(page, 'db:draft-get-full', final.id, projectPath, session) : null
  return { statuses: drafts.map(draft => `v${draft.version}:${draft.status}`).sort(), authoritative: full?.content ?? null,
    knowledge: await knowledgeDocuments(context, chapterNumber, session) }
}

export const REOPEN_SCENARIOS = {
  /**
   * 种子：第 1、2 章导入定稿，第 3 章在界面定稿，第 4–12 章只有蓝图。重开第 2 章改一句、直接修稿、合并、定稿：
   * 新稿成为权威定稿，原定稿成了已被替换的定稿，确认框与定稿后的提示列出第 3 章和只有蓝图的各章，第 4 章照常能写，
   * 点过「知道了」重启后不再提示。再重开替换一次：上一次导入知识库的文档和正文文件在新的导入之后删掉，提示重新出现。
   */
  'reopen-refinalize': { model: true, shell: 'stage', setup: seedWithoutChapter4, run: async context => {
    const projectPath = context.samplePath
    context.fake.replyCharacterState(characterStateReply)
    context.fake.replyReview(directRevision)
    const observed = {}
    let page = context.page

    await finalizeChapter(page, 3)
    await openChapter(page, 2)
    observed.manuscriptsAtStart = manuscripts(projectPath, 2)
    observed.knowledgeAtStart = await knowledgeDocuments(context, 2)
    await context.shoot('reopen-1-final-reopen-button')

    await reopen(page, 2)
    await context.shoot('reopen-2-banner')
    await appendSentence(page, FIRST_EDIT)

    await chapterView.more(page, '直接修稿…')
    await page.getByRole('dialog', { name: '直接修稿' }).getByRole('button', { name: '开始修稿', exact: true }).click()
    await chapterView.merge(page).waitFor({ state: 'visible', timeout: 60_000 })
    await running(page).waitFor({ state: 'detached', timeout: 90_000 })
    await chapterView.merge(page).getByRole('button', { name: '全部用修稿' }).click()
    await chapterView.merge(page).getByRole('button', { name: '完成合并' }).click()
    await chapterView.view(page).getByRole('button', { name: '定稿', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    await running(page).waitFor({ state: 'detached', timeout: 90_000 })
    observed.mergedText = await stage.proseBody(chapterView.prose(page))

    observed.preview = await finalizeReopened(page, 2, async dialog => {
      const preview = await readPreview(dialog)
      await context.shoot('reopen-3-finalize-preview')
      return preview
    })
    observed.postProcess = await chapterView.postProcessSteps(page)
    await ownNotice(page, 2).waitFor({ state: 'visible', timeout: 30_000 })
    observed.notice = await ownNotice(page, 2).innerText()
    await context.shoot('reopen-4-impact-notice')

    await openChapter(page, 3)
    const laterLine = chapterView.view(page).locator('.pi-notice').filter({ hasText: '写于第 2 章修改之前' })
    await laterLine.waitFor({ state: 'visible', timeout: 30_000 })
    observed.laterLine = await laterLine.innerText()
    await context.shoot('reopen-4b-later-chapter')

    await stage.openChapterVersion(page, 2, 1)
    observed.supersededHint = await chapterView.hint(page).innerText()
    observed.supersededSwitcher = await chapterView.versionButton(page).getAttribute('aria-label')
    await context.shoot('reopen-5-superseded')

    await openChapter(page, 2)
    await ownNotice(page, 2).getByRole('button', { name: '知道了' }).click()
    await ownNotice(page, 2).waitFor({ state: 'detached' })
    const loadsBeforeChapter3 = await impactLoadCount(context.app)
    await openChapter(page, 3)
    await impactLoaded(context.app, page, loadsBeforeChapter3, 2)
    observed.laterLineAfterAcknowledge = await laterLine.count()
    observed.manuscriptsAfterFirst = manuscripts(projectPath, 2)
    observed.knowledgeAfterFirst = await knowledgeDocuments(context, 2)

    await openChapter(page, 4)
    await chapterView.view(page).getByRole('button', { name: '写作此章', exact: true }).click()
    const refused = blueprint.popover(page).getByText(/权威|定稿/u).first()
    await refused.or(chapterView.prose(page)).first().waitFor({ state: 'visible', timeout: 60_000 })
    observed.writeChapter4 = await blueprint.popover(page).isVisible() ? await blueprint.popover(page).innerText() : 'started'
    await running(page).waitFor({ state: 'detached', timeout: 90_000 })
    observed.chapter4Row = (await stage.chapterRows(page)).find(row => row.number === 4)

    await context.restart()
    page = context.page
    await trackImpactLoads(context.app)
    await stage.openAfterRestart(page, STAGE_SAMPLE.name)
    await openChapter(page, 2)
    await impactLoaded(context.app, page, 0, 2)
    observed.noticeAfterRestart = await ownNotice(page, 2).count()

    // 再替换一次：这次被替换的定稿是上面重开出来的，有自己导入的知识库文档和正文文件。
    await reopen(page, 2)
    await appendSentence(page, SECOND_EDIT)
    observed.secondPreview = await finalizeReopened(page, 2, readPreview)
    observed.secondPostProcess = await chapterView.postProcessSteps(page)
    await ownNotice(page, 2).waitFor({ state: 'visible', timeout: 30_000 })
    observed.secondNotice = await ownNotice(page, 2).innerText()
    await context.shoot('reopen-6-second-replacement')
    observed.manuscriptsAfterSecond = manuscripts(projectPath, 2)
    observed.secondFileText = observed.manuscriptsAfterSecond.length === 1
      ? fs.readFileSync(path.join(projectPath, observed.manuscriptsAfterSecond[0]), 'utf8') : null

    observed.facts = await readChapter(context, projectPath, 2)
    observed.knowledgeAfterSecond = observed.facts.knowledge
    console.log(`[reopen] observed ${JSON.stringify(observed)}`)

    assert.ok(observed.mergedText.includes(FIRST_EDIT) && observed.mergedText.includes(REVISED_LINE), `合并后的正文带着作者改的一句和修稿加的一段。实际：${observed.mergedText}`)
    assert.match(observed.preview, /第 3 章写于这次修改之前，第 4–12 章只有蓝图，可能和新内容不符，不会自动修改。/u, `确认框预览后续各章。实际：${observed.preview}`)
    assert.match(observed.preview, /林岚的当前状态来自后续章节，没有按新内容重算。/u, `确认框预览状态来自后续章节的角色。实际：${observed.preview}`)
    assert.ok(observed.postProcess.length > 0 && observed.postProcess.every(step => step.state === 'success'),
      `第一次替换后的后处理全部成功。实际：${JSON.stringify(observed.postProcess)}`)
    assert.match(observed.notice, /第 3 章写于这次修改之前，第 4–12 章只有蓝图，可能和新内容不符，不会自动修改。/u, `定稿后的提示。实际：${observed.notice}`)
    assert.match(observed.laterLine, /第 2 章后来改过，这一章可能和它不符，不会自动修改。/u, `第 3 章的提示。实际：${observed.laterLine}`)
    assert.equal(observed.supersededHint, '已被替换的定稿，只读')
    assert.match(observed.supersededSwitcher, /^本章版本：已被替换的定稿 v1 · /u)
    assert.equal(observed.laterLineAfterAcknowledge, 0, '点了「知道了」，后续章的那一行一起不再显示')
    assert.equal(observed.knowledgeAfterFirst.length, 1, `第一次替换后知识库里有第 2 章新定稿的文档。实际：${JSON.stringify(observed.knowledgeAfterFirst)}`)
    assert.ok(observed.knowledgeAtStart.every(id => !observed.knowledgeAfterFirst.includes(id)),
      `替换前的知识库文档已删除。实际：${JSON.stringify({ start: observed.knowledgeAtStart, after: observed.knowledgeAfterFirst })}`)
    assert.equal(observed.manuscriptsAfterFirst.length, 1,`第一次替换后第 2 章只剩一份正文文件。实际：${JSON.stringify(observed.manuscriptsAfterFirst)}`)
    assert.ok(observed.manuscriptsAtStart.every(name => !observed.manuscriptsAfterFirst.includes(name)),
      `替换前的正文文件不再留着（导入的定稿没有发布正文文件时为空）。实际：${JSON.stringify({ start: observed.manuscriptsAtStart, after: observed.manuscriptsAfterFirst })}`)
    assert.equal(observed.writeChapter4, 'started', `第 4 章能写。实际：${observed.writeChapter4}`)
    assert.equal(observed.chapter4Row?.phase, 'draft', `第 4 章写出了草稿。实际：${JSON.stringify(observed.chapter4Row)}`)
    assert.equal(observed.noticeAfterRestart, 0, '点过「知道了」，重启后不再提示')

    assert.match(observed.secondPreview, /第 3–4 章写于这次修改之前，第 5–12 章只有蓝图/u, `第二次替换的预览含刚写的第 4 章。实际：${observed.secondPreview}`)
    assert.ok(observed.secondPostProcess.every(step => step.state === 'success'), `第二次替换后的后处理全部成功。实际：${JSON.stringify(observed.secondPostProcess)}`)
    assert.ok(observed.secondPostProcess.some(step => step.label === '删除旧版本的知识库文档'), '替换登记了删除旧知识库文档这一步')
    assert.match(observed.secondNotice, /第 3–4 章写于这次修改之前/u, '同一章再替换一次，提示重新出现')
    assert.equal(observed.knowledgeAfterSecond.length, 1, `知识库里第 2 章只剩最新定稿的文档。实际：${JSON.stringify(observed.knowledgeAfterSecond)}`)
    assert.ok(!observed.knowledgeAfterFirst.includes(observed.knowledgeAfterSecond[0]), `上一份定稿的知识库文档已删除。实际：${JSON.stringify(observed)}`)
    assert.equal(observed.manuscriptsAfterSecond.length, 1, `第 2 章只剩最新定稿的正文文件。实际：${JSON.stringify(observed.manuscriptsAfterSecond)}`)
    assert.ok(!observed.manuscriptsAfterFirst.includes(observed.manuscriptsAfterSecond[0]), '上一份定稿的正文文件已删除，新文件另起')
    assert.ok(observed.secondFileText?.includes(SECOND_EDIT), '正文文件是最新定稿的内容')

    assert.deepEqual(observed.facts.statuses, ['v1:superseded', 'v2:superseded', 'v3:finalized'])
    assert.ok(observed.facts.authoritative?.includes(SECOND_EDIT), `权威正文是最新的重开稿。实际：${observed.facts.authoritative}`)
    assert.ok(observed.facts.authoritative?.startsWith(observed.mergedText.trim().slice(0, 20)), '最新定稿建立在第一次合并后的正文上')
    return observed
  } },

  /**
   * 第 3 章在界面定稿后先重开再放弃修改：章节回到原定稿，不留稿件、文件和知识库文档。然后手改它的正文文件，再重开替换：
   * 旧知识库文档照常删除，手改过的旧文件保留，「删除旧版本的正文文件」一步失败并写明保留了哪个文件，其余各步成功。
   */
  'reopen-refinalize-edited-txt': { model: true, shell: 'stage', setup: seedWithoutChapter4, run: async context => {
    const { page } = context
    const projectPath = context.samplePath
    context.fake.replyCharacterState(characterStateReply)
    const observed = {}

    await finalizeChapter(page, 3)
    observed.knowledgeBefore = await knowledgeDocuments(context, 3)
    observed.manuscriptsBefore = manuscripts(projectPath, 3)
    observed.versionsBefore = await chapterView.versions(page)

    await reopen(page, 3)
    await appendSentence(page, '这一句会随放弃修改一起丢掉。')
    await chapterView.more(page, '放弃修改…')
    const discard = page.getByRole('alertdialog').or(page.getByRole('dialog')).filter({ hasText: '放弃对第 3 章的修改？' })
    await discard.getByRole('button', { name: '放弃修改', exact: true }).click()
    await chapterView.view(page).getByText('已定稿，只读', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    observed.versionsAfterDiscard = await chapterView.versions(page)
    observed.bannerAfterDiscard = await chapterView.view(page).getByText('正在修改已定稿的第 3 章').count()
    observed.manuscriptsAfterDiscard = manuscripts(projectPath, 3)
    observed.knowledgeAfterDiscard = await knowledgeDocuments(context, 3)
    await context.shoot('reopen-7-discarded')

    assert.equal(observed.manuscriptsBefore.length, 1, `第 3 章定稿后有一份正文文件。实际：${JSON.stringify(observed.manuscriptsBefore)}`)
    const oldFile = path.join(projectPath, observed.manuscriptsBefore[0])
    const handEdited = `${fs.readFileSync(oldFile, 'utf8')}\n作者在文件里手改的一行。\n`
    fs.writeFileSync(oldFile, handEdited, 'utf8')

    await reopen(page, 3)
    await appendSentence(page, '林岚又数了一遍台阶，还是七十三级。')
    await finalizeReopened(page, 3)
    observed.postProcess = await chapterView.postProcessSteps(page)
    const kept = chapterView.postProcess(page).locator('li[data-state="failed"]')
      .filter({ has: page.locator('b', { hasText: /^删除旧版本的正文文件$/u }) })
    observed.keptDetail = await kept.count() > 0 ? await kept.first().innerText() : null
    await context.shoot('reopen-8-edited-txt-kept')

    observed.manuscriptsAfter = manuscripts(projectPath, 3)
    observed.oldFileKept = fs.existsSync(oldFile) && fs.readFileSync(oldFile, 'utf8') === handEdited
    observed.knowledgeAfter = await knowledgeDocuments(context, 3)
    observed.reopenAvailable = await chapterView.view(page).getByRole('button', { name: '重新打开修改', exact: true }).isEnabled()
    console.log(`[reopen] observed ${JSON.stringify(observed)}`)

    assert.deepEqual(observed.versionsAfterDiscard, observed.versionsBefore, '放弃修改后本章的版本回到重开之前')
    assert.equal(observed.bannerAfterDiscard, 0, '放弃修改后不再显示重开横幅')
    assert.deepEqual(observed.manuscriptsAfterDiscard, observed.manuscriptsBefore, '放弃修改不动正文文件')
    assert.deepEqual(observed.knowledgeAfterDiscard, observed.knowledgeBefore, '放弃修改不动知识库')

    const byLabel = Object.fromEntries(observed.postProcess.map(step => [step.label, step.state]))
    assert.equal(byLabel['删除旧版本的正文文件'], 'failed', `手改过的旧文件不删，这一步报出来。实际：${JSON.stringify(observed.postProcess)}`)
    assert.ok(observed.postProcess.filter(step => step.label !== '删除旧版本的正文文件').every(step => step.state === 'success'),
      `其余各步照常成功。实际：${JSON.stringify(observed.postProcess)}`)
    assert.ok(observed.keptDetail?.includes(observed.manuscriptsBefore[0]), `说明里写出保留的文件名。实际：${observed.keptDetail}`)
    assert.equal(observed.oldFileKept, true, '手改过的旧文件原样保留')
    assert.equal(observed.manuscriptsAfter.length, 2, `新定稿另起一份带后缀的文件。实际：${JSON.stringify(observed.manuscriptsAfter)}`)
    assert.equal(observed.knowledgeBefore.length, 1)
    assert.equal(observed.knowledgeAfter.length, 1)
    assert.notEqual(observed.knowledgeAfter[0], observed.knowledgeBefore[0], '旧定稿的知识库文档在新文档导入后删除')
    assert.equal(observed.reopenAvailable, true, '这一章还能再重开，不被保留的旧文件锁住')
    return observed
  } },
}

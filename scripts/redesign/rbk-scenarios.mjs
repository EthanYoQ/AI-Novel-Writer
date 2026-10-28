import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as blueprint from './pages/blueprint.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as refs from './pages/refs.mjs'
import * as stage from './pages/stage.mjs'
import { finalizeChapter, openChapter } from './f491-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'
import { countUnits, STAGE_SAMPLE } from './stage-sample.mjs'

const SECOND_DRAFT = `${STAGE_SAMPLE.drafts[3].text}\n\n林岚把纸条又读了一遍，决定等到下一次大潮再上灯室。`

const seedChapter3WithOlderDraft = context => seedStageSample(context, { beforeReload: async ({ page, invoke, path, session }) => {
  const draft = await invoke(page, 'db:draft-create', { chapterNumber: 3, version: 2, source: 'write', content: SECOND_DRAFT,
    wordCount: countUnits(SECOND_DRAFT) }, path, session)
  assert.equal(draft.success, true, draft.error)
} })

const seedChapter3WithRevision = context => seedStageSample(context, { beforeReload: async ({ page, invoke, path, session }) => {
  const draft = await invoke(page, 'db:draft-create', { chapterNumber: 3, version: 2, source: 'rewrite', content: SECOND_DRAFT,
    wordCount: countUnits(SECOND_DRAFT) }, path, session)
  assert.equal(draft.success, true, draft.error)
  const revised = await invoke(page, 'db:draft-update-status', draft.id, 'revised', undefined, path, session)
  assert.equal(revised.success, true, revised.error)
} })

/** 驱动打开作品会让界面的会话失效，界面不先回到书房就退不干净。 */
async function factsFromDriverOpen(context, projectPath) {
  await context.reload()
  const { page, invoke } = context
  const opened = await invoke(page, 'project:open', projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  const session = { projectId: opened.project.id, projectPath, leaseId: opened.project.sessionLease }
  const sequence = await invoke(page, 'db:draft-authority-sequence', projectPath, session)
  const chapter3 = (await invoke(page, 'db:draft-list', 3, projectPath, session)).map(draft => `v${draft.version}:${draft.status}`)
  return { repair: opened.finalizationRepair, sequence: { status: sequence.status, nextChapterNumber: sequence.nextChapterNumber ?? null, duplicateChapterNumbers: sequence.duplicateChapterNumbers }, chapter3 }
}

export const RBK_SCENARIOS = {
  'rbk-rollback-refinalize': { model: true, shell: 'stage', setup: seedChapter3WithOlderDraft, run: async context => {
    const { page, shoot } = context
    const observed = {}

    await finalizeChapter(page, 3)
    await shoot('rbk-1-ch3-finalized')
    await finalizeChapter(page, 4)
    await shoot('rbk-2-ch4-finalized')

    await refs.open(page, 'history')
    await refs.historyChapters(page).getByRole('button', { name: /雾钟/ }).click()
    await refs.versionButton(page, '定稿 v2').waitFor({ state: 'visible' })
    observed.historyBefore = await refs.versionNames(page)
    await refs.versionButton(page, '草稿 v1').click()
    await refs.diffPage(page).waitFor({ state: 'visible' })
    observed.revertButtonOnFinalizedChapter = await page.getByRole('button', { name: '回退到此版本…' }).count()
    await page.getByRole('button', { name: '回退到此版本…' }).click()
    observed.revertDialog = await refs.dialog(page).innerText()
    await shoot('rbk-3-revert-dialog')
    await refs.dialog(page).getByRole('button', { name: '新建回滚草稿' }).click()
    await refs.versionButton(page, '草稿 v3').waitFor({ state: 'visible' })
    observed.historyAfterRevert = await refs.versionNames(page)
    await shoot('rbk-4-reverted-v3')

    await openChapter(page, 3)
    observed.chapter3RowAfterRevert = (await stage.chapterRows(page)).find(row => row.number === 3)
    await finalizeChapter(page, 3)
    observed.postProcessAfterRefinalize = await chapterView.postProcessSteps(page)
    observed.chapter3RowAfterRefinalize = (await stage.chapterRows(page)).find(row => row.number === 3)
    await shoot('rbk-5-ch3-refinalized')

    await refs.open(page, 'history')
    await refs.historyChapters(page).getByRole('button', { name: /雾钟/ }).click()
    await refs.versionButton(page, '定稿 v3').waitFor({ state: 'visible' })
    observed.historyAfterRefinalize = await refs.versionNames(page)
    await shoot('rbk-5b-history-superseded')
    await stage.openChapterVersion(page, 3, 2)
    observed.supersededSwitcher = await chapterView.versionButton(page).getAttribute('aria-label')
    observed.supersededHint = await chapterView.hint(page).innerText()
    await shoot('rbk-5c-chapter-superseded')

    await openChapter(page, 5)
    await chapterView.view(page).getByRole('button', { name: '写作此章', exact: true }).click()
    const message = blueprint.popover(page).getByText(/权威|定稿/u).first()
    const started = page.locator('.stage-capsule:not([data-tone="ok"])')
    await message.or(started).first().waitFor({ state: 'visible', timeout: 30_000 })
    observed.writeChapter5 = await blueprint.popover(page).isVisible() ? await blueprint.popover(page).innerText() : 'started'
    await shoot('rbk-6-write-ch5')
    await started.waitFor({ state: 'detached', timeout: 90_000 })
    observed.afterRefinalize = await factsFromDriverOpen(context, context.samplePath)

    console.log(`[rbk] observed ${JSON.stringify(observed)}`)
    assert.deepEqual(observed.afterRefinalize.sequence, { status: 'continuous', nextChapterNumber: 5, duplicateChapterNumbers: [] },
      `再定稿回退稿之后权威序列仍应连续、下一章是第 5 章。实际：${JSON.stringify(observed)}`)
    assert.equal(observed.writeChapter5, 'started', `第 5 章应能开始写。实际：${JSON.stringify(observed)}`)
    assert.equal(observed.chapter3RowAfterRevert?.phase, 'draft', `回退后第 3 章应回到草稿阶段。实际：${JSON.stringify(observed)}`)
    assert.equal(observed.chapter3RowAfterRefinalize?.phase, 'final', `再定稿后第 3 章应是定稿。实际：${JSON.stringify(observed)}`)
    assert.ok(observed.postProcessAfterRefinalize.length > 0 && observed.postProcessAfterRefinalize.every(step => step.state === 'success'),
      `再定稿后的后处理应全部成功。实际：${JSON.stringify(observed)}`)
    assert.ok(observed.historyAfterRefinalize.some(name => name.startsWith('已被替换的定稿 v2')), `版本历史应把旧定稿标为已被替换。实际：${JSON.stringify(observed)}`)
    assert.match(observed.supersededSwitcher, /^本章版本：已被替换的定稿 v2 · /u)
    assert.equal(observed.supersededHint, '已被替换的定稿，只读')
    return observed
  } },
  'rbk-history-revised-name': { model: true, shell: 'stage', setup: seedChapter3WithRevision, run: async context => {
    const { page } = context
    await refs.open(page, 'history')
    await refs.historyChapters(page).getByRole('button', { name: /雾钟/ }).click()
    await refs.versionButton(page, '修稿已合并 v2').waitFor({ state: 'visible' })
    const names = await refs.versionNames(page)
    await context.shoot('rbk-8-history-revised-name')
    assert.ok(names.some(name => name.startsWith('修稿已合并 v2')), `版本历史的修稿节点名与版本切换器一致。实际：${JSON.stringify(names)}`)
    return { names }
  } },
  'rbk-legacy-duplicate-repair': { model: true, shell: 'stage', setup: seedStageSample, run: async context => {
    const projectPath = context.samplePath
    const observed = {}
    const notice = () => context.page.getByRole('alertdialog').or(context.page.getByRole('dialog')).filter({ hasText: '已修复重复的定稿' })

    await context.restart({ beforeLaunch: () => { observed.injected = JSON.parse(injectDuplicateFinalization(projectPath, 2)) } })
    await stage.openAfterRestart(context.page, STAGE_SAMPLE.name)
    await notice().waitFor({ state: 'visible', timeout: 60_000 })
    observed.notice = await notice().innerText()
    await context.shoot('rbk-7-repair-notice')
    await notice().getByRole('button', { name: '知道了' }).click()
    observed.afterRepair = await factsFromDriverOpen(context, projectPath)

    const logged = context.diagnostics.length
    await context.restart()
    await stage.openAfterRestart(context.page, STAGE_SAMPLE.name)
    await waitForLayer2Loaded(context.diagnostics, logged)
    await openChapter(context.page, 3)
    observed.noticeOnSecondOpen = await notice().count()
    observed.afterSecondOpen = await factsFromDriverOpen(context, projectPath)

    console.log(`[rbk] observed ${JSON.stringify(observed)}`)
    assert.deepEqual(observed.injected, { chapter: 2, finalized: 2 }, '造出第 2 章两行定稿')
    assert.match(observed.notice, /第 2 章：保留 v2 作为定稿，v1 改为「已被替换的定稿」/u)
    assert.deepEqual(observed.afterRepair.repair, { status: 'checked', chapters: [] }, '修好之后再打开不再修')
    assert.deepEqual(observed.afterRepair.sequence, { status: 'continuous', nextChapterNumber: 3, duplicateChapterNumbers: [] })
    assert.equal(observed.noticeOnSecondOpen, 0, '再打开一次不再提示')
    assert.deepEqual(observed.afterSecondOpen, observed.afterRepair, '修复幂等：再打开一次数据不变')
    return observed
  } },
}

/** 界面打开作品时第二层数据加载完成会打这条日志，重复定稿提示紧接着在同一条调用链里派发。 */
async function waitForLayer2Loaded(diagnostics, from) {
  const deadline = Date.now() + 60_000
  while (!diagnostics.slice(from).some(line => line.includes('[ProjectService] 项目数据加载完成'))) {
    assert.ok(Date.now() < deadline, '重启后界面没有打完作品打开流程')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

function injectDuplicateFinalization(projectPath, chapter) {
  const electron = createRequire(import.meta.url)('electron')
  const script = fileURLToPath(new URL('./rbk-inject-duplicate.cjs', import.meta.url))
  return execFileSync(electron, [script, path.join(projectPath, '.ai-novel', 'project.db'), String(chapter)],
    // better-sqlite3 是原生模块，必须用 Electron 自带的 Node 加载，ABI 才和应用一致。
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
}

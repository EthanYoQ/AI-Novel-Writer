// 版本历史「回退到此版本」在已定稿章上建稿、再定稿之后，后续章节还能不能写（rollback-refinalize 第一阶段复现）。
// 示例作品第 1、2 章已定稿；本场景在界面上定稿第 3、4 章，回退第 3 章并再定稿，再试写第 5 章。
import assert from 'node:assert/strict'

import * as blueprint from './pages/blueprint.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as refs from './pages/refs.mjs'
import * as stage from './pages/stage.mjs'
import { finalizeChapter, openChapter } from './f491-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'
import { countUnits, STAGE_SAMPLE } from './stage-sample.mjs'

const SECOND_DRAFT = `${STAGE_SAMPLE.drafts[3].text}\n\n林岚把纸条又读了一遍，决定等到下一次大潮再上灯室。`

/** 第 3 章再有一份草稿 v2，定稿 v2 之后 v1 还在，版本历史里才有可回退的旧稿。 */
const seed = context => seedStageSample(context, { beforeReload: async ({ page, invoke, path, session }) => {
  context.projectPath = path
  const draft = await invoke(page, 'db:draft-create', { chapterNumber: 3, version: 2, source: 'write', content: SECOND_DRAFT,
    wordCount: countUnits(SECOND_DRAFT) }, path, session)
  assert.equal(draft.success, true, draft.error)
} })

/** 记下界面最近一次带项目会话的调用参数，驱动用同一会话读库，不重开作品。 */
async function watchSession(app) {
  await app.evaluate(({ ipcMain }) => {
    for (const [channel, handler] of ipcMain._invokeHandlers) {
      ipcMain._invokeHandlers.set(channel, (event, ...args) => {
        const session = args.at(-1)
        if (session && typeof session === 'object' && 'leaseId' in session) globalThis.__driveSession = session
        return handler(event, ...args)
      })
    }
  })
}

async function facts({ app, page, invoke, projectPath }) {
  const handle = await app.evaluateHandle(() => globalThis.__driveSession ?? null)
  const session = await handle.jsonValue()
  await handle.dispose()
  assert.ok(session, '界面已带会话调用过主进程')
  const sequence = await invoke(page, 'db:draft-authority-sequence', projectPath, session)
  const chapter3 = (await invoke(page, 'db:draft-list', 3, projectPath, session)).map(draft => `v${draft.version}:${draft.status}`)
  return { sequence: { status: sequence.status, nextChapterNumber: sequence.nextChapterNumber ?? null, duplicateChapterNumbers: sequence.duplicateChapterNumbers }, chapter3 }
}

export const RBK_SCENARIOS = {
  'rbk-rollback-refinalize': { model: true, shell: 'stage', setup: seed, run: async context => {
    const { app, page, shoot } = context
    await watchSession(app)
    const observed = {}

    await finalizeChapter(page, 3)
    await shoot('rbk-1-ch3-finalized')
    await finalizeChapter(page, 4)
    await shoot('rbk-2-ch4-finalized')
    observed.afterFirstFinals = await facts(context)

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
    observed.afterRefinalize = await facts(context)

    await openChapter(page, 5)
    await chapterView.view(page).getByRole('button', { name: '写作此章', exact: true }).click()
    const message = blueprint.popover(page).getByText(/权威|定稿/u).first()
    const started = page.locator('.stage-capsule:not([data-tone="ok"])')
    await message.or(started).first().waitFor({ state: 'visible', timeout: 30_000 })
    observed.writeChapter5 = await blueprint.popover(page).isVisible() ? await blueprint.popover(page).innerText() : 'started'
    await shoot('rbk-6-write-ch5')

    console.log(`[rbk] observed ${JSON.stringify(observed)}`)
    assert.deepEqual(observed.afterRefinalize.sequence, { status: 'continuous', nextChapterNumber: 5, duplicateChapterNumbers: [] },
      `再定稿回退稿之后权威序列仍应连续、下一章是第 5 章。实际：${JSON.stringify(observed)}`)
    assert.equal(observed.writeChapter5, 'started', `第 5 章应能开始写。实际：${JSON.stringify(observed)}`)
    return observed
  } },
}

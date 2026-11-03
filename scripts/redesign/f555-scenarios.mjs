// #555 实机场景：导入中断（关窗口、活动时长在请求途中用完）后，在导入对话框点「继续导入」接着跑完，已提交的批次不重做。
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'

import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { holdBlueprintDispatch, readDb, referenceNovel, startImport, stopOnActiveTime } from './f537-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const CHAPTERS = 15

const latestRun = db => db.prepare('SELECT id, stage, status, last_error FROM import_runs ORDER BY rowid DESC LIMIT 1').get()

/** 每个导入 slot 有几个生成运行：继续导入只为中断的那个 slot 多开一个，已提交的 slot 仍只有一个。 */
const runsPerSlot = db => db.prepare(`SELECT json_extract(binding_json,'$.sourceManifest.importSlot.stage') AS stage,
  json_extract(binding_json,'$.sourceManifest.importSlot.batchId') AS batchId, COUNT(*) AS runs FROM generation_runs
  WHERE json_extract(binding_json,'$.sourceManifest.importSlotKey') IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2`).all()

/** 点「继续导入」，返回点之前的导入运行行：继续沿用同一个运行，等结束时要和它比，免得把上次的失败当成这次的结果。 */
async function continueImport(context, shotName) {
  const { page } = context
  await stage.root(page).getByRole('banner').getByRole('button', { name: `《${STAGE_SAMPLE.name}》作品菜单` }).click()
  await page.getByRole('menuitem', { name: '小说拆解与仿写…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '小说拆解与仿写' })
  await dialog.getByTestId('import-target-current').click()
  const resume = dialog.getByRole('button', { name: '继续导入', disabled: false })
  await resume.waitFor({ state: 'visible' })
  await page.waitForTimeout(400)
  await context.shoot(shotName)
  const previous = readDb(context, latestRun)
  await resume.click()
  await dialog.waitFor({ state: 'hidden' })
  return previous
}

async function untilImportEnds(context, previous) {
  for (const deadline = Date.now() + 5 * 60_000; ; await new Promise(resolve => setTimeout(resolve, 1000))) {
    const run = readDb(context, latestRun)
    if (run?.status === 'completed' || run?.status === 'failed' && !isDeepStrictEqual(run, previous)) return run
    assert.ok(Date.now() < deadline, `5 分钟内继续导入没有结束：${JSON.stringify(run)}`)
  }
}

async function finished(context, shotName, before, previous) {
  const run = await untilImportEnds(context, previous)
  const measured = readDb(context, db => ({
    run,
    blueprints: db.prepare('SELECT COUNT(*) FROM blueprints WHERE chapter_number BETWEEN 1 AND ?').pluck().get(CHAPTERS),
    runsPerSlot: runsPerSlot(db),
  }))
  await runSheet.waitUntilOpen(context.page).catch(() => undefined)
  await context.page.waitForTimeout(400)
  await context.shoot(shotName)
  assert.equal(run.status, 'completed', JSON.stringify(run))
  assert.equal(measured.blueprints, CHAPTERS)
  const retried = measured.runsPerSlot.filter(slot => slot.runs > 1)
  assert.equal(retried.length, 1, `只有中断的 slot 重开：${JSON.stringify(measured.runsPerSlot)}`)
  assert.equal(retried[0].runs, 2)
  for (const slot of before) {
    assert.equal(measured.runsPerSlot.find(item => item.stage === slot.stage && item.batchId === slot.batchId)?.runs, 1,
      `继续前已提交的 ${slot.stage}:${slot.batchId} 没有重做`)
  }
  return { ...measured, committedBeforeContinue: before }
}

const committedSlots = db => db.prepare("SELECT stage, batch_id AS batchId FROM import_run_receipts WHERE state='committed' AND stage IN ('global','style','blueprints')").all()

/**
 * 第 4 次蓝图派发发出后卡在假模型上。导入运行中关窗会被退出确认拦下（只能等完成或取消），
 * 所以中断只能来自进程被结束（崩溃、任务管理器、断电）：结束进程树，重新打开作品后继续导入。
 */
async function closeWindowThenContinue(context) {
  const { app, page, roots, fake } = context
  fake.replyImport()
  const hold = await holdBlueprintDispatch(app, 4)
  await startImport(app, page, referenceNovel(roots, CHAPTERS), CHAPTERS)
  try {
    await hold.waitHeld()
    fake.gate.hold()
  } finally {
    await hold.release()
  }
  for (const deadline = Date.now() + 60_000; fake.gate.waiting === 0; await new Promise(resolve => setTimeout(resolve, 100))) {
    assert.ok(Date.now() < deadline, '60 秒内蓝图请求没有发到假模型')
  }
  const before = readDb(context, committedSlots)
  assert.ok(before.some(slot => slot.stage === 'blueprints'), `中断前已有提交的蓝图批次：${JSON.stringify(before)}`)
  const interrupted = readDb(context, latestRun)
  assert.equal(interrupted.status, 'running')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  const exit = page.getByRole('dialog', { name: '创作任务仍在运行' })
  await exit.waitFor({ state: 'visible' })
  await page.waitForTimeout(400)
  await context.shoot('f555-close-window-blocked')
  await context.restart({ killed: true })
  fake.gate.release()
  await stage.openAfterRestart(context.page, STAGE_SAMPLE.name)
  const previous = await continueImport(context, 'f555-close-window-dialog')
  return finished(context, 'f555-close-window-done', before, previous)
}

/** 活动时长在请求途中用完、根被阻断（#541 的停止说明）后，继续导入接着跑完。 */
async function activeTimeThenContinue(context) {
  const stop = await stopOnActiveTime(context)
  const before = readDb(context, committedSlots)
  const previous = await continueImport(context, 'f555-stop-time-dialog')
  return { stop, stopped: previous, ...await finished(context, 'f555-stop-time-done', before, previous) }
}

export const F555_SCENARIOS = {
  'f555-close-window': { model: true, shell: 'stage', setup: seedStageSample, run: closeWindowThenContinue },
  'f555-stop-time': { model: true, shell: 'stage', setup: seedStageSample, run: activeTimeThenContinue },
}

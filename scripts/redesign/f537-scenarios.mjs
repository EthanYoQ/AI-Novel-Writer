// #537 实机场景：长篇参考小说导入一次跑完，导入根按章数定额；活动时长在请求途中用完时，运行卡片说明原因与下一步、不露错误码，码在「诊断」日志里。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { EMPTY_BOOK, inferenceReply, manuscript, openAuthorImport, seedEmptyBook } from './import-infer-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')

function referenceNovel(roots, chapters) {
  const file = path.join(roots.temp, `reference-${chapters}.txt`)
  fs.writeFileSync(file, Array.from({ length: chapters }, (_, index) =>
    `第${index + 1}章 雾港${index + 1}\n林岚沿着旧港的石阶往下走，第${index + 1}次对照父亲留下的潮汐表。灯塔的雾钟在远处响了三声。\n`).join('\n'))
  return file
}

async function startImport(app, page, file, chapters) {
  assert.ok(await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
    return true
  }, file))
  await stage.root(page).getByRole('banner').getByRole('button', { name: `《${STAGE_SAMPLE.name}》作品菜单` }).click()
  await page.getByRole('menuitem', { name: '小说拆解与仿写…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '小说拆解与仿写' })
  await dialog.getByTestId('import-target-current').click()
  await dialog.getByRole('button', { name: '选择', exact: true }).click()
  await dialog.getByRole('button', { name: `导入当前项目（${chapters} 章）`, disabled: false }).click()
  await dialog.waitFor({ state: 'hidden' })
}

function readDb(context, read) {
  const db = new Database(path.join(context.samplePath, '.ai-novel', 'project.db'), { readonly: true, fileMustExist: true })
  try { return read(db) } finally { db.close() }
}

function writeDb(context, write) {
  const db = new Database(path.join(context.samplePath, '.ai-novel', 'project.db'), { fileMustExist: true, timeout: 10_000 })
  try { return write(db) } finally { db.close() }
}

const importRoot = db => db.prepare(`SELECT root_action_id, budget_json, blocked_code, active_elapsed_ms FROM generation_roots
  WHERE json_extract(action_json,'$.operation')='import-global-facts' ORDER BY rowid DESC LIMIT 1`).get()

async function failedStepError(page) {
  const failedStep = runSheet.sheet(page).locator('.run-step[data-status="failed"] .run-step-row').first()
  await failedStep.waitFor({ state: 'visible', timeout: 90_000 })
  if (await failedStep.getAttribute('aria-expanded') !== 'true') await failedStep.click()
  const stepError = runSheet.sheet(page).locator('.run-step[data-status="failed"] .run-step-error').first()
  await stepError.waitFor({ state: 'visible' })
  return stepError.innerText()
}

/**
 * 卡住第 nth 次序号 0 的导入蓝图派发（假模型输出上限小，每批先被按单章拆开，第 2 次才真正发出），
 * 卡在主进程处理函数之前：这时没有在途请求，改库不会和请求计时打架。
 */
async function holdBlueprintDispatch(app, nth) {
  assert.ok(await app.evaluate(({ ipcMain }, nth) => {
    const handlers = ipcMain._invokeHandlers
    const original = handlers.get('import-generation:execute')
    if (!original) return false
    const gate = Promise.withResolvers()
    const state = globalThis.__f537 = { seen: 0, held: false, release: gate.resolve }
    handlers.set('import-generation:execute', async (event, request, ...rest) => {
      if (request?.task?.purpose === 'import-chapter-blueprints' && request.ordinal === 0 && ++state.seen === nth) {
        state.held = true
        await gate.promise
      }
      return original(event, request, ...rest)
    })
    return true
  }, nth), '能在主进程里卡住导入蓝图的派发')
  return {
    waitHeld: async () => {
      for (const deadline = Date.now() + 90_000; ; await new Promise(resolve => setTimeout(resolve, 100))) {
        const handle = await app.evaluateHandle(() => globalThis.__f537.held)
        const held = await handle.jsonValue().finally(() => handle.dispose())
        if (held) return
        assert.ok(Date.now() < deadline, `90 秒内第 ${nth} 次蓝图派发没有卡在门上`)
      }
    },
    release: () => app.evaluate(() => globalThis.__f537.release()),
  }
}

/** 活动时长在请求进行中用完：派发前把根的活动时长推到只差 300 毫秒，并卡住假模型，让主进程的计时到点中止请求、阻断根。 */
async function stopOnActiveTime(context) {
  const { app, page, roots, fake, shoot } = context
  fake.replyImport()
  const hold = await holdBlueprintDispatch(app, 2)
  await startImport(app, page, referenceNovel(roots, 15), 15)
  try {
    await hold.waitHeld()
    writeDb(context, db => {
      const root = importRoot(db)
      db.prepare('UPDATE generation_roots SET active_elapsed_ms=? WHERE root_action_id=?').run(JSON.parse(root.budget_json).maxActiveElapsedMs - 300, root.root_action_id)
    })
    fake.gate.hold()
  } finally {
    await hold.release()
  }
  await runSheet.waitUntilOpen(page)
  let stepError
  try { stepError = await failedStepError(page) } finally { fake.gate.release() }
  const root = readDb(context, importRoot)
  await page.waitForTimeout(400)
  await shoot('f537-stop-time-card')
  await runSheet.tab(page, '诊断').click()
  const logLine = runSheet.sheet(page).locator('.run-log-line').filter({ hasText: '停止原因：ROOT_BUDGET_EXHAUSTED' }).first()
  await logLine.scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await shoot('f537-stop-time-diagnostics')
  assert.equal(root.blocked_code, 'ROOT_BUDGET_EXHAUSTED')
  assert.match(stepError, /模型请求累计时长已到上限/u, stepError)
  assert.match(stepError, /只能在导入对话框里点「重新开始」，它会从第 1 章重新推演蓝图/u, stepError)
  assert.doesNotMatch(stepError, /[A-Z]{3,}_[A-Z]/u, '运行卡片的说明不露错误码')
  const diagnostic = await logLine.innerText()
  return { stepError, diagnostic, blockedCode: root.blocked_code }
}

/** 发送前根预算已用完：派发前把根的活动时长推到上限，预留时被拒，运行卡片给中性的预算说明。 */
async function stopBeforeSend(context) {
  const { app, page, roots, shoot } = context
  context.fake.replyImport()
  const hold = await holdBlueprintDispatch(app, 2)
  await startImport(app, page, referenceNovel(roots, 15), 15)
  try {
    await hold.waitHeld()
    writeDb(context, db => {
      const root = importRoot(db)
      db.prepare('UPDATE generation_roots SET active_elapsed_ms=? WHERE root_action_id=?').run(JSON.parse(root.budget_json).maxActiveElapsedMs, root.root_action_id)
    })
  } finally {
    await hold.release()
  }
  await runSheet.waitUntilOpen(page)
  const stepError = await failedStepError(page)
  await page.waitForTimeout(400)
  await shoot('f537-stop-before-send-card')
  assert.match(stepError, /这次导入的请求次数或运行时长已到上限，这一批没有发送/u, stepError)
  assert.match(stepError, /只能在导入对话框里点「重新开始」，它会从第 1 章重新推演蓝图/u, stepError)
  assert.doesNotMatch(stepError, /[A-Z]{3,}_[A-Z]/u, '运行卡片的说明不露错误码')
  return { stepError }
}

/** 作者原稿反推在蓝图阶段发送前被根预算拒绝：说明写正文已保存、可手动补齐，不指向点不了的「重新开始」。 */
async function stopAuthorInference(context) {
  const { app, page, roots, fake, shoot } = context
  fake.replyReview(inferenceReply)
  const hold = await holdBlueprintDispatch(app, 1)
  const dialog = await openAuthorImport(app, page, EMPTY_BOOK, manuscript(roots, [[1, '匿名信'], [2, '茶馆'], [3, '河对岸']]))
  await dialog.getByRole('button', { name: '确认导入（3 章）', disabled: false }).click()
  await dialog.waitFor({ state: 'hidden' })
  try {
    await hold.waitHeld()
    const opened = await app.evaluate(() => globalThis.__driveOpened)
    assert.ok(opened?.projectPath, '记下了界面打开作品的路径')
    context.samplePath = opened.projectPath
    writeDb(context, db => {
      const root = importRoot(db)
      db.prepare('UPDATE generation_roots SET active_elapsed_ms=? WHERE root_action_id=?').run(JSON.parse(root.budget_json).maxActiveElapsedMs, root.root_action_id)
    })
  } finally {
    await hold.release()
  }
  await runSheet.waitUntilOpen(page)
  const stepError = await failedStepError(page)
  await page.waitForTimeout(400)
  await shoot('f537-author-stop-card')
  assert.match(stepError, /这次导入的请求次数或运行时长已到上限，这一批没有发送/u, stepError)
  assert.match(stepError, /原稿正文已经导入并保存，只是 AI 反推的设定、文风或蓝图没有做完。已导入的正文不受影响，可以在设定页和蓝图页手动补齐/u, stepError)
  assert.doesNotMatch(stepError, /重新开始/u, '作者原稿不指向重新开始')
  assert.doesNotMatch(stepError, /[A-Z]{3,}_[A-Z]/u, '运行卡片的说明不露错误码')
  return { stepError }
}

export const F537_SCENARIOS = {
  // 252 章参考小说导入当前作品：知识库、全局、文风、全部蓝图一次跑完，导入根按 252 章定额（770 次、86 625 000 毫秒）。
  'f537-import-252': { model: true, shell: 'stage', setup: seedStageSample, run: async context => {
    const { app, page, roots, fake, shoot } = context
    fake.replyImport()
    await startImport(app, page, referenceNovel(roots, 252), 252)
    let run
    for (const deadline = Date.now() + 15 * 60_000; ; await new Promise(resolve => setTimeout(resolve, 1000))) {
      run = readDb(context, db => db.prepare('SELECT id, stage, status, last_error FROM import_runs ORDER BY rowid DESC LIMIT 1').get())
      if (run?.status === 'completed' || run?.status === 'failed') break
      assert.ok(Date.now() < deadline, `15 分钟内导入没有结束：${JSON.stringify(run)}`)
    }
    const measured = readDb(context, db => {
      const root = importRoot(db)
      return {
        run,
        budget: JSON.parse(root.budget_json),
        blockedCode: root.blocked_code,
        physicalRequests: db.prepare("SELECT COUNT(*) FROM generation_attempts WHERE root_action_id=? AND json_extract(attempt_json,'$.status')<>'cancelled-before-dispatch'").pluck().get(root.root_action_id),
        blueprints: db.prepare('SELECT COUNT(*) FROM blueprints WHERE chapter_number BETWEEN 1 AND 252').pluck().get(),
        blueprintRequests: fake.requests.filter(kind => kind === 'import-blueprints').length,
      }
    })
    await runSheet.waitUntilOpen(page).catch(() => undefined)
    await page.waitForTimeout(400)
    await shoot('f537-import-252')
    assert.equal(run.status, 'completed', JSON.stringify(run))
    assert.deepEqual({ maxPhysicalRequests: measured.budget.maxPhysicalRequests, maxActiveElapsedMs: measured.budget.maxActiveElapsedMs },
      { maxPhysicalRequests: 770, maxActiveElapsedMs: 86_625_000 })
    assert.equal(measured.blockedCode, null)
    // 假模型的输出上限只有 4096，每批 5 章先被按单章拆开，所以蓝图实际是每章 1 次，共 252 次；旧的 32 次根在第 30 章左右就会用完。
    assert.equal(measured.physicalRequests, 2 + measured.blueprintRequests)
    assert.ok(measured.blueprintRequests >= 51, `蓝图请求 ${measured.blueprintRequests} 次`)
    assert.equal(measured.blueprints, 252)
    return measured
  } },
  'f537-stop-time': { model: true, shell: 'stage', setup: seedStageSample, run: stopOnActiveTime },
  'f537-stop-before-send': { model: true, shell: 'stage', setup: seedStageSample, run: stopBeforeSend },
  'f537-author-stop': { model: true, shell: 'stage', setup: seedEmptyBook, run: stopAuthorInference },
}

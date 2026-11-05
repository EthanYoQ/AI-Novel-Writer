import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { characterStateReply, finalizeChapter, openChapter } from './f491-scenarios.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'

// 回收站（#564 PR3）没有界面入口（界面在 PR4），这里经公开 IPC 在真实 Electron 里走一遍：
// 删一章、恢复、再删、彻底删除，之后重新打开作品，核对实体稿与知识库都没有残留。

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

const manuscripts = (projectPath, chapterNumber) => fs.readdirSync(projectPath).filter(name => name.startsWith(`第${chapterNumber}章`)).sort()

export const TRASH_SCENARIOS = {
  'trash-roundtrip': { model: true, shell: 'stage', setup: async context => {
    await trackOpenedSession(context.app)
    await seedStageSample(context)
  }, run: async context => {
    const { app, page, invoke } = context
    const projectPath = context.samplePath
    context.fake.replyCharacterState(characterStateReply)
    await finalizeChapter(page, 3)
    const session = await app.evaluate(() => globalThis.__driveOpened)
    assert.ok(session?.leaseId, '记下了界面打开作品的会话')
    const call = (channel, ...args) => invoke(page, channel, ...args, projectPath, session)
    // 删除后 finalizedChapter 不再标出被删章，除了文件名再按定稿时记下的文档 ID 认，免得改了名的残留文档漏网。
    const tracked = new Set()
    const ofChapter = document => document.finalizedChapter === 3 || /第3章/u.test(document.fileName) || tracked.has(document.id)
    const knowledge = async () => (await call('kb:list-documents')).filter(ofChapter)
    const finalized = async () => (await call('db:draft-list', 3)).find(draft => draft.status === 'finalized')
    const observed = { steps: [] }
    const step = (name, value) => { observed.steps.push({ name, ...value }); console.log(`[trash] ${name} ${JSON.stringify(value)}`) }

    const draft = await finalized()
    assert.ok(draft, '第 3 章已定稿')
    const before = { manuscripts: manuscripts(projectPath, 3), knowledge: (await knowledge()).map(document => document.id) }
    for (const id of before.knowledge) tracked.add(id)
    step('定稿后', before)
    assert.equal(before.manuscripts.length, 1, '定稿后有一份实体稿')
    assert.equal(before.knowledge.length, 1, '定稿后知识库有这一章')

    const deleted = await call('chapter:delete-finalized', { draftId: draft.id, chapterNumber: 3 })
    const listed = await call('chapter:trash-list')
    step('删除', { deleted: { success: deleted.success, status: deleted.operation?.status }, trash: listed.entries, damaged: listed.damaged,
      manuscripts: manuscripts(projectPath, 3), knowledge: await knowledge(), live: Boolean(await finalized()) })
    assert.equal(deleted.success, true, JSON.stringify(deleted))
    assert.deepEqual(listed.damaged, [])
    assert.equal(listed.entries.length, 1)
    assert.equal(listed.entries[0].restoreMode, 'into-gap')
    assert.deepEqual(manuscripts(projectPath, 3), [])
    assert.deepEqual(await knowledge(), [])
    assert.equal(await finalized(), undefined)

    const deletionId = listed.entries[0].deletionId
    const restored = await call('chapter:trash-restore', { deletionId, draftId: draft.id, expectedMode: 'into-gap' })
    step('恢复', { restored, manuscripts: manuscripts(projectPath, 3), knowledge: await knowledge(), trash: (await call('chapter:trash-list')).entries })
    assert.equal(restored.outcome, 'restored', JSON.stringify(restored))
    assert.equal(restored.publicationStatus, 'published')
    assert.deepEqual(manuscripts(projectPath, 3), before.manuscripts, '实体稿按原名重发')
    assert.equal((await finalized())?.id, draft.id)

    const again = await call('chapter:delete-finalized', { draftId: draft.id, chapterNumber: 3 })
    const relisted = await call('chapter:trash-list')
    step('再删', { again: { success: again.success, error: again.error, status: again.operation?.status }, trash: relisted.entries })
    assert.equal(again.success, true, `恢复后再删不要旧定稿知识授权：${JSON.stringify(again)}`)
    assert.equal(relisted.entries.length, 1)

    const purged = await call('chapter:trash-purge', { deletionIds: [relisted.entries[0].deletionId] })
    step('彻底删除', { purged, trash: await call('chapter:trash-list') })
    assert.deepEqual(purged, { success: true, purged: [relisted.entries[0].deletionId], alreadyGone: [] })

    await context.reload()
    const opened = await invoke(context.page, 'project:open', projectPath, randomUUID(), null)
    assert.equal(opened.success, true, `彻底删除后作品照常打开：${opened.error}`)
    const reopened = { projectId: opened.project.id, projectPath, leaseId: opened.project.sessionLease }
    const after = {
      drafts: (await invoke(context.page, 'db:draft-list', 3, projectPath, reopened)).map(item => `${item.id}:${item.status}`),
      trash: await invoke(context.page, 'chapter:trash-list', projectPath, reopened),
      manuscripts: manuscripts(projectPath, 3),
      knowledge: (await invoke(context.page, 'kb:list-documents', projectPath, reopened))
        .filter(ofChapter),
      incomplete: await invoke(context.page, 'chapter:list-incomplete-deletions', projectPath, reopened),
    }
    step('重新打开', after)
    assert.equal(after.drafts.some(item => item.startsWith(`${draft.id}:`)), false, '被彻底删除的定稿不在了')
    assert.deepEqual(after.trash, { success: true, entries: [], damaged: [] })
    assert.deepEqual(after.manuscripts, [])
    assert.deepEqual(after.knowledge, [])
    assert.deepEqual(after.incomplete, { success: true, operations: [] })
    return observed
  } },
}

/** 有实体稿时把它独占打开，让删除时的移除失败，回收站这一项就停在「清理没完成」。返回解锁函数。 */
function lockFile(file) {
  const quoted = file.replaceAll("'", "''")
  const child = spawn('powershell.exe', ['-NoProfile', '-Command', `$f=[System.IO.File]::Open('${quoted}','Open','Read','None'); Write-Output locked; Start-Sleep 300`], { stdio: ['ignore', 'pipe', 'inherit'] })
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { if (String(chunk).includes('locked')) resolve() })
    child.once('exit', code => reject(new Error(`锁文件进程提前退出：${code}`)))
  })
  return { pid: child.pid, ready, release: () => { try { execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch { /* 已退出 */ } } }
}

/** 只让下一次恢复返回「批次没写完」：真实复现要一批没写完的批量创作，这里替换一次主进程回复，界面走的是真实的报错与文案。 */
async function rejectNextRestoreAsBatchUnfinished(app) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const original = handlers.get('chapter:trash-restore')
    handlers.set('chapter:trash-restore', async () => {
      handlers.set('chapter:trash-restore', original)
      return { success: false, error: 'CHAPTER_RESTORE_BATCH_UNFINISHED' }
    })
  })
}

const toasts = page => page.locator('#ai-novel-ink-toasts')
/** 关掉已有的通知，下一张截图只留这一步的提示。 */
const dismissToasts = async page => {
  await toasts(page).evaluate(node => { for (const button of node.querySelectorAll('button[aria-label="关闭通知"]')) button.click() })
  await page.waitForTimeout(600)
}
const trashDialog = page => page.getByRole('dialog', { name: /^回收站（\d+）$/u })

TRASH_SCENARIOS['trash-ui'] = { model: true, shell: 'stage', setup: async context => {
  if (process.platform !== 'win32') throw new Error(`trash-ui 场景只能在 Windows 上跑：它用 powershell.exe 独占锁住实体稿，当前平台是 ${process.platform}`)
  await trackOpenedSession(context.app)
  await seedStageSample(context)
}, run: async context => {
  const { page, app } = context
  const projectPath = context.samplePath
  const observed = {}
  context.fake.replyCharacterState(characterStateReply)
  await finalizeChapter(page, 3)
  // 第 4 章也定稿，删第 3 章后才留下缺口（后面有定稿章），蓝图页出缺口卡。
  await finalizeChapter(page, 4)
  const files = manuscripts(projectPath, 3)
  observed.manuscripts = files
  assert.equal(files.length, 1, `第 3 章定稿后有一份实体稿：${files}`)
  const lock = lockFile(path.join(projectPath, files[0]))
  try {
    await lock.ready
    await openChapter(page, 3)
    await chapterView.more(page, '删除正文…')
    const confirm = page.getByRole('dialog', { name: '删除正文' })
    await confirm.getByText(/后面的章节.*可能要跟着改/u).waitFor({ state: 'visible' })
    await context.shoot('delete-confirm')
    await confirm.getByRole('button', { name: '删除', exact: true }).click()
    await confirm.waitFor({ state: 'hidden' })
    await page.waitForTimeout(1500)
    observed.afterDeleteToast = await toasts(page).innerText()
  } finally {
    lock.release()
  }

  // 第 3 章的页面会列出删除清理失败的原文（本机路径和 EBUSY），回收站从第 4 章打开，截图里只看回收站。
  await dismissToasts(page)
  await openChapter(page, 4)
  assert.equal(await page.getByText(/EBUSY|C:\\Users/u).count(), 0, '回收站背后的页面不露本机路径和 EBUSY')
  await page.getByRole('button', { name: /^回收站（1）$/u }).click()
  const trash = trashDialog(page)
  await trash.waitFor({ state: 'visible' })
  observed.trashText = await trash.innerText()
  assert.match(observed.trashText, /还没清理完/u, '实体稿删不掉时，这一项标清理没完成')
  await dismissToasts(page)
  await context.shoot('trash-cleanup-incomplete')

  await rejectNextRestoreAsBatchUnfinished(app)
  await trash.getByRole('button', { name: '恢复' }).click()
  await toasts(page).getByText(/这一章属于一次没写完的批量创作/u).waitFor({ state: 'visible' })
  await context.shoot('restore-batch-unfinished')
  await dismissToasts(page)

  await trash.getByRole('button', { name: '重试清理' }).click()
  await toasts(page).getByText(/的清理完成了，现在可以恢复/u).waitFor({ state: 'visible', timeout: 30_000 })
  observed.afterRetry = manuscripts(projectPath, 3)
  assert.deepEqual(observed.afterRetry, [], '重试清理后实体稿移除了')
  await trash.getByRole('button', { name: '关闭' }).click()
  await dismissToasts(page)

  await stage.stageButton(page, '蓝图').click()
  const gap = page.locator('.pi-notice').filter({ hasText: '正文在回收站里' }).first()
  await gap.waitFor({ state: 'visible' })
  await gap.scrollIntoViewIfNeeded()
  observed.gapButtons = await gap.getByRole('button').allInnerTexts()
  await context.shoot('gap-card')

  await gap.getByRole('button', { name: '恢复' }).click()
  await toasts(page).getByText(/已恢复第 3 章的正文和全部版本/u).waitFor({ state: 'visible', timeout: 30_000 })
  observed.afterRestore = manuscripts(projectPath, 3)
  observed.restoreToast = await toasts(page).innerText()
  await context.shoot('restore-success')

  // 恢复提示让作者去「定稿后处理」点「重试」重新收进知识库：核对知识库里确实没有这一章，单章页确实有这个按钮。
  const session = await app.evaluate(() => globalThis.__driveOpened)
  observed.knowledgeAfterRestore = (await context.invoke(page, 'kb:list-documents', projectPath, session))
    .filter(document => document.finalizedChapter === 3 || /第3章/u.test(document.fileName)).map(document => document.fileName)
  await openChapter(page, 3)
  await chapterView.postProcess(page).waitFor({ state: 'visible' })
  observed.postProcessAfterRestore = await chapterView.postProcess(page).innerText()
  console.log(`[trash-ui] ${JSON.stringify(observed)}`)
  return observed
} }

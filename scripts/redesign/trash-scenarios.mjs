import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'

import { characterStateReply, finalizeChapter } from './f491-scenarios.mjs'
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

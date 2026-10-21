import assert from 'node:assert/strict'
import { it, vi } from 'vitest'
vi.mock('playwright', () => ({ _electron: { launch: () => { throw new Error('UNIT_TEST_MUST_NOT_LAUNCH_ELECTRON') } } }))
import { recordCalls, stubChannel } from '../x1-scenarios.mjs'

/** 和 Playwright 的 app.evaluate 一样把主进程模块交给回调；主进程里只注册了 db:draft-list。 */
function fakeApp() {
  const handlers = new Map([['db:draft-list', (_event, chapter) => [`第 ${chapter} 章的稿`]]])
  return { handlers, evaluate: async (fn, arg) => fn({ ipcMain: { _invokeHandlers: handlers } }, arg) }
}

it('recordCalls 遇到主进程没有的通道就报错，不让数据安全断言因为记不到调用而假绿', async () => {
  await assert.rejects(recordCalls(fakeApp(), ['db:draft-list', 'db:renamed-channel']), /db:renamed-channel/)
})

it('recordCalls 包住已有的通道：调用照常交给原处理函数，并记下所属作品', async () => {
  const app = fakeApp()
  await recordCalls(app, ['db:draft-list'])
  assert.deepEqual(await app.handlers.get('db:draft-list')(null, 3, { projectPath: 'C:\novels\harbor' }), ['第 3 章的稿'])
  assert.deepEqual(globalThis.__driveCalls.map(({ channel, projectPath }) => ({ channel, projectPath })), [{ channel: 'db:draft-list', projectPath: 'C:\novels\harbor' }])
})

it('stubChannel 遇到主进程没有的通道就报错，不凭空注册一个没人调用的处理函数', async () => {
  const app = fakeApp()
  await assert.rejects(stubChannel(app, 'dialog:renamed-channel', null), /dialog:renamed-channel/)
  assert.deepEqual([...app.handlers.keys()], ['db:draft-list'])
})

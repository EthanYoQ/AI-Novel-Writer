import assert from 'node:assert/strict'
import { it } from 'vitest'
import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'

it('fixture chooser uses the production IPC and restores the native dialog after success or failure', async () => {
  const original = async () => ({ canceled: true, filePaths: [] })
  const dialog = { showOpenDialog: original }
  const app = { evaluate: (callback, argument) => callback({ dialog }, argument) }
  const calls = []
  const previousWindow = globalThis.window
  globalThis.window = { aiNovelAPI: { invoke: async (channel, purpose) => {
    calls.push([channel, purpose, await dialog.showOpenDialog()])
    return { grantId: 'issued-by-chooser', displayName: 'projects' }
  } } }
  const page = { evaluate: (callback, argument) => callback(argument) }
  try {
    assert.equal((await chooseProjectDirectoryGrant(app, page, 'C:\\projects')).grantId, 'issued-by-chooser')
    assert.deepEqual(calls, [['dialog:select-folder', 'project-create', { canceled: false, filePaths: ['C:\\projects'] }]])
    assert.equal(dialog.showOpenDialog, original)
    globalThis.window.aiNovelAPI.invoke = async () => { throw new Error('chooser failed') }
    await assert.rejects(chooseProjectDirectoryGrant(app, page, 'C:\\projects'), /chooser failed/)
    assert.equal(dialog.showOpenDialog, original)
  } finally {
    globalThis.window = previousWindow
  }
})

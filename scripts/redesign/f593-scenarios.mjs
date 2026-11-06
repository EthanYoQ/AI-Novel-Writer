// #593 实机场景：知识库「导入创作资料」选中一个不是 UTF-8 的文本文件，提示说编码和办法，不说授权。
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'

import * as refs from './pages/refs.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'

const GBK_TEXT = Buffer.from([0xc1, 0xd6, 0xe1, 0xb0, 0xa3, 0xba, 0xbe, 0xc9, 0xb8, 0xdb])

export const F593_SCENARIOS = {
  'f593-kb-invalid-text': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page, roots }) => {
    const file = path.join(roots.temp, '旧港笔记.txt')
    fs.writeFileSync(file, GBK_TEXT)
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
    }, file)
    await refs.open(page, 'knowledge')
    await refs.materials(page).getByRole('button', { name: '导入创作资料' }).click()
    const toast = stage.toastStack(page).locator(stage.LIVE_TOAST).filter({ hasText: '发生错误' }).last()
    await toast.waitFor({ state: 'visible', timeout: 15_000 })
    const shown = (await toast.innerText()).trim()
    assert.match(shown, /另存为 UTF-8 后重新导入/u, '提示给出另存为 UTF-8 的办法')
    assert.doesNotMatch(shown, /授权|SECURE_FS/u, '提示不说授权，也不露原码')
    return { toast: shown }
  } },
}

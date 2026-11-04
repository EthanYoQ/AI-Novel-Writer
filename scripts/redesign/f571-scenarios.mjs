// #571 实机场景：作品所在的磁盘建不了硬链接时，定稿后处理的「导入知识库」给出可读说明；换到支持的磁盘后重试能完成。
import assert from 'node:assert/strict'

import * as chapterView from './pages/chapter-view.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { openChapter } from './f491-scenarios.mjs'

const RETRY_BUTTONS = /^(重试|重试失败步骤|Retry|Retry failed steps)$/u
const KB_IMPORT = '导入知识库'
const region = (page, locale) => page.getByRole('region', { name: locale === 'en-US' ? 'Post-finalization steps' : '定稿后处理' })
const kbRow = (page, locale) => region(page, locale).locator('li').filter({ has: page.locator('b', { hasText: new RegExp(`^${KB_IMPORT}$`, 'u') }) })

/**
 * 替身：主进程里只让知识库的硬链接探测失败，模拟 exFAT 卷上建不了硬链接（Windows 报 ERROR_INVALID_FUNCTION）。
 * LanceDB 的原生提交不经过 Node 的 fs，本场景碰不到它；真实 exFAT 卷上 LanceDB 提交失败的证据见 #571 的源码链。
 */
async function volumeWithoutHardLinks(app, enabled) {
  assert.ok(await app.evaluate((_electron, on) => {
    const fs = globalThis.process.getBuiltinModule('node:fs')
    globalThis.__f571 ??= { linkSync: fs.linkSync, probes: 0 }
    const state = globalThis.__f571
    fs.linkSync = on
      ? (existing, target) => {
          if (!String(target).includes('.link-probe-')) return state.linkSync(existing, target)
          state.probes += 1
          throw Object.assign(new Error('EISDIR: illegal operation on a directory, link'), { code: 'EISDIR', errno: -4068 })
        }
      : state.linkSync
    return true
  }, enabled), '能在主进程里替换 fs.linkSync')
}

async function probes(app) {
  const handle = await app.evaluateHandle(() => globalThis.__f571.probes)
  try { return await handle.jsonValue() } finally { await handle.dispose() }
}

/** 卡上列出了导入知识库，每一步都已成功或失败，且没有进行中的运行。 */
const settled = (page, locale) => page.waitForFunction(({ label, name }) => {
  const rows = [...document.querySelectorAll(`[aria-label="${name}"] li`)]
  return rows.some(row => row.querySelector('b')?.textContent === label)
    && rows.every(row => ['success', 'failed', 'retired'].includes(row.dataset.state))
    && !document.querySelector('.stage-capsule:not([data-tone="ok"])')
}, { label: KB_IMPORT, name: locale === 'en-US' ? 'Post-finalization steps' : '定稿后处理' }, { timeout: 90_000 })

async function readCard(page, locale) {
  await settled(page, locale)
  const row = kbRow(page, locale)
  return {
    state: await row.getAttribute('data-state'),
    detail: await row.locator('.stage-ch-post-detail').innerText(),
    rowRetry: await row.getByRole('button', { name: RETRY_BUTTONS }).count(),
    cardRetry: await region(page, locale).locator('.stage-ch-post-head').getByRole('button', { name: RETRY_BUTTONS }).count(),
    count: await region(page, locale).locator('h2 small').innerText(),
  }
}

async function switchToEnglish(page) {
  await stage.openSettings(page)
  await stage.showSettingsPage(page, '外观')
  await page.getByLabel('界面语言').selectOption('en-US')
  await page.keyboard.press('Escape')
  await page.getByRole('navigation', { name: 'Settings sections' }).waitFor({ state: 'detached' })
}

const RAW = /LanceError|os error|KNOWLEDGE_BASE|Error invoking/u

export const F571_SCENARIOS = {
  'f571-volume-unsupported': { model: true, shell: 'stage', setup: seedStageSample, run: async context => {
    const { app, page } = context
    let failed, probesAfterFinalize, retriedOnSameVolume, english
    await volumeWithoutHardLinks(app, true)
    try {
      await openChapter(page, 3)
      await chapterView.finalize(page, 3)
      failed = await readCard(page, 'zh-CN')
      await context.shoot('f571-volume-unsupported-zh')
      probesAfterFinalize = await probes(app)

      await region(page, 'zh-CN').locator('.stage-ch-post-head').getByRole('button', { name: '重试失败步骤' }).click()
      for (const deadline = Date.now() + 60_000; await probes(app) === probesAfterFinalize; await page.waitForTimeout(100)) {
        assert.ok(Date.now() < deadline, '60 秒内「重试失败步骤」没有再导入知识库')
      }
      retriedOnSameVolume = await readCard(page, 'zh-CN')

      await switchToEnglish(page)
      english = await readCard(page, 'en-US')
      await context.shoot('f571-volume-unsupported-en')
    } finally {
      await volumeWithoutHardLinks(app, false)
    }
    await kbRow(page, 'en-US').getByRole('button', { name: 'Retry', exact: true }).click()
    await page.waitForFunction(label => [...document.querySelectorAll('[aria-label="Post-finalization steps"] li')]
      .some(row => row.querySelector('b')?.textContent === label && row.dataset.state === 'success'), KB_IMPORT, { timeout: 90_000 })
    const movedToSupportedVolume = await readCard(page, 'en-US')
    await context.shoot('f571-volume-unsupported-retried')

    assert.equal(probesAfterFinalize > 0, true, '定稿后处理在主进程里跑了硬链接探测')
    for (const card of [failed, retriedOnSameVolume]) {
      assert.equal(card.state, 'failed', JSON.stringify(card))
      assert.match(card.detail, /^正文定稿已保存，但没能收进知识库.*exFAT.*NTFS.*APFS.*「重试」。$/u, JSON.stringify(card))
      assert.doesNotMatch(card.detail, RAW, '不显示原始错误')
      assert.deepEqual({ rowRetry: card.rowRetry, cardRetry: card.cardRetry }, { rowRetry: 1, cardRetry: 1 }, '换盘后还要能重试')
    }
    assert.equal(retriedOnSameVolume.detail, failed.detail, '在同一块盘上重试，说明不变')
    assert.equal(english.state, 'failed')
    assert.deepEqual({ rowRetry: english.rowRetry, cardRetry: english.cardRetry }, { rowRetry: 1, cardRetry: 1 }, '英文界面同样能重试')
    assert.match(english.detail, /^The finalized chapter text is saved.*exFAT.*NTFS.*APFS.*select Retry\.$/u, JSON.stringify(english))
    assert.doesNotMatch(english.detail, RAW)
    assert.doesNotMatch(english.detail, /\p{Script=Han}/u, '英文说明不带汉字')
    assert.equal(movedToSupportedVolume.state, 'success', JSON.stringify(movedToSupportedVolume))
    assert.equal(movedToSupportedVolume.cardRetry, 0, '都完成后不再摆「重试失败步骤」')
    assert.equal(movedToSupportedVolume.count, '4 / 4 done', '换盘后各步都完成')
    return { failed, retriedOnSameVolume, english, movedToSupportedVolume, probesAfterFinalize, probesTotal: await probes(app) }
  } },
}

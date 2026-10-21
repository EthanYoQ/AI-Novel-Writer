// 运行面板。旧外壳里是右侧「AI 输出」，与写作助手共用 .writer-ai-panel。
import { waitForCompletionToast } from './shell.mjs'

const PANEL = '.writer-ai-panel'

const panel = page => page.locator(PANEL)

export async function open(page) {
  const header = panel(page).getByText('AI 输出', { exact: true })
  if (!await header.isVisible()) await page.getByRole('button', { name: 'AI 输出', exact: true }).click()
  await header.waitFor({ state: 'visible' })
}

export async function waitForPersistedRun(page, label) {
  await panel(page).getByRole('region', { name: '持久正文候选' }).getByText(label, { exact: true }).waitFor({ state: 'visible' })
}

export async function waitForWorkflowDone(page) {
  await panel(page).getByText('整个工作流已全部完成', { exact: true }).waitFor({ state: 'visible', timeout: 90_000 })
  await waitForCompletionToast(page)
}

/** 在渲染进程里计时：从点击名为 buttonName 的按钮到运行面板标题可见，单位毫秒，帧粒度。超过 deadlineMs 未出现即失败。 */
export async function msFromClickToOpen(page, buttonName, trigger, deadlineMs = 30_000) {
  const header = panel(page).getByText('AI 输出', { exact: true })
  if (await header.isVisible()) throw new Error('运行面板在计时前已经可见')
  await page.evaluate(({ selector, buttonName, deadlineMs }) => {
    let clickedAt = null
    const onClick = event => {
      if (event.target instanceof Element && event.target.closest('button')?.textContent?.trim() === buttonName) clickedAt = performance.now()
    }
    document.addEventListener('click', onClick, { capture: true })
    const opened = () => [...document.querySelectorAll(`${selector} *`)]
      .some(node => node.childElementCount === 0 && node.textContent === 'AI 输出' && node.getClientRects().length > 0)
    window.__driveOpenLatency = new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error(`运行面板在 ${deadlineMs} ms 内未出现`)), deadlineMs)
      const tick = () => {
        if (clickedAt !== null && opened()) {
          document.removeEventListener('click', onClick, { capture: true })
          resolve(Math.round(performance.now() - clickedAt))
        } else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, { selector: PANEL, buttonName, deadlineMs })
  await trigger()
  return page.evaluate(() => window.__driveOpenLatency)
}

/** AI 输出里列出的步骤名与最后一段正文。 */
export async function summary(page) {
  return {
    steps: await panel(page).locator('.truncate.flex-1').allInnerTexts(),
    output: (await panel(page).locator('.assistant-content').last().innerText()).trim(),
  }
}

export const isOpen = page => panel(page).getByText('AI 输出', { exact: true }).isVisible()

export async function waitUntilOpen(page) {
  await panel(page).getByText('AI 输出', { exact: true }).waitFor({ state: 'visible' })
}

export async function waitUntilClosed(page) {
  await panel(page).getByText('AI 输出', { exact: true }).waitFor({ state: 'hidden' })
}

export async function openFromCompletionToast(page) {
  await page.getByRole('button', { name: '打开查看', exact: true }).first().click()
}

const CAPSULE = '.ai-task-capsule'

export async function openFromStatusCapsule(page) {
  await page.locator(CAPSULE).first().click()
}

/** 取消底部任务面板里所有仍在运行的任务，等到状态栏胶囊消失，退出时不必强杀。 */
export async function cancelActiveRuns(page) {
  const CANCEL = '#writer-bottom button[title="取消任务"]'
  for (let remaining = await page.locator(CANCEL).count(); remaining > 0; remaining = await page.locator(CANCEL).count()) {
    await page.locator(CANCEL).first().click()
    await page.waitForFunction(([selector, before]) => document.querySelectorAll(selector).length < before, [CANCEL, remaining])
  }
  await waitForStatusCapsuleGone(page)
}

export async function waitForStatusCapsuleGone(page) {
  await page.locator(CAPSULE).first().waitFor({ state: 'detached', timeout: 30_000 })
}

export async function waitForStatusCapsule(page) {
  await page.locator(CAPSULE).first().waitFor({ state: 'visible' })
}

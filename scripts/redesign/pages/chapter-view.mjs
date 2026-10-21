// 新外壳的正文单章视图（RD-8）：章节头、动作条、版本切换器、审稿侧页、修稿合并、定稿视图。选择器用角色与可访问名称，正文沿用 CodeMirror 的 .cm-content。
import * as stage from './stage.mjs'

export const view = page => stage.root(page).locator('.stage-ch')
export const prose = page => view(page).locator('.stage-ch-prose .cm-content')
export const title = page => view(page).getByRole('heading', { level: 1 })
export const versionButton = page => view(page).getByRole('button', { name: /^本章版本：/ })
export const lifecycleCurrent = page => view(page).locator('.pi-life [aria-current="step"]')
export const reviewSheet = page => page.getByRole('complementary', { name: '审稿报告' })
export const merge = page => page.getByRole('region', { name: '修稿合并' })
export const postProcess = page => page.getByRole('region', { name: '定稿后处理' })
export const finalizeDialog = (page, chapterNumber) => page.getByRole('dialog', { name: `定稿第 ${chapterNumber} 章？` })
export const hint = page => view(page).locator('.stage-ch-hint')

/** 动作条上的主按钮：纸墨主按钮里第一个（拆分按钮的箭头排在它后面）。 */
export const primary = page => view(page).locator('.stage-ch-actions .pi-btn--primary').first()

/** 打开这一章：流程脊章节列表里点它，等单章视图出现。 */
export async function open(page, chapterNumber) {
  await stage.chapterButton(page, chapterNumber).click()
  await view(page).waitFor({ state: 'visible' })
}

export async function more(page, item) {
  await view(page).getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('menuitem', { name: item }).click()
}

export async function versions(page) {
  await versionButton(page).click()
  const items = await page.getByRole('menu', { name: '本章版本' }).getByRole('menuitemradio').allInnerTexts()
  await page.keyboard.press('Escape')
  return items.map(item => item.split('\n')[0])
}

/** AI 审稿并等审稿侧页展开（侧页与「按 N 项意见修稿」只在审稿写回后出现）。 */
export async function review(page) {
  await view(page).getByRole('button', { name: 'AI 审稿', exact: true }).click()
  await reviewSheet(page).waitFor({ state: 'visible', timeout: 60_000 })
}

export const reviseButton = page => view(page).getByRole('button', { name: /^按 \d+ 项意见修稿$/ })

/** 定稿：已修稿时点主按钮，否则从「更多」里点；untilReadOnly 为 false 时不等只读（定稿后会跳到别的页面时）。 */
export async function finalize(page, chapterNumber, { untilReadOnly = true } = {}) {
  const button = view(page).getByRole('button', { name: '定稿', exact: true })
  if (await button.count() > 0) await button.click()
  else await more(page, '定稿…')
  await finalizeDialog(page, chapterNumber).getByRole('button', { name: '确认定稿', exact: true }).click()
  if (untilReadOnly) await view(page).getByText('已定稿，只读', { exact: true }).waitFor({ state: 'visible', timeout: 60_000 })
}

/** 后处理各步的名字与状态（success / pending / failed）。 */
export async function postProcessSteps(page) {
  return postProcess(page).locator('li').evaluateAll(rows => rows.map(row => ({ label: row.querySelector('b')?.textContent, state: row.dataset.state })))
}

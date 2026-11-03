// 新外壳的运行侧页（RD-4 起）。选择器用角色与可访问名称；实时输出框沿用类名 .run-output。
import { waitForCompletionToast } from './shell.mjs'

/** 实时输出的正文：新外壳在运行侧页的输出框，旧外壳与 RD-3 的过渡侧页在 AI 输出里。 */
export const OUTPUT_TEXT = '.run-output .assistant-content, .writer-ai-panel .assistant-content'

export const sheet = page => page.getByRole('complementary', { name: /^(运行|Run)$/ })
export const tab = (page, name) => sheet(page).getByRole('tab', { name, exact: true })
export const anyCard = page => sheet(page).getByRole('article')
export const lastRun = page => anyCard(page).filter({ hasText: /^(上一次运行|Last run)/ })
export const output = page => sheet(page).locator('.run-output')
export const recovery = page => sheet(page).getByRole('region', { name: /^(可恢复的内容|Recoverable work)$/ })

export async function waitUntilOpen(page) {
  await sheet(page).waitFor({ state: 'visible' })
}

/** 用 Ctrl K 的「运行侧页」打开；侧页已开着时不动。 */
export async function openFromPalette(page) {
  if (await sheet(page).isVisible()) return
  await page.keyboard.press('Control+K')
  const input = page.getByRole('dialog', { name: '搜索与跳转' }).getByRole('combobox')
  await input.waitFor({ state: 'visible' })
  await input.fill('运行侧页')
  await page.keyboard.press('Enter')
  await waitUntilOpen(page)
}

/** 没有进行中的运行、上一次运行已完成。侧页在运行开始时自动展开，作者没关它就一直在。 */
export async function waitForRunDone(page, timeout = 90_000) {
  await lastRun(page).getByText(/已完成|Complete/).waitFor({ state: 'visible', timeout })
  await waitForCompletionToast(page)
}

/** 进行中分页里运行卡片的标题。 */
export async function activeTitles(page) {
  return sheet(page).getByRole('article').evaluateAll(cards => cards
    .filter(card => !card.textContent?.startsWith('上一次运行') && !card.textContent?.startsWith('可恢复'))
    .map(card => card.querySelector('h3')?.textContent ?? ''))
}

/**
 * 侧页里所有可见文字与无障碍名称，用来查有没有实现术语或聊天字样。
 * withoutLogLines 时不算日志行的原文：日志逐字记录工作流步骤写下的内容，属于排查用的原始记录。
 */
export function visibleWords(page, { withoutLogLines = false } = {}) {
  return sheet(page).evaluate((node, skip) => {
    const copy = node.cloneNode(true)
    if (skip) copy.querySelectorAll('.run-log-message').forEach(line => line.remove())
    document.body.append(copy)
    try {
      return [copy.innerText, ...[...copy.querySelectorAll('[aria-label],[title]')]
        .map(element => `${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''}`)].join('\n')
    } finally { copy.remove() }
  }, withoutLogLines)
}

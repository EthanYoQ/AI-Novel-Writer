// 单章流程：写作、审稿、修稿合并、定稿。
export const EDITOR = '.writer-editor-content .cm-content'

export const editor = page => page.locator(EDITOR)

async function startWriting(page, targetWords) {
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: '开始创作' }) })
  await dialog.getByPlaceholder('3000').fill(String(targetWords))
  await dialog.getByRole('button', { name: '开始创作' }).click()
}

export async function writeThisChapter(page, targetWords) {
  await page.getByRole('button', { name: '写作此章' }).click()
  await startWriting(page, targetWords)
}

export async function writeNextChapter(page, targetWords) {
  await page.getByRole('button', { name: /^写作第\d+章$/ }).click()
  await startWriting(page, targetWords)
}

export async function review(page) {
  await page.getByRole('button', { name: 'AI 审稿', exact: true }).click()
  await page.getByRole('heading', { name: 'AI 审稿确认' }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '确认执行', exact: true }).click()
  await page.getByText('人工确认修稿清单', { exact: true }).waitFor({ state: 'visible', timeout: 60_000 })
}

export async function reviseFromReview(page, modelId) {
  await page.getByRole('button', { name: '确认审稿清单', exact: true }).click()
  await page.getByRole('button', { name: '按确认意见修稿', exact: true }).click()
  await page.getByLabel('本次修稿模型').selectOption(modelId)
  await page.getByRole('button', { name: '开始修稿', exact: true }).click()
}

export const mergeDialog = page => page.getByRole('dialog', { name: /^修稿合并/ })

export async function completeMerge(page) {
  const dialog = mergeDialog(page)
  await dialog.getByRole('button', { name: '全部修稿' }).click()
  await dialog.getByRole('button', { name: '完成合并' }).click()
  await dialog.waitFor({ state: 'hidden' })
}

export async function finalize(page, chapterNumber) {
  await page.getByRole('button', { name: '定稿', exact: true }).click()
  await page.getByRole('dialog').filter({ hasText: `确定要将第 ${chapterNumber} 章定稿吗？` })
    .getByRole('button', { name: '确认定稿', exact: true }).click()
  await page.getByText('已定稿（只读）', { exact: true }).waitFor({ state: 'visible', timeout: 60_000 })
}

export async function startBatch(page, modelId, targetWords, chapterCount = 1) {
  await page.getByRole('button', { name: '批量创作' }).click()
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: '启动批量创作' }) })
  await dialog.locator('#batch-chapter-count').fill(String(chapterCount))
  await dialog.locator('#batch-chapter-words-target').fill(String(targetWords))
  await dialog.locator('#batch-writing-model').selectOption(modelId)
  await dialog.getByRole('button', { name: '启动批量创作' }).click()
}

/** 正文编辑器（两种外壳都行）每一行的文字与首行缩进的计算值。 */
export const lineIndents = editorContent => editorContent.locator('.cm-line').evaluateAll(lines => lines.map(line => [line.textContent, getComputedStyle(line).textIndent]))

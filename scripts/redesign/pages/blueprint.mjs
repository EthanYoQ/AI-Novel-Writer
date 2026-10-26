// 新外壳的蓝图阶段与写作此章弹层（RD-7）。选择器用角色与可访问名称。
import * as stage from './stage.mjs'
import * as runSheet from './run-sheet.mjs'

export const plan = page => page.getByRole('complementary', { name: '章节规划' })
export const planItem = (page, number) => plan(page).getByRole('button', { name: new RegExp(`^${number}\\D`) })
export const card = page => page.getByRole('region', { name: /^第 \d+ 章蓝图$/ })
export const titleInput = page => card(page).getByRole('textbox', { name: '章节标题' })
export const writeButton = page => page.getByRole('button', { name: /^写第 \d+ 章$/ })
export const writeOptions = page => page.getByRole('button', { name: '本次写作选项' })
export const popover = page => page.getByRole('dialog', { name: '本次写作选项' })
export const preflight = page => popover(page).getByRole('region', { name: '一致性预检' })
export const emptyHeading = page => page.getByRole('heading', { name: '还没有章节蓝图' })

/** 从流程脊进入蓝图阶段，等章节规划或空状态出现。 */
export async function open(page) {
  await stage.stageButton(page, '蓝图').click()
  await plan(page).or(emptyHeading(page)).waitFor({ state: 'visible' })
}

/** 主按钮直接按蓝图开始写，不弹表单。 */
export async function writeNext(page) {
  await writeButton(page).click()
}

export async function openWriteOptions(page) {
  await writeOptions(page).click()
  await popover(page).waitFor({ state: 'visible' })
}

export async function pageMenu(page, item) {
  await page.getByRole('button', { name: '更多蓝图操作' }).click()
  await page.getByRole('menuitem', { name: item }).click()
}

export const confirmDialog = (page, title) => page.getByRole('dialog', { name: title })

export const generateDialog = page => page.getByRole('dialog', { name: 'AI 生成蓝图' })
export const batchDialog = page => page.getByRole('dialog', { name: '批量创作' })

/** 打开 AI 生成蓝图；existing 为 'append' 或 'full'（覆盖），只在已有蓝图时出现。 */
export async function openGenerate(page) {
  await page.getByRole('button', { name: 'AI 生成蓝图' }).click()
  await generateDialog(page).getByRole('button', { name: '开始生成', disabled: false }).waitFor({ state: 'visible' })
}

/**
 * 生成第 from～to 章蓝图（指定范围，保留已有），返回是否经过「架构还不完整」。
 * 运行开始时运行侧页自动展开，以它为「生成已开始」；侧页先开着就分不出来，所以要求调用前收起。
 */
export async function generateRange(page, from, to) {
  if (await runSheet.sheet(page).isVisible()) throw new Error('generateRange 要求运行侧页先收起，否则分不出生成是否已开始')
  await openGenerate(page)
  const dialog = generateDialog(page)
  await dialog.getByLabel('蓝图起始章').fill(String(from))
  await dialog.getByLabel('蓝图结束章').fill(String(to))
  await dialog.getByRole('button', { name: '开始生成' }).click()
  return continuePastArchitectureWarning(page)
}

export async function continuePastArchitectureWarning(page) {
  // 生成对话框收起后警告才出现；先等它收起，否则「对话框或警告」会先命中还在卸载的对话框。
  await generateDialog(page).waitFor({ state: 'hidden' })
  const warning = page.getByRole('dialog', { name: '架构还不完整' })
  await warning.or(runSheet.sheet(page)).first().waitFor({ state: 'visible', timeout: 60_000 })
  if (!await warning.isVisible()) return false
  await warning.getByRole('button', { name: '继续生成' }).click()
  return true
}

/** 批量创作 count 章，模型用默认，写完留作草稿。 */
export async function startBatch(page, count) {
  await page.getByRole('button', { name: '批量创作' }).click()
  const dialog = batchDialog(page)
  await dialog.getByLabel(/写几章/).fill(String(count))
  await dialog.getByRole('button', { name: `开始写 ${count} 章` }).click()
}

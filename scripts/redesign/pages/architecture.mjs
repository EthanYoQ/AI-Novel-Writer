// 新外壳的架构阶段与角色名单（RD-6 起）。选择器用角色与可访问名称；分节卡按 data-section 区分四节。
import { root, spine } from './stage.mjs'

export const SECTION_NAMES = { premise: '故事前提', characters: '角色名单', worldbuilding: '世界观', synopsis: '情节大纲' }

export const page = page => root(page).locator('.arch-page')
export const section = (page, key) => root(page).getByRole('region', { name: SECTION_NAMES[key], exact: true })
export const badge = (page, key) => section(page, key).locator('.arch-badge')
export const summary = (page, key) => section(page, key).locator('.arch-section-summary')
export const primary = page => root(page).locator('.arch-header .pi-btn--primary')
export const next = page => root(page).locator('.arch-header').getByRole('button', { name: /^下一步：章节蓝图/ })
export const dialog = page => page.getByRole('dialog', { name: '生成架构' })
export const mark = (page, key) => dialog(page).locator(`[data-step="${key}"] .arch-mark`)
/** 勾选框是视觉隐藏的原生 checkbox，点它所在的 label。 */
export const stepCheck = (page, key) => dialog(page).locator(`[data-step="${key}"] label.pi-check`)
const stepBox = (page, key) => dialog(page).locator(`[data-step="${key}"] input[type="checkbox"]`)
export const castRoster = page => root(page).getByRole('complementary', { name: '角色名单' })
export const castRow = (page, name) => castRoster(page).getByRole('button', { name: new RegExp(`^${name}`) })
export const profileName = page => root(page).locator('.cast-profile-name')

/** 从流程脊进入架构阶段，等四节与角色名单都读完。 */
export async function open(page) {
  await spine(page).getByRole('button', { name: /^架构/ }).click()
  await waitReady(page)
}

export async function waitReady(page) {
  await root(page).locator('.arch-page:not([data-loading]):not([data-cast-loading])').waitFor({ state: 'visible', timeout: 20_000 })
  await root(page).locator('.arch-section').nth(3).waitFor({ state: 'visible' })
}

export async function openSectionMenu(page, key) {
  await section(page, key).getByRole('button', { name: `「${SECTION_NAMES[key]}」的更多操作` }).click()
}

/** 在生成架构对话框里把勾选改成只有 keys 这几节。 */
export async function selectOnly(page, keys) {
  for (const key of Object.keys(SECTION_NAMES)) {
    if (await stepBox(page, key).isChecked() !== keys.includes(key)) await stepCheck(page, key).click()
  }
}

export async function setRange(page, from, to) {
  await dialog(page).getByRole('spinbutton', { name: '本次生成范围的起始章' }).fill(String(from))
  await dialog(page).getByRole('spinbutton', { name: '本次生成范围的结束章' }).fill(String(to))
}

export async function startGenerate(page) {
  await dialog(page).getByRole('button', { name: /^开始生成 \d+ 项$/ }).click()
  await dialog(page).waitFor({ state: 'hidden' })
}

/** 打开角色名单页：从架构阶段的「角色名单」一节进入。 */
export async function openCast(page) {
  await section(page, 'characters').getByRole('button', { name: '打开角色名单' }).click()
  await castRoster(page).waitFor({ state: 'visible' })
}

// 新外壳的作品资料页：剧情与伏笔、知识库、版本历史（RD-9）。选择器用角色与可访问名称。
import { spine } from './stage.mjs'

export const PAGES = { plot: '剧情与伏笔', knowledge: '知识库', history: '版本历史' }

export async function open(page, name) {
  await spine(page).getByRole('button', { name: PAGES[name], exact: true }).click()
}

export const resourceButton = (page, name) => spine(page).getByRole('button', { name: PAGES[name], exact: true })

/* 剧情与伏笔 */
export const plotTable = page => page.getByRole('table', { name: '剧情树' })
export const plotView = (page, name) => page.getByRole('group', { name: '剧情与伏笔的视图' }).getByRole('button', { name, exact: true })
export const plotMore = page => page.getByRole('button', { name: '剧情树的更多操作' })
export const threadMore = (page, title) => page.getByRole('button', { name: `「${title}」的更多操作` })
export const menuItem = (page, name) => page.getByRole('menuitem', { name, exact: true })
export const threadRoute = (page, title) => page.getByRole('listitem').filter({ hasText: title }).getByRole('list', { name: '线索路线' })

export async function routeStates(page, title) {
  return threadRoute(page, title).locator('li').evaluateAll(stops => stops.map(stop => stop.dataset.state))
}

export async function buildPlotTree(page) {
  const empty = page.getByRole('button', { name: /^(生成|刷新)剧情树$/ })
  await empty.first().click()
  await plotTable(page).waitFor({ state: 'visible', timeout: 60_000 })
}

/** 剧情树里每条轨道的类别、名称与各事件（章、是否已发生、摘要），按页内顺序。 */
export function plotLanes(page) {
  return plotTable(page).locator('tbody tr').evaluateAll(rows => rows.map(row => ({
    lane: row.querySelector('th')?.textContent ?? '',
    events: [...row.querySelectorAll('button')].map(button => `${button.dataset.state}:${button.textContent}`),
  })))
}

/* 知识库 */
export const materials = page => page.getByRole('navigation', { name: '资料' })
export const materialButton = (page, name) => materials(page).getByRole('button', { name })
export const copyEditor = page => page.getByRole('textbox', { name: '项目副本内容' })
export const searchInput = page => page.getByRole('textbox', { name: '查找内容' })
export const results = page => page.getByRole('list', { name: '查找结果' })

export async function search(page, query) {
  await searchInput(page).fill(query)
  await searchInput(page).press('Enter')
  await results(page).locator('mark').first().waitFor({ state: 'visible' })
}

/* 版本历史 */
export const historyChapters = page => page.getByRole('navigation', { name: '章节' })
export const timeline = page => page.getByRole('list', { name: '版本时间线' })
export const versionButton = (page, name) => timeline(page).getByRole('button', { name: new RegExp(`^${name}`) })
export const comparison = page => page.getByRole('region', { name: '对比' })
export const diffPage = page => page.getByRole('article', { name: '与当前稿的差异' })

export async function versionNames(page) {
  return timeline(page).locator('.stage-hist-version-name').evaluateAll(names => names.map(name => name.firstChild?.textContent ?? ''))
}

export const dialog = page => page.getByRole('dialog')

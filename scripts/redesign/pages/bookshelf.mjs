// 书房：新建、打开作品。
import { tree } from './project.mjs'

const SHELF = '.writer-shelf'

/** 旧外壳的对话框叫「新建小说项目」，新外壳书房的叫「新建作品」；两者都是作品名、选择保存位置、创建。 */
export async function createProject(page, name) {
  await page.getByRole('button', { name: '新建作品', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /^(新建小说项目|新建作品)$/ })
  await dialog.getByRole('textbox').first().fill(name)
  await dialog.getByRole('button', { name: '选择', exact: true }).click()
  await dialog.getByRole('button', { name: /^(创建项目|创建作品)$/ }).click()
  await dialog.waitFor({ state: 'hidden' })
}

export async function openProject(page, name) {
  await page.locator(SHELF).getByRole('button', { name: `打开《${name}》` }).click()
  await tree(page).getByText(name, { exact: true }).waitFor({ state: 'visible' })
}

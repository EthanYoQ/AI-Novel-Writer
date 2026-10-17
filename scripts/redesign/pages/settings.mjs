const LEFT_RAIL = '.writer-left-rail'

export async function open(page) {
  await page.locator(LEFT_RAIL).getByRole('button', { name: '设置' }).click()
  await page.getByRole('button', { name: '关闭设置' }).waitFor({ state: 'visible' })
}

export async function close(page) {
  const button = page.getByRole('button', { name: '关闭设置' })
  await button.click()
  await button.waitFor({ state: 'hidden' })
}

export async function waitForSection(page, title) {
  await page.getByRole('heading', { name: title, level: 2, exact: true }).waitFor({ state: 'visible' })
}

export async function showSection(page, name) {
  await page.getByRole('button', { name, exact: true }).click()
  await waitForSection(page, name)
}

/** 设置弹窗当前分区的标题。 */
export function currentSection(page) {
  return page.getByRole('button', { name: '关闭设置' }).locator('xpath=preceding-sibling::div[1]//h2').innerText()
}

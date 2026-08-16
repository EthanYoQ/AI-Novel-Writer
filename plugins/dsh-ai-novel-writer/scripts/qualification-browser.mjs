#!/usr/bin/env node
/** Google Chrome journey over the packed disposable DSH Web profile. */

import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import process from 'node:process'

const [url, sourceRoot, workspaceRoot, screenshotRoot, phase = 'first'] = process.argv.slice(2)
if (url === undefined || sourceRoot === undefined || workspaceRoot === undefined || screenshotRoot === undefined) {
  throw new Error('qualification browser requires URL, source root, workspace root, and screenshot root')
}
if (phase !== 'first' && phase !== 'restart' && phase !== 'reinstall') {
  throw new Error(`unknown qualification browser phase: ${phase}`)
}

const require = createRequire(join(sourceRoot, 'package.json'))
const { chromium } = require('playwright')

async function finishOnboarding(page) {
  const deadline = Date.now() + 30_000
  const continueButton = page.getByRole('button', { name: /^(?:继续|Continue)$/ })
  const laterButton = page.getByRole('button', { name: /^(?:稍后配置|Configure later)$/ })
  let settledReads = 0
  while (Date.now() < deadline) {
    if (await clickWhenActionable(continueButton) || await clickWhenActionable(laterButton)) {
      settledReads = 0
      continue
    }
    settledReads = await page.locator('#root').evaluate(root => !root.inert) ? settledReads + 1 : 0
    if (settledReads >= 5) return
    await page.waitForTimeout(100)
  }
  throw new Error('Harness onboarding did not release the application root')
}

async function clickWhenActionable(button) {
  if (!(await button.isVisible()) || !(await button.isEnabled())) return false
  try {
    await button.click({ timeout: 2_000 })
    return true
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') return false
    throw error
  }
}

async function capture(page, name) {
  const path = join(screenshotRoot, `${phase}-${name}.png`)
  await page.screenshot({ path, fullPage: false })
  return path
}

async function connectWorkspace(page) {
  const workspaceName = basename(workspaceRoot)
  const existing = page.getByRole('treeitem', { name: workspaceName, exact: true })
  if (!(await existing.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: '添加工作区' }).click()
    const dialog = page.getByRole('dialog', { name: '选择工作区目录' })
    await dialog.waitFor({ state: 'visible', timeout: 30_000 })
    await dialog.getByRole('button', { name: '编辑路径' }).click()
    const pathInput = dialog.getByRole('textbox', { name: '编辑路径' })
    await pathInput.fill(workspaceRoot)
    await pathInput.press('Enter')
    await dialog.getByRole('button', { name: '打开', exact: true }).click()
  }
  await existing.click()
  await page.getByRole('button', { name: `在“${workspaceName}”中新建会话` }).click()
}

async function selectNovelPreset(page) {
  const preset = page.getByRole('button', { name: /^(?:标准模式|Standard mode|AI 小说作家)$/ })
  await preset.waitFor({ state: 'visible', timeout: 30_000 })
  if (!/AI 小说作家/.test(await preset.innerText())) {
    await preset.click()
    await page.getByRole('menuitem', { name: /AI 小说作家/ }).click()
  }
  await page.getByRole('button', { name: 'AI 小说作家' }).waitFor({ state: 'visible', timeout: 30_000 })
  await page.locator('textarea:enabled[placeholder="描述你想要构建的内容"]').waitFor({ timeout: 30_000 })
}

async function openWorkbench(page) {
  const trigger = page.getByRole('button', { name: '打开小说工作台' })
  await trigger.waitFor({ state: 'visible', timeout: 60_000 })
  await trigger.click()
  const drawer = page.getByRole('dialog', { name: '小说工作台' })
  await drawer.waitFor({ state: 'visible', timeout: 30_000 })
  return drawer
}

async function ensurePresetInstalled(drawer) {
  const install = drawer.getByRole('button', { name: '安装 AI 小说作家 Preset' })
  const installed = drawer.getByText('Preset 已安装。')
  await Promise.race([
    install.waitFor({ state: 'visible', timeout: 30_000 }),
    installed.waitFor({ state: 'visible', timeout: 30_000 }),
  ])
  if (await install.isVisible().catch(() => false)) await install.click()
  await installed.waitFor({ state: 'visible', timeout: 30_000 })
}

async function allowOnce(page, screenshots, label) {
  const panel = page.locator('[data-approval-key]')
  await panel.waitFor({ state: 'visible', timeout: 60_000 })
  screenshots.push(await capture(page, `${label}-native-approval`))
  await panel.getByRole('button', { name: /^(?:允许一次|Allow once)$/ }).click()
  await panel.waitFor({ state: 'detached', timeout: 60_000 })
}

async function settingsEvidence(page, screenshots) {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置' })
  await settings.getByRole('button', { name: '插件' }).click()
  await settings.getByRole('tab', { name: '插件配置' }).click()
  const card = settings.getByRole('listitem').filter({ hasText: 'AI 小说作家' })
  await card.waitFor({ timeout: 30_000 })
  const text = await card.innerText()
  if (!text.includes('Client 已挂载') || !text.includes('Host 已连接')) {
    throw new Error(`Plugin Configuration card did not prove mount state: ${text}`)
  }
  screenshots.push(await capture(page, 'plugin-configuration'))
  await page.keyboard.press('Escape')
  return text
}

async function initializeProject(page, drawer, screenshots) {
  await drawer.getByRole('textbox', { name: '小说标题' }).fill('潮汐来信')
  await drawer.getByRole('textbox', { name: '类型' }).fill('奇幻悬疑')
  await drawer.getByRole('spinbutton', { name: '计划章数' }).fill('6')
  await drawer.getByRole('spinbutton', { name: '每章目标字数' }).fill('2000')
  await drawer.getByRole('combobox', { name: '创作策略' }).selectOption('consistency-first')
  await drawer.getByRole('button', { name: '预览初始化提案' }).click()
  await drawer.locator('.aiNovelInitializationPreview').waitFor({ timeout: 15_000 })
  screenshots.push(await capture(page, 'initialization-preview'))
  await drawer.getByRole('button', { name: '提交到当前会话' }).click()
  await allowOnce(page, screenshots, 'initialization')
  await drawer.getByRole('heading', { name: '小说资产' }).waitFor({ timeout: 60_000 })
}

async function editStory(page, drawer, screenshots) {
  await drawer.getByRole('button', { name: /故事蓝图/ }).click()
  await drawer.getByRole('textbox', { name: '故事前提' }).fill('退潮后的海床会浮现来自未来的信件。')
  await drawer.getByRole('textbox', { name: '主题（每行一项）' }).fill('记忆\n选择')
  await drawer.getByRole('textbox', { name: '世界设定' }).fill('被永夜潮汐包围的群岛。')
  await drawer.getByRole('textbox', { name: '故事主线' }).fill('林夏循着未来信件寻找失踪者。')
  await drawer.getByRole('textbox', { name: '结局目标' }).fill('林夏决定保留真实记忆并点亮全部灯塔。')
  await drawer.getByRole('textbox', { name: '修改摘要' }).fill('建立故事蓝图')
  await drawer.getByRole('button', { name: '预览修改提案' }).click()
  await drawer.getByRole('region', { name: '即将提交的完整资产文本' }).waitFor({ timeout: 15_000 })
  screenshots.push(await capture(page, 'story-preview'))
  await drawer.getByRole('button', { name: '提交到当前会话' }).click()
  await allowOnce(page, screenshots, 'story')
  await drawer.getByText(/^revision (?!absent$)[0-9a-f]{12}$/).waitFor({ timeout: 60_000 })
  if (await drawer.getByRole('textbox', { name: '修改摘要' }).inputValue() !== '') {
    throw new Error('Story editor did not reconcile to the authoritative saved revision')
  }
  screenshots.push(await capture(page, 'story-saved'))
}

async function measureWorkbench(page, drawer, screenshots) {
  const back = drawer.getByRole('button', { name: '返回小说资产列表' })
  if (await back.isVisible().catch(() => false)) await back.click()
  const frame = page.locator('[class*="frame"]').first()
  const center = page.locator('[class*="centerCol"]').first()
  const drawerBox = await drawer.boundingBox()
  const centerBox = await center.boundingBox()
  if (drawerBox === null || centerBox === null) throw new Error('Workbench geometry is unavailable')
  const oneColumn = await drawer.evaluate(root => ({
    overflow: root.scrollWidth - root.clientWidth,
    background: getComputedStyle(root).backgroundColor,
  }))
  if (drawerBox.width < 399 || drawerBox.width > 441 || centerBox.x + centerBox.width > drawerBox.x + 1 || oneColumn.overflow > 1) {
    throw new Error('Workbench did not preserve the compact non-covering DSH drawer geometry')
  }
  screenshots.push(await capture(page, 'asset-root-wide'))
  await page.setViewportSize({ width: 390, height: 844 })
  const narrowBox = await drawer.boundingBox()
  const narrowOverflow = await drawer.evaluate(root => root.scrollWidth - root.clientWidth)
  if (narrowBox === null || narrowBox.width > 390 || narrowOverflow > 1) {
    throw new Error('Workbench overflowed the narrow Chrome viewport')
  }
  screenshots.push(await capture(page, 'asset-root-narrow'))
  await page.setViewportSize({ width: 1440, height: 900 })
  return {
    viewport: { width: 1440, height: 900 },
    drawerWidth: Math.round(drawerBox.width),
    conversationRight: Math.round(centerBox.x + centerBox.width),
    drawerLeft: Math.round(drawerBox.x),
    framePaddingRight: await frame.evaluate(element => getComputedStyle(element).paddingRight),
    narrowWidth: Math.round(narrowBox.width),
    narrowOverflow,
    oneColumn,
  }
}

await mkdir(screenshotRoot, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
let result
let bodyError
let page
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
  const pageErrors = []
  page.on('pageerror', error => { pageErrors.push(error.message) })
  await page.goto(url, { waitUntil: 'load', timeout: 60_000 })
  await page.locator('#root').waitFor({ state: 'attached', timeout: 30_000 })
  await page.locator('[class*="frame"]').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(1_000)
  await finishOnboarding(page)
  await connectWorkspace(page)
  const screenshots = []
  const pluginCard = await settingsEvidence(page, screenshots)
  let drawer = await openWorkbench(page)
  await ensurePresetInstalled(drawer)
  await drawer.getByRole('button', { name: '关闭小说工作台' }).click()
  await page.reload({ waitUntil: 'load', timeout: 60_000 })
  await page.locator('[class*="frame"]').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(1_000)
  await finishOnboarding(page)
  await connectWorkspace(page)
  await selectNovelPreset(page)
  drawer = await openWorkbench(page)
  if (phase === 'first') {
    await initializeProject(page, drawer, screenshots)
    await editStory(page, drawer, screenshots)
  } else {
    await drawer.getByRole('heading', { name: '小说资产' }).waitFor({ timeout: 30_000 })
    const content = await drawer.innerText()
    if (!content.includes('潮汐来信') || !content.includes('退潮后的海床会浮现来自未来的信件。')) {
      throw new Error('Restarted packed profile did not render the saved project and story blueprint')
    }
    screenshots.push(await capture(page, 'restart-readback'))
  }
  const geometry = await measureWorkbench(page, drawer, screenshots)
  if (pageErrors.length > 0) throw new Error(`browser page errors: ${pageErrors.join(' | ')}`)
  result = { phase, browser: 'Google Chrome', pluginCard, geometry, screenshots }
} catch (error) {
  if (page === undefined) {
    bodyError = error
  } else {
    const failureScreenshot = join(screenshotRoot, `${phase}-failure.png`)
    await page.screenshot({ path: failureScreenshot, fullPage: false }).catch(() => undefined)
    const snapshot = await page.locator('body').ariaSnapshot().catch(() => '<page unavailable>')
    bodyError = new AggregateError([error, new Error(snapshot)], `Browser journey failed; screenshot: ${failureScreenshot}`)
  }
}

let closeError
try {
  await browser.close()
} catch (error) {
  closeError = error
}

if (bodyError !== undefined && closeError !== undefined) {
  throw new AggregateError([bodyError, closeError], 'Browser probe and cleanup both failed')
}
if (bodyError !== undefined) throw bodyError
if (closeError !== undefined) throw closeError
process.stdout.write(`${JSON.stringify(result)}\n`)

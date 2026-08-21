#!/usr/bin/env node
/** Google Chrome journey over the installed V2 sidebar in a disposable DSH Web profile. */

import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import process from 'node:process'

const V2_WORKSPACE_STATE_ENDPOINT = 'workspace/state/read'
const V2_INITIALIZE_ENDPOINT = 'workspace/initialize'
const QUALIFICATION_TOOL_NAMES = ['novel_read', 'novel_propose_change']
const RESULT_FIELDS = ['phase', 'browser', 'pluginCard', 'geometry', 'screenshots']
const QUALIFICATION_PROPOSAL_ENVIRONMENT = 'DSH_NOVEL_QUALIFICATION_PROPOSAL_JSON'
const QUALIFICATION_FINAL_ARTIFACT_ID = 'qualification-chapter-1-draft'
const QUALIFICATION_PARTIAL_STOP_ARTIFACT_ID = 'qualification-invalid-review'
const STATIC_RESULT = {
  kind: 'dsh-ai-novel-v2-browser-journey',
  browser: 'Google Chrome',
  workspaceStateEndpoint: V2_WORKSPACE_STATE_ENDPOINT,
  initializeEndpoint: V2_INITIALIZE_ENDPOINT,
  tools: QUALIFICATION_TOOL_NAMES,
  phases: ['first', 'restart', 'reinstall'],
  output: RESULT_FIELDS,
  proposalEnvironment: QUALIFICATION_PROPOSAL_ENVIRONMENT,
  finalArtifactId: QUALIFICATION_FINAL_ARTIFACT_ID,
  partialStopArtifactId: QUALIFICATION_PARTIAL_STOP_ARTIFACT_ID,
  chapterContext: { chapter: 2, previousFinalArtifactId: QUALIFICATION_FINAL_ARTIFACT_ID },
  requiresHarnessRoot: true,
  directStoreBootstrap: false,
  userAppliesProposal: true,
}

if (process.argv[2] === '--check-static') {
  process.stdout.write(`${JSON.stringify(STATIC_RESULT)}\n`)
  process.exit(0)
}

const [url, sourceRoot, workspaceRoot, screenshotRoot, phase = 'first'] = process.argv.slice(2)
if (url === undefined || sourceRoot === undefined || workspaceRoot === undefined || screenshotRoot === undefined) {
  throw new Error('qualification browser requires URL, source root, workspace root, and screenshot root')
}
if (phase !== 'first' && phase !== 'restart' && phase !== 'reinstall') {
  throw new Error(`unknown qualification browser phase: ${phase}`)
}

/**
 * This journey is only meaningful against the installed Harness Web profile. It deliberately
 * has no fallback that writes a store, registers a module, or imitates a successful browser run.
 */
if (process.env.DSH_HARNESS_ROOT === undefined || process.env.DSH_HARNESS_ROOT === '') {
  process.stdout.write(`${JSON.stringify({
    status: 'skipped',
    reason: 'DSH_HARNESS_ROOT is required for installed-sidebar browser qualification',
    phase,
    browser: 'Google Chrome',
    pluginCard: null,
    geometry: null,
    screenshots: [],
  })}\n`)
  process.exit(0)
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
  const preset = page.getByRole('button', { name: /^(?:标准模式|Standard mode|AI 小说作家 V2)$/ })
  await preset.waitFor({ state: 'visible', timeout: 30_000 })
  if (await preset.innerText() !== 'AI 小说作家 V2') {
    await preset.click()
    await page.getByRole('menuitem', { name: 'AI 小说作家 V2', exact: true }).click()
  }
  await page.getByRole('button', { name: 'AI 小说作家 V2', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
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

function assertPathFreeDrawer(drawer) {
  return drawer.innerText().then(text => {
    if (text.includes(workspaceRoot) || text.includes(sourceRoot)) {
      throw new Error('V2 sidebar exposed a local path during workspace initialization')
    }
  })
}

async function initializeWorkspace(page, drawer, screenshots) {
  await drawer.getByRole('heading', { name: '创建 V2 项目', exact: true }).waitFor({ timeout: 30_000 })
  await drawer.getByRole('textbox', { name: '小说标题' }).fill('潮汐来信')
  await drawer.getByRole('textbox', { name: '语言' }).fill('zh-CN')
  await drawer.getByRole('textbox', { name: '类型' }).fill('奇幻悬疑')
  await drawer.getByRole('spinbutton', { name: '计划章数' }).fill('2')
  await drawer.getByRole('spinbutton', { name: '每章目标字数' }).fill('2000')
  await drawer.getByRole('combobox', { name: '创作策略' }).selectOption('consistency-first')
  await drawer.getByRole('combobox', { name: '结构模式' }).selectOption('three-act')
  await drawer.getByRole('combobox', { name: '叙事视角' }).selectOption('third-limited')
  await drawer.getByRole('textbox', { name: '全局创作提示' }).fill('保持冷峻而温柔的语气。')
  await assertPathFreeDrawer(drawer)
  screenshots.push(await capture(page, 'v2-initialization-form'))
  await drawer.getByRole('button', { name: '创建 V2 项目', exact: true }).click()
  await drawer.getByRole('heading', { name: '项目概览', exact: true }).waitFor({ timeout: 60_000 })
  await drawer.getByText('潮汐来信', { exact: true }).waitFor({ timeout: 30_000 })
  screenshots.push(await capture(page, 'v2-workspace-ready'))
}

function qualificationProposalPrompt() {
  const raw = process.env[QUALIFICATION_PROPOSAL_ENVIRONMENT]
  if (typeof raw !== 'string' || raw === '') {
    throw new Error(`${QUALIFICATION_PROPOSAL_ENVIRONMENT} is required for the V2 user proposal journey`)
  }
  let proposal
  try {
    proposal = JSON.parse(raw)
  } catch {
    throw new Error('DSH_NOVEL_QUALIFICATION_PROPOSAL_JSON must be one complete JSON object')
  }
  if (proposal === null || typeof proposal !== 'object' || Array.isArray(proposal)
    || !Array.isArray(proposal.changes) || proposal.changes.length === 0) {
    throw new Error('DSH_NOVEL_QUALIFICATION_PROPOSAL_JSON must contain a non-empty V2 changes array')
  }
  return `${JSON.stringify(proposal)}\n\n这只是提案。`
}

async function submitProposalThroughSession(page, screenshots) {
  const prompt = qualificationProposalPrompt()
  const composer = page.locator('textarea:enabled[placeholder="描述你想要构建的内容"]')
  await composer.fill(prompt)
  const send = page.getByRole('button', { name: /^(?:发送|Send)$/ })
  await send.waitFor({ state: 'visible', timeout: 30_000 })
  await send.click()
  await page.getByText('提案已记录，等待用户在提案收件箱中审核并应用。', { exact: true }).waitFor({ timeout: 60_000 })
  screenshots.push(await capture(page, 'v2-proposal-submitted'))
}

async function applyProposalAndReadChapterContext(page, drawer, screenshots) {
  await drawer.getByRole('heading', { name: '提案队列', exact: true }).waitFor({ timeout: 60_000 })
  await drawer.getByRole('button', { name: '依序应用未完成项', exact: true }).waitFor({ timeout: 60_000 })
  screenshots.push(await capture(page, 'v2-proposal-preview'))
  await drawer.getByRole('button', { name: '依序应用未完成项', exact: true }).click()
  await drawer.getByText('部分已应用', { exact: true }).waitFor({ timeout: 60_000 })
  await drawer.getByText(new RegExp(QUALIFICATION_PARTIAL_STOP_ARTIFACT_ID)).waitFor({ timeout: 30_000 })
  await drawer.getByRole('button', { name: /第 2 章：/ }).click()
  await drawer.getByRole('heading', { name: '第 2 章蓝图', exact: true }).waitFor({ timeout: 30_000 })
  await drawer.getByText('潮水退去，信件显露。', { exact: true }).waitFor({ timeout: 30_000 })
  screenshots.push(await capture(page, 'v2-partial-final-context'))
}

async function assertRestartReadback(page, drawer, screenshots) {
  await drawer.getByRole('heading', { name: '项目概览', exact: true }).waitFor({ timeout: 30_000 })
  const content = await drawer.innerText()
  for (const required of ['潮汐来信', '部分已应用', QUALIFICATION_FINAL_ARTIFACT_ID, QUALIFICATION_PARTIAL_STOP_ARTIFACT_ID, '已定稿']) {
    if (!content.includes(required)) throw new Error(`Restarted V2 sidebar did not render ${required}`)
  }
  await drawer.getByRole('button', { name: /第 2 章：/ }).click()
  await drawer.getByText('潮水退去，信件显露。', { exact: true }).waitFor({ timeout: 30_000 })
  screenshots.push(await capture(page, 'v2-restart-readback'))
}

async function measureWorkbench(page, drawer, screenshots) {
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
  screenshots.push(await capture(page, 'v2-sidebar-wide'))
  await page.setViewportSize({ width: 390, height: 844 })
  const narrowBox = await drawer.boundingBox()
  const narrowOverflow = await drawer.evaluate(root => root.scrollWidth - root.clientWidth)
  if (narrowBox === null || narrowBox.width > 390 || narrowOverflow > 1) {
    throw new Error('Workbench overflowed the narrow Chrome viewport')
  }
  screenshots.push(await capture(page, 'v2-sidebar-narrow'))
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
    await initializeWorkspace(page, drawer, screenshots)
    await drawer.getByRole('button', { name: '关闭小说工作台' }).click()
    await submitProposalThroughSession(page, screenshots)
    drawer = await openWorkbench(page)
    await applyProposalAndReadChapterContext(page, drawer, screenshots)
  } else {
    await assertRestartReadback(page, drawer, screenshots)
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

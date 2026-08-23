#!/usr/bin/env node
/** Google Chrome journey over the installed V2 sidebar in a disposable DSH Web profile. */

import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import process from 'node:process'

const V2_WORKSPACE_STATE_ENDPOINT = 'workspace/state/read'
const V2_INITIALIZE_ENDPOINT = 'workspace/initialize'
const QUALIFICATION_TOOL_NAMES = ['novel_read', 'novel_propose_change']
const AGENT_PRESET_LIST_ENDPOINT = 'agentPreset.list'
const AGENT_PRESET_LIST_API_PATH = `/api/${AGENT_PRESET_LIST_ENDPOINT}`
const V2_PRESET_ID = 'ai-novel-writer-v2'
const RESULT_FIELDS = ['phase', 'browser', 'pluginCard', 'geometry', 'screenshots']
const QUALIFICATION_PROPOSAL_ENVIRONMENT = 'DSH_NOVEL_QUALIFICATION_PROPOSAL_JSON'
const QUALIFICATION_FINAL_ARTIFACT_ID = 'qualification-chapter-1-draft'
const QUALIFICATION_PARTIAL_STOP_ARTIFACT_ID = 'qualification-invalid-review'
const REVIEW_DISCLOSURE_SELECTOR = 'details[aria-label="审核建议"]'
const PARTIAL_PROPOSAL_RESULT = '部分已应用'
const PROPOSAL_RESULT_TIMEOUT = 60_000
const PROPOSAL_RESULT_RETRY_TIMEOUT = 1_000
const V2_INITIALIZATION_LABEL = /^(?:创建项目|创建 V2 项目)$/
const SEND_MESSAGE_BUTTON_NAME = /^(?:发送(?:消息)?|Send(?: message)?)$/i
const AUTHOR_TECHNICAL_MARKERS = [
  QUALIFICATION_FINAL_ARTIFACT_ID, QUALIFICATION_PARTIAL_STOP_ARTIFACT_ID,
  'artifactId', 'parentArtifactId', 'taskId', 'characterId',
  'baseAggregateRevision', 'baseGlobalRevision', 'globalRevision',
  'Host', '命令差异', '版本链',
]
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
  presetPreflight: { endpoint: AGENT_PRESET_LIST_ENDPOINT, requiredPresetId: V2_PRESET_ID },
}

function agentPresetIds(response) {
  if (response === null || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('agentPreset.list returned an invalid response')
  }
  const result = response.result
  if (result === null || typeof result !== 'object' || Array.isArray(result) || result.ok !== true) {
    throw new Error('agentPreset.list did not return a successful roster response')
  }
  const value = result.value
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.presets)) {
    throw new Error('agentPreset.list returned an invalid preset roster')
  }
  const ids = value.presets.map(preset => {
    if (preset === null || typeof preset !== 'object' || Array.isArray(preset) || typeof preset.id !== 'string') {
      throw new Error('agentPreset.list returned an invalid preset entry')
    }
    return preset.id
  })
  return ids
}

function assertNovelPresetAvailable(response) {
  const presetIds = agentPresetIds(response)
  if (!presetIds.includes(V2_PRESET_ID)) {
    throw new Error(`agentPreset.list did not expose ${V2_PRESET_ID} after preset installation; available: ${presetIds.join(', ') || 'none'}`)
  }
  return { presetId: V2_PRESET_ID, presetIds }
}

if (process.argv[2] === '--check-static') {
  process.stdout.write(`${JSON.stringify(STATIC_RESULT)}\n`)
  process.exit(0)
}

if (process.argv[2] === '--check-agent-preset-response') {
  const raw = process.argv[3]
  if (typeof raw !== 'string' || raw === '') throw new Error('agentPreset.list response JSON is required')
  let response
  try {
    response = JSON.parse(raw)
  } catch {
    throw new Error('agentPreset.list response must be valid JSON')
  }
  process.stdout.write(`${JSON.stringify(assertNovelPresetAvailable(response))}\n`)
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

function isAgentPresetListResponse(response) {
  return response.request().method() === 'POST' && new URL(response.url()).pathname === AGENT_PRESET_LIST_API_PATH
}

async function assertNovelPresetFromApi(response) {
  if (!response.ok()) throw new Error(`agentPreset.list returned HTTP ${response.status()}`)
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new Error('agentPreset.list did not return JSON')
  }
  return assertNovelPresetAvailable(payload)
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

function assertMinimalInitializationDrawer(drawer) {
  return drawer.innerText().then(text => {
    for (const legacyField of ['语言', '创作策略', '结构模式', '叙事视角', '全局创作提示']) {
      if (text.includes(legacyField)) throw new Error(`V2 initialization exposed the retired ${legacyField} field`)
    }
  })
}

function assertAuthorFacingDrawer(drawer) {
  return drawer.innerText().then(text => {
    const marker = AUTHOR_TECHNICAL_MARKERS.find(value => text.includes(value))
    if (marker !== undefined) throw new Error(`V2 author UI exposed technical marker: ${marker}`)
  })
}

async function initializeWorkspace(page, drawer, screenshots) {
  await drawer.getByRole('heading', { name: V2_INITIALIZATION_LABEL }).waitFor({ timeout: 30_000 })
  await drawer.getByRole('textbox', { name: '小说标题' }).fill('潮汐来信')
  await drawer.getByRole('textbox', { name: '类型' }).fill('奇幻悬疑')
  await drawer.getByRole('spinbutton', { name: '计划章数' }).fill('2')
  await drawer.getByRole('spinbutton', { name: '每章目标字数' }).fill('2000')
  await assertPathFreeDrawer(drawer)
  await assertMinimalInitializationDrawer(drawer)
  screenshots.push(await capture(page, 'v2-initialization-form'))
  await drawer.getByRole('button', { name: V2_INITIALIZATION_LABEL }).click()
  await drawer.getByRole('heading', { name: '项目概览', exact: true }).waitFor({ timeout: 60_000 })
  await drawer.getByText('潮汐来信', { exact: true }).waitFor({ timeout: 30_000 })
  await assertAuthorFacingDrawer(drawer)
  screenshots.push(await capture(page, 'v2-workspace-ready'))
}

/** Expand the native V2 review disclosure before interacting with durable Proposal details. */
async function expandProposalReview(drawer, timeout = PROPOSAL_RESULT_TIMEOUT) {
  const review = drawer.locator(REVIEW_DISCLOSURE_SELECTOR)
  await review.waitFor({ state: 'visible', timeout })
  const summary = review.locator('summary')
  await summary.waitFor({ state: 'visible', timeout })
  if (!(await review.evaluate(element => element.open))) await summary.click()
  if (!(await review.evaluate(element => element.open))) {
    throw new Error('V2 proposal review disclosure did not expand')
  }
  return review
}

/**
 * Observe the post-apply status through React remounts without reloading the page.
 * Each retry obtains a new disclosure locator, opens its current instance, and only
 * accepts the status while that same disclosure is open.
 */
async function waitForVisiblePartialProposalResult(drawer) {
  const deadline = Date.now() + PROPOSAL_RESULT_TIMEOUT
  let lastError
  while (Date.now() < deadline) {
    const attemptTimeout = Math.max(1, Math.min(PROPOSAL_RESULT_RETRY_TIMEOUT, deadline - Date.now()))
    try {
      const review = await expandProposalReview(drawer, attemptTimeout)
      await review.getByText(PARTIAL_PROPOSAL_RESULT, { exact: false }).waitFor({ state: 'visible', timeout: attemptTimeout })
      if (await review.evaluate(element => element.open)) return review
      lastError = new Error('V2 proposal review disclosure closed while the partial result rendered')
    } catch (error) {
      lastError = error
    }
  }
  const reason = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`V2 partial Proposal result did not become visible in an open review disclosure${reason}`)
}

/** Scope prior-final assertions to the current chapter's author-facing context panel. */
function chapterContextRegion(drawer, chapter) {
  return drawer.getByRole('region', { name: `第 ${chapter} 章的上一章定稿上下文`, exact: true })
}

/** Verify direct stage navigation preserves an unsent local project edit across another stage. */
async function assertStructuredStageDraftRetention(page, drawer, screenshots) {
  const localTitle = '潮汐来信（本地草稿）'
  await drawer.getByRole('button', { name: '项目设置', exact: true }).click()
  const projectTitle = drawer.getByRole('textbox', { name: '项目设置小说标题', exact: true })
  await projectTitle.waitFor({ state: 'visible', timeout: 30_000 })
  if ((await projectTitle.inputValue()) !== '潮汐来信') {
    throw new Error('Project settings did not prefill the authoritative title after direct stage navigation')
  }
  await drawer.getByRole('button', { name: '让 AI 起草项目设置', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
  await drawer.getByText('人工修改', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
  await projectTitle.fill(localTitle)

  await drawer.getByRole('button', { name: '故事架构', exact: true }).click()
  await drawer.getByRole('heading', { name: '故事架构', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
  await drawer.getByRole('textbox', { name: '故事架构故事前提', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })

  await drawer.getByRole('button', { name: '项目设置', exact: true }).click()
  await projectTitle.waitFor({ state: 'visible', timeout: 30_000 })
  if ((await projectTitle.inputValue()) !== localTitle) {
    throw new Error('Project settings local draft was lost after switching to story architecture and back')
  }
  await assertAuthorFacingDrawer(drawer)
  screenshots.push(await capture(page, 'v2-stage-local-draft-retained'))
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
  const send = page.getByRole('button', { name: SEND_MESSAGE_BUTTON_NAME })
  await send.waitFor({ state: 'visible', timeout: 30_000 })
  await send.click()
  await page.getByText('提案已记录，等待用户在提案收件箱中审核并应用。', { exact: true }).waitFor({ timeout: 60_000 })
  screenshots.push(await capture(page, 'v2-proposal-submitted'))
}

async function applyProposalAndReadChapterContext(page, drawer, screenshots) {
  const review = await expandProposalReview(drawer)
  await review.getByRole('heading', { name: '提案队列', exact: true }).waitFor({ timeout: 60_000 })
  const proposalDetails = review.getByRole('button', { name: /^查看 .*建议$/ }).first()
  await proposalDetails.waitFor({ state: 'visible', timeout: 30_000 })
  await proposalDetails.click()
  await assertAuthorFacingDrawer(drawer)
  await drawer.getByRole('button', { name: '依序应用未完成项', exact: true }).waitFor({ timeout: 60_000 })
  screenshots.push(await capture(page, 'v2-proposal-preview'))
  await drawer.getByRole('button', { name: '依序应用未完成项', exact: true }).click()
  await waitForVisiblePartialProposalResult(drawer)
  await assertAuthorFacingDrawer(drawer)
  await drawer.getByRole('button', { name: /第 2 章：/ }).click()
  const currentStage = drawer.getByRole('region', { name: '当前创作步骤', exact: true })
  await currentStage.getByRole('heading', { name: '第 2 章蓝图', exact: true, level: 3 }).waitFor({ timeout: 30_000 })
  await chapterContextRegion(drawer, 2).getByText('潮水退去，信件显露。', { exact: true }).waitFor({ timeout: 30_000 })
  screenshots.push(await capture(page, 'v2-partial-final-context'))
}

async function assertRestartReadback(page, drawer, screenshots) {
  await drawer.getByRole('heading', { name: '项目概览', exact: true }).waitFor({ timeout: 30_000 })
  await expandProposalReview(drawer)
  const content = await drawer.innerText()
  for (const required of ['潮汐来信', '部分已应用']) {
    if (!content.includes(required)) throw new Error(`Restarted V2 sidebar did not render ${required}`)
  }
  await assertAuthorFacingDrawer(drawer)
  await drawer.getByRole('button', { name: /第 2 章：/ }).click()
  await chapterContextRegion(drawer, 2).getByText('潮水退去，信件显露。', { exact: true }).waitFor({ timeout: 30_000 })
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
  const wideRootOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  if (Math.abs(drawerBox.x - 386) > 1 || Math.abs(drawerBox.width - 1054) > 1
    || centerBox.x + centerBox.width > drawerBox.x + 1 || oneColumn.overflow > 1 || wideRootOverflow > 1) {
    throw new Error('Workbench did not preserve the wide native rail, visible conversation, and unclipped authoring canvas')
  }
  screenshots.push(await capture(page, 'v2-sidebar-wide'))

  await page.setViewportSize({ width: 1360, height: 900 })
  const wideBoundaryBox = await drawer.boundingBox()
  const wideBoundaryOverflow = await drawer.evaluate(root => root.scrollWidth - root.clientWidth)
  const wideBoundaryRootOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  if (wideBoundaryBox === null || Math.abs(wideBoundaryBox.x - 386) > 1 || Math.abs(wideBoundaryBox.width - 974) > 1
    || wideBoundaryOverflow > 1 || wideBoundaryRootOverflow > 1) {
    throw new Error('Workbench did not preserve the focused wide layout at the 1360 px breakpoint')
  }

  await page.setViewportSize({ width: 1280, height: 900 })
  const mediumBox = await drawer.boundingBox()
  const mediumOverflow = await drawer.evaluate(root => root.scrollWidth - root.clientWidth)
  const mediumRootOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  if (mediumBox === null || Math.abs(mediumBox.x - 56) > 1 || Math.abs(mediumBox.width - 1224) > 1
    || mediumOverflow > 1 || mediumRootOverflow > 1) {
    throw new Error('Workbench did not cover the medium main area after the native 56 px rail')
  }
  screenshots.push(await capture(page, 'v2-sidebar-medium'))

  await page.setViewportSize({ width: 1024, height: 900 })
  const mediumBoundaryBox = await drawer.boundingBox()
  const mediumBoundaryOverflow = await drawer.evaluate(root => root.scrollWidth - root.clientWidth)
  const mediumBoundaryRootOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  if (mediumBoundaryBox === null || Math.abs(mediumBoundaryBox.x - 56) > 1 || Math.abs(mediumBoundaryBox.width - 968) > 1
    || mediumBoundaryOverflow > 1 || mediumBoundaryRootOverflow > 1) {
    throw new Error('Workbench did not preserve the rail-first medium layout at the 1024 px breakpoint')
  }

  await page.setViewportSize({ width: 390, height: 844 })
  const narrowBox = await drawer.boundingBox()
  const narrowOverflow = await drawer.evaluate(root => root.scrollWidth - root.clientWidth)
  const narrowRootOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  if (narrowBox === null || Math.abs(narrowBox.x - 56) > 1 || Math.abs(narrowBox.width - 334) > 1
    || narrowOverflow > 1 || narrowRootOverflow > 1) {
    throw new Error('Workbench obscured the narrow native rail or overflowed the one-column viewport')
  }
  screenshots.push(await capture(page, 'v2-sidebar-narrow'))
  await page.setViewportSize({ width: 1440, height: 900 })
  await drawer.getByRole('button', { name: '关闭小说工作台', exact: true }).click()
  await drawer.waitFor({ state: 'detached', timeout: 30_000 })
  if (await frame.evaluate(element => element.classList.contains('aiNovelWorkbenchFrameOpen'))) {
    throw new Error('Workbench close did not restore the Harness frame reservation')
  }
  return {
    viewport: { width: 1440, height: 900 },
    drawerWidth: Math.round(drawerBox.width),
    conversationRight: Math.round(centerBox.x + centerBox.width),
    drawerLeft: Math.round(drawerBox.x),
    framePaddingRight: await frame.evaluate(element => getComputedStyle(element).paddingRight),
    wideRootOverflow,
    wideBoundaryWidth: Math.round(wideBoundaryBox.width),
    wideBoundaryOverflow,
    wideBoundaryRootOverflow,
    mediumWidth: Math.round(mediumBox.width),
    mediumOverflow,
    mediumRootOverflow,
    mediumBoundaryWidth: Math.round(mediumBoundaryBox.width),
    mediumBoundaryOverflow,
    mediumBoundaryRootOverflow,
    narrowWidth: Math.round(narrowBox.width),
    narrowOverflow,
    narrowRootOverflow,
    restored: true,
    oneColumn,
  }
}

await mkdir(screenshotRoot, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
let result
let bodyError
let page
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
  page = await context.newPage()
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
  const agentPresetResponse = page.waitForResponse(isAgentPresetListResponse, { timeout: 30_000 })
  await page.reload({ waitUntil: 'load', timeout: 60_000 })
  await page.locator('[class*="frame"]').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(1_000)
  await finishOnboarding(page)
  await connectWorkspace(page)
  await assertNovelPresetFromApi(await agentPresetResponse)
  await selectNovelPreset(page)
  drawer = await openWorkbench(page)
  if (phase === 'first') {
    await initializeWorkspace(page, drawer, screenshots)
    await assertStructuredStageDraftRetention(page, drawer, screenshots)
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

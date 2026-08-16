#!/usr/bin/env node
/** Real DSH Web browser journey for the compact AI novel workbench. */

import { createRequire } from 'node:module'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

const packageRoot = resolve(import.meta.dirname, '..', '..', '..')

function normalize(snapshot) {
  return snapshot
    .replace(/\[AI_NOVEL_UI_CORRELATION:[0-9a-f-]{36}\]/giu, '[AI_NOVEL_UI_CORRELATION:{{correlationId}}]')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu, '{{projectId}}')
    .replace(/[0-9a-f]{64}/giu, '{{revision}}')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/gu, '{{timestamp}}')
}

function textContent(blocks) {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Run the workbench journey inside a Vitest process configured with DSH source paths.
 *
 * @param {string} harnessRoot Absolute DeepSeek Harness repository root.
 * @returns {Promise<object>} Stable user-visible snapshots and wide-layout geometry.
 */
export async function runWorkbenchBrowserJourney(harnessRoot) {
  const screenshotDir = process.env.DSH_WORKBENCH_SCREENSHOT_DIR
  if (screenshotDir !== undefined) await mkdir(screenshotDir, { recursive: true })
  const workspaceModule = await import(pathToFileURL(join(packageRoot, 'tests', 'test-workspace.ts')).href)
  const overlayRoot = await workspaceModule.makeTestWorkspace('workbench-browser-overlay-')
  const harnessHome = join(overlayRoot, 'harness-home')
  const overlayPath = join(overlayRoot, 'cordis.overlay.yml')
  await writeFile(overlayPath, [
    '- insert:',
    '    - id: ai-novel-writer',
    '      name: \'@ethanyoq/dsh-ai-novel-writer\'',
    '',
  ].join('\n'), 'utf8')
  const cliRequire = createRequire(join(harnessRoot, 'apps', 'cli', 'package.json'))
  const appBootModule = await import(pathToFileURL(cliRequire.resolve('@deepseek-ai/dsh-app-boot')).href)
  appBootModule.healProfilesModuleFallback(join(packageRoot, 'package.json'), harnessHome)
  const scaffoldModule = await import(pathToFileURL(join(harnessRoot, 'apps', 'web', 'tests', 'scaffold.ts')).href)
  const supportModule = await import(pathToFileURL(join(harnessRoot, 'apps', 'web', 'tests', 'support.ts')).href)
  const require = createRequire(join(harnessRoot, 'package.json'))
  const { chromium } = require('playwright')
  let scaffold
  let browser
  let page
  let stopLlmCapture
  const llmRequests = []
  const browserMessages = []
  let bodyError
  let result
  try {
    scaffold = await scaffoldModule.launchWebScaffold({
      extraOverlayPath: overlayPath,
      harnessHome,
      replayFixture: join(packageRoot, 'tests', 'fixtures', 'workbench-browser', 'session.jsonl'),
      agentPresets: {
        roots: [{ path: join(packageRoot, 'presets'), trust: 'user' }],
        default: 'ai-novel-writer',
      },
    })
  stopLlmCapture = scaffold.ctx.on('llm/stream', (options, next) => {
    llmRequests.push(options)
    return next()
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: supportModule.ZH_BROWSER_LOCALE })
  const pageErrors = []
  page.on('pageerror', error => { pageErrors.push(error.message) })
  page.on('console', message => { browserMessages.push(`${message.type()}: ${message.text()}`) })
  await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
  await page.locator('[class*="frame"]').waitFor({ timeout: 30_000 })
  const workspaceName = 'novel-workspace'
  await mkdir(join(scaffold.workspaceCwd, workspaceName), { recursive: true })
  await page.getByRole('textbox', { name: '选择工作区' }).click()
  const workspaceDialog = page.getByRole('dialog', { name: '选择工作区目录' })
  await workspaceDialog.getByRole('button', { name: '编辑路径' }).click()
  const workspacePath = workspaceDialog.getByRole('textbox', { name: '编辑路径' })
  await workspacePath.fill(join(scaffold.workspaceCwd, workspaceName))
  await workspacePath.press('Enter')
  await workspaceDialog.getByRole('button', { name: '打开', exact: true }).click()
  await page.getByRole('treeitem', { name: workspaceName }).click()
  await page.getByRole('button', { name: `在“${workspaceName}”中新建会话` }).click()
  await page.locator('textarea:enabled[placeholder="描述你想要构建的内容"]')
    .waitFor({ timeout: 15_000 })

  const trigger = page.getByRole('button', { name: '打开小说工作台' })
  await trigger.click()
  const drawer = page.getByRole('dialog', { name: '小说工作台' })
  await drawer.waitFor({ timeout: 15_000 })
  await drawer.getByRole('textbox', { name: '小说标题' }).fill('潮汐来信')
  await drawer.getByRole('textbox', { name: '类型' }).fill('悬疑')
  await drawer.getByRole('button', { name: '预览初始化提案' }).click()
  const preview = drawer.locator('.aiNovelInitializationPreview')
  await preview.waitFor({ timeout: 10_000 })

  const frame = page.locator('[class*="frame"]').first()
  const center = page.locator('[class*="centerCol"]').first()
  const drawerBox = await drawer.boundingBox()
  const centerBox = await center.boundingBox()
  const framePaddingRight = await frame.evaluate(element => getComputedStyle(element).paddingRight)
  if (drawerBox === null || centerBox === null || centerBox.x + centerBox.width > drawerBox.x + 1) {
    throw new Error('workbench drawer covered the conversation column')
  }
  const previewSnapshot = normalize(await drawer.ariaSnapshot())

  const initializationTurn = scaffold.whenTurnSettled()
  await drawer.getByRole('button', { name: '提交到当前会话' }).click()
  await drawer.getByText('初始化提案已发送。').waitFor({ timeout: 10_000 })
  await initializationTurn
  const submittedSnapshot = normalize(await drawer.ariaSnapshot())
  await drawer.getByRole('button', { name: '关闭小说工作台' }).click()

  const projectRoot = join(scaffold.workspaceCwd, workspaceName)
  const assetRoot = join(projectRoot, '.ai-novel')
  await mkdir(join(assetRoot, 'blueprints', 'chapters'), { recursive: true })
  await mkdir(join(projectRoot, 'chapters'), { recursive: true })
  await writeFile(join(assetRoot, 'project.json'), `${JSON.stringify({
    formatVersion: 1,
    kind: 'harness-novel-project',
    projectId: '123e4567-e89b-42d3-a456-426614174000',
    title: '潮汐来信',
    language: 'zh-CN',
    genre: '悬疑',
    plannedChapters: 20,
    targetWordsPerChapter: 3000,
    creativeStrategy: 'auto',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
  }, null, 2)}\n`, 'utf8')
  await writeFile(join(assetRoot, 'characters.json'), `${JSON.stringify({ characters: [{
    id: 'lin', name: '林澈', role: '调查者', summary: '追查旧案', goal: '找到真相', relationships: [], notes: '',
  }] }, null, 2)}\n`, 'utf8')
  await writeFile(join(assetRoot, 'blueprints', 'story.json'), `${JSON.stringify({
    premise: '退潮后，失踪者的信件逐封出现。',
    themes: ['记忆', '责任'],
    world: '近未来海港城',
    mainPlot: '记者与调查员追查潮汐站旧案。',
    endingGoal: '公开真相并阻止下一次事故。',
  }, null, 2)}\n`, 'utf8')
  await writeFile(join(assetRoot, 'blueprints', 'chapters', '0002.json'), `${JSON.stringify({
    chapter: 2,
    title: '潮汐站',
    purpose: '让两位调查者第一次交换证据。',
    beats: ['抵达废弃站', '发现录音'],
    characterIds: ['lin'],
    continuityNotes: ['林澈仍隐瞒旧案关系'],
    status: 'planned',
  }, null, 2)}\n`, 'utf8')
  const longDraft = `# 第二章\n\n${Array.from(
    { length: 120 },
    (_, index) => `潮水第 ${index + 1} 次退去时，林澈在废弃潮汐站记下新的证据与时间。`,
  ).join('\n\n')}\n`
  await writeFile(join(projectRoot, 'chapters', '0002.md'), longDraft, 'utf8')
  await trigger.click()
  await drawer.getByRole('heading', { name: '小说资产' }).waitFor({ timeout: 10_000 })
  const assetRootSnapshot = normalize(await drawer.ariaSnapshot())
  await drawer.getByRole('button', { name: /项目设置/ }).click()
  await drawer.getByRole('textbox', { name: '小说标题' }).fill('潮汐之后')
  await drawer.getByRole('textbox', { name: '修改摘要' }).fill('调整项目定位')
  await drawer.getByRole('button', { name: '预览修改提案' }).click()
  await drawer.getByRole('region', { name: '即将提交的完整资产文本' }).waitFor({ timeout: 10_000 })
  const projectEditorSnapshot = normalize(await drawer.ariaSnapshot())
  if (screenshotDir !== undefined) {
    await page.screenshot({ path: join(screenshotDir, '03-project-editor-generation.png'), fullPage: false })
  }
  await drawer.getByRole('button', { name: '放弃修改' }).click()
  await drawer.getByRole('button', { name: '返回小说资产列表' }).click()
  await drawer.getByRole('button', { name: /人物设定/ }).click()
  await drawer.getByRole('textbox', { name: '搜索人物' }).fill('林')
  const characterEditorSnapshot = normalize(await drawer.ariaSnapshot())
  await drawer.getByRole('button', { name: '返回小说资产列表' }).click()
  await drawer.getByRole('button', { name: /故事蓝图/ }).click()
  const storyHeading = drawer.getByRole('heading', { name: '故事蓝图', exact: true })
  await drawer.getByRole('textbox', { name: '故事前提' }).waitFor({ timeout: 10_000 })
  await page.waitForFunction(element => document.activeElement === element, await storyHeading.elementHandle())
  const storyGenerationBrief = drawer.getByRole('textbox', { name: '故事蓝图 AI 生成要求' })
  await storyGenerationBrief.fill('加强海港世界观，同时保持现有人物一致。')
  if (await drawer.getByRole('button', { name: '让当前模型生成' }).isDisabled()) {
    throw new Error('clean story asset did not enable model generation after a brief was entered')
  }
  const generationTurn = scaffold.whenTurnSettled()
  await drawer.getByRole('button', { name: '让当前模型生成' }).click()
  const generationSessionId = await generationTurn
  await drawer.getByText(/未产生可归因的修改/).waitFor({ timeout: 10_000 })
  const generationSession = scaffold.ctx.agents.get(generationSessionId)?.session
  if (generationSession === undefined) throw new Error('generation turn did not retain its assembled Session')
  const durableGeneration = generationSession.events.findLast(event => event.type === 'user/message'
    && event.data.source.kind === 'user'
    && textContent(event.data.content).includes('[AI_NOVEL_UI_CORRELATION:'))
  if (durableGeneration?.type !== 'user/message') throw new Error('generation prompt was not durably logged')
  const durableGenerationPrompt = textContent(durableGeneration.data.content)
  const request = llmRequests.at(-1)
  const requestGenerationPrompt = request?.messages.filter(message => message.role === 'user')
    .map(message => textContent(message.content)).findLast(text => text.includes('[AI_NOVEL_UI_CORRELATION:'))
  if (requestGenerationPrompt === undefined) throw new Error('generation prompt did not reach the assembled model request')
  if (requestGenerationPrompt !== durableGenerationPrompt) {
    throw new Error('durable generation prompt and model request diverged')
  }
  if (!durableGenerationPrompt.includes('此标记只供小说工作台对账；不得把它写入任何小说资产或工具参数。')) {
    throw new Error('generation prompt omitted correlation-marker non-write semantics')
  }
  const generationEvidence = {
    durableUserPrompt: normalize(durableGenerationPrompt),
    modelRequestUserPrompt: normalize(requestGenerationPrompt),
    durableLog: {
      userMessageSeq: durableGeneration.seq,
      requestHeaderLogged: generationSession.events.some(event => event.type === 'request/header'),
      turnEndSeq: generationSession.events.findLast(event => event.type === 'turn/end')?.seq,
    },
  }
  if (screenshotDir !== undefined) {
    await page.screenshot({ path: join(screenshotDir, '04-story-ai-generation.png'), fullPage: false })
  }
  await storyGenerationBrief.fill('')
  await drawer.getByRole('textbox', { name: '结局目标' }).fill('在风暴前公开真相并阻止下一次事故。')
  await drawer.getByRole('textbox', { name: '修改摘要' }).fill('明确故事结局目标')
  await drawer.getByRole('button', { name: '预览修改提案' }).click()
  await drawer.getByRole('region', { name: '即将提交的完整资产文本' }).waitFor({ timeout: 10_000 })
  const storyEditorSnapshot = normalize(await drawer.ariaSnapshot())
  await drawer.getByRole('button', { name: '放弃修改' }).click()
  await drawer.getByRole('button', { name: '返回小说资产列表' }).click()
  const assetHeading = drawer.getByRole('heading', { name: '小说资产' })
  await page.waitForFunction(element => document.activeElement === element, await assetHeading.elementHandle())
  const chapterSelector = drawer.getByRole('spinbutton', { name: '选择小说章节' })
  await chapterSelector.press('Backspace')
  await drawer.getByRole('alert').filter({ hasText: '章节编号必须在 1 到 20 之间。' }).waitFor({ timeout: 10_000 })
  await chapterSelector.fill('2')
  await drawer.getByText('第 2 / 20 章').waitFor({ timeout: 10_000 })
  await drawer.getByRole('button', { name: /章节蓝图/ }).click()
  await drawer.getByRole('heading', { name: '第 2 章蓝图', exact: true }).waitFor({ timeout: 10_000 })
  await drawer.getByRole('textbox', { name: '章节目的' }).fill('让两位调查者交换证据并首次产生分歧。')
  await drawer.getByRole('textbox', { name: '修改摘要' }).fill('细化第二章目的')
  await drawer.getByRole('button', { name: '预览修改提案' }).click()
  await drawer.getByRole('region', { name: '即将提交的完整资产文本' }).waitFor({ timeout: 10_000 })
  const chapterBlueprintEditorSnapshot = normalize(await drawer.ariaSnapshot())
  await drawer.getByRole('button', { name: '放弃修改' }).click()
  await drawer.getByRole('button', { name: '返回小说资产列表' }).click()
  await drawer.getByRole('button', { name: /章节正文/ }).click()
  const draftEditor = drawer.getByRole('textbox', { name: '章节正文 Markdown' })
  await draftEditor.waitFor({ timeout: 10_000 })
  const editorScroll = await draftEditor.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  if (editorScroll.scrollHeight <= editorScroll.clientHeight) throw new Error('long chapter draft did not create an editor scroll region')
  await draftEditor.fill(`${longDraft}\n## 新线索\n\n林澈决定在风暴前公开录音。\n`)
  await drawer.getByRole('textbox', { name: '修改摘要' }).fill('补写第二章新线索')
  await drawer.evaluate(element => { element.scrollTop = element.scrollHeight })
  const previewButton = drawer.getByRole('button', { name: '预览修改提案' })
  const scrolledDrawerBox = await drawer.boundingBox()
  const stickyActionsBox = await drawer.locator('.aiNovelWorkbenchActions').boundingBox()
  if (scrolledDrawerBox === null || stickyActionsBox === null
    || stickyActionsBox.y + stickyActionsBox.height > scrolledDrawerBox.y + scrolledDrawerBox.height + 1) {
    throw new Error('chapter draft actions were not visible after scrolling long prose')
  }
  await previewButton.click()
  await drawer.getByRole('region', { name: '即将提交的完整资产文本' }).waitFor({ timeout: 10_000 })
  const chapterDraftEditorSnapshot = normalize(await drawer.ariaSnapshot())
  await page.setViewportSize({ width: 390, height: 844 })
  const narrowDrawerBox = await drawer.boundingBox()
  const draftEditorBox = await draftEditor.boundingBox()
  const actionsBox = await drawer.locator('.aiNovelWorkbenchActions').boundingBox()
  const narrowOverflow = await drawer.evaluate(element => element.scrollWidth - element.clientWidth)
  if (narrowDrawerBox === null || draftEditorBox === null || actionsBox === null
    || narrowDrawerBox.width > 390
    || draftEditorBox.x + draftEditorBox.width > narrowDrawerBox.x + narrowDrawerBox.width + 1
    || actionsBox.x + actionsBox.width > narrowDrawerBox.x + narrowDrawerBox.width + 1
    || narrowOverflow > 1) throw new Error('chapter draft editor overflowed the narrow drawer')
  await page.setViewportSize({ width: 1440, height: 900 })
  await drawer.getByRole('button', { name: '关闭小说工作台' }).click()

  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置' })
  await settings.getByRole('button', { name: '插件' }).click()
  await settings.getByRole('tab', { name: '插件配置' }).click()
  const card = settings.getByRole('listitem').filter({ hasText: 'AI 小说作家' })
  await card.waitFor({ timeout: 10_000 })
  const settingsSnapshot = normalize(await card.ariaSnapshot())

  if (pageErrors.length > 0) throw new Error(`browser page errors: ${pageErrors.join(' | ')}`)
  result = {
    geometry: {
      viewportWidth: 1440,
      drawerWidth: Math.round(drawerBox.width),
      conversationRight: Math.round(centerBox.x + centerBox.width),
      drawerLeft: Math.round(drawerBox.x),
      framePaddingRight,
    },
    preview: previewSnapshot,
    submitted: submittedSnapshot,
    assetRoot: assetRootSnapshot,
    projectEditor: projectEditorSnapshot,
    characterEditor: characterEditorSnapshot,
    storyEditor: storyEditorSnapshot,
    chapterBlueprintEditor: chapterBlueprintEditorSnapshot,
    chapterDraftEditor: chapterDraftEditorSnapshot,
    narrowDraftGeometry: {
      viewportWidth: 390,
      drawerWidth: Math.round(narrowDrawerBox.width),
      draftRight: Math.round(draftEditorBox.x + draftEditorBox.width),
      drawerRight: Math.round(narrowDrawerBox.x + narrowDrawerBox.width),
      horizontalOverflow: narrowOverflow,
    },
    settings: settingsSnapshot,
    generationEvidence,
  }
  } catch (error) {
    if (page === undefined) {
      bodyError = error
    } else {
      const pageSnapshot = await page.locator('body').ariaSnapshot().catch(() => '<page unavailable>')
      bodyError = new AggregateError([
        error,
        new Error(pageSnapshot),
        new Error(browserMessages.join('\n')),
      ], 'Browser journey failed with page state')
    }
  }

  const cleanupErrors = []
  if (browser !== undefined) {
    try { await browser.close() } catch (error) { cleanupErrors.push(error) }
  }
  try { stopLlmCapture?.() } catch (error) { cleanupErrors.push(error) }
  if (scaffold !== undefined) {
    try { await scaffold.close() } catch (error) { cleanupErrors.push(error) }
  }
  try { await rm(overlayRoot, { recursive: true, force: true }) } catch (error) { cleanupErrors.push(error) }
  if (bodyError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError([bodyError, ...cleanupErrors], 'Browser journey and cleanup both failed')
  }
  if (bodyError !== undefined) throw bodyError
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Browser journey cleanup failed')
  return result
}

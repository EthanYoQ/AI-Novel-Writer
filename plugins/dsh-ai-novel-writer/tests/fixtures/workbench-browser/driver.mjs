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
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu, '{{projectId}}')
    .replace(/[0-9a-f]{64}/giu, '{{revision}}')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/gu, '{{timestamp}}')
}

/**
 * Run the workbench journey inside a Vitest process configured with DSH source paths.
 *
 * @param {string} harnessRoot Absolute DeepSeek Harness repository root.
 * @returns {Promise<object>} Stable user-visible snapshots and wide-layout geometry.
 */
export async function runWorkbenchBrowserJourney(harnessRoot) {
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
  const browserMessages = []
  let bodyError
  let result
  try {
    scaffold = await scaffoldModule.launchWebScaffold({
      extraOverlayPath: overlayPath,
      harnessHome,
      agentPresets: {
        roots: [{ path: join(packageRoot, 'presets'), trust: 'user' }],
        default: 'ai-novel-writer',
      },
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

  await drawer.getByRole('button', { name: '提交到当前会话' }).click()
  await drawer.getByText('初始化提案已发送。').waitFor({ timeout: 10_000 })
  const submittedSnapshot = normalize(await drawer.ariaSnapshot())
  await drawer.getByRole('button', { name: '关闭小说工作台' }).click()

  const projectRoot = join(scaffold.workspaceCwd, workspaceName)
  const assetRoot = join(projectRoot, '.ai-novel')
  await mkdir(assetRoot, { recursive: true })
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
  await trigger.click()
  await drawer.getByRole('heading', { name: '小说资产' }).waitFor({ timeout: 10_000 })
  const assetRootSnapshot = normalize(await drawer.ariaSnapshot())
  await drawer.getByRole('button', { name: /项目设置/ }).click()
  await drawer.getByRole('textbox', { name: '小说标题' }).fill('潮汐之后')
  await drawer.getByRole('textbox', { name: '修改摘要' }).fill('调整项目定位')
  await drawer.getByRole('button', { name: '预览修改提案' }).click()
  await drawer.getByRole('region', { name: '即将提交的完整资产文本' }).waitFor({ timeout: 10_000 })
  const projectEditorSnapshot = normalize(await drawer.ariaSnapshot())
  await drawer.getByRole('button', { name: '返回资产' }).click()
  await drawer.getByRole('button', { name: /人物设定/ }).click()
  await drawer.getByRole('textbox', { name: '搜索人物' }).fill('林')
  const characterEditorSnapshot = normalize(await drawer.ariaSnapshot())
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
    settings: settingsSnapshot,
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

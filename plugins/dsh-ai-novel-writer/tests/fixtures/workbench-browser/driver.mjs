#!/usr/bin/env node
/** Real DSH Web browser journey for the V2 read-only novel workbench shell. */

import { createRequire } from 'node:module'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

const packageRoot = resolve(import.meta.dirname, '..', '..', '..')
const signal = new AbortController().signal

async function registeredWorkspace(scaffold, projectRoot) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const workspace = scaffold.ctx.workspaceRegistry.list().find(item => item.path === projectRoot)
    if (workspace !== undefined && workspace.sessionIds.length > 0) return workspace
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error('browser-created Workspace did not appear in the Host registry')
}

/** Create Host-authoritative V2 data; browser actions below remain read-only/local. */
async function provisionV2Project(projectRoot, workspaceId) {
  const storeModule = await import(pathToFileURL(join(packageRoot, 'src', 'novel-store.ts')).href)
  const store = await storeModule.openNovelStore(projectRoot, workspaceId)
  try {
    await store.initialize({
      workspaceId,
      title: '潮汐来信', language: 'zh-CN', genre: '奇幻悬疑', plannedChapters: 12, targetWordsPerChapter: 3000,
      creativeStrategy: 'consistency-first', structureMode: 'three-act', narrativePov: 'third-limited', globalGuidance: '保持克制的观察视角。',
    }, signal)
    let state = await store.read(signal)
    const longPremise = Array.from(
      { length: 120 },
      (_, index) => `第 ${index + 1} 段：退潮后的海港仍保留林澈追查旧案的证据与疑问。`,
    ).join('\n\n')
    await store.applyChange({
      changeSetId: 'fixture-architecture', operation: 'replace', aggregate: { kind: 'architecture' },
      baseAggregateRevision: state.architecture.revision, baseGlobalRevision: state.globalRevision,
      nextValue: {
        premise: longPremise, characterGraph: '林澈 -> 周遥', world: '近未来海港城',
        plotOutline: '追查潮汐站旧案', styleConstraints: '克制', referenceWorks: [],
      }, provenance: { origin: 'manual' },
    }, signal)
    state = await store.read(signal)
    await store.applyChange({
      changeSetId: 'fixture-chapter-1', operation: 'replace', aggregate: { kind: 'chapter', chapter: 1 },
      baseAggregateRevision: 0, baseGlobalRevision: state.globalRevision,
      nextValue: {
        chapter: 1, title: '潮汐站', purpose: '交换证据', plotBeats: ['抵达海港'], characters: [],
        keyEvents: ['发现录音带'], suspense: '录音带缺失', status: 'drafting',
      }, provenance: { origin: 'manual' },
    }, signal)
    state = await store.read(signal)
    await store.applyChange({
      changeSetId: 'fixture-task-chapter-1', operation: 'replace', aggregate: { kind: 'task', taskId: 'chapter-1' },
      baseAggregateRevision: 0, baseGlobalRevision: state.globalRevision,
      nextValue: {
        taskId: 'chapter-1', kind: 'chapter', stage: 'draft', status: 'blocked', failure: '等待用户补充上下文',
        resumeCursor: 'chapter-1:beat-2', createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z',
      }, provenance: { origin: 'manual' },
    }, signal)
    state = await store.read(signal)
    const proposalPayload = {
      changes: [{
        changeSetId: 'fixture-proposal-project', aggregate: { kind: 'project' },
        baseAggregateRevision: state.project.revision, baseGlobalRevision: state.globalRevision,
        nextValue: {
          title: '潮汐来信（修订）', language: state.project.language, genre: state.project.genre,
          plannedChapters: state.project.plannedChapters, targetWordsPerChapter: state.project.targetWordsPerChapter,
          creativeStrategy: state.project.creativeStrategy, structureMode: state.project.structureMode,
          narrativePov: state.project.narrativePov, globalGuidance: state.project.globalGuidance,
          createdAt: state.project.createdAt, updatedAt: '2026-08-21T01:00:00.000Z',
        },
      }],
    }
    await store.submitProposal({
      sessionId: 'fixture-session', callId: 'fixture-call',
      argsHash: storeModule.novelProposalArgsHash(proposalPayload), payload: proposalPayload,
    }, signal)
  } finally {
    await store.dispose()
  }
}

/**
 * Run the V2 workbench inside an actual DSH Harness Web application.
 *
 * @param {string} harnessRoot Absolute DeepSeek Harness repository root.
 * @returns {Promise<object>} Deterministic geometry and interaction evidence.
 */
export async function runWorkbenchBrowserJourney(harnessRoot) {
  const screenshotDir = process.env.DSH_WORKBENCH_SCREENSHOT_DIR
  if (screenshotDir !== undefined) await mkdir(screenshotDir, { recursive: true })
  const workspaceModule = await import(pathToFileURL(join(packageRoot, 'tests', 'test-workspace.ts')).href)
  const overlayRoot = await workspaceModule.makeTestWorkspace('workbench-browser-v2-')
  const harnessHome = join(overlayRoot, 'harness-home')
  const overlayPath = join(overlayRoot, 'cordis.overlay.yml')
  await writeFile(overlayPath, [
    '- insert:',
    "    - id: ai-novel-writer",
    "      name: '@ethanyoq/dsh-ai-novel-writer'",
    '',
  ].join('\n'), 'utf8')
  const cliRequire = createRequire(join(harnessRoot, 'apps', 'cli', 'package.json'))
  const appBootModule = await import(pathToFileURL(cliRequire.resolve('@deepseek-ai/dsh-app-boot')).href)
  appBootModule.healProfilesModuleFallback(join(packageRoot, 'package.json'), harnessHome)
  const scaffoldModule = await import(pathToFileURL(join(harnessRoot, 'apps', 'web', 'tests', 'scaffold.ts')).href)
  const supportModule = await import(pathToFileURL(join(harnessRoot, 'apps', 'web', 'tests', 'support.ts')).href)
  const { chromium } = createRequire(join(harnessRoot, 'package.json'))('playwright')
  let scaffold
  let browser
  let page
  let bodyError
  let result
  try {
    scaffold = await scaffoldModule.launchWebScaffold({
      extraOverlayPath: overlayPath,
      harnessHome,
      replayFixture: join(packageRoot, 'tests', 'fixtures', 'workbench-browser', 'session.jsonl'),
      agentPresets: {
        roots: [{ path: join(packageRoot, 'presets'), trust: 'user' }],
        default: 'ai-novel-writer-v2',
      },
    })
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: supportModule.ZH_BROWSER_LOCALE })
    const pageErrors = []
    page.on('pageerror', error => { pageErrors.push(error.message) })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.locator('[class*="frame"]').waitFor({ timeout: 30_000 })
    const workspaceName = 'novel-workspace-v2'
    const projectRoot = join(scaffold.workspaceCwd, workspaceName)
    await mkdir(projectRoot, { recursive: true })
    await page.getByRole('textbox', { name: '选择工作区' }).click()
    const workspaceDialog = page.getByRole('dialog', { name: '选择工作区目录' })
    await workspaceDialog.getByRole('button', { name: '编辑路径' }).click()
    await workspaceDialog.getByRole('textbox', { name: '编辑路径' }).fill(projectRoot)
    await workspaceDialog.getByRole('textbox', { name: '编辑路径' }).press('Enter')
    await workspaceDialog.getByRole('button', { name: '打开', exact: true }).click()
    await page.getByRole('treeitem', { name: workspaceName }).click()
    await page.getByRole('button', { name: `在“${workspaceName}”中新建会话` }).click()
    await page.locator('textarea:enabled[placeholder="描述你想要构建的内容"]').waitFor({ timeout: 15_000 })
    const workspace = await registeredWorkspace(scaffold, projectRoot)
    await provisionV2Project(projectRoot, workspace.id)

    const trigger = page.getByRole('button', { name: '打开小说工作台' })
    await trigger.focus()
    await trigger.click()
    const drawer = page.getByRole('dialog', { name: '小说工作台' })
    await drawer.getByRole('heading', { name: '项目概览' }).waitFor({ timeout: 15_000 })
    await drawer.getByRole('heading', { name: '提案队列' }).waitFor({ timeout: 15_000 })
    await drawer.getByRole('heading', { name: '任务' }).waitFor({ timeout: 15_000 })
    await drawer.getByRole('heading', { name: '资产导航' }).waitFor({ timeout: 15_000 })
    const frame = page.locator('[class*="frame"]').first()
    const center = page.locator('[class*="centerCol"]').first()
    const drawerBox = await drawer.boundingBox()
    const centerBox = await center.boundingBox()
    const framePaddingRight = await frame.evaluate(element => getComputedStyle(element).paddingRight)
    if (drawerBox === null || centerBox === null || centerBox.x + centerBox.width > drawerBox.x + 1) {
      throw new Error('V2 workbench drawer covered the conversation column at 1440px')
    }
    await drawer.getByRole('button', { name: /待处理.*1 个聚合变更/ }).click()
    await drawer.getByRole('button', { name: /查看 项目设置 差异/ }).click()
    await drawer.getByText('当前值', { exact: true }).waitFor({ timeout: 10_000 })
    await drawer.getByText(/提案下一值/).waitFor({ timeout: 10_000 })
    if (!await drawer.getByRole('button', { name: /保存/ }).isDisabled()
      || !await drawer.getByRole('button', { name: /应用/ }).isDisabled()) {
      throw new Error('V2 shell exposed an enabled save or apply command')
    }
    await drawer.getByRole('button', { name: '故事架构' }).click()
    const editor = drawer.getByRole('textbox', { name: '故事架构 JSON 草稿' })
    const editorScroll = await editor.evaluate(element => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }))
    if (editorScroll.scrollHeight <= editorScroll.clientHeight) throw new Error('long V2 aggregate did not create an editor scroll region')
    await drawer.evaluate(element => { element.scrollTop = element.scrollHeight })
    const stickyActionsBox = await drawer.locator('.aiNovelWorkbenchActions').boundingBox()
    const scrolledDrawerBox = await drawer.boundingBox()
    if (stickyActionsBox === null || scrolledDrawerBox === null
      || stickyActionsBox.y + stickyActionsBox.height > scrolledDrawerBox.y + scrolledDrawerBox.height + 1) {
      throw new Error('V2 editor actions were not sticky after scrolling long aggregate content')
    }
    if (screenshotDir !== undefined) await page.screenshot({ path: join(screenshotDir, 'workbench-v2-detail.png'), fullPage: false })
    await page.setViewportSize({ width: 390, height: 844 })
    const narrowDrawerBox = await drawer.boundingBox()
    const editorBox = await editor.boundingBox()
    const actionsBox = await drawer.locator('.aiNovelWorkbenchActions').boundingBox()
    const narrowOverflow = await drawer.evaluate(element => element.scrollWidth - element.clientWidth)
    if (narrowDrawerBox === null || editorBox === null || actionsBox === null
      || narrowDrawerBox.width > 390
      || editorBox.x + editorBox.width > narrowDrawerBox.x + narrowDrawerBox.width + 1
      || actionsBox.x + actionsBox.width > narrowDrawerBox.x + narrowDrawerBox.width + 1
      || narrowOverflow > 1) throw new Error('V2 detail overflowed the 390px drawer')
    await page.setViewportSize({ width: 1440, height: 900 })
    await drawer.getByRole('button', { name: '关闭小说工作台' }).focus()
    await page.keyboard.press('Tab')
    const tabContained = await drawer.evaluate(element => element.contains(document.activeElement))
    if (!tabContained) throw new Error('Tab escaped the V2 workbench focus scope')
    await page.keyboard.press('Escape')
    await drawer.waitFor({ state: 'detached', timeout: 10_000 })
    const escapeRestored = await trigger.evaluate(element => document.activeElement === element)
    if (!escapeRestored) throw new Error('Escape did not restore focus to the V2 workbench trigger')
    if (pageErrors.length > 0) throw new Error(`browser page errors: ${pageErrors.join(' | ')}`)
    result = {
      geometry: {
        desktop1440: true,
        drawerWithin440: drawerBox.width >= 400 && drawerBox.width <= 440,
        conversationReserved: centerBox.x + centerBox.width <= drawerBox.x + 1,
        framePaddingReserved: framePaddingRight === '440px',
      },
      v2Detail: {
        overview: true, proposalDiff: true, taskStatus: true, longBodyScroll: true, stickyActions: true, saveAndApplyDisabled: true,
      },
      narrowDetailGeometry: {
        viewport390: true,
        drawerWithinViewport: narrowDrawerBox.width <= 390,
        editorWithinDrawer: editorBox.x + editorBox.width <= narrowDrawerBox.x + narrowDrawerBox.width + 1,
        actionsWithinDrawer: actionsBox.x + actionsBox.width <= narrowDrawerBox.x + narrowDrawerBox.width + 1,
        noHorizontalOverflow: narrowOverflow <= 1,
      },
      keyboard: { tabContained, escapeRestored },
    }
  } catch (error) {
    bodyError = error
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

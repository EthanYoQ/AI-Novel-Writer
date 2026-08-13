import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { _electron as electron } from 'playwright'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = resolve(dirname(scriptPath), '..')
const IMAGE_SKIN_ALPHA_TOLERANCE = 0.015
const TEXT_CHANNEL_TOLERANCE = 1
const RUNNER_TIMEOUT_MS = 45_000

export const RENDERER_SURFACE_E2E_CONTRACT = Object.freeze({
  smokeEnvironment: Object.freeze([
    'AI_NOVEL_VELA_HOME',
    'AI_NOVEL_SMOKE_OPEN_PROJECT',
    'AI_NOVEL_SMOKE_PROJECT_MARKER',
  ]),
  themes: Object.freeze(['light', 'galaxy', 'paper', 'dark']),
  surfaces: Object.freeze({
    sidebar: Object.freeze({ selector: '.skin-workspace-panel', alpha: 0.56 }),
    page: Object.freeze({ selector: '.skin-workspace-page', alpha: 0.60 }),
    solid: Object.freeze({ selector: '.skin-solid-surface', alpha: 0.88 }),
  }),
  routes: Object.freeze(['project', 'knowledge', 'characters', 'blueprint']),
  classicMustBeOpaque: true,
  classicThemeSurfaces: Object.freeze({
    themed: Object.freeze(['light', 'galaxy', 'dark']),
    paper: 'paper',
    surfaces: Object.freeze({
      topbar: Object.freeze({ selector: '.writer-topbar', token: '--color-titlebar', textToken: '--color-titlebar-text', minHeight: 24 }),
      leftRail: Object.freeze({ selector: '.writer-left-rail', token: '--color-activity-bar', textToken: '--color-text-secondary', minWidth: 40 }),
      projectTree: Object.freeze({ selector: '.writer-project-tree', token: '--color-sidebar', textToken: '--color-text' }),
      aiPanel: Object.freeze({ selector: '.writer-ai-panel', token: '--color-panel', textToken: '--color-text' }),
      taskTable: Object.freeze({ selector: '.writer-task-table', token: '--color-panel', textToken: '--color-text' }),
      workspacePage: Object.freeze({ selector: '.skin-workspace-page', token: '--color-editor-bg', textToken: '--color-text' }),
      statusbar: Object.freeze({ selector: '.writer-statusbar', token: '--color-statusbar', textToken: '--color-text-secondary', minHeight: 20 }),
    }),
    statusbarHover: Object.freeze({ selector: '.writer-statusbar-segment', token: '--color-hover' }),
  }),
})

const TEXT_RGB_BY_THEME = Object.freeze({
  light: [23, 32, 51],
  galaxy: [245, 250, 255],
  paper: [34, 29, 23],
  dark: [250, 250, 250],
})

function parseAlphaComponent(value, percent) {
  const numeric = Number(value)
  assert.ok(Number.isFinite(numeric), `Computed color has an invalid alpha: ${value}`)
  return percent ? numeric / 100 : numeric
}

export function computedColorAlpha(cssColor) {
  const color = String(cssColor).trim().toLowerCase()
  if (color === 'transparent') return 0
  if (/^#[0-9a-f]{3,8}$/.test(color)) return 1

  const slashAlpha = /\/\s*(-?(?:\d+\.?\d*|\.\d+))(%)?\s*\)$/.exec(color)
  if (slashAlpha) return parseAlphaComponent(slashAlpha[1], Boolean(slashAlpha[2]))

  if (color.startsWith('rgba(')) {
    const components = color.slice(5, -1).split(',').map(component => component.trim())
    assert.equal(components.length, 4, `Computed rgba color is malformed: ${cssColor}`)
    const percent = components[3].endsWith('%')
    return parseAlphaComponent(components[3].replace(/%$/, ''), percent)
  }

  if (/^(?:rgb|hsl|hwb|lab|lch|oklab|oklch|color)\(/.test(color)) return 1
  throw new Error(`Unsupported computed color format: ${cssColor}`)
}

function computedRgbChannels(cssColor) {
  const color = String(cssColor).trim().toLowerCase()
  if (/^#[0-9a-f]{3,8}$/.test(color)) {
    const hex = color.slice(1)
    const expanded = hex.length <= 4
      ? hex.slice(0, 3).split('').map(channel => `${channel}${channel}`).join('')
      : hex.slice(0, 6)
    return [0, 2, 4].map(index => Number.parseInt(expanded.slice(index, index + 2), 16))
  }
  if (color.startsWith('rgb(') || color.startsWith('rgba(')) {
    const channels = color.match(/-?(?:\d+\.?\d*|\.\d+)/g)?.slice(0, 3).map(Number)
    assert.equal(channels?.length, 3, `Computed rgb color is malformed: ${cssColor}`)
    return channels
  }
  if (color.startsWith('color(srgb ')) {
    const body = color.slice('color(srgb '.length).split('/')[0]
    const channels = body.match(/-?(?:\d+\.?\d*|\.\d+)/g)?.slice(0, 3).map(value => Number(value) * 255)
    assert.equal(channels?.length, 3, `Computed srgb color is malformed: ${cssColor}`)
    return channels
  }
  throw new Error(`Unsupported computed text color format: ${cssColor}`)
}

function assertClose(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} ± ${tolerance}, received ${actual}`,
  )
}

async function waitForFile(filePath, timeoutMs = RUNNER_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error(`Timed out waiting for renderer smoke marker: ${filePath}`)
}

function createIsolatedFixture() {
  const temporaryRoot = join(tmpdir(), `ai-novel-renderer-surface-${randomUUID()}`)
  const projectRoot = join(temporaryRoot, 'project')
  const velaHome = join(temporaryRoot, 'vela-home')
  const markerPath = join(temporaryRoot, 'project-opened.json')
  const manifestRoot = join(projectRoot, '.vela')
  mkdirSync(manifestRoot, { recursive: true })
  mkdirSync(velaHome, { recursive: true })
  writeFileSync(join(manifestRoot, 'project.json'), `${JSON.stringify({
    schemaVersion: 1,
    kind: 'ai-novel-project',
    projectId: randomUUID(),
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8')
  return { temporaryRoot, projectRoot, velaHome, markerPath }
}

function runProjectScript(scriptName) {
  const pnpmCli = process.env.npm_execpath
  const command = pnpmCli ? (process.env.npm_node_execpath || process.execPath) : 'pnpm'
  const args = pnpmCli ? [pnpmCli, 'run', scriptName] : ['run', scriptName]
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
    shell: !pnpmCli && process.platform === 'win32',
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `Project script failed: pnpm run ${scriptName}`)
}

async function computedSurface(page, selector, label, { minWidth = 100, minHeight = 100 } = {}) {
  const locator = page.locator(selector).first()
  await locator.waitFor({ state: 'visible', timeout: RUNNER_TIMEOUT_MS })
  const surface = await locator.evaluate(element => {
    const style = getComputedStyle(element)
    const bounds = element.getBoundingClientRect()
    return {
      backgroundColor: style.backgroundColor,
      color: style.color,
      width: bounds.width,
      height: bounds.height,
    }
  })
  assert.ok(surface.width >= minWidth && surface.height >= minHeight, `${label} is not a real surface`)
  return surface
}

async function computedTokenColor(page, token) {
  return page.evaluate((tokenName) => {
    const probe = document.createElement('div')
    probe.style.backgroundColor = `var(${tokenName})`
    document.body.appendChild(probe)
    const value = getComputedStyle(probe).backgroundColor
    probe.remove()
    return value
  }, token)
}

function assertColorMatches(actualColor, expectedColor, label) {
  const actual = computedRgbChannels(actualColor)
  const expected = computedRgbChannels(expectedColor)
  for (let index = 0; index < expected.length; index += 1) {
    assertClose(actual[index], expected[index], TEXT_CHANNEL_TOLERANCE, `${label} channel ${index + 1}`)
  }
  assert.equal(computedColorAlpha(actualColor), 1, `${label} must remain opaque`)
}

async function assertSurfaceAlpha(page, surfaceName, expectedAlpha, label) {
  const selector = RENDERER_SURFACE_E2E_CONTRACT.surfaces[surfaceName].selector
  const surface = await computedSurface(page, selector, label)
  assertClose(
    computedColorAlpha(surface.backgroundColor),
    expectedAlpha,
    IMAGE_SKIN_ALPHA_TOLERANCE,
    `${label} computed background alpha (${surface.backgroundColor})`,
  )
  return surface
}

function assertTextColor(cssColor, theme, label) {
  const actual = computedRgbChannels(cssColor)
  const expected = TEXT_RGB_BY_THEME[theme]
  for (let index = 0; index < expected.length; index += 1) {
    assertClose(actual[index], expected[index], TEXT_CHANNEL_TOLERANCE, `${label} channel ${index + 1}`)
  }
  assert.equal(computedColorAlpha(cssColor), 1, `${label} text must remain fully opaque`)
}

async function openAppearanceSettings(page) {
  await page.locator('button[title="设置"], button[title="Settings"]').first().click()
  const modal = page.locator('.skin-solid-surface').first()
  await modal.waitFor({ state: 'visible', timeout: RUNNER_TIMEOUT_MS })
  await modal.locator('aside button').filter({ hasText: /外观|Appearance/ }).first().click()
  await page.locator('.appearance-settings').waitFor({ state: 'visible', timeout: RUNNER_TIMEOUT_MS })
}

async function closeSettings(page) {
  const modal = page.locator('.skin-solid-surface').first()
  await modal.click({ position: { x: 4, y: 4 } })
  await modal.waitFor({ state: 'detached', timeout: RUNNER_TIMEOUT_MS })
}

async function selectImageSkin(page, skinId) {
  await page.locator(`[data-skin-card="${skinId}"] .appearance-skin-select`).click()
  await page.waitForFunction(
    expected => document.querySelector('.app-skin-root')?.getAttribute('data-skin') === expected,
    skinId,
    { timeout: RUNNER_TIMEOUT_MS },
  )
}

async function selectTheme(page, theme) {
  await page.locator(`.appearance-theme-option[data-theme="${theme}"]`).click()
  await page.waitForFunction(
    expected => document.querySelector('.app-skin-root')?.getAttribute('data-theme') === expected,
    theme,
    { timeout: RUNNER_TIMEOUT_MS },
  )
}

async function clickNavigation(page, titles) {
  const selector = titles.map(title => `button[title="${title}"]`).join(', ')
  await page.locator(selector).first().click()
  await page.locator('.skin-workspace-page').first().waitFor({ state: 'visible', timeout: RUNNER_TIMEOUT_MS })
}

async function assertImageSkinThemes(page) {
  const evidence = []
  for (const theme of RENDERER_SURFACE_E2E_CONTRACT.themes) {
    await selectTheme(page, theme)
    const sidebar = await assertSurfaceAlpha(page, 'sidebar', 0.56, `${theme} sidebar`)
    const workspacePage = await assertSurfaceAlpha(page, 'page', 0.60, `${theme} workspace page`)
    const solid = await assertSurfaceAlpha(page, 'solid', 0.88, `${theme} settings modal`)
    assertTextColor(sidebar.color, theme, `${theme} sidebar text`)
    assertTextColor(workspacePage.color, theme, `${theme} workspace text`)
    evidence.push({
      theme,
      sidebar: sidebar.backgroundColor,
      page: workspacePage.backgroundColor,
      solid: solid.backgroundColor,
      sidebarText: sidebar.color,
      pageText: workspacePage.color,
    })
  }
  return evidence
}

async function assertReachableRoutes(page) {
  const routes = [
    { id: 'project', titles: ['项目', 'Project'] },
    { id: 'knowledge', titles: ['小说', 'Novel'] },
    { id: 'characters', titles: ['角色', 'Cast'] },
    { id: 'blueprint', titles: ['章节蓝图', 'Chapter blueprint'] },
  ]
  const evidence = []
  for (const route of routes) {
    await clickNavigation(page, route.titles)
    const sidebar = await assertSurfaceAlpha(page, 'sidebar', 0.56, `${route.id} sidebar`)
    const workspacePage = await assertSurfaceAlpha(page, 'page', 0.60, `${route.id} workspace page`)
    evidence.push({ route: route.id, sidebar: sidebar.backgroundColor, page: workspacePage.backgroundColor })
  }
  return evidence
}

async function assertClassicThemeSurfaces(page) {
  const evidence = []
  const { themed, surfaces, statusbarHover } = RENDERER_SURFACE_E2E_CONTRACT.classicThemeSurfaces
  for (const [themeIndex, theme] of themed.entries()) {
    await selectTheme(page, theme)
    await closeSettings(page)
    const themeEvidence = { theme, surfaces: {} }
    for (const [surfaceName, contract] of Object.entries(surfaces)) {
      const surface = await computedSurface(page, contract.selector, `${theme} classic ${surfaceName}`, contract)
      const expectedBackground = await computedTokenColor(page, contract.token)
      const expectedText = await computedTokenColor(page, contract.textToken)
      assertColorMatches(surface.backgroundColor, expectedBackground, `${theme} classic ${surfaceName} background`)
      assertColorMatches(surface.color, expectedText, `${theme} classic ${surfaceName} text`)
      themeEvidence.surfaces[surfaceName] = {
        background: surface.backgroundColor,
        text: surface.color,
      }
    }
    const clickableSegments = page.locator(statusbarHover.selector)
    const segmentCount = await clickableSegments.count()
    let clickableSegment = null
    for (let index = 0; index < segmentCount; index += 1) {
      const candidate = clickableSegments.nth(index)
      if (await candidate.evaluate(element => getComputedStyle(element).cursor === 'pointer')) {
        clickableSegment = candidate
        break
      }
    }
    assert.ok(clickableSegment, `${theme} classic statusbar must expose a clickable segment`)
    await clickableSegment.hover()
    // The segment deliberately transitions its background color.  Sample after
    // the transition settles so this is a semantic color assertion rather than
    // an assertion about the transition's transparent starting frame.
    await page.waitForTimeout(180)
    assert.equal(
      await clickableSegment.evaluate(element => element.matches(':hover')),
      true,
      `${theme} classic statusbar clickable segment must receive the hover state`,
    )
    const expectedHover = await computedTokenColor(page, statusbarHover.token)
    const hoverState = await clickableSegment.evaluate(element => {
      const style = getComputedStyle(element)
      return {
        backgroundColor: style.backgroundColor,
        background: style.background,
        themeHover: style.getPropertyValue('--writer-statusbar-hover').trim(),
        inlineStyle: element.getAttribute('style'),
      }
    })
    const hoverLabel = `${theme} classic statusbar clickable hover background (var=${hoverState.themeHover}, inline=${hoverState.inlineStyle}, background=${hoverState.background})`
    assertColorMatches(hoverState.backgroundColor, expectedHover, hoverLabel)
    const actualHover = hoverState.backgroundColor
    themeEvidence.statusbarHover = actualHover
    evidence.push(themeEvidence)
    if (themeIndex < themed.length - 1) await openAppearanceSettings(page)
  }
  return evidence
}

async function assertClassicPaperUsesSemanticSurfaces(page) {
  await openAppearanceSettings(page)
  await selectTheme(page, RENDERER_SURFACE_E2E_CONTRACT.classicThemeSurfaces.paper)
  await closeSettings(page)
  const projectTree = await computedSurface(page, '.writer-project-tree', 'paper classic project tree')
  const expectedProjectTree = await computedTokenColor(page, '--color-sidebar')
  assertColorMatches(projectTree.backgroundColor, expectedProjectTree, 'paper classic project tree background')
  const chrome = await page.locator('.writer-topbar, .writer-left-rail').evaluateAll(elements => elements.map((element) => getComputedStyle(element).backgroundImage))
  assert.ok(chrome.every(backgroundImage => backgroundImage === 'none'), 'paper classic chrome must use flat paper-ink surfaces, not warm gradients')
  return { projectTree: projectTree.backgroundColor, chrome }
}

async function runRendererSurfaceE2e() {
  assert.ok(existsSync(join(repositoryRoot, 'dist', 'index.html')), 'Run `pnpm run build` before the renderer surface E2E')
  assert.ok(existsSync(join(repositoryRoot, 'dist-electron', 'main.js')), 'Electron build output is missing')

  const fixture = createIsolatedFixture()
  let electronApp
  let nativeRuntimePreparationAttempted = false
  const diagnostics = []
  const captureDiagnostic = value => {
    diagnostics.push(String(value))
    if (diagnostics.length > 40) diagnostics.shift()
  }
  try {
    // Repository unit tests use the host Node ABI, while the real renderer
    // requires Electron's ABI. Reuse the project's established transitions and
    // always restore the host ABI before returning control to the developer.
    nativeRuntimePreparationAttempted = true
    runProjectScript('rebuild:electron')

    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    environment.AI_NOVEL_VELA_HOME = fixture.velaHome
    environment.AI_NOVEL_SMOKE_OPEN_PROJECT = fixture.projectRoot
    environment.AI_NOVEL_SMOKE_PROJECT_MARKER = fixture.markerPath

    electronApp = await electron.launch({
      args: ['.'],
      cwd: repositoryRoot,
      env: environment,
      timeout: RUNNER_TIMEOUT_MS,
    })
    electronApp.process().stdout?.on('data', chunk => captureDiagnostic(`[main:stdout] ${chunk}`))
    electronApp.process().stderr?.on('data', chunk => captureDiagnostic(`[main:stderr] ${chunk}`))
    const page = await electronApp.firstWindow({ timeout: RUNNER_TIMEOUT_MS })
    page.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warning') {
        captureDiagnostic(`[renderer:${message.type()}] ${message.text()}`)
      }
    })
    page.on('pageerror', error => captureDiagnostic(`[renderer:pageerror] ${error.stack ?? error.message}`))
    await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: RUNNER_TIMEOUT_MS })
    try {
      await waitForFile(fixture.markerPath)
    } catch (error) {
      const rendererState = await page.evaluate(() => ({
        skin: document.querySelector('.app-skin-root')?.getAttribute('data-skin'),
        theme: document.querySelector('.app-skin-root')?.getAttribute('data-theme'),
        bodyText: document.body.innerText.slice(0, 800),
      })).catch(() => null)
      const detail = diagnostics.join('\n').slice(-8_000)
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nRenderer state: ${JSON.stringify(rendererState)}\n${detail}`)
    }
    const marker = JSON.parse(readFileSync(fixture.markerPath, 'utf8'))
    assert.equal(resolve(marker.projectPath), resolve(fixture.projectRoot), 'Renderer opened a different project fixture')

    await openAppearanceSettings(page)
    await selectImageSkin(page, 'anime')
    const themes = await assertImageSkinThemes(page)
    await closeSettings(page)
    const routes = await assertReachableRoutes(page)

    await openAppearanceSettings(page)
    await selectImageSkin(page, 'classic')
    const classicThemes = await assertClassicThemeSurfaces(page)
    const classicPaper = await assertClassicPaperUsesSemanticSurfaces(page)

    return {
      schemaVersion: 1,
      kind: 'renderer-surface-e2e',
      imageSkin: 'anime',
      themes,
      routes,
      classic: {
        themes: classicThemes,
        paper: classicPaper,
      },
    }
  } finally {
    if (electronApp) await electronApp.close().catch(() => {})
    rmSync(fixture.temporaryRoot, { recursive: true, force: true })
    if (nativeRuntimePreparationAttempted) runProjectScript('prepare:native-node')
  }
}

const isMain = process.argv[1]
  && resolve(process.argv[1]).toLocaleLowerCase('en-US') === resolve(scriptPath).toLocaleLowerCase('en-US')

if (isMain) {
  runRendererSurfaceE2e()
    .then(evidence => process.stdout.write(`${JSON.stringify(evidence)}\n`))
    .catch(error => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error))
      process.exitCode = 1
    })
}

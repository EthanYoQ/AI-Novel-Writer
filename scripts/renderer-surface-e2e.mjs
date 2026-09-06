/* global process */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
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
  visualEvidence: Object.freeze({
    outputEnvironment: 'AI_NOVEL_RENDERER_VISUAL_EVIDENCE_DIR',
    viewport: Object.freeze({ width: 1440, height: 900 }),
    state: Object.freeze({
      project: 'isolated-open-project-fixture',
      route: 'project/novel-configuration',
      panels: Object.freeze(['project-tree', 'ai-panel', 'task-table']),
    }),
    themes: Object.freeze(['light', 'galaxy', 'paper', 'dark']),
    imageSkins: Object.freeze(['classic', 'anime', 'custom']),
    sameStateSkinTheme: 'paper',
    persistence: Object.freeze({
      theme: 'dark',
      imageSkin: 'custom',
      relaunches: 1,
      stateProof: Object.freeze(['project-open-marker', 'app-skin-root']),
      requiresTreeReselection: false,
      failClosedGuards: Object.freeze([
        'fresh-project-marker',
        'no-visible-dialog',
        'no-project-open-failure',
        'novel-configuration-route-visible',
        'required-panels-visible',
        'matching-theme-and-image-skin',
        'background-image-decoded',
        'completed-current-run-receipt',
        'successful-electron-exit',
        'successful-node-abi-restore',
      ]),
      manifestWrite: 'candidate-then-atomic-after-postprocess',
    }),
  }),
  classicThemeSurfaces: Object.freeze({
    themed: Object.freeze(['light', 'galaxy', 'paper', 'dark']),
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
    approvedComputed: Object.freeze({
      light: Object.freeze({
        topbar: Object.freeze(['#FCFAF3', '#2B2A26']), leftRail: Object.freeze(['#F0EADA', '#6E6A5F']),
        projectTree: Object.freeze(['#F0EADA', '#2B2A26']), aiPanel: Object.freeze(['#F0EADA', '#2B2A26']),
        taskTable: Object.freeze(['#F0EADA', '#2B2A26']), workspacePage: Object.freeze(['#FCFAF3', '#2B2A26']),
        statusbar: Object.freeze(['#FCFAF3', '#6E6A5F']), statusbarHover: '#EAE3D2',
      }),
      galaxy: Object.freeze({
        topbar: Object.freeze(['#0A1628', '#8BA4BE']), leftRail: Object.freeze(['#071220', '#8BA4BE']),
        projectTree: Object.freeze(['#0E1B30', '#E0ECF4']), aiPanel: Object.freeze(['#0E1B30', '#E0ECF4']),
        taskTable: Object.freeze(['#0E1B30', '#E0ECF4']), workspacePage: Object.freeze(['#091525', '#E0ECF4']),
        statusbar: Object.freeze(['#071220', '#8BA4BE']), statusbarHover: '#142640',
      }),
      paper: Object.freeze({
        topbar: Object.freeze(['#FCFAF3', '#2B2A26']), leftRail: Object.freeze(['#F0EADA', '#6E6A5F']),
        projectTree: Object.freeze(['#F0EADA', '#2B2A26']), aiPanel: Object.freeze(['#F0EADA', '#2B2A26']),
        taskTable: Object.freeze(['#F0EADA', '#2B2A26']), workspacePage: Object.freeze(['#FCFAF3', '#2B2A26']),
        statusbar: Object.freeze(['#FCFAF3', '#6E6A5F']), statusbarHover: '#EAE3D2',
      }),
      dark: Object.freeze({
        topbar: Object.freeze(['#181818', '#CCCCCC']), leftRail: Object.freeze(['#333333', '#A0A0A0']),
        projectTree: Object.freeze(['#252526', '#D4D4D4']), aiPanel: Object.freeze(['#252526', '#D4D4D4']),
        taskTable: Object.freeze(['#252526', '#D4D4D4']), workspacePage: Object.freeze(['#1E1E1E', '#D4D4D4']),
        statusbar: Object.freeze(['#181818', '#A0A0A0']), statusbarHover: '#2A2D2E',
      }),
    }),
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
  const temporaryRoot = join(repositoryRoot, '.runtime', '.cache', 'renderer-surface-runs', randomUUID())
  const projectRoot = join(temporaryRoot, 'project')
  const velaHome = join(temporaryRoot, 'vela-home')
  const electronUserData = join(temporaryRoot, 'electron-user-data')
  const markerPath = join(temporaryRoot, 'project-opened.json')
  const manifestRoot = join(projectRoot, '.vela')
  mkdirSync(manifestRoot, { recursive: true })
  mkdirSync(velaHome, { recursive: true })
  mkdirSync(electronUserData, { recursive: true })
  writeFileSync(join(temporaryRoot, '.vibe-owner.json'), `${JSON.stringify({
    owner: 'codex/renderer-surface-e2e',
    sourceProject: 'AI-Novel-Writer',
    task: 'github-issue-97-real-electron',
    createdAt: new Date().toISOString(),
    ttlHours: 1,
    cleanupCommand: `Remove-Item -LiteralPath '${relative(repositoryRoot, temporaryRoot)}' -Recurse -Force`,
  }, null, 2)}\n`, 'utf8')
  writeFileSync(join(manifestRoot, 'project.json'), `${JSON.stringify({
    schemaVersion: 1,
    kind: 'ai-novel-project',
    projectId: randomUUID(),
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8')

  // 通过原生选择器写入的同一持久清单边界，预置仓库内的 PNG。
  // 这样无需自动操作系统对话框，仍能覆盖真实主进程服务、IPC、
  // Blob URL、渲染器解码及自定义图片皮肤的重启恢复路径。
  const customSource = join(repositoryRoot, 'build', 'icon.png')
  const customBytes = readFileSync(customSource)
  const customDimensions = pngDimensions(customBytes)
  const revision = createHash('sha256').update(customBytes).digest('hex')
  const skinRoot = join(velaHome, 'skins')
  const skinAssetRoot = join(skinRoot, 'assets')
  const assetFile = `${revision}.png`
  mkdirSync(skinAssetRoot, { recursive: true })
  copyFileSync(customSource, join(skinAssetRoot, assetFile))
  writeFileSync(join(skinRoot, 'manifest.json'), `${JSON.stringify({
    version: 1,
    activeSkin: 'classic',
    customSkin: {
      assetFile,
      mime: 'image/png',
      revision,
      ...customDimensions,
    },
  }, null, 2)}\n`, 'utf8')

  return { temporaryRoot, projectRoot, velaHome, electronUserData, markerPath }
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

export function prepareVisualEvidenceDirectory(configuredOverride) {
  const { outputEnvironment } = RENDERER_SURFACE_E2E_CONTRACT.visualEvidence
  const configuredPath = configuredOverride ?? process.env[outputEnvironment]?.trim()
  if (!configuredPath) return null

  const cacheRoot = resolve(repositoryRoot, '.runtime', '.cache')
  const outputDirectory = resolve(repositoryRoot, configuredPath)
  const cacheRelativePath = relative(cacheRoot, outputDirectory)
  assert.ok(
    cacheRelativePath && !cacheRelativePath.startsWith('..') && !isAbsolute(cacheRelativePath),
    `${outputEnvironment} must point inside the repository's .runtime/.cache directory`,
  )

  if (existsSync(outputDirectory)) {
    const ownerReceiptPath = join(outputDirectory, '.vibe-owner.json')
    assert.ok(existsSync(ownerReceiptPath), 'Existing visual evidence directory must have the expected owner receipt')
    let ownerReceipt
    try {
      ownerReceipt = JSON.parse(readFileSync(ownerReceiptPath, 'utf8'))
    } catch {
      throw new Error('Existing visual evidence directory has an invalid owner receipt')
    }
    assert.equal(
      ownerReceipt.owner,
      'codex/paper-ink-visual-qa',
      'Existing visual evidence directory must have the expected owner receipt',
    )
    rmSync(outputDirectory, { recursive: true, force: true })
  }

  mkdirSync(outputDirectory, { recursive: true })
  const createdAt = new Date()
  const expiresAt = new Date(createdAt.getTime() + (8 * 60 * 60 * 1000))
  writeFileSync(join(outputDirectory, '.vibe-owner.json'), `${JSON.stringify({
    owner: 'codex/paper-ink-visual-qa',
    sourceProject: 'AI-Novel-Writer',
    task: 'github-issue-97',
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ttlHours: 8,
    cleanupCommand: `Remove-Item -LiteralPath '${relative(repositoryRoot, outputDirectory)}' -Recurse -Force`,
  }, null, 2)}\n`, 'utf8')
  writeFileSync(join(outputDirectory, 'run-state.json'), `${JSON.stringify({
    schemaVersion: 1,
    kind: 'renderer-visual-qa-run',
    runId: randomUUID(),
    status: 'in-progress',
    startedAt: createdAt.toISOString(),
  }, null, 2)}\n`, 'utf8')
  return outputDirectory
}

function writeJsonAtomically(filePath, value, nonce = randomUUID()) {
  const temporaryPath = join(dirname(filePath), `.${filePath.split(/[\\/]/).at(-1)}-${nonce}.tmp`)
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporaryPath, filePath)
}

function markVisualEvidenceRunFailed(outputDirectory, failureStage) {
  const runStatePath = join(outputDirectory, 'run-state.json')
  const runState = JSON.parse(readFileSync(runStatePath, 'utf8'))
  const manifestPath = join(outputDirectory, 'manifest.json')
  const candidatePath = join(outputDirectory, '.manifest-candidate.json')
  if (existsSync(manifestPath)) unlinkSync(manifestPath)
  if (existsSync(candidatePath)) unlinkSync(candidatePath)
  writeJsonAtomically(runStatePath, {
    ...runState,
    status: 'failed',
    failureStage,
    failedAt: new Date().toISOString(),
  }, runState.runId)
}

export async function finalizeVisualEvidenceRun(outputDirectory, visualEvidence, postprocess) {
  const runStatePath = join(outputDirectory, 'run-state.json')
  const runState = JSON.parse(readFileSync(runStatePath, 'utf8'))
  assert.equal(runState.status, 'in-progress', 'Visual evidence run must still be in progress before finalization')
  const manifest = {
    ...visualEvidence,
    runId: runState.runId,
  }
  const manifestPath = join(outputDirectory, 'manifest.json')
  const candidatePath = join(outputDirectory, '.manifest-candidate.json')
  try {
    writeJsonAtomically(candidatePath, manifest, runState.runId)
  } catch (candidateError) {
    let postprocessError
    try {
      await postprocess()
    } catch (error) {
      postprocessError = error
    }
    markVisualEvidenceRunFailed(outputDirectory, 'candidate')
    if (postprocessError) {
      throw new AggregateError([candidateError, postprocessError], 'Visual evidence candidate and postprocess both failed')
    }
    throw candidateError
  }
  try {
    await postprocess()
    renameSync(candidatePath, manifestPath)
    writeJsonAtomically(runStatePath, {
      ...runState,
      status: 'completed',
      completedAt: new Date().toISOString(),
    }, runState.runId)
    return manifest
  } catch (error) {
    markVisualEvidenceRunFailed(outputDirectory, 'postprocess')
    throw error
  }
}

async function performRendererPostprocess(electronApp, fixture, restoreNativeRuntime) {
  const errors = []
  if (electronApp) {
    try {
      await quitElectronApp(electronApp, 'Final Electron QA session')
    } catch (error) {
      errors.push(error)
    }
  }
  try {
    rmSync(fixture.temporaryRoot, { recursive: true, force: true })
  } catch (error) {
    errors.push(error)
  }
  if (restoreNativeRuntime) {
    try {
      runProjectScript('prepare:native-node')
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'Renderer postprocess failed')
}

export function assertVisualEvidenceObservation(observation, expected) {
  assert.equal(resolve(observation.projectPath), resolve(expected.projectPath), 'Visual evidence opened a different project fixture')
  assert.ok(
    Date.parse(observation.markerOpenedAt ?? '') >= expected.launchStartedAt - 1_000,
    'Visual evidence project-open marker is stale',
  )
  assert.equal(observation.routeTitleVisible, true, 'Novel configuration route must be visible')
  assert.deepEqual(observation.panelsVisible, {
    projectTree: true,
    aiPanel: true,
    taskTable: true,
  }, 'Project tree, AI panel, and task table must all be visible')
  assert.equal(observation.visibleDialogCount, 0, 'Visual evidence must not contain a visible dialog')
  assert.doesNotMatch(
    observation.bodyText,
    /打开项目失败|Failed to open project|加载失败|Failed to load|发生错误|An error occurred/i,
    'Visual evidence must not contain a visible failure message',
  )
  assert.equal(observation.theme, expected.theme, 'Visual evidence restored a different theme')
  assert.equal(observation.imageSkin, expected.imageSkin, 'Visual evidence restored a different image skin')
  if ((expected.imageSurface ?? 'decoded') === 'opaque') {
    assert.equal(observation.workspaceAlpha, 1, 'Classic visual evidence workspace must remain opaque')
  } else {
    assert.equal(observation.imageDecoded, true, 'Visual evidence background image must decode')
    if (observation.workspaceAlpha != null) {
      assertClose(observation.workspaceAlpha, 0.60, IMAGE_SKIN_ALPHA_TOLERANCE, 'Image-skin workspace alpha')
    }
  }
}

async function assertCurrentVisualEvidenceState(page, fixture, launchStartedAt, expected) {
  const marker = JSON.parse(readFileSync(fixture.markerPath, 'utf8'))
  const root = page.locator('.app-skin-root')
  const backgroundImage = page.locator('.app-skin-background-image')
  const workspace = await computedSurface(page, '.skin-workspace-page', 'visual evidence workspace')
  const imageDecoded = await backgroundImage.count() > 0
    ? await backgroundImage.first().evaluate(element => element.complete && element.naturalWidth > 0)
    : null
  const observation = {
    projectPath: marker.projectPath,
    markerOpenedAt: marker.openedAt,
    routeTitleVisible: await page.locator('h2').filter({ hasText: /小说配置|Novel configuration/ }).first().isVisible(),
    panelsVisible: {
      projectTree: await page.locator('.writer-project-tree').first().isVisible(),
      aiPanel: await page.locator('.writer-ai-panel').first().isVisible(),
      taskTable: await page.locator('.writer-task-table').first().isVisible(),
    },
    visibleDialogCount: await page.locator('[role="dialog"]:visible').count(),
    bodyText: await page.locator('body').innerText(),
    theme: await root.getAttribute('data-theme'),
    imageSkin: await root.getAttribute('data-skin'),
    imageDecoded,
    workspaceAlpha: computedColorAlpha(workspace.backgroundColor),
  }
  assertVisualEvidenceObservation(observation, {
    projectPath: fixture.projectRoot,
    launchStartedAt,
    ...expected,
  })
  return observation
}

function pngDimensions(buffer) {
  const pngSignature = '89504e470d0a1a0a'
  assert.equal(buffer.subarray(0, 8).toString('hex'), pngSignature, 'Visual evidence must be a PNG screenshot')
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

async function captureVisualEvidence(page, outputDirectory, { theme, imageSkin, ordinal, phase = 'same-state' }) {
  if (!outputDirectory) return null

  const { viewport } = RENDERER_SURFACE_E2E_CONTRACT.visualEvidence
  await page.mouse.move(Math.floor(viewport.width / 2), Math.floor(viewport.height / 2))
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(100)

  const phaseSuffix = phase === 'relaunch' ? '-relaunched' : ''
  const file = `${String(ordinal).padStart(2, '0')}-${imageSkin}-${theme}${phaseSuffix}-open-project.png`
  const filePath = join(outputDirectory, file)
  await page.screenshot({
    path: filePath,
    animations: 'disabled',
    caret: 'hide',
    fullPage: false,
    scale: 'css',
  })

  const buffer = readFileSync(filePath)
  const dimensions = pngDimensions(buffer)
  assert.deepEqual(dimensions, viewport, `${theme} visual evidence must use the frozen viewport`)
  return {
    theme,
    imageSkin,
    phase,
    file,
    ...dimensions,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  }
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
  await modal.getByRole('button', { name: /关闭设置|Close settings/ }).click()
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

async function selectVisualQaState(page) {
  await clickNavigation(page, ['项目', 'Project'])
  await page.locator('.writer-project-tree .tree-item')
    .filter({ hasText: /小说配置|Novel configuration/ })
    .first()
    .click()
  await page.locator('h2').filter({ hasText: /小说配置|Novel configuration/ }).first()
    .waitFor({ state: 'visible', timeout: RUNNER_TIMEOUT_MS })
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

async function assertClassicThemeSurfaces(page, visualEvidenceDirectory, fixture, launchStartedAt) {
  const evidence = []
  const screenshots = []
  const { themed, surfaces, statusbarHover, approvedComputed } = RENDERER_SURFACE_E2E_CONTRACT.classicThemeSurfaces
  for (const [themeIndex, theme] of themed.entries()) {
    await selectTheme(page, theme)
    await closeSettings(page)
    await selectVisualQaState(page)
    const themeEvidence = { theme, surfaces: {} }
    for (const [surfaceName, contract] of Object.entries(surfaces)) {
      const surface = await computedSurface(page, contract.selector, `${theme} classic ${surfaceName}`, contract)
      const expectedBackground = await computedTokenColor(page, contract.token)
      const expectedText = await computedTokenColor(page, contract.textToken)
      assertColorMatches(surface.backgroundColor, expectedBackground, `${theme} classic ${surfaceName} background`)
      assertColorMatches(surface.color, expectedText, `${theme} classic ${surfaceName} text`)
      const [approvedBackground, approvedText] = approvedComputed[theme][surfaceName]
      assertColorMatches(surface.backgroundColor, approvedBackground, `${theme} classic ${surfaceName} approved background`)
      assertColorMatches(surface.color, approvedText, `${theme} classic ${surfaceName} approved text`)
      themeEvidence.surfaces[surfaceName] = {
        background: surface.backgroundColor,
        text: surface.color,
      }
    }
    await assertCurrentVisualEvidenceState(page, fixture, launchStartedAt, {
      theme,
      imageSkin: 'classic',
      imageSurface: 'opaque',
    })
    const screenshot = await captureVisualEvidence(page, visualEvidenceDirectory, {
      theme,
      imageSkin: 'classic',
      ordinal: themeIndex + 1,
    })
    if (screenshot) screenshots.push(screenshot)
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
    assertColorMatches(hoverState.backgroundColor, approvedComputed[theme].statusbarHover, `${theme} classic approved statusbar hover`)
    const actualHover = hoverState.backgroundColor
    themeEvidence.statusbarHover = actualHover
    evidence.push(themeEvidence)
    if (themeIndex < themed.length - 1) await openAppearanceSettings(page)
  }
  return { evidence, screenshots }
}

async function assertSameStateImageSkinEvidence(page, visualEvidenceDirectory, fixture, launchStartedAt) {
  const screenshots = []
  const contract = RENDERER_SURFACE_E2E_CONTRACT.visualEvidence
  await openAppearanceSettings(page)
  await selectTheme(page, contract.sameStateSkinTheme)

  for (const [skinIndex, imageSkin] of contract.imageSkins.entries()) {
    await selectImageSkin(page, imageSkin)
    await closeSettings(page)
    await selectVisualQaState(page)
    const root = page.locator('.app-skin-root')
    assert.equal(await root.getAttribute('data-skin'), imageSkin, `${imageSkin} must be the active image skin`)
    assert.equal(await root.getAttribute('data-theme'), contract.sameStateSkinTheme, `${imageSkin} must use the shared QA theme`)

    if (imageSkin === 'classic') {
      const pageSurface = await computedSurface(page, '.skin-workspace-page', 'classic same-state workspace')
      assert.equal(computedColorAlpha(pageSurface.backgroundColor), 1, 'classic same-state workspace must be opaque')
    } else {
      await assertSurfaceAlpha(page, 'page', 0.60, `${imageSkin} same-state workspace page`)
      const image = page.locator('.app-skin-background-image')
      await image.waitFor({ state: 'visible', timeout: RUNNER_TIMEOUT_MS })
      assert.ok(await image.evaluate(element => element.complete && element.naturalWidth > 0), `${imageSkin} background image must decode`)
    }

    // 四张经典皮肤主题截图已经包含序号 3 的同状态 classic/paper 证据；
    // 此处只补两张图片皮肤，避免重复证据。
    if (imageSkin !== 'classic') {
      await assertCurrentVisualEvidenceState(page, fixture, launchStartedAt, {
        theme: contract.sameStateSkinTheme,
        imageSkin,
        imageSurface: 'decoded',
      })
      const screenshot = await captureVisualEvidence(page, visualEvidenceDirectory, {
        theme: contract.sameStateSkinTheme,
        imageSkin,
        ordinal: 4 + skinIndex,
      })
      if (screenshot) screenshots.push(screenshot)
    }
    if (skinIndex < contract.imageSkins.length - 1) await openAppearanceSettings(page)
  }
  return screenshots
}

async function launchIsolatedElectron(fixture, captureDiagnostic) {
  if (existsSync(fixture.markerPath)) unlinkSync(fixture.markerPath)
  const launchStartedAt = Date.now()
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  environment.AI_NOVEL_VELA_HOME = fixture.velaHome
  environment.AI_NOVEL_SMOKE_OPEN_PROJECT = fixture.projectRoot
  environment.AI_NOVEL_SMOKE_PROJECT_MARKER = fixture.markerPath

  const electronApp = await electron.launch({
    args: ['.', `--user-data-dir=${fixture.electronUserData}`],
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
  await page.setViewportSize(RENDERER_SURFACE_E2E_CONTRACT.visualEvidence.viewport)
  await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: RUNNER_TIMEOUT_MS })
  await waitForFile(fixture.markerPath)
  const marker = JSON.parse(readFileSync(fixture.markerPath, 'utf8'))
  assert.equal(resolve(marker.projectPath), resolve(fixture.projectRoot), 'Renderer opened a different project fixture')
  assert.ok(Date.parse(marker.openedAt ?? '') >= launchStartedAt - 1_000, 'Renderer project-open marker is stale')
  await page.locator('.writer-project-tree').waitFor({ state: 'visible', timeout: RUNNER_TIMEOUT_MS })
  assert.equal(await page.locator('[role="dialog"]:visible').count(), 0, 'Renderer exposed a dialog after opening the project')
  assert.doesNotMatch(await page.locator('body').innerText(), /打开项目失败|Failed to open project/i)
  return { electronApp, page, launchStartedAt }
}

export async function quitElectronApp(electronApp, label) {
  const child = electronApp.process()
  if (child.exitCode !== null || child.signalCode !== null) {
    assert.equal(child.signalCode, null, `${label} did not exit cleanly (signal: ${child.signalCode})`)
    assert.equal(child.exitCode, 0, `${label} did not exit cleanly (code: ${child.exitCode})`)
    return
  }
  const exited = new Promise(resolvePromise => child.once('exit', (code, signal) => resolvePromise({ code, signal })))
  try {
    await electronApp.evaluate(({ app }) => {
      setTimeout(() => app.quit(), 0)
      return true
    })
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) throw error
  }
  const exit = await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`${label} did not exit after app.quit()`)),
      10_000,
    )),
  ])
  assert.equal(exit.signal, null, `${label} did not exit cleanly (signal: ${exit.signal})`)
  assert.equal(exit.code, 0, `${label} did not exit cleanly (code: ${exit.code})`)
}

async function assertPersistedAppearanceAcrossRelaunch(page, electronApp, fixture, visualEvidenceDirectory, captureDiagnostic) {
  const contract = RENDERER_SURFACE_E2E_CONTRACT.visualEvidence.persistence
  await openAppearanceSettings(page)
  await selectTheme(page, contract.theme)
  await selectImageSkin(page, contract.imageSkin)
  await closeSettings(page)
  await selectVisualQaState(page)

  const beforeClose = await page.locator('.app-skin-root').evaluate(element => ({
    theme: element.getAttribute('data-theme'),
    imageSkin: element.getAttribute('data-skin'),
  }))
  assert.deepEqual(beforeClose, { theme: contract.theme, imageSkin: contract.imageSkin })

  await quitElectronApp(electronApp, 'First Electron QA session')

  const relaunched = await launchIsolatedElectron(fixture, captureDiagnostic)
  await relaunched.page.waitForFunction(
    expected => {
      const root = document.querySelector('.app-skin-root')
      return root?.getAttribute('data-theme') === expected.theme
        && root?.getAttribute('data-skin') === expected.imageSkin
    },
    contract,
    { timeout: RUNNER_TIMEOUT_MS },
  )
  const afterRelaunch = await relaunched.page.locator('.app-skin-root').evaluate(element => ({
    theme: element.getAttribute('data-theme'),
    imageSkin: element.getAttribute('data-skin'),
  }))
  assert.deepEqual(afterRelaunch, beforeClose, 'theme and image skin must survive a real Electron relaunch')
  const customImage = relaunched.page.locator('.app-skin-background-image')
  await customImage.waitFor({ state: 'visible', timeout: RUNNER_TIMEOUT_MS })
  assert.ok(await customImage.evaluate(element => element.complete && element.naturalWidth > 0), 'restored custom image must decode after relaunch')
  const visualState = await assertCurrentVisualEvidenceState(
    relaunched.page,
    fixture,
    relaunched.launchStartedAt,
    {
      theme: contract.theme,
      imageSkin: contract.imageSkin,
      imageSurface: 'decoded',
    },
  )
  const screenshot = await captureVisualEvidence(relaunched.page, visualEvidenceDirectory, {
    theme: contract.theme,
    imageSkin: contract.imageSkin,
    ordinal: 7,
    phase: 'relaunch',
  })

  return {
    electronApp: relaunched.electronApp,
    evidence: {
      appSessions: contract.relaunches + 1,
      beforeClose,
      afterRelaunch,
      visualState,
      screenshot,
    },
  }
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

  const visualEvidenceDirectory = prepareVisualEvidenceDirectory()
  const fixture = createIsolatedFixture()
  try {
    let electronApp
    let nativeRuntimePreparationAttempted = false
    let runEvidence
    let visualEvidence = null
    let executionError
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

      const launched = await launchIsolatedElectron(fixture, captureDiagnostic)
      electronApp = launched.electronApp
      const page = launched.page
      try {
        assert.ok(existsSync(fixture.markerPath))
      } catch (error) {
        const rendererState = await page.evaluate(() => ({
          skin: document.querySelector('.app-skin-root')?.getAttribute('data-skin'),
          theme: document.querySelector('.app-skin-root')?.getAttribute('data-theme'),
          bodyText: document.body.innerText.slice(0, 800),
        })).catch(() => null)
        const detail = diagnostics.join('\n').slice(-8_000)
        throw new Error(`${error instanceof Error ? error.message : String(error)}\nRenderer state: ${JSON.stringify(rendererState)}\n${detail}`)
      }
      await openAppearanceSettings(page)
      await selectImageSkin(page, 'anime')
      const themes = await assertImageSkinThemes(page)
      await closeSettings(page)
      const routes = await assertReachableRoutes(page)

      await openAppearanceSettings(page)
      await selectImageSkin(page, 'classic')
      const { evidence: classicThemes, screenshots } = await assertClassicThemeSurfaces(
        page,
        visualEvidenceDirectory,
        fixture,
        launched.launchStartedAt,
      )
      const classicPaper = await assertClassicPaperUsesSemanticSurfaces(page)
      const imageSkinScreenshots = await assertSameStateImageSkinEvidence(
        page,
        visualEvidenceDirectory,
        fixture,
        launched.launchStartedAt,
      )

      const persistenceResult = await assertPersistedAppearanceAcrossRelaunch(
        page,
        electronApp,
        fixture,
        visualEvidenceDirectory,
        captureDiagnostic,
      )
      electronApp = persistenceResult.electronApp

      if (visualEvidenceDirectory) {
        const contract = RENDERER_SURFACE_E2E_CONTRACT.visualEvidence
        visualEvidence = {
          schemaVersion: 1,
          kind: 'renderer-visual-qa',
          viewport: contract.viewport,
          state: contract.state,
          screenshots: [
            ...screenshots,
            ...imageSkinScreenshots,
            ...(persistenceResult.evidence.screenshot ? [persistenceResult.evidence.screenshot] : []),
          ],
          persistence: {
            appSessions: persistenceResult.evidence.appSessions,
            beforeClose: persistenceResult.evidence.beforeClose,
            afterRelaunch: persistenceResult.evidence.afterRelaunch,
          },
        }
      }

      runEvidence = {
        schemaVersion: 1,
        kind: 'renderer-surface-e2e',
        imageSkin: 'anime',
        themes,
        routes,
        classic: {
          themes: classicThemes,
          paper: classicPaper,
        },
        visualEvidence,
      }
    } catch (error) {
      executionError = error
    }

    const postprocess = () => performRendererPostprocess(
      electronApp,
      fixture,
      nativeRuntimePreparationAttempted,
    )

    if (executionError) {
      const errors = [executionError]
      try {
        await postprocess()
      } catch (error) {
        errors.push(error)
      }
      if (visualEvidenceDirectory) markVisualEvidenceRunFailed(visualEvidenceDirectory, 'execution')
      if (errors.length > 1) throw new AggregateError(errors, 'Renderer validation and postprocess both failed')
      throw executionError
    }

    if (visualEvidenceDirectory) {
      const finalizedManifest = await finalizeVisualEvidenceRun(
        visualEvidenceDirectory,
        visualEvidence,
        postprocess,
      )
      runEvidence.visualEvidence = finalizedManifest
    } else {
      await postprocess()
    }
    return runEvidence
  } finally {
    rmSync(fixture.temporaryRoot, { recursive: true, force: true })
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

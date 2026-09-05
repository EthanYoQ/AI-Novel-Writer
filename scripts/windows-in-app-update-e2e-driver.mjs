/* eslint-env node */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

const scriptPath = fileURLToPath(import.meta.url)

const checkUpdateNames = /^(检查更新|Check for updates)$/
const downloadUpdateNames = /^(下载更新|Download update)$/
const restartUpdateNames = /^(立即重启更新|Restart and update now)$/

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function delay(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
}

function usage() {
  return [
    'Usage: node scripts/windows-in-app-update-e2e-driver.mjs <trigger|verify>',
    '--endpoint <http://127.0.0.1:port> --expected-version <X.Y.Z> --evidence-root <path>',
  ].join(' ')
}

function parseCli(argv) {
  const [command, ...options] = argv
  if (command !== 'trigger' && command !== 'verify') throw new Error(usage())
  const values = new Map()
  for (let index = 0; index < options.length; index += 2) {
    const key = options[index]
    const value = options[index + 1]
    if (!['--endpoint', '--expected-version', '--evidence-root'].includes(key) || !value || values.has(key)) {
      throw new Error(usage())
    }
    values.set(key, value)
  }
  const endpoint = values.get('--endpoint')
  const expectedVersion = values.get('--expected-version')
  const evidenceRoot = values.get('--evidence-root')
  if (!endpoint || !expectedVersion || !evidenceRoot || values.size !== 3) throw new Error(usage())
  assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint), 'CDP endpoint must be a loopback HTTP endpoint')
  assert(/^\d+\.\d+\.\d+$/.test(expectedVersion), 'Expected version must be a final semantic version')
  return { command, endpoint, expectedVersion, evidenceRoot: resolve(evidenceRoot) }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function findApplicationPage(browser, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.isClosed()) continue
        try {
          await page.locator('body').waitFor({ state: 'attached', timeout: 250 })
          return page
        } catch {
          // The target can appear while Electron is still loading its renderer.
        }
      }
    }
    await delay(100)
  }
  throw new Error('Timed out waiting for an Electron renderer page over CDP')
}

async function connect(endpoint) {
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 20_000 })
  const page = await findApplicationPage(browser, 20_000)
  return { browser, page }
}

function attachPageDiagnostics(page, evidence) {
  page.on('console', message => {
    evidence.console.push({ type: message.type(), text: message.text() })
  })
  page.on('pageerror', error => {
    evidence.pageErrors.push(error.message)
  })
}

async function waitForAvailableUpdateControl(checkButton, downloadButton, restartButton, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    if (await restartButton.isVisible().catch(() => false)) return 'restart'
    if (
      await downloadButton.isVisible().catch(() => false)
      && await downloadButton.isEnabled().catch(() => false)
    ) return 'download'
    const checkIsReady = await checkButton.isVisible().catch(() => false)
      && await checkButton.isEnabled().catch(() => false)
    if (checkIsReady) return 'check'
    await delay(250)
  }
  throw new Error('Timed out waiting for an update check, download, or restart action')
}

async function triggerRealUpdate({ endpoint, expectedVersion, evidenceRoot }) {
  const screenshots = join(evidenceRoot, 'screenshots')
  mkdirSync(screenshots, { recursive: true })
  const evidence = {
    schemaVersion: 1,
    kind: 'windows-in-app-update-e2e-ui-trigger',
    endpoint,
    expectedVersion,
    startedAt: new Date().toISOString(),
    console: [],
    pageErrors: [],
    usedControl: null,
    downloadControl: null,
    restartControl: null,
  }
  let browser
  try {
    const connected = await connect(endpoint)
    browser = connected.browser
    const { page } = connected
    attachPageDiagnostics(page, evidence)
    await page.screenshot({ path: join(screenshots, 'before-check-update.png'), fullPage: true })

    const restartButton = page.getByRole('button', { name: restartUpdateNames })
    const downloadButton = page.getByRole('button', { name: downloadUpdateNames })
    const checkButton = page.getByRole('button', { name: checkUpdateNames })
    const availableControl = await waitForAvailableUpdateControl(checkButton, downloadButton, restartButton, 300_000)
    if (availableControl === 'check') {
      evidence.usedControl = await checkButton.innerText()
      await checkButton.click()
      await downloadButton.waitFor({ state: 'visible', timeout: 300_000 })
      evidence.downloadControl = await downloadButton.innerText()
      await downloadButton.click()
    } else if (availableControl === 'download') {
      evidence.usedControl = 'startup-auto-check'
      evidence.downloadControl = await downloadButton.innerText()
      await downloadButton.click()
    } else {
      evidence.usedControl = 'already-downloaded'
    }

    await restartButton.waitFor({ state: 'visible', timeout: 300_000 })
    evidence.restartControl = await restartButton.innerText()
    await page.screenshot({ path: join(screenshots, 'ready-to-restart-update.png'), fullPage: true })

    // This is the live renderer action that reaches UpdateService.requestInstall
    // and Electron's real autoUpdater.quitAndInstall; no test IPC shortcut is used.
    await restartButton.click({ noWaitAfter: true })
    evidence.quitAndInstallRequestedAt = new Date().toISOString()
  } finally {
    evidence.finishedAt = new Date().toISOString()
    writeJson(join(evidenceRoot, 'ui-trigger.json'), evidence)
    await browser?.close().catch(() => undefined)
  }
}

async function verifyRestartedVersion({ endpoint, expectedVersion, evidenceRoot }) {
  const screenshots = join(evidenceRoot, 'screenshots')
  mkdirSync(screenshots, { recursive: true })
  const evidence = {
    schemaVersion: 1,
    kind: 'windows-in-app-update-e2e-ui-restart',
    endpoint,
    expectedVersion,
    startedAt: new Date().toISOString(),
    console: [],
    pageErrors: [],
  }
  let browser
  try {
    const connected = await connect(endpoint)
    browser = connected.browser
    const { page } = connected
    attachPageDiagnostics(page, evidence)
    const state = await page.evaluate(async () => {
      const api = window.velaAPI
      if (!api) throw new Error('Installed renderer did not expose the preload API')
      return await api.invoke('update:get-state')
    })
    assert(
      state != null && typeof state === 'object' && state.currentVersion === expectedVersion,
      `Restarted application reports ${state?.currentVersion ?? '(missing)'} instead of expected ${expectedVersion}`,
    )
    evidence.updateState = state
    await page.screenshot({ path: join(screenshots, `restarted-${expectedVersion}.png`), fullPage: true })
    evidence.versionVerifiedAt = new Date().toISOString()
  } finally {
    evidence.finishedAt = new Date().toISOString()
    writeJson(join(evidenceRoot, 'ui-restart.json'), evidence)
    await browser?.close().catch(() => undefined)
  }
}

async function main() {
  const options = parseCli(process.argv.slice(2))
  if (options.command === 'trigger') {
    await triggerRealUpdate(options)
  } else {
    await verifyRestartedVersion(options)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  })
}

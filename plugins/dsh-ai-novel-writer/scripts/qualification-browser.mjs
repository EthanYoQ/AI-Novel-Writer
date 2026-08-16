#!/usr/bin/env node
/** Real-browser probe for the installed AI Novel Writer client bundle. */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import process from 'node:process'

const [url, sourceRoot] = process.argv.slice(2)
if (url === undefined || sourceRoot === undefined) {
  throw new Error('qualification browser requires the Web URL and source repository root')
}

const require = createRequire(join(sourceRoot, 'package.json'))
const { chromium } = require('playwright')

async function finishOnboarding(page) {
  const deadline = Date.now() + 30_000
  const continueButton = page.getByRole('button', { name: /^(?:继续|Continue)$/ })
  const laterButton = page.getByRole('button', { name: /^(?:稍后配置|Configure later)$/ })
  while (Date.now() < deadline) {
    if (await clickWhenActionable(continueButton)) {
      continue
    }
    if (await clickWhenActionable(laterButton)) {
      continue
    }
    if (await page.locator('#root').evaluate(root => !root.inert)) return
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

async function clickContextTrigger(page, trigger) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    await finishOnboarding(page)
    try {
      await trigger.click({ timeout: 2_000 })
      return
    } catch (error) {
      if (!(error instanceof Error && error.name === 'TimeoutError')) throw error
    }
  }
  throw new Error('AI novel context trigger never became actionable')
}

const browser = await chromium.launch({ headless: true })
let result
let bodyError
try {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', error => { pageErrors.push(error.message) })
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.locator('#root').waitFor({ state: 'attached', timeout: 30_000 })
  await finishOnboarding(page)
  const trigger = page.getByRole('button', { name: '打开小说上下文' })
  await trigger.waitFor({ state: 'visible', timeout: 60_000 })
  await clickContextTrigger(page, trigger)
  await page.getByRole('dialog', { name: '小说上下文' }).waitFor({ state: 'visible', timeout: 30_000 })
  const install = page.getByRole('button', { name: '安装 AI 小说作家 Preset' })
  const installed = page.getByText('Preset 已安装。')
  await Promise.race([
    install.waitFor({ state: 'visible', timeout: 30_000 }),
    installed.waitFor({ state: 'visible', timeout: 30_000 }),
  ])
  if (await install.isVisible()) await install.click()
  await installed.waitFor({ state: 'visible', timeout: 30_000 })
  const graph = await page.evaluate(() => window.__DSH_BOOT__)
  if (pageErrors.length > 0) throw new Error(`browser page errors: ${pageErrors.join(' | ')}`)
  result = { graph, contextWindowOpened: true, presetInstalled: true }
} catch (error) {
  bodyError = error
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

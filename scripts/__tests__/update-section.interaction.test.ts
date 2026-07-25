import { existsSync } from 'node:fs'
import path from 'node:path'

import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'

const repositoryRoot = path.resolve('.')
const chromeExecutable = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const describeWithChrome = existsSync(chromeExecutable) ? describe : describe.skip

describeWithChrome('UpdateSection browser interactions', () => {
  let server: ViteDevServer
  let browser: Browser
  let pageUrl: string

  beforeAll(async () => {
    server = await createServer({
      root: repositoryRoot,
      configFile: false,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      appType: 'spa',
    })
    await server.listen()
    const address = server.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Unable to determine browser harness address')
    pageUrl = `http://127.0.0.1:${address.port}/scripts/browser-fixtures/update-section-harness.html`
    browser = await chromium.launch({ executablePath: chromeExecutable, headless: true })
  })

  afterAll(async () => {
    await browser?.close()
    await server?.close()
  })

  async function openHarness(): Promise<Page> {
    const page = await browser.newPage()
    await page.goto(pageUrl)
    await page.getByRole('button', { name: '立即重启更新' }).waitFor()
    return page
  }

  it('requires an explicit save-or-discard decision before restarting an update with dirty tabs', async () => {
    const page = await openHarness()

    await page.getByRole('button', { name: '立即重启更新' }).click()
    expect(await page.getByText('请先处理未保存的修改').isVisible()).toBe(true)
    expect(await page.evaluate(() => window.__updateHarness.installCalls)).toBe(0)

    await page.getByRole('button', { name: '返回保存' }).click()
    expect(await page.evaluate(() => window.__updateHarness.installCalls)).toBe(0)

    await page.getByRole('button', { name: '立即重启更新' }).click()
    await page.getByRole('button', { name: '放弃修改并重启更新' }).click()
    await page.waitForFunction(() => window.__updateHarness.installCalls === 1)
    expect(await page.evaluate(() => window.__updateHarness.installCalls)).toBe(1)
    await page.close()
  }, 15_000)

  it('offers an explicit later action after download and postpones the reminder for seven days', async () => {
    const page = await openHarness()

    await page.getByRole('button', { name: '检查更新' }).click()
    await page.waitForFunction(() => window.__updateHarness.checkCalls === 1)
    await page.getByRole('button', { name: '稍后（7天后提醒）', exact: true }).click()
    await page.waitForFunction(() => window.__updateHarness.deferCalls.includes(7))

    expect(await page.evaluate(() => window.__updateHarness.checkCalls)).toBe(1)
    expect(await page.evaluate(() => window.__updateHarness.deferCalls)).toEqual([7])
    expect(await page.getByText('更新已准备就绪').count()).toBe(0)
    await page.close()
  }, 15_000)

  it('uses the visible thirty-day action to postpone a downloaded update', async () => {
    const page = await openHarness()

    await page.getByRole('button', { name: '30 天后提醒', exact: true }).click()
    await page.waitForFunction(() => window.__updateHarness.deferCalls.includes(30))

    expect(await page.evaluate(() => window.__updateHarness.deferCalls)).toEqual([30])
    expect(await page.getByText('更新已准备就绪').count()).toBe(0)
    await page.close()
  }, 15_000)

  it('treats closing the update card as a seven-day reminder postponement', async () => {
    const page = await openHarness()

    await page.getByRole('button', { name: '关闭并在 7 天后提醒' }).click()
    await page.waitForFunction(() => window.__updateHarness.deferCalls.includes(7))

    expect(await page.evaluate(() => window.__updateHarness.deferCalls)).toEqual([7])
    expect(await page.getByText('更新已准备就绪').count()).toBe(0)
    await page.close()
  }, 15_000)
})

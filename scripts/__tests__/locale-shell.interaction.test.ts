import { existsSync } from 'node:fs'
import path from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'

const repositoryRoot = path.resolve('.')
const chromeExecutable = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const describeWithChrome = existsSync(chromeExecutable) ? describe : describe.skip

describeWithChrome('locale shell browser regression', () => {
  let server: ViteDevServer
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    server = await createServer({
      root: repositoryRoot,
      configFile: false,
      plugins: [tailwindcss(), react()],
      define: { __APP_VERSION__: JSON.stringify('0.9.2') },
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      appType: 'spa',
    })
    await server.listen()
    const address = server.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Unable to determine browser harness address')
    browser = await chromium.launch({ executablePath: chromeExecutable, headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(`http://127.0.0.1:${address.port}/scripts/browser-fixtures/locale-shell-harness.html`)
    await page.getByText('欢迎使用 AI小说作家').waitFor()
  }, 30_000)

  afterAll(async () => {
    await page?.close()
    await browser?.close()
    await server?.close()
  }, 30_000)

  it('updates mounted shell components immediately and keeps the update card readable at 448px', async () => {
    expect(await page.locator('.writer-topbar').getByText('AI小说作家', { exact: true }).count()).toBe(1)
    expect(await page.locator('.writer-topbar').getByText('AI Novel Writer', { exact: true }).count()).toBe(1)
    expect(await page.locator('.writer-statusbar').getByText('AI小说作家', { exact: true }).count()).toBe(1)

    await page.getByTestId('switch-to-english').click()

    await expect.poll(() => page.getByText('Welcome to AI Novel Writer').count()).toBe(1)
    expect(await page.getByText('AI Writing Assistant', { exact: true }).count()).toBe(1)
    expect(await page.getByText('Your AI creative assistant', { exact: false }).count()).toBe(1)
    expect(await page.getByText('Model calls', { exact: true }).count()).toBe(1)
    expect(await page.getByText('欢迎使用 AI小说作家').count()).toBe(0)
    expect(await page.getByText('AI小说作家', { exact: true }).count()).toBe(0)
    expect(await page.locator('.writer-topbar').getByText('AI Novel Writer', { exact: true }).count()).toBe(1)
    expect(await page.locator('.writer-statusbar').getByText('AI Novel Writer', { exact: true }).count()).toBe(1)

    const measurements = await page.locator('section[aria-label="App updates"] > div').first().evaluate((card) => {
      const copy = card.querySelector('div')!
      const title = copy.querySelector('span')!
      const description = copy.querySelector('p')!
      const lineCount = (element: Element) => {
        const range = document.createRange()
        range.selectNodeContents(element)
        return new Set(Array.from(range.getClientRects(), rect => Math.round(rect.top))).size
      }
      return {
        cardWidth: Math.round(card.getBoundingClientRect().width),
        copyWidth: Math.round(copy.getBoundingClientRect().width),
        titleLines: lineCount(title),
        descriptionLines: lineCount(description),
      }
    })

    expect(measurements.cardWidth).toBe(448)
    expect(measurements.copyWidth).toBeGreaterThan(200)
    expect(measurements.titleLines).toBe(1)
    expect(measurements.descriptionLines).toBeLessThanOrEqual(2)
  })
})

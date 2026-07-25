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

  it.each(['running', 'paused', 'waiting', 'completed', 'failed'] as const)(
    'blocks restarting an update while a %s workflow may still have unpersisted results',
    async (status) => {
      const page = await openHarness()
      await page.evaluate((nextStatus) => {
        window.__updateHarness.setActiveWorkflowStatuses([nextStatus])
      }, status)

      await page.getByRole('button', { name: '立即重启更新' }).click()

      expect(await page.getByText('创作任务尚未结束，暂不能更新').isVisible()).toBe(true)
      expect(await page.getByText(/结果可能尚未完整写入项目/).isVisible()).toBe(true)
      expect(await page.evaluate(() => window.__updateHarness.installCalls)).toBe(0)
      expect(await page.getByText('请先处理未保存的修改').count()).toBe(0)
      await page.close()
    },
    15_000,
  )

  it('rechecks workflows before the final discard-and-install action', async () => {
    const page = await openHarness()

    await page.getByRole('button', { name: '立即重启更新' }).click()
    expect(await page.getByText('请先处理未保存的修改').isVisible()).toBe(true)

    await page.evaluate(() => {
      window.__updateHarness.setActiveWorkflowStatuses(['running'])
    })
    await page.getByRole('button', { name: '放弃修改并重启更新' }).click()

    expect(await page.getByText('创作任务尚未结束，暂不能更新').isVisible()).toBe(true)
    expect(await page.evaluate(() => window.__updateHarness.installCalls)).toBe(0)
    await page.close()
  }, 15_000)

  it('does not recheck after download and offers an explicit seven-day later action', async () => {
    const page = await openHarness()

    expect(await page.getByRole('button', { name: '检查更新' }).isDisabled()).toBe(true)
    await page.getByRole('button', { name: '稍后（7天后提醒）', exact: true }).click()
    await page.waitForFunction(() => window.__updateHarness.deferCalls.includes(7))

    expect(await page.evaluate(() => window.__updateHarness.checkCalls)).toBe(0)
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

  it('keeps the official homepage beside the update action and invokes its fixed no-argument intent', async () => {
    const page = await openHarness()
    const actionGroup = page.getByTestId('update-entry-actions')

    expect((await actionGroup.getByRole('button').allTextContents()).map(label => label.trim()))
      .toEqual(['官方主页', '检查更新'])
    expect(await actionGroup.evaluate((element) => {
      const [homepage, update] = Array.from(element.querySelectorAll('button'))
      if (!homepage || !update) return false
      const homepageBox = homepage.getBoundingClientRect()
      const updateBox = update.getBoundingClientRect()
      return homepageBox.right <= updateBox.left && Math.abs(homepageBox.top - updateBox.top) < 1
    })).toBe(true)

    await page.getByRole('button', { name: '官方主页' }).click()
    await page.waitForFunction(() => {
      const harness = (window as unknown as { __updateHarness: { officialHomepageRequests: unknown[] } }).__updateHarness
      return harness.officialHomepageRequests.length === 1
    })

    expect(await page.evaluate(() => (
      (window as unknown as { __updateHarness: { officialHomepageRequests: unknown[] } }).__updateHarness.officialHomepageRequests
    ))).toEqual([{ channel: 'official-homepage:open', args: [] }])
    await page.close()
  }, 15_000)

  it('uses English homepage copy and shows a localized error when its trusted intent fails', async () => {
    const page = await openHarness()

    await page.evaluate(() => {
      const harness = (window as unknown as {
        __updateHarness: {
          setLocale: (locale: 'en-US') => void
          setOfficialHomepageFailure: (shouldFail: boolean) => void
        }
      }).__updateHarness
      harness.setLocale('en-US')
      harness.setOfficialHomepageFailure(true)
    })

    await page.getByRole('button', { name: 'Official homepage' }).click()
    expect(await page.getByText('Unable to open the official homepage. Please try again later.').isVisible()).toBe(true)
    await page.close()
  }, 15_000)
})

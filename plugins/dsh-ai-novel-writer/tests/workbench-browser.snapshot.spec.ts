/** Optional real-DSH browser snapshot for the AI novel workbench tracer bullet. */

import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const harnessRoot = process.env.DSH_HARNESS_ROOT
const realHarnessIt = harnessRoot === undefined ? it.skip : it
const expectedPath = join(import.meta.dirname, 'snapshots', 'workbench-browser.expected.json')

describe('AI novel real DSH Web snapshot', () => {
  realHarnessIt('shows the bounded drawer, exact initialization preview, and Plugin Configuration evidence', async () => {
    if (harnessRoot === undefined) throw new Error('real browser snapshot requires DSH_HARNESS_ROOT')
    const driverUrl = new URL('./fixtures/workbench-browser/driver.mjs', import.meta.url).href
    const driver = await import(driverUrl) as {
      runWorkbenchBrowserJourney(root: string): Promise<unknown>
    }
    const snapshot = await driver.runWorkbenchBrowserJourney(resolve(harnessRoot))
    const payload = `${JSON.stringify(snapshot, null, 2)}\n`
    if (process.env.DSH_SNAPSHOT === 'refresh') {
      await writeFile(expectedPath, payload, 'utf8')
    } else {
      expect(payload).toBe(await readFile(expectedPath, 'utf8'))
    }
  }, 130_000)
})

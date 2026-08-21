/** Optional real-DSH browser snapshot for the AI novel workbench tracer bullet. */

import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const harnessRoot = process.env.DSH_HARNESS_ROOT
const realHarnessIt = harnessRoot === undefined ? it.skip : it
const v2ExpectedPath = join(import.meta.dirname, 'snapshots', 'workbench-browser.expected.json')
const v2FixturePath = join(import.meta.dirname, 'fixtures', 'workbench-browser', 'session.jsonl')
const v1ExpectedPath = join(import.meta.dirname, 'snapshots', 'workbench-browser-v1.expected.json')
const v1FixturePath = join(import.meta.dirname, 'fixtures', 'workbench-browser-v1', 'session.jsonl')
const v2DriverPath = join(import.meta.dirname, 'fixtures', 'workbench-browser', 'driver.mjs')
const v1DriverPath = join(import.meta.dirname, 'fixtures', 'workbench-browser-v1', 'driver.mjs')

async function assertBrowserSnapshot(driverPath: string, expectedPath: string): Promise<void> {
  if (harnessRoot === undefined) throw new Error('real browser snapshot requires DSH_HARNESS_ROOT')
  const driver = await import(new URL(driverPath, import.meta.url).href) as {
    runWorkbenchBrowserJourney(root: string): Promise<unknown>
  }
  const payload = `${JSON.stringify(await driver.runWorkbenchBrowserJourney(resolve(harnessRoot)), null, 2)}\n`
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expectedPath, payload, 'utf8')
  else expect(payload).toBe(await readFile(expectedPath, 'utf8'))
}

describe('AI novel real DSH Web snapshot', () => {
  it('keeps independent V1 generation/reconciliation and V2 read-only fixture tool faces on their own Presets', async () => {
    const [v1Fixture, v2Fixture, v1Driver, v2Driver] = await Promise.all([
      readFile(v1FixturePath, 'utf8'), readFile(v2FixturePath, 'utf8'), readFile(v1DriverPath, 'utf8'), readFile(v2DriverPath, 'utf8'),
    ])
    const v1Events = v1Fixture.trim().split(/\r?\n/).map(line => JSON.parse(line) as { type?: unknown; agentPreset?: unknown })
    const v2Events = v2Fixture.trim().split(/\r?\n/).map(line => JSON.parse(line) as { type?: unknown; agentPreset?: unknown })

    expect(v1Events[0]).toMatchObject({ type: 'session', agentPreset: 'ai-novel-writer' })
    expect(v1Fixture).toContain('\\"kind\\":\\"working-set\\"')
    expect(v1Fixture).toContain('"name":"novel_apply_change"')
    expect(v1Driver).toContain("'workbench-browser-v1', 'session.jsonl'")
    expect(v1Driver).toContain("default: 'ai-novel-writer'")
    expect(v1Driver).toContain("name: '允许一次'")
    expect(v1Driver).toContain('模型生成已批准并载入 revision')
    expect(v1Driver).toContain('预览手动修改')

    expect(v2Events).toHaveLength(1)
    expect(v2Events[0]).toMatchObject({ type: 'session', agentPreset: 'ai-novel-writer-v2' })
    expect(v2Fixture).not.toContain('working-set')
    expect(v2Fixture).not.toContain('novel_apply_change')
    expect(v2Driver).toContain("'workbench-browser', 'session.jsonl'")
    expect(v2Driver).toContain("default: 'ai-novel-writer-v2'")
    expect(v2Driver).toContain("name: '项目概览'")
    expect(v2Driver).toContain('Tab escaped the V2 workbench focus scope')
  })

  realHarnessIt('keeps the independent V1 generation, approval, and reconciliation browser journey', async () => {
    await assertBrowserSnapshot('./fixtures/workbench-browser-v1/driver.mjs', v1ExpectedPath)
  }, 130_000)

  realHarnessIt('shows the V2 detail shell, responsive geometry, sticky actions, and keyboard restoration', async () => {
    await assertBrowserSnapshot('./fixtures/workbench-browser/driver.mjs', v2ExpectedPath)
  }, 130_000)
})

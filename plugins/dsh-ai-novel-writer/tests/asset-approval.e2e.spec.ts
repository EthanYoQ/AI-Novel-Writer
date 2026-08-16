/** Real-Loader rejection and stale-revision evidence for approval-gated asset proposals. */

import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { makeTestWorkspace } from './test-workspace.ts'

const execFileAsync = promisify(execFile)
const packageRoot = resolve(import.meta.dirname, '..')
const fixtureRoot = join(import.meta.dirname, 'fixtures', 'complete-chapter')

interface SessionEventLine {
  readonly type: 'session_event'
  readonly phase: string
  readonly event: SessionEvent
}

async function runScenario(scenario: 'approval-rejected' | 'stale-revision') {
  const workspace = await makeTestWorkspace(`asset-approval-${scenario}-`)
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      join(fixtureRoot, 'driver.mjs'),
      join(fixtureRoot, 'cordis.yml'),
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        DSH_HOME: join(workspace, '.dsh'),
        DSH_AGENTS_HOME: join(workspace, '.agents'),
        DSH_NOVEL_PRESET_ROOT: join(packageRoot, 'presets'),
        DSH_NOVEL_SCENARIO: scenario,
      },
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })
    expect(stderr).not.toContain('UNHANDLED')
    const lines = stdout.trimEnd().split('\n').map(line => JSON.parse(line) as SessionEventLine | {
      readonly type: string
    })
    return {
      workspace,
      events: lines.filter((line): line is SessionEventLine => line.type === 'session_event').map(line => line.event),
      release: async () => { await rm(workspace, { recursive: true, force: true }) },
    }
  } catch (error) {
    await rm(workspace, { recursive: true, force: true })
    throw error
  }
}

describe('asset mutation native approval outcomes', () => {
  it('rejects one initialization without creating the manifest', async () => {
    const run = await runScenario('approval-rejected')
    try {
      expect(run.events.filter(event => event.type === 'approval/decided').map(event =>
        event.type === 'approval/decided' ? event.data.outcome : undefined)).toEqual(['rejected'])
      const result = run.events.find(event =>
        event.type === 'tool/result' && event.data.message.source.callId === 'rejected-init')
      if (result?.type !== 'tool/result') throw new Error('rejected tool result was not logged')
      const block = result.data.message.content[0]
      expect(block?.type === 'tool-result' ? block.isError : false).toBe(true)
      expect(block?.type === 'tool-result' ? block.content : []).toContainEqual({
        type: 'text', text: 'Error: the user rejected tool "novel_apply_change"',
      })
      await expect(readFile(join(run.workspace, '.ai-novel', 'project.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await run.release()
    }
  }, 35_000)

  it('lets approval proceed but rejects a stale replacement without overwriting the concurrent asset', async () => {
    const run = await runScenario('stale-revision')
    try {
      expect(run.events.filter(event => event.type === 'approval/decided').map(event =>
        event.type === 'approval/decided' ? event.data.outcome : undefined)).toEqual(['allowed-once', 'allowed-once'])
      const result = run.events.find(event =>
        event.type === 'tool/result' && event.data.message.source.callId === 'stale-replace-project')
      expect(result?.type === 'tool/result' ? result.data.error?.code : undefined).toBe('STALE_REVISION')
      const manifest = JSON.parse(await readFile(join(run.workspace, '.ai-novel', 'project.json'), 'utf8')) as {
        readonly title: string
      }
      expect(manifest.title).toBe('外部并发标题')
    } finally {
      await run.release()
    }
  }, 35_000)
})

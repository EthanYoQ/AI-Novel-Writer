/** Keyless real-Loader snapshots for approval-disabled and invalid-argument stops. */
import { execFile } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { makeTestWorkspace } from './test-workspace.ts'

const execFileAsync = promisify(execFile)
const packageRoot = resolve(import.meta.dirname, '..')
const fixtureRoot = join(import.meta.dirname, 'fixtures', 'complete-chapter')
const expectedPath = join(import.meta.dirname, 'snapshots', 'agent-guardrails.expected.json')

interface DriverLine {
  readonly type: 'model_request' | 'session_event'
  readonly request?: { readonly system: string | null; readonly messages: unknown }
  readonly event?: SessionEvent
}

async function runScenario(scenario: 'approval-never' | 'invalid-args'): Promise<DriverLine[]> {
  const workspace = await makeTestWorkspace(`${scenario}-`)
  const { stdout } = await execFileAsync(process.execPath, [
    join(fixtureRoot, 'driver.mjs'), join(fixtureRoot, 'cordis.yml'),
  ], {
    cwd: workspace,
    env: {
      ...process.env,
      DSH_HOME: join(workspace, '.dsh'),
      DSH_AGENTS_HOME: join(workspace, '.agents'),
      DSH_NOVEL_PRESET_ROOT: join(packageRoot, 'presets'),
      DSH_NOVEL_SCENARIO: scenario,
      DSH_NOVEL_APPROVAL_POLICY: scenario === 'approval-never' ? 'never' : 'ask',
    },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 15_000,
  })
  await expect(access(join(workspace, '.ai-novel', 'project.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  return stdout.trimEnd().split('\n').map(line => JSON.parse(line) as DriverLine)
}

function textOf(event: SessionEvent): string {
  if (event.type === 'assistant/message') {
    return event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
  }
  if (event.type === 'tool/result') {
    return event.data.message.content.flatMap(block => block.content)
      .filter(block => block.type === 'text')
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
  }
  return ''
}

describe('AI novel model guardrail snapshots', () => {
  it('explains disabled approval before mutation and stops after one invalid nested call', async () => {
    const never = await runScenario('approval-never')
    const invalid = await runScenario('invalid-args')
    const neverEvents = never.flatMap(line => line.event === undefined ? [] : [line.event])
    const invalidEvents = invalid.flatMap(line => line.event === undefined ? [] : [line.event])
    const neverRequest = never.find(line => line.type === 'model_request')?.request
    const neverVisibleText = JSON.stringify(neverRequest ?? {})
    const invalidCalls = invalidEvents.filter(event => event.type === 'tool/call')
    const invalidResult = invalidEvents.find(event => event.type === 'tool/result')
    const snapshot = `${JSON.stringify({
      approvalNever: {
        runtimeContextExplainsDisabledApproval: neverVisibleText.includes('Approval prompts are disabled in this session'),
        personaForbidsApply: neverVisibleText.includes('do not call novel_apply_change'),
        toolCalls: neverEvents.filter(event => event.type === 'tool/call').length,
        assistant: neverEvents.filter(event => event.type === 'assistant/message').map(textOf),
      },
      invalidArguments: {
        toolCalls: invalidCalls.map(event => event.type === 'tool/call'
          ? { name: event.data.name, arguments: JSON.parse(event.data.arguments) }
          : undefined),
        result: invalidResult === undefined ? null : textOf(invalidResult),
        assistant: invalidEvents.filter(event => event.type === 'assistant/message').map(textOf).filter(Boolean),
      },
    }, null, 2)}\n`
    if (process.env.DSH_SNAPSHOT === 'refresh') {
      await mkdir(dirname(expectedPath), { recursive: true })
      await writeFile(expectedPath, snapshot, 'utf8')
    }
    expect(snapshot).toBe(await readFile(expectedPath, 'utf8'))
  }, 30_000)
})

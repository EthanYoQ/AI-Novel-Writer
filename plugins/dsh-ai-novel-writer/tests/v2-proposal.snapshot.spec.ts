/** Keyless real-Loader snapshot for the V2 proposal inbox and sidebar loopback. */
import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { describe, expect, it } from 'vitest'
import { createAiNovelRpcHandler } from '../src/index.ts'
import { openNovelStore } from '../src/novel-store.ts'
import { createPresetInstaller } from '../src/preset-installer.ts'
import { makeTestWorkspace } from './test-workspace.ts'

type Phase = 'v2-proposal'

interface ModelRequestLine {
  readonly type: 'model_request'
  readonly phase: Phase
  readonly request: {
    readonly provider: string
    readonly model: string
    readonly tools: ToolSchema[]
  }
}

interface SessionEventLine {
  readonly type: 'session_event'
  readonly phase: Phase
  readonly event: SessionEvent
}

type DriverLine = ModelRequestLine | SessionEventLine

const execFileAsync = promisify(execFile)
const signal = new AbortController().signal
const packageRoot = resolve(import.meta.dirname, '..')
const fixtureRoot = join(import.meta.dirname, 'fixtures', 'complete-chapter')
const WORKSPACE_ID = WorkspaceId('123e4567-e89b-42d3-a456-426614174201')

function eventResultText(event: SessionEvent): string | undefined {
  if (event.type !== 'tool/result') return undefined
  return event.data.message.content
    .flatMap(block => block.content)
    .filter(block => block.type === 'text')
    .map(block => block.type === 'text' ? block.text : '')
    .join('')
}

describe('V2 proposal inbox keyless snapshot', () => {
  it('keeps the scripted model proposal in the durable inbox and exposes it through loopback', async () => {
    const workspace = await makeTestWorkspace('v2-proposal-real-loader-')
    const seed = await openNovelStore(workspace, WORKSPACE_ID)
    let before: Awaited<ReturnType<typeof seed.read>>
    try {
      await seed.initialize({
        workspaceId: WORKSPACE_ID,
        title: '潮汐来信',
        language: 'zh-CN',
        genre: '奇幻悬疑',
        plannedChapters: 6,
        targetWordsPerChapter: 2_000,
        creativeStrategy: 'consistency-first',
        structureMode: 'three-act',
        narrativePov: 'third-limited',
        globalGuidance: '保持冷峻而温柔的语气。',
      }, signal)
      before = await seed.read(signal)
    } finally {
      await seed.dispose()
    }

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
        DSH_NOVEL_SCENARIO: 'v2-proposal',
      },
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: 30_000,
    })

    expect(stderr).not.toContain('UNHANDLED')
    const lines = stdout.trimEnd().split('\n').map(line => JSON.parse(line) as DriverLine)
    const requests = lines.filter((line): line is ModelRequestLine => line.type === 'model_request')
    const events = lines
      .filter((line): line is SessionEventLine => line.type === 'session_event')
      .map(line => line.event)
    expect(requests).toHaveLength(3)
    expect(requests.every(request => request.request.provider === 'novel-snapshot'
      && request.request.model === 'keyless')).toBe(true)
    expect(requests.map(request => request.request.tools.map(tool => tool.name).sort()))
      .toEqual(Array.from({ length: requests.length }, () => ['novel_propose_change', 'novel_read']))

    const calls = events.filter((event): event is Extract<SessionEvent, { type: 'tool/call' }> => event.type === 'tool/call')
    expect(calls.map(event => event.data.name)).toEqual(['novel_read', 'novel_propose_change'])
    expect(events.filter(event => event.type === 'approval/asked')).toHaveLength(0)
    expect(events.filter(event => event.type === 'approval/decided')).toHaveLength(0)

    const proposalResult = events.find((event): event is Extract<SessionEvent, { type: 'tool/result' }> =>
      event.type === 'tool/result' && event.data.message.source.callId === 'v2-propose-architecture')
    if (proposalResult === undefined) throw new Error('keyless V2 session did not record the proposal result')
    expect(JSON.parse(eventResultText(proposalResult) ?? '')).toMatchObject({
      duplicate: false,
      proposal: {
        sessionId: 'complete-chapter-v2-proposal',
        callId: 'v2-propose-architecture',
        argsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        status: 'pending',
      },
    })

    const reopened = await openNovelStore(workspace, WORKSPACE_ID, { create: false })
    let durableProposals: Awaited<ReturnType<typeof reopened.listProposals>>
    try {
      const after = await reopened.read(signal)
      durableProposals = await reopened.listProposals(signal)
      expect(after.globalRevision).toBe(before.globalRevision)
      expect(after.project).toEqual(before.project)
      expect(after.architecture).toEqual(before.architecture)
      expect(after.changes).toEqual(before.changes)
      expect(durableProposals).toHaveLength(1)
      expect(durableProposals[0]).toMatchObject({
        sessionId: 'complete-chapter-v2-proposal',
        callId: 'v2-propose-architecture',
        status: 'pending',
        items: [{
          itemOrder: 0,
          status: 'pending',
          attemptCount: 0,
          change: {
            changeSetId: 'v2-architecture-proposal',
            operation: 'replace',
            aggregate: { kind: 'architecture' },
            provenance: { origin: 'model', sessionId: 'complete-chapter-v2-proposal', callId: 'v2-propose-architecture' },
          },
        }],
      })
    } finally {
      await reopened.dispose()
    }

    const handler = createAiNovelRpcHandler(
      createPresetInstaller(join(packageRoot, 'presets', 'ai-novel-writer'), join(workspace, '.preset-root')),
      { get: workspaceId => workspaceId === WORKSPACE_ID ? { path: workspace } : undefined },
    )
    const loopback = await handler('proposal/list', { workspaceId: String(WORKSPACE_ID) }, signal)
    expect(loopback).toEqual({ ok: true, value: { proposals: durableProposals } })
    expect(JSON.stringify(loopback)).not.toContain(workspace)
  }, 45_000)
})

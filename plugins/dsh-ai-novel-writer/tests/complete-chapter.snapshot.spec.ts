/** Keyless real-Loader snapshot for one complete approved chapter. */
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { deriveEventMessage, foldSurface } from '@deepseek-ai/dsh-session/surface'
import { describe, expect, it } from 'vitest'
import { makeTestWorkspace } from './test-workspace.ts'

type Phase = 'first' | 'restart' | 'approval-never' | 'invalid-args'

interface ModelRequestLine {
  readonly type: 'model_request'
  readonly phase: Phase
  readonly request: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort: string | null
    readonly maxTokens: number | null
    readonly system: string | null
    readonly tools: ToolSchema[]
    readonly messages: Message[]
  }
}

interface SessionEventLine {
  readonly type: 'session_event'
  readonly phase: Phase
  readonly event: SessionEvent
}

interface PreapprovalLine {
  readonly type: 'preapproval'
  readonly phase: Phase
  readonly manifest: 'absent' | 'present'
}

type DriverLine = ModelRequestLine | SessionEventLine | PreapprovalLine

const execFileAsync = promisify(execFile)
const packageRoot = resolve(import.meta.dirname, '..')
const fixtureRoot = join(import.meta.dirname, 'fixtures', 'complete-chapter')
const expectedPath = join(import.meta.dirname, 'snapshots', 'complete-chapter.expected.json')

function linesFor<T extends DriverLine['type']>(
  lines: readonly DriverLine[],
  type: T,
  phase?: Phase,
): Extract<DriverLine, { type: T }>[] {
  return lines.filter((line): line is Extract<DriverLine, { type: T }> =>
    line.type === type && (phase === undefined || line.phase === phase))
}

function eventResultText(event: SessionEvent): string | undefined {
  if (event.type !== 'tool/result') return undefined
  return event.data.message.content
    .flatMap(block => block.content)
    .filter(block => block.type === 'text')
    .map(block => block.type === 'text' ? block.text : '')
    .join('')
}

function requestBoundaryIndex(events: readonly SessionEvent[], startIndex: number): number {
  const start = events[startIndex]
  if (start?.type !== 'step/start') throw new Error('request reconstruction requires step/start')
  const chunkOffset = events.slice(startIndex + 1).findIndex(event =>
    event.type === 'assistant/chunk'
    && event.data.turn === start.data.turn
    && event.data.step === start.data.step)
  if (chunkOffset === -1) throw new Error('request reconstruction found no model stream boundary')
  return startIndex + chunkOffset
}

function requestBoundaryMessages(events: readonly SessionEvent[], startIndex: number): Message[] {
  const prefix = events.slice(0, requestBoundaryIndex(events, startIndex) + 1)
  const bySeq = new Map(prefix.map(event => [event.seq, event]))
  return foldSurface(prefix).nodes.map((seq) => {
    const event = bySeq.get(seq)
    if (event === undefined) throw new Error(`surface references missing event ${seq}`)
    return deriveEventMessage(event)
  }).filter((message): message is Message => message !== null)
}

function headerAt(events: readonly SessionEvent[], boundaryIndex: number) {
  return events.slice(0, boundaryIndex + 1)
    .filter((event): event is Extract<SessionEvent, { type: 'request/header' }> => event.type === 'request/header')
    .at(-1)?.data.header
}

function assertRequestsReconstruct(events: readonly SessionEvent[], requests: readonly ModelRequestLine[]): void {
  const starts = events
    .map((event, index) => ({ event, index }))
    .filter((row): row is { event: Extract<SessionEvent, { type: 'step/start' }>; index: number } =>
      row.event.type === 'step/start')
  expect(requests).toHaveLength(starts.length)
  for (const [index, row] of starts.entries()) {
    const request = requests[index]?.request
    if (request === undefined) throw new Error(`missing recorded model request ${index}`)
    expect(request.messages).toEqual(requestBoundaryMessages(events, row.index))
    const header = headerAt(events, requestBoundaryIndex(events, row.index))
    if (header === undefined) throw new Error(`missing request header for model request ${index}`)
    expect(request.provider).toBe(header.config.provider)
    expect(request.model).toBe(header.config.model)
    expect(request.reasoningEffort).toBe(header.config.reasoningEffort ?? null)
    expect(request.maxTokens).toBe(header.config.maxTokens ?? null)
    expect(request.system).toBe(header.system ?? null)
    expect(request.tools).toEqual(header.tools ?? [])
  }
}

function summarizeWorkingSet(value: Record<string, unknown>): object {
  const assets = value.assets as Array<{
    target: { kind: string; chapter?: number }
    source: string
    revision: string
    text: string
    bytes: number
    truncated: boolean
    omitted: boolean
  }>
  return {
    kind: value.kind,
    assets: assets.map(asset => ({
      target: asset.target,
      source: asset.source,
      revision: asset.revision,
      bytes: asset.bytes,
      truncated: asset.truncated,
      omitted: asset.omitted,
      ...asset.target.kind === 'project'
        ? { creativeStrategy: (JSON.parse(asset.text) as { creativeStrategy: string }).creativeStrategy }
        : {},
      ...asset.target.kind === 'chapter-draft' ? { text: asset.text } : {},
    })),
    bytes: value.bytes,
    truncated: value.truncated,
    omittedSources: value.omittedSources,
  }
}

function summarizeToolResult(event: Extract<SessionEvent, { type: 'tool/result' }>): object {
  const text = eventResultText(event)
  const value = JSON.parse(text ?? '') as Record<string, unknown>
  if (value.kind === 'working-set') return summarizeWorkingSet(value)
  if (value.kind === 'asset') {
    const { text: _text, ...summary } = value
    return summary
  }
  return value
}

function messageText(message: Message): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.type === 'text' ? block.text : '')
    .join('')
}

function projectEvent(event: SessionEvent): object | undefined {
  switch (event.type) {
    case 'user/message': return {
      type: event.type,
      source: event.data.source,
      text: messageText(event.data),
    }
    case 'tool/call': return {
      type: event.type,
      callId: event.data.callId,
      name: event.data.name,
      arguments: JSON.parse(event.data.arguments) as Record<string, unknown>,
    }
    case 'approval/asked': return {
      type: event.type,
      toolName: event.data.toolName,
      callId: event.data.callId,
      reason: event.data.reason,
    }
    case 'approval/decided': return { type: event.type, outcome: event.data.outcome }
    case 'tool/result': return {
      type: event.type,
      callId: event.data.message.source.callId,
      error: event.data.error,
      value: summarizeToolResult(event),
    }
    case 'assistant/message': {
      const text = messageText(event.data.message)
      return text.length === 0 ? undefined : { type: event.type, text }
    }
    case 'turn/end': return { type: event.type, reason: event.data.reason }
    default: return undefined
  }
}

function semanticLog(events: readonly SessionEvent[]): object[] {
  return events.map(projectEvent).filter((event): event is object => event !== undefined)
}

function normalizeHeader(
  header: Extract<SessionEvent, { type: 'request/header' }>['data']['header'],
  workspace: string,
): object {
  return {
    ...header,
    ...header.system === undefined
      ? {}
      : { system: header.system.replaceAll(workspace, '<workspace>').replaceAll(workspace.replaceAll('\\', '/'), '<workspace>') },
  }
}

describe('complete chapter keyless snapshot', () => {
  it('boots the real Loader app, records approvals, and reconstructs requests after restart', async () => {
    const workspace = await makeTestWorkspace('complete-chapter-real-loader-')
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
      },
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: 30_000,
    })
    expect(stderr).not.toContain('UNHANDLED')
    const lines = stdout.trimEnd().split('\n').map(line => JSON.parse(line) as DriverLine)
    const firstEvents = linesFor(lines, 'session_event', 'first').map(line => line.event)
    const restartEvents = linesFor(lines, 'session_event', 'restart').map(line => line.event)
    const firstRequests = linesFor(lines, 'model_request', 'first')
    const restartRequests = linesFor(lines, 'model_request', 'restart')
    assertRequestsReconstruct(firstEvents, firstRequests)
    assertRequestsReconstruct(restartEvents, restartRequests)
    expect([...firstRequests, ...restartRequests].every(line => line.request.reasoningEffort === null)).toBe(true)
    expect([...firstRequests, ...restartRequests].every(line =>
      line.request.tools.map(tool => tool.name).sort().join(',') === 'novel_apply_change,novel_read')).toBe(true)

    expect(linesFor(lines, 'preapproval')).toEqual([
      { type: 'preapproval', phase: 'first', manifest: 'absent' },
    ])
    const applyCalls = firstEvents.filter(event =>
      event.type === 'tool/call' && event.data.name === 'novel_apply_change')
    const approvals = firstEvents.filter(event => event.type === 'approval/asked')
    const decisions = firstEvents.filter(event => event.type === 'approval/decided')
    expect(applyCalls.map(event => event.type === 'tool/call' ? event.data.callId : undefined)).toEqual([
      'chapter-01-init',
      'chapter-01-write-characters',
      'chapter-01-write-story',
      'chapter-01-write-blueprint',
      'chapter-01-write-draft',
    ])
    expect(approvals.map(event => event.type === 'approval/asked' ? event.data.callId : undefined))
      .toEqual(applyCalls.map(event => event.type === 'tool/call' ? event.data.callId : undefined))
    expect(decisions.map(event => event.type === 'approval/decided' ? event.data.outcome : undefined))
      .toEqual(Array.from({ length: 5 }, () => 'allowed-once'))
    const receipts = applyCalls.map((call) => {
      if (call.type !== 'tool/call') throw new Error('apply call projection lost its discriminant')
      const result = firstEvents.find(event =>
        event.type === 'tool/result' && event.data.message.source.callId === call.data.callId)
      return JSON.parse(result === undefined ? '' : eventResultText(result) ?? '') as {
        target: { kind: string }
        oldRevision: string
        newRevision: string
        bytes: number
      }
    })
    expect(receipts.map(receipt => receipt.target.kind)).toEqual([
      'project', 'characters', 'story-blueprint', 'chapter-blueprint', 'chapter-draft',
    ])
    expect(receipts.every(receipt =>
      receipt.oldRevision === 'absent'
      && /^[a-f0-9]{64}$/.test(receipt.newRevision)
      && receipt.bytes > 0)).toBe(true)

    const firstReadback = firstEvents.find(event =>
      event.type === 'tool/result' && event.data.message.source.callId === 'chapter-01-readback')
    const restartReadback = restartEvents.find(event => event.type === 'tool/result')
    const firstReadbackText = firstReadback === undefined ? undefined : eventResultText(firstReadback)
    const restartReadbackText = restartReadback === undefined ? undefined : eventResultText(restartReadback)
    expect(restartReadbackText).toBe(firstReadbackText)
    const restartValue = JSON.parse(restartReadbackText ?? '') as {
      assets: { target: { kind: string }, text: string }[]
    }
    const projectText = restartValue.assets.find(asset => asset.target.kind === 'project')?.text ?? ''
    const draftText = restartValue.assets.find(asset => asset.target.kind === 'chapter-draft')?.text ?? ''
    expect(projectText).toContain('"creativeStrategy": "consistency-first"')
    expect(draftText).toContain('午夜，灯塔的主灯第一次熄灭。')
    expect(await readFile(join(workspace, 'chapters', '0001.md'), 'utf8')).toBe(draftText)

    const firstHeaderEvent = firstEvents.find((event): event is Extract<SessionEvent, { type: 'request/header' }> =>
      event.type === 'request/header')
    const restartHeaderEvent = restartEvents.find((event): event is Extract<SessionEvent, { type: 'request/header' }> =>
      event.type === 'request/header')
    if (firstHeaderEvent === undefined || restartHeaderEvent === undefined) {
      throw new Error('real composition did not log both request headers')
    }
    const firstHeader = normalizeHeader(firstHeaderEvent.data.header, workspace)
    expect(normalizeHeader(restartHeaderEvent.data.header, workspace)).toEqual(firstHeader)
    const snapshot = `${JSON.stringify({
      loaderProcess: {
        preapproval: 'manifest absent',
        firstHeader,
        restartHeader: 'same-as-first',
      },
      firstSession: semanticLog(firstEvents),
      restartSession: semanticLog(restartEvents),
      restartReadback: {
        matchesFirstReadback: true,
        creativeStrategy: (JSON.parse(projectText) as { creativeStrategy: string }).creativeStrategy,
        chapterDraft: draftText,
      },
    }, null, 2)}\n`
    if (process.env.DSH_SNAPSHOT === 'refresh') {
      await mkdir(dirname(expectedPath), { recursive: true })
      await writeFile(expectedPath, snapshot, 'utf8')
    }
    expect(snapshot).toBe(await readFile(expectedPath, 'utf8'))
  }, 45_000)
})

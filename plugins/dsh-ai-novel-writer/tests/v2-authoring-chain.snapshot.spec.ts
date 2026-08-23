/** Public V2 authoring-to-ToolRuntime qualification with a deterministic keyless model. */
import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { describe, expect, it } from 'vitest'
import { NovelV2WorkbenchController } from '../src/client/workbench-v2.ts'
import type { NovelV2WorkbenchPort } from '../src/client/workbench-v2.ts'
import { NovelWorkbenchRouteController, observeNovelV2Workspace } from '../src/client/workbench-v2-observer.ts'
import type { NovelV2AuthoringInput, NovelV2AuthoringStage } from '../src/client/v2-authoring.ts'
import { createAiNovelCommandRpcHandler } from '../src/command-rpc.ts'
import type { NovelStateReadResult } from '../src/command-rpc.ts'
import { makeTestWorkspace } from './test-workspace.ts'

type FixtureStage =
  | 'project-refine'
  | 'architecture'
  | 'architecture-manual'
  | 'characters'
  | 'outline'
  | 'chapter-blueprint-1'
  | 'draft-1'
  | 'revision-1-manual'
  | 'select-final-1'
  | 'chapter-blueprint-2'
  | 'draft-2'

interface Stage {
  readonly fixture: FixtureStage
  readonly authoring: NovelV2AuthoringStage
  readonly chapter?: number
  readonly input?: NovelV2AuthoringInput
  readonly selectArtifactId?: string
  readonly selectFinalArtifactId?: string
}

interface ModelRequestLine {
  readonly type: 'model_request'
  readonly phase: FixtureStage
  readonly request: {
    readonly provider: string
    readonly model: string
    readonly tools: ToolSchema[]
    readonly messages: readonly unknown[]
  }
}

interface SessionEventLine {
  readonly type: 'session_event'
  readonly phase: FixtureStage
  readonly event: SessionEvent
}

interface V2ProposalProtocolAssertionLine {
  readonly type: 'v2_proposal_protocol_asserted'
  readonly phase: FixtureStage
}

type DriverLine = ModelRequestLine | SessionEventLine | V2ProposalProtocolAssertionLine

interface PublicChain {
  readonly controller: NovelV2WorkbenchController
  readonly rpcEndpoints: readonly string[]
  readonly startStage: (stage: FixtureStage) => void
  readonly lines: () => readonly DriverLine[]
  readonly settleAuthoringTurn: (requestText: string) => void
  readonly dispose: () => void
}

function source<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    set: (next: T) => { value = next; for (const listener of listeners) listener() },
  }
}

const execFileAsync = promisify(execFile)
const signal = new AbortController().signal
const packageRoot = resolve(import.meta.dirname, '..')
const fixtureRoot = join(import.meta.dirname, 'fixtures', 'complete-chapter')
const WORKSPACE_ID = WorkspaceId('123e4567-e89b-42d3-a456-426614174201')
const SESSION_ID = SessionId('v2-authoring-public-chain')
const CHAIN_MANUAL_ARCHITECTURE = {
  premise: 'fixture-architecture-premise-manual',
  characterGraph: 'fixture-character-graph-manual',
  world: 'fixture-world-manual',
  plotOutline: 'fixture-outline-manual',
  styleConstraints: 'fixture-style-manual',
  referenceWorks: '[]',
}
const CHAIN_MANUAL_REVISION = 'fixture-revision-content-manual'
const stages: readonly Stage[] = [
  { fixture: 'project-refine', authoring: 'project-refine' },
  { fixture: 'architecture', authoring: 'architecture' },
  {
    fixture: 'architecture-manual', authoring: 'architecture',
    input: { kind: 'structured', stage: 'architecture', chapter: undefined, values: CHAIN_MANUAL_ARCHITECTURE },
  },
  { fixture: 'characters', authoring: 'characters' },
  { fixture: 'outline', authoring: 'outline' },
  { fixture: 'chapter-blueprint-1', authoring: 'chapter-blueprint', chapter: 1 },
  { fixture: 'draft-1', authoring: 'draft', chapter: 1 },
  {
    fixture: 'revision-1-manual', authoring: 'revision', chapter: 1,
    selectArtifactId: 'chain-chapter-1-draft',
    input: { kind: 'prose', content: CHAIN_MANUAL_REVISION },
  },
  { fixture: 'select-final-1', authoring: 'select-final', chapter: 1, selectFinalArtifactId: 'chain-chapter-1-revision' },
  { fixture: 'chapter-blueprint-2', authoring: 'chapter-blueprint', chapter: 2 },
  { fixture: 'draft-2', authoring: 'draft', chapter: 2 },
]

async function runStage(
  workspace: string,
  stage: FixtureStage,
  prompt: string,
  forceReadError: boolean,
): Promise<readonly DriverLine[]> {
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
      DSH_NOVEL_SCENARIO: 'v2-authoring-chain',
      DSH_NOVEL_AUTHORING_STAGE: stage,
      DSH_NOVEL_AUTHORING_PROMPT_BASE64: Buffer.from(prompt).toString('base64url'),
      ...(forceReadError ? { DSH_NOVEL_FORCE_READ_ERROR: '1' } : {}),
    },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: 30_000,
  })
  expect(stderr).not.toContain('UNHANDLED')
  return stdout.trimEnd().split('\n').map(line => JSON.parse(line) as DriverLine)
}

function expectedCalls(stage: FixtureStage): Array<{ readonly name: string; readonly arguments: Record<string, unknown> }> {
  const reads: Array<{ readonly name: string; readonly arguments: Record<string, unknown> }> = [{ name: 'novel_read', arguments: { kind: 'state' } }]
  if (stage === 'draft-2') reads.push({ name: 'novel_read', arguments: { kind: 'chapter-context', chapter: 2 } })
  return [...reads, { name: 'novel_propose_change', arguments: expect.any(Object) }]
}

function sessionEvents(lines: readonly DriverLine[]): readonly SessionEvent[] {
  return lines
    .filter((line): line is SessionEventLine => line.type === 'session_event')
    .map(line => line.event)
}

function toolCalls(events: readonly SessionEvent[]): Array<{ readonly name: string; readonly arguments: Record<string, unknown> }> {
  return events
    .filter((event): event is Extract<SessionEvent, { type: 'tool/call' }> => event.type === 'tool/call')
    .map(event => ({ name: event.data.name, arguments: JSON.parse(event.data.arguments) }))
}

function authorRequestText(messages: readonly unknown[]): string | undefined {
  for (const message of messages) {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
    const record = message as { readonly source?: { readonly kind?: unknown }; readonly content?: unknown }
    if (record.source?.kind !== 'user' || !Array.isArray(record.content)) continue
    const text = record.content.find(block => typeof block === 'object' && block !== null
      && !Array.isArray(block)
      && (block as { readonly type?: unknown }).type === 'text'
      && typeof (block as { readonly text?: unknown }).text === 'string') as { readonly text: string } | undefined
    if (text !== undefined) return text.text
  }
  return undefined
}

function isReadyWorkspaceState(value: unknown): value is { readonly status: 'ready'; readonly state: NovelStateReadResult } {
  return typeof value === 'object' && value !== null
    && 'status' in value && value.status === 'ready'
    && 'state' in value && typeof value.state === 'object' && value.state !== null
}

async function initializeWorkspace(workspace: string): Promise<void> {
  const handler = createAiNovelCommandRpcHandler({ get: workspaceId => workspaceId === WORKSPACE_ID ? { path: workspace } : undefined })
  await expect(handler('workspace/initialize', {
    workspaceId: WORKSPACE_ID,
    title: 'fixture-project-title', language: 'zh-CN', genre: 'fixture-genre', plannedChapters: 2,
    targetWordsPerChapter: 2_000, creativeStrategy: 'consistency-first', structureMode: 'three-act',
    narrativePov: 'third-limited', globalGuidance: 'fixture-project-guidance-initial',
  }, signal)).resolves.toMatchObject({ ok: true, value: { globalRevision: 0 } })
}

async function createPublicChain(workspace: string, forceReadError = false): Promise<PublicChain> {
  const handler = createAiNovelCommandRpcHandler({ get: workspaceId => workspaceId === WORKSPACE_ID ? { path: workspace } : undefined })
  const endpoints: string[] = []
  const pending: { stage: FixtureStage | undefined; lines: readonly DriverLine[] | undefined } = { stage: undefined, lines: undefined }
  const callHost = async (endpoint: string, payload: Record<string, unknown>, requestSignal: AbortSignal): Promise<unknown> => {
      endpoints.push(endpoint)
      const result = await handler(endpoint, payload, requestSignal)
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return result.value
  }
  const port = {
    readWorkspaceState: async (workspaceId: WorkspaceId, requestSignal: AbortSignal) =>
      callHost('workspace/state/read', { workspaceId }, requestSignal) as never,
    listProposals: async (workspaceId: WorkspaceId, requestSignal: AbortSignal) => {
      const value = await callHost('proposal/list', { workspaceId }, requestSignal) as { readonly proposals: readonly unknown[] }
      return value.proposals as never
    },
    readTask: async (): Promise<never> => { throw new Error('authoring qualification must not read a task') },
    applyProposal: async (workspaceId: WorkspaceId, proposalId: string, requestSignal: AbortSignal) =>
      callHost('proposal/apply', { workspaceId, proposalId }, requestSignal) as never,
    prompt: async (sessionId: SessionId, text: string) => {
      expect(sessionId).toBe(SESSION_ID)
      const stage = pending.stage
      if (stage === undefined) throw new Error('controller queued an authoring prompt without a qualification stage')
      pending.lines = await runStage(workspace, stage, text, forceReadError)
      return { ok: true as const, value: { accepted: true as const } }
    },
  } satisfies NovelV2WorkbenchPort
  const controller = new NovelV2WorkbenchController(port)
  const sessionList = source({
    current: SESSION_ID as SessionId | undefined,
    byId: { [SESSION_ID]: { agentPreset: 'ai-novel-writer-v2' } },
  })
  const workspaceList = source({ items: [{ workspaceId: WORKSPACE_ID, sessionIds: [SESSION_ID] }] })
  const conversation = source({
    nodes: [] as Array<{ readonly kind: string; readonly seq: number; readonly content?: readonly { readonly type: string; readonly text?: string }[] }>,
    turnEnds: new Map<number, number>(),
    queue: [] as Array<{ readonly text: string | null; readonly content: readonly { readonly type: string; readonly text?: string }[] }>,
    running: false,
  })
  let nextConversationSeq = 11
  const route = new NovelWorkbenchRouteController()
  const disposeObserver = observeNovelV2Workspace({
    sessions: { list: sessionList, binding: sessionId => sessionId === SESSION_ID ? { session: conversation } : undefined },
    workspaces: { list: workspaceList },
  }, controller, route)
  await controller.open()
  await controller.whenIdle()
  return {
    controller,
    rpcEndpoints: endpoints,
    startStage: stage => { pending.stage = stage; pending.lines = undefined },
    lines: () => {
      if (pending.lines === undefined) throw new Error('the bound Session did not cross the Loader/ToolRuntime boundary')
      return pending.lines
    },
    settleAuthoringTurn: requestText => {
      const content = [{ type: 'text', text: requestText }] as const
      const userSeq = nextConversationSeq
      nextConversationSeq += 2
      conversation.set({ nodes: [{ kind: 'user', seq: userSeq, content }], turnEnds: new Map(), queue: [], running: true })
      conversation.set({ nodes: [{ kind: 'user', seq: userSeq, content }], turnEnds: new Map([[userSeq, userSeq + 1]]), queue: [], running: false })
    },
    dispose: () => { disposeObserver(); route.dispose() },
  }
}

async function submit(controller: NovelV2WorkbenchController, stage: Stage): Promise<void> {
  if (stage.selectArtifactId !== undefined) controller.selectArtifact(stage.selectArtifactId)
  if (stage.selectFinalArtifactId !== undefined) controller.selectFinal(stage.selectFinalArtifactId)
  if (stage.input !== undefined) {
    controller.prepareAuthoring(stage.authoring, stage.chapter)
    controller.updateAuthoringInput(stage.input)
    await controller.reproposeManualDraft()
    return
  }
  await controller.startDraft(stage.authoring, stage.chapter)
}

describe('V2 staged authoring chain keyless qualification', () => {
  it('crosses the controller prompt, bound Session, real ToolRuntime, and Host proposal/list refresh without direct writes', async () => {
    const workspace = await makeTestWorkspace('v2-authoring-chain-public-')
    await initializeWorkspace(workspace)
    const chain = await createPublicChain(workspace)

    for (const [stageIndex, stage] of stages.entries()) {
      const requestStart = chain.rpcEndpoints.length
      chain.startStage(stage.fixture)
      await submit(chain.controller, stage)
      const requestText = chain.controller.currentAuthoringRequestText()
      const requestKind = stage.input === undefined ? ' AI 起草' : '人工修改提交'
      expect(requestText, stage.fixture).toContain(`这是第 ${stageIndex + 1} 次${requestKind}请求。`)

      // Assert against the Loader-observed model request, not merely against the client port call.
      const lines = chain.lines()
      const requests = lines.filter((line): line is ModelRequestLine => line.type === 'model_request')
      const firstRequestIndex = lines.findIndex(line => line.type === 'model_request')
      expect(firstRequestIndex, stage.fixture).toBeGreaterThan(-1)
      expect(lines.filter((line): line is V2ProposalProtocolAssertionLine => line.type === 'v2_proposal_protocol_asserted'))
        .toEqual([{ type: 'v2_proposal_protocol_asserted', phase: stage.fixture }])
      expect(lines.slice(0, firstRequestIndex)).toContainEqual({ type: 'v2_proposal_protocol_asserted', phase: stage.fixture })
      const observedRequestText = authorRequestText(requests[0]?.request.messages ?? [])
      expect(observedRequestText, stage.fixture).toBe(requestText)
      expect(observedRequestText, stage.fixture)
        .not.toMatch(/AI_NOVEL_UI_CORRELATION|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|novel_(?:read|propose_change)|artifactId|characterId|Host|command/i)
      expect(requests, stage.fixture).toHaveLength(stage.fixture === 'draft-2' ? 4 : 3)
      expect(requests.every(request => request.phase === stage.fixture
        && request.request.provider === 'novel-snapshot' && request.request.model === 'keyless')).toBe(true)
      expect(requests.map(request => request.request.tools.map(tool => tool.name).sort()))
        .toEqual(Array.from({ length: requests.length }, () => ['novel_propose_change', 'novel_read']))
      expect(toolCalls(sessionEvents(lines))).toEqual(expectedCalls(stage.fixture))

      expect(chain.controller.getSnapshot()).toMatchObject({ authoring: { phase: 'submitted' } })
      chain.settleAuthoringTurn(requestText!)
      expect(chain.controller.getSnapshot()).toMatchObject({ authoring: { phase: 'reconciling' } })
      expect(chain.controller.currentAuthoringRequestText()).toBe(requestText)
      await chain.controller.whenIdle()
      expect(chain.rpcEndpoints.slice(requestStart)).toEqual(['workspace/state/read', 'proposal/list'])
      const refreshed = chain.controller.getSnapshot()
      expect(refreshed).toMatchObject({ status: 'ready', proposals: { phase: 'ready' } })
      expect(chain.controller.currentAuthoringRequestText()).toBeUndefined()
      if (refreshed.status !== 'ready') throw new Error(`V2 authoring stage ${stage.fixture} did not refresh a ready workspace`)
      const pending = refreshed.proposals.items.find(proposal => proposal.status === 'pending'
        && proposal.sessionId === `complete-chapter-${stage.fixture}`)
      expect(pending).toBeDefined()
      if (pending === undefined) throw new Error(`V2 authoring stage ${stage.fixture} did not refresh its pending Proposal`)
      const pendingChange = pending.items[0]?.change
      if (pendingChange === undefined) throw new Error(`V2 authoring stage ${stage.fixture} recorded an empty pending Proposal`)
      if ('nextValue' in pendingChange) {
        expect(refreshed.authoring).toMatchObject({
          phase: 'editing',
          input: {
            kind: 'structured', stage: stage.authoring,
            chapter: stage.authoring === 'chapter-blueprint' ? stage.chapter : undefined,
          },
          message: 'AI 生成的待审核建议已填入本地草稿；它尚未应用，请在建议队列审核后再应用。',
        })
      } else if ((pendingChange.kind === 'artifact/draft' || pendingChange.kind === 'artifact/revision')) {
        expect(refreshed.authoring).toMatchObject({
          phase: 'editing',
          input: { kind: 'prose', content: pendingChange.content },
          message: 'AI 生成的待审核建议已填入本地草稿；它尚未应用，请在建议队列审核后再应用。',
        })
      }
      if (stage.fixture === 'revision-1-manual') {
        expect(pending.items[0]?.change).toMatchObject({
          kind: 'artifact/revision',
        })
      }
      if (stage.fixture === 'select-final-1') {
        expect(pending.items[0]?.change).toMatchObject({
          kind: 'chapter/select-final',
        })
      }
      chain.controller.selectProposal(pending.proposalId)
      await chain.controller.applySelectedProposal()
      await chain.controller.whenIdle()
      const applied = chain.controller.getSnapshot()
      expect(applied).toMatchObject({ status: 'ready' })
      if (applied.status !== 'ready') throw new Error(`V2 authoring stage ${stage.fixture} lost ready state after Proposal apply`)
      expect(applied.proposals.items).toHaveLength(stageIndex + 1)
      expect(applied.proposals.items.every(proposal => proposal.status === 'applied')).toBe(true)
    }
    chain.dispose()

    const finalRead = await createAiNovelCommandRpcHandler({ get: workspaceId => workspaceId === WORKSPACE_ID ? { path: workspace } : undefined })(
      'workspace/state/read', { workspaceId: WORKSPACE_ID }, signal,
    )
    expect(finalRead).toMatchObject({ ok: true, value: { status: 'ready' } })
    if (!finalRead.ok || !isReadyWorkspaceState(finalRead.value)) throw new Error('expected a final ready V2 workspace state')
    expect(finalRead.value.state).toMatchObject({
      globalRevision: 7,
      project: { globalGuidance: 'fixture-project-guidance-manual' },
      architecture: { premise: 'fixture-architecture-premise-manual', plotOutline: expect.stringContaining('chapter-2-fixture-outline') },
      chapterFinals: [{ chapter: 1, artifactId: 'chain-chapter-1-revision' }],
    })
  }, 90_000)

  it('does not advance to a Proposal when actual novel_read ToolRuntime output is an error', async () => {
    const workspace = await makeTestWorkspace('v2-authoring-read-error-')
    await initializeWorkspace(workspace)
    const chain = await createPublicChain(workspace, true)
    chain.startStage('project-refine')
    await chain.controller.startDraft('project-refine')
    const events = sessionEvents(chain.lines())

    expect(toolCalls(events)).toEqual([{ name: 'novel_read', arguments: { kind: 'state' } }])
    expect(events.some((event): event is Extract<SessionEvent, { type: 'tool/result' }> =>
      event.type === 'tool/result' && event.data.error !== undefined)).toBe(true)
    expect(chain.lines().filter((line): line is ModelRequestLine => line.type === 'model_request')).toHaveLength(2)
    const requestText = chain.controller.currentAuthoringRequestText()
    expect(requestText).toContain('这是第 1 次 AI 起草请求。')
    chain.settleAuthoringTurn(requestText!)
    await chain.controller.whenIdle()
    expect(chain.controller.getSnapshot()).toMatchObject({ status: 'ready', proposals: { items: [] } })
    chain.dispose()
  }, 45_000)
})

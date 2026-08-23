/** Focused controller contract for V2's author-first, Proposal-only workbench. */

import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import type { NovelStateReadResult } from '../src/command-rpc.ts'
import { v2AuthoringPrompt } from '../src/client/v2-authoring.ts'
import { NovelV2WorkbenchController, type NovelV2WorkbenchPort } from '../src/client/workbench-v2.ts'
import { NovelWorkbenchRouteController, observeNovelV2Workspace } from '../src/client/workbench-v2-observer.ts'

const WORKSPACE_ID = '123e4567-e89b-42d3-a456-426614174201' as WorkspaceId
const SESSION_ID = 'author-first-session' as SessionId

const AUTHORING_STAGE_SCOPES = [
  ['project-refine', '本次只处理项目设置。不要起草或修改故事架构、人物设定、全书章节纲要、任何章节蓝图或正文。'],
  ['architecture', '本次只处理故事架构。不要起草或修改项目设置、人物设定、全书章节纲要、任何章节蓝图或正文。'],
  ['characters', '本次只处理人物设定。不要起草或修改项目设置、故事架构、全书章节纲要、任何章节蓝图或正文。'],
  ['outline', '本次只处理全书章节纲要。不要起草或修改项目设置、故事架构的其他内容、人物设定、任何章节蓝图或正文。'],
  ['chapter-blueprint', '本次只处理本章蓝图。不要起草或修改项目设置、故事架构、人物设定、全书章节纲要或正文。'],
  ['draft', '本次只处理本章正文初稿。不要起草或修改项目设置、故事架构、人物设定、全书章节纲要或章节蓝图。'],
  ['revision', '本次只处理本章正文修订。不要起草或修改项目设置、故事架构、人物设定、全书章节纲要或章节蓝图。'],
  ['select-final', '本次只处理本章定稿选择。不要起草或修改项目设置、故事架构、人物设定、全书章节纲要、章节蓝图或正文。'],
] as const

const STRUCTURED_AUTHORING_STAGE_SCOPES = [
  ['project-refine', '本次只处理项目设置。不要起草或修改故事架构、人物设定、全书章节纲要、任何章节蓝图或正文。'],
  ['architecture', '本次只处理故事架构。不要起草或修改项目设置、人物设定、全书章节纲要、任何章节蓝图或正文。'],
  ['characters', '本次只处理人物设定。不要起草或修改项目设置、故事架构、全书章节纲要、任何章节蓝图或正文。'],
  ['outline', '本次只处理全书章节纲要。不要起草或修改项目设置、故事架构的其他内容、人物设定、任何章节蓝图或正文。'],
  ['chapter-blueprint', '本次只处理本章蓝图。不要起草或修改项目设置、故事架构、人物设定、全书章节纲要或正文。'],
] as const

const snapshot = {
  projectId: 'project-1', workspaceId: WORKSPACE_ID, globalRevision: 7, readOnly: false,
  project: {
    revision: 2, title: '潮汐来信', language: 'zh-CN', genre: '悬疑', plannedChapters: 2,
    targetWordsPerChapter: 3_000, creativeStrategy: 'consistency-first', structureMode: 'three-act',
    narrativePov: 'third-limited', globalGuidance: '保留伏笔。', createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z',
  },
  architecture: {
    revision: 3, premise: '一封迟到的信', characterGraph: '林澈与周遥', world: '海港城',
    plotOutline: '第一章发现录音，第二章追查寄件人。', styleConstraints: '克制', referenceWorks: [],
  },
  characters: { revision: 4, items: [{ characterId: 'lin', name: '林澈', role: '调查者', summary: '追查旧案', goal: '找回弟弟', currentState: '隐瞒线索', notes: '惧怕深水' }], relationships: [] },
  chapters: [{ revision: 5, chapter: 1, title: '退潮来信', purpose: '收到来自未来的信', plotBeats: [], characters: ['lin'], keyEvents: [], suspense: '署名被涂改', status: 'drafting' }],
  artifacts: [{ artifactId: 'draft-1', chapter: 1, kind: 'draft', content: '# 退潮来信\n\n作者保留的正文。', summary: '第一章初稿', createdAt: '2026-08-21T00:00:00.000Z' }],
  chapterFinals: [], tasks: [], proposals: [], changes: [], migration: undefined,
} as unknown as NovelStateReadResult

const proposal = {
  proposalId: 'proposal-1', sessionId: 'session-1', callId: 'call-1', argsHash: 'a'.repeat(64), status: 'pending' as const,
  createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z',
  items: [{
    itemId: 'proposal-1-project', itemOrder: 1, status: 'pending' as const, attemptCount: 0,
    change: {
      changeSetId: 'proposal-1-project', operation: 'replace' as const, aggregate: { kind: 'project' as const },
      baseAggregateRevision: 2, baseGlobalRevision: 7,
      nextValue: { ...snapshot.project, title: '潮汐来信（待审）' },
      provenance: { origin: 'model' as const, sessionId: 'session-1', callId: 'call-1', argsHash: 'a'.repeat(64) },
    },
  }],
}

function controller(port: Partial<NovelV2WorkbenchPort> = {}): NovelV2WorkbenchController {
  return new NovelV2WorkbenchController({
    readWorkspaceState: vi.fn().mockResolvedValue({ status: 'ready' as const, workspaceId: WORKSPACE_ID, state: snapshot }),
    listProposals: vi.fn().mockResolvedValue([]), readTask: vi.fn(), ...port,
  })
}

function source<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (next: T) => { value = next; for (const listener of listeners) listener() },
  }
}

describe('V2 author-first workbench controller', () => {
  it('removes the retired raw aggregate editor from V2 snapshots', async () => {
    const workbench = controller()
    workbench.setWorkspace(WORKSPACE_ID)
    await workbench.open()

    expect(workbench.getSnapshot()).not.toHaveProperty('editor')
  })

  it('keeps proposal review and lifecycle selection inside the queue without leaving a failure-state message after a successful apply refresh', async () => {
    const applyProposal = vi.fn().mockResolvedValue({ proposal: { ...proposal, status: 'applied' }, appliedItemIds: ['proposal-1-project'] })
    const workbench = controller({ listProposals: vi.fn().mockResolvedValue([proposal]), applyProposal })
    workbench.setWorkspace(WORKSPACE_ID)
    await workbench.open()

    workbench.openProposalChange(0)
    expect(workbench.getSnapshot()).toMatchObject({ proposals: { selectedId: proposal.proposalId, selectedChange: 0 } })

    await workbench.applySelectedProposal()
    expect(applyProposal).toHaveBeenCalledWith(WORKSPACE_ID, proposal.proposalId, expect.any(AbortSignal))
    expect(workbench.getSnapshot()).toMatchObject({
      proposals: { phase: 'ready', message: undefined },
    })
    expect(workbench.getSnapshot()).not.toHaveProperty('editor')
  })

  it('clears only the applied stage local draft after the authoritative apply refresh', async () => {
    const appliedProposal = {
      ...proposal,
      status: 'applied' as const,
      items: proposal.items.map(item => ({ ...item, status: 'applied' as const })),
    }
    const appliedSnapshot = {
      ...snapshot,
      project: { ...snapshot.project, title: '潮汐来信（已应用）' },
    }
    const readWorkspaceState = vi.fn()
      .mockResolvedValueOnce({ status: 'ready' as const, workspaceId: WORKSPACE_ID, state: snapshot })
      .mockResolvedValue({ status: 'ready' as const, workspaceId: WORKSPACE_ID, state: appliedSnapshot })
    const listProposals = vi.fn()
      .mockResolvedValueOnce([proposal])
      .mockResolvedValue([appliedProposal])
    const applyProposal = vi.fn().mockResolvedValue({ proposal: appliedProposal, appliedItemIds: ['proposal-1-project'] })
    const workbench = controller({ readWorkspaceState, listProposals, applyProposal })
    workbench.setWorkspace(WORKSPACE_ID)
    await workbench.open()

    workbench.prepareAuthoring('project-refine')
    workbench.updateDraftBrief('保留作者自己的补充要求。')
    workbench.updateAuthoringInput({
      kind: 'structured', stage: 'project-refine', chapter: undefined,
      values: { title: '本地待审核标题' },
    })
    await workbench.applySelectedProposal()

    expect(workbench.getSnapshot()).toMatchObject({
      workspace: { snapshot: { project: { title: '潮汐来信（已应用）' } } },
      authoring: { stage: 'project-refine', brief: '', input: undefined },
    })

    workbench.prepareAuthoring('outline')
    workbench.prepareAuthoring('project-refine')
    expect(workbench.getSnapshot()).toMatchObject({ authoring: { stage: 'project-refine', brief: '', input: undefined } })
  })

  it('selects a newly received authoring proposal instead of reapplying the previously selected applied proposal', async () => {
    const appliedProjectProposal = {
      ...proposal,
      status: 'applied' as const,
      items: proposal.items.map(item => ({ ...item, status: 'applied' as const })),
    }
    const pendingArchitectureProposal = {
      ...proposal,
      proposalId: 'proposal-2-architecture',
      callId: 'call-2',
      status: 'pending' as const,
      items: [{
        itemId: 'proposal-2-architecture', itemOrder: 1, status: 'pending' as const, attemptCount: 0,
        change: {
          changeSetId: 'proposal-2-architecture', operation: 'replace' as const, aggregate: { kind: 'architecture' as const },
          baseAggregateRevision: 3, baseGlobalRevision: 7,
          nextValue: { ...snapshot.architecture, premise: '新的待审核故事架构。' },
          provenance: { origin: 'model' as const, sessionId: 'session-1', callId: 'call-2', argsHash: 'b'.repeat(64) },
        },
      }],
    }
    const listProposals = vi.fn()
      .mockResolvedValueOnce([appliedProjectProposal])
      .mockResolvedValue([appliedProjectProposal, pendingArchitectureProposal])
    const prompt = vi.fn().mockResolvedValue({ ok: true as const, value: { accepted: true as const } })
    const applyProposal = vi.fn().mockResolvedValue({
      proposal: { ...pendingArchitectureProposal, status: 'applied' as const },
      appliedItemIds: [pendingArchitectureProposal.items[0].itemId],
    })
    const workbench = controller({ listProposals, prompt, applyProposal })
    workbench.setWorkspace(WORKSPACE_ID)
    workbench.setSession(SESSION_ID)
    await workbench.open()
    expect(workbench.getSnapshot()).toMatchObject({ proposals: { selectedId: appliedProjectProposal.proposalId } })

    await workbench.startDraft('architecture')
    workbench.authoringTurnSettled()
    await workbench.refreshAfterSessionActivity()
    expect(workbench.getSnapshot()).toMatchObject({ proposals: { selectedId: pendingArchitectureProposal.proposalId } })

    workbench.selectProposal(appliedProjectProposal.proposalId)
    await workbench.refresh()
    expect(workbench.getSnapshot()).toMatchObject({ proposals: { selectedId: appliedProjectProposal.proposalId } })

    workbench.selectProposal(pendingArchitectureProposal.proposalId)
    await workbench.applySelectedProposal()
    expect(applyProposal).toHaveBeenCalledWith(WORKSPACE_ID, pendingArchitectureProposal.proposalId, expect.any(AbortSignal))
  })

  it('queues an author-facing manual request that preserves every human value and never direct-writes', async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: true as const, value: { accepted: true as const } })
    const workbench = controller({ prompt })
    workbench.setWorkspace(WORKSPACE_ID)
    workbench.setSession(SESSION_ID)
    await workbench.open()

    workbench.prepareAuthoring('project-refine')
    workbench.updateAuthoringInput({
      kind: 'structured', stage: 'project-refine', chapter: undefined,
      values: { title: '潮汐来信：人工修订', globalGuidance: '保留伏笔；不要改写结局。' },
    })
    await workbench.reproposeManualDraft()

    const text = String(prompt.mock.calls[0]?.[1])
    expect(text).toContain('项目设定优化')
    expect(text).toContain('潮汐来信：人工修订')
    expect(text).toContain('保留伏笔；不要改写结局。')
    expect(text).toContain('这是第 1 次人工修改提交请求。')
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    expect(text).not.toMatch(/JSON|revision|artifactId|characterId|Host|command|tool|工具|命令|Proposal Bundle|baseAggregate|nextValue|AI_NOVEL|novel_(?:read|propose_change|apply_change)/i)
    expect(workbench.currentAuthoringRequestText()).toBe(text)
    expect(workbench.getSnapshot()).toMatchObject({
      authoring: {
        input: { kind: 'structured' }, phase: 'submitted',
        message: '创作请求已提交；完成后会更新建议列表。',
      },
    })
  })

  it('accepts manual prose only from a selected version and always submits a revision request', async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: true as const, value: { accepted: true as const } })
    const workbench = controller({ prompt })
    workbench.setWorkspace(WORKSPACE_ID)
    workbench.setSession(SESSION_ID)
    await workbench.open()

    workbench.prepareAuthoring('chapter-blueprint', 1)
    workbench.updateAuthoringInput({ kind: 'prose', content: '不应作为蓝图提交的正文。' })
    await workbench.reproposeManualDraft()
    expect(prompt).not.toHaveBeenCalled()
    expect(workbench.getSnapshot()).toMatchObject({ authoring: { stage: 'chapter-blueprint', phase: 'error' } })

    workbench.selectFinal('draft-1')
    workbench.updateAuthoringInput({ kind: 'prose', content: '不应作为定稿选择提交的正文。' })
    await workbench.reproposeManualDraft()
    expect(prompt).not.toHaveBeenCalled()
    expect(workbench.getSnapshot()).toMatchObject({ authoring: { stage: 'select-final', phase: 'error' } })

    workbench.selectArtifact('draft-1')
    workbench.updateAuthoringInput({ kind: 'prose', content: '作者确认的人工修订正文。' })
    await workbench.reproposeManualDraft()
    expect(prompt).toHaveBeenCalledOnce()
    expect(prompt).toHaveBeenCalledWith(SESSION_ID, expect.stringContaining('本次只处理本章正文修订。'))
    expect(workbench.getSnapshot()).toMatchObject({ authoring: { stage: 'revision', chapter: 1, phase: 'submitted' } })
  })

  it('keeps an already queued identical author request retryable without submitting it twice', async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: true as const, value: { accepted: true as const } })
    const queuedRequest = v2AuthoringPrompt({
      stage: 'architecture', mode: 'ai-draft', requestNumber: 1,
      brief: '请保留信件线索。', input: undefined, chapter: undefined,
    })
    const hasQueuedAuthoringRequest = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValue(false)
    const workbench = controller({
      prompt,
      hasQueuedAuthoringRequest,
    } as Partial<NovelV2WorkbenchPort>)
    workbench.setWorkspace(WORKSPACE_ID)
    workbench.setSession(SESSION_ID)
    await workbench.open()
    workbench.prepareAuthoring('architecture')
    workbench.updateDraftBrief('请保留信件线索。')

    await workbench.startDraft('architecture')

    expect(hasQueuedAuthoringRequest).toHaveBeenCalledWith(SESSION_ID, queuedRequest)
    expect(prompt).not.toHaveBeenCalled()
    expect(workbench.currentAuthoringRequestText()).toBeUndefined()
    expect(workbench.getSnapshot()).toMatchObject({
      authoring: {
        brief: '请保留信件线索。',
        phase: 'error',
        message: '相同创作请求正在等待处理，请等待完成后再试。',
      },
    })
    expect(workbench.authoringBlocker('architecture')).toBeUndefined()

    await workbench.startDraft('architecture')
    expect(prompt).toHaveBeenCalledWith(SESSION_ID, queuedRequest)
  })

  it('does not block a differently worded queued author request', async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: true as const, value: { accepted: true as const } })
    const oldQueuedRequest = v2AuthoringPrompt({
      stage: 'architecture', mode: 'ai-draft', requestNumber: 1,
      brief: '这是先前的创作要求。', input: undefined, chapter: undefined,
    })
    const hasQueuedAuthoringRequest = vi.fn((_sessionId: SessionId, requestText: string) => requestText === oldQueuedRequest)
    const workbench = controller({
      prompt,
      hasQueuedAuthoringRequest,
    } as Partial<NovelV2WorkbenchPort>)
    workbench.setWorkspace(WORKSPACE_ID)
    workbench.setSession(SESSION_ID)
    await workbench.open()
    workbench.prepareAuthoring('architecture')
    workbench.updateDraftBrief('这是新的创作要求。')

    await workbench.startDraft('architecture')

    expect(hasQueuedAuthoringRequest).toHaveBeenCalledWith(SESSION_ID, expect.any(String))
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(workbench.currentAuthoringRequestText()).not.toBe(oldQueuedRequest)
    expect(workbench.getSnapshot()).toMatchObject({ authoring: { phase: 'submitted' } })
  })

  it('requires a project-refine Proposal before architecture for the durable minimal project revision', async () => {
    let authoritative = {
      ...snapshot,
      globalRevision: 0,
      project: { ...snapshot.project, revision: 0 },
    }
    const prompt = vi.fn().mockResolvedValue({ ok: true as const, value: { accepted: true as const } })
    const workbench = controller({
      readWorkspaceState: vi.fn(() => Promise.resolve({ status: 'ready' as const, workspaceId: WORKSPACE_ID, state: authoritative })),
      prompt,
    })
    workbench.setWorkspace(WORKSPACE_ID)
    workbench.setSession(SESSION_ID)
    await workbench.open()

    expect(workbench.authoringBlocker('project-refine')).toBeUndefined()
    expect(workbench.authoringBlocker('architecture')).toBe('请先创建并应用项目设置优化建议，再开始故事架构创作。')
    await workbench.startDraft('architecture')
    expect(prompt).not.toHaveBeenCalled()

    authoritative = { ...authoritative, globalRevision: 1, project: { ...authoritative.project, revision: 1 } }
    await workbench.refresh()
    expect(workbench.authoringBlocker('architecture')).toBeUndefined()
  })

  it('requires the prior chapter final before creating a later chapter blueprint', async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: true as const, value: { accepted: true as const } })
    const workbench = controller({ prompt })
    workbench.setWorkspace(WORKSPACE_ID)
    workbench.setSession(SESSION_ID)
    await workbench.open()

    expect(workbench.authoringBlocker('chapter-blueprint', 2))
      .toBe('请先让上一章的定稿选择进入权威快照，再创建本章蓝图以保持连续性。')
    await workbench.startDraft('chapter-blueprint', 2)
    expect(prompt).not.toHaveBeenCalled()
  })

  it('uses the exact selected prose as an ephemeral revision input', async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: true as const, value: { accepted: true as const } })
    const workbench = controller({ prompt })
    workbench.setWorkspace(WORKSPACE_ID)
    workbench.setSession(SESSION_ID)
    await workbench.open()

    workbench.selectArtifact('draft-1')
    expect(workbench.getSnapshot()).toMatchObject({
      authoring: { stage: 'revision', selectedArtifactId: 'draft-1', input: { kind: 'prose', content: snapshot.artifacts[0]!.content } },
    })
    await workbench.reproposeManualDraft()
    expect(String(prompt.mock.calls[0]?.[1])).toContain(snapshot.artifacts[0]!.content)
  })

  it('describes selected prose by a stable author-facing version label without exposing its identity', async () => {
    const versioned = {
      ...snapshot,
      artifacts: [
        snapshot.artifacts[0]!,
        {
          artifactId: 'internal-revision-identity', chapter: 1, kind: 'revision' as const,
          parentArtifactId: 'draft-1', content: '# 退潮来信（修订）', summary: '补足了寄件人的线索',
          createdAt: '2026-08-21T00:02:00.000Z',
        },
      ],
    } as unknown as NovelStateReadResult
    const prompt = vi.fn().mockResolvedValue({ ok: true as const, value: { accepted: true as const } })
    const workbench = controller({
      readWorkspaceState: vi.fn().mockResolvedValue({ status: 'ready' as const, workspaceId: WORKSPACE_ID, state: versioned }),
      prompt,
    })
    workbench.setWorkspace(WORKSPACE_ID)
    workbench.setSession(SESSION_ID)
    await workbench.open()

    workbench.selectArtifact('draft-1')
    await workbench.reproposeManualDraft()
    const revisionPrompt = String(prompt.mock.calls[0]?.[1])
    expect(revisionPrompt).toContain('请根据第 1 个版本（第 1 章初稿）提出修订建议；人工将在提案中核对目标版本后再应用。')
    expect(revisionPrompt).not.toContain('draft-1')
    expect(revisionPrompt).not.toContain('internal-revision-identity')

    workbench.authoringPromptLost()
    workbench.selectFinal('internal-revision-identity')
    await workbench.startDraft('select-final', 1)
    const finalPrompt = String(prompt.mock.calls[1]?.[1])
    expect(finalPrompt).toContain('请根据第 2 个版本（第 1 章修订稿）提出定稿建议；人工将在提案中核对目标版本后再应用。')
    expect(finalPrompt).not.toContain('draft-1')
    expect(finalPrompt).not.toContain('internal-revision-identity')
    expect(finalPrompt).not.toMatch(/artifactId|parentArtifactId|novel_(?:read|propose_change)/i)
  })

  it('retains distinct submitting, submitted, and reconciling phases until the queued proposal refreshes', async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: true as const, value: { accepted: true as const } })
    const listProposals = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([proposal])
    const workbench = controller({ prompt, listProposals })
    workbench.setWorkspace(WORKSPACE_ID)
    workbench.setSession(SESSION_ID)
    await workbench.open()

    const pending = workbench.startDraft('architecture')
    expect(workbench.getSnapshot()).toMatchObject({ authoring: { phase: 'submitting' } })
    await pending
    expect(workbench.getSnapshot()).toMatchObject({ authoring: { phase: 'submitted' } })
    expect(workbench.currentAuthoringRequestText()).toBeDefined()

    workbench.authoringTurnSettled()
    expect(workbench.getSnapshot()).toMatchObject({ authoring: { phase: 'reconciling' } })
    await workbench.refreshAfterSessionActivity()
    expect(workbench.getSnapshot()).toMatchObject({
      authoring: { phase: 'idle', message: '已更新建议列表；新的创作建议等待审核。' },
    })
    expect(workbench.currentAuthoringRequestText()).toBeUndefined()
  })

  it('hydrates a matching pending architecture Proposal into the local editable draft without applying it', async () => {
    const pendingArchitectureProposal = {
      ...proposal,
      proposalId: 'proposal-authoring-architecture',
      callId: 'call-authoring-architecture',
      items: [{
        itemId: 'proposal-authoring-architecture-item', itemOrder: 1, status: 'pending' as const, attemptCount: 0,
        change: {
          changeSetId: 'proposal-authoring-architecture-item', operation: 'replace' as const,
          aggregate: { kind: 'architecture' as const }, baseAggregateRevision: 3, baseGlobalRevision: 7,
          nextValue: {
            ...snapshot.architecture,
            premise: '待审核的新故事前提。',
            characterGraph: '林澈与周遥共同追查。',
            world: '潮汐港的旧码头。',
            styleConstraints: '悬疑感逐步升高。',
            referenceWorks: ['潮汐寓言', '旧港档案'],
          },
          provenance: { origin: 'model' as const, sessionId: 'session-1', callId: 'call-authoring-architecture', argsHash: 'c'.repeat(64) },
        },
      }],
    }
    const listProposals = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pendingArchitectureProposal])
    const prompt = vi.fn().mockResolvedValue({ ok: true as const, value: { accepted: true as const } })
    const applyProposal = vi.fn()
    const workbench = controller({ prompt, listProposals, applyProposal })
    workbench.setWorkspace(WORKSPACE_ID)
    workbench.setSession(SESSION_ID)
    await workbench.open()

    await workbench.startDraft('architecture')
    workbench.authoringTurnSettled()
    await workbench.refreshAfterSessionActivity()

    expect(workbench.getSnapshot()).toMatchObject({
      workspace: { snapshot: { architecture: { premise: snapshot.architecture.premise } } },
      proposals: { selectedId: pendingArchitectureProposal.proposalId },
      authoring: {
        stage: 'architecture', phase: 'editing',
        input: {
          kind: 'structured', stage: 'architecture', chapter: undefined,
          values: {
            premise: '待审核的新故事前提。',
            characterGraph: '林澈与周遥共同追查。',
            world: '潮汐港的旧码头。',
            styleConstraints: '悬疑感逐步升高。',
            referenceWorks: '潮汐寓言\n旧港档案',
          },
        },
        message: 'AI 生成的待审核建议已填入本地草稿；它尚未应用，请在建议队列审核后再应用。',
      },
    })
    expect(workbench.authoringBlocker('architecture')).toBe('已有待审核建议；请先审核、应用、放弃或等待它完成后再创建新的建议。')
    expect(applyProposal).not.toHaveBeenCalled()
  })

  it('hydrates a matching pending draft Proposal content locally without creating an authoritative artifact', async () => {
    const pendingDraftProposal = {
      ...proposal,
      proposalId: 'proposal-authoring-draft',
      callId: 'call-authoring-draft',
      items: [{
        itemId: 'proposal-authoring-draft-item', itemOrder: 1, status: 'pending' as const, attemptCount: 0,
        change: {
          kind: 'artifact/draft' as const, artifactId: 'pending-draft-1', chapter: 1,
          content: '这是只存在于待审核建议中的第一章正文。', summary: '第一章待审核初稿。',
        },
      }],
    }
    const listProposals = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pendingDraftProposal])
    const prompt = vi.fn().mockResolvedValue({ ok: true as const, value: { accepted: true as const } })
    const applyProposal = vi.fn()
    const workbench = controller({ prompt, listProposals, applyProposal })
    workbench.setWorkspace(WORKSPACE_ID)
    workbench.setSession(SESSION_ID)
    await workbench.open()

    await workbench.startDraft('draft', 1)
    workbench.authoringTurnSettled()
    await workbench.refreshAfterSessionActivity()

    const refreshed = workbench.getSnapshot()
    expect(refreshed).toMatchObject({
      workspace: { snapshot: { artifacts: [{ artifactId: 'draft-1' }] } },
      authoring: {
        stage: 'draft', chapter: 1, phase: 'editing',
        input: { kind: 'prose', content: '这是只存在于待审核建议中的第一章正文。' },
        message: 'AI 生成的待审核建议已填入本地草稿；它尚未应用，请在建议队列审核后再应用。',
      },
    })
    if (refreshed.status !== 'ready') throw new Error('pending draft hydration did not retain a ready workspace')
    expect(refreshed.workspace.snapshot.artifacts)
      .not.toContainEqual(expect.objectContaining({ artifactId: 'pending-draft-1' }))
    expect(applyProposal).not.toHaveBeenCalled()
  })

  it('replaces the exact pending draft Proposal with edited local prose before asking the Session for a new draft', async () => {
    const pendingDraftProposal = {
      ...proposal,
      proposalId: 'proposal-authoring-draft',
      callId: 'call-authoring-draft',
      items: [{
        itemId: 'proposal-authoring-draft-item', itemOrder: 1, status: 'pending' as const, attemptCount: 0,
        change: {
          kind: 'artifact/draft' as const, artifactId: 'pending-draft-1', chapter: 1,
          content: '这是 AI 待审核初稿。', summary: '第一章待审核初稿。',
        },
      }],
    }
    const discardedDraftProposal = {
      ...pendingDraftProposal,
      status: 'discarded' as const,
      items: pendingDraftProposal.items.map(item => ({ ...item, status: 'discarded' as const })),
    }
    const previouslyAppliedProposal = {
      ...proposal,
      proposalId: 'proposal-already-applied',
      status: 'applied' as const,
      items: proposal.items.map(item => ({ ...item, status: 'applied' as const })),
    }
    const listProposals = vi.fn()
      .mockResolvedValueOnce([previouslyAppliedProposal])
      .mockResolvedValueOnce([previouslyAppliedProposal, pendingDraftProposal])
      .mockResolvedValueOnce([previouslyAppliedProposal, discardedDraftProposal])
    const prompt = vi.fn().mockResolvedValue({ ok: true as const, value: { accepted: true as const } })
    let releaseDiscard!: () => void
    const discardProposalItem = vi.fn().mockImplementation(() => new Promise(resolve => {
      releaseDiscard = () => { resolve({ proposal: discardedDraftProposal, item: discardedDraftProposal.items[0] }) }
    }))
    const applyProposal = vi.fn()
    const workbench = controller({ listProposals, prompt, discardProposalItem, applyProposal })
    workbench.setWorkspace(WORKSPACE_ID)
    workbench.setSession(SESSION_ID)
    await workbench.open()

    await workbench.startDraft('draft', 1)
    workbench.authoringTurnSettled()
    await workbench.refreshAfterSessionActivity()
    workbench.selectProposal(previouslyAppliedProposal.proposalId)
    workbench.updateAuthoringInput({ kind: 'prose', content: '这是作者修改后的第一章初稿。' })

    const replacement = workbench.reproposeManualDraft()
    await Promise.resolve()

    expect(discardProposalItem).toHaveBeenCalledWith(
      WORKSPACE_ID,
      pendingDraftProposal.proposalId,
      pendingDraftProposal.items[0].itemId,
      expect.any(AbortSignal),
    )
    expect(prompt).toHaveBeenCalledTimes(1)
    releaseDiscard()
    await replacement

    expect(applyProposal).not.toHaveBeenCalled()
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(String(prompt.mock.calls[1]?.[1])).toContain('本次只处理本章正文初稿。')
    expect(String(prompt.mock.calls[1]?.[1])).toContain('这是作者修改后的第一章初稿。')
    expect(String(prompt.mock.calls[1]?.[1])).not.toContain('本次只处理本章正文修订。')
    expect(workbench.getSnapshot()).toMatchObject({
      authoring: {
        stage: 'draft', chapter: 1, phase: 'submitted',
        input: { kind: 'prose', content: '这是作者修改后的第一章初稿。' },
        pendingProposalItem: undefined,
      },
    })
  })

  it('keeps edited pending draft prose locally when discarding its exact Proposal item fails', async () => {
    const pendingDraftProposal = {
      ...proposal,
      proposalId: 'proposal-authoring-draft',
      callId: 'call-authoring-draft',
      items: [{
        itemId: 'proposal-authoring-draft-item', itemOrder: 1, status: 'pending' as const, attemptCount: 0,
        change: {
          kind: 'artifact/draft' as const, artifactId: 'pending-draft-1', chapter: 1,
          content: '这是 AI 待审核初稿。', summary: '第一章待审核初稿。',
        },
      }],
    }
    const listProposals = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pendingDraftProposal])
    const prompt = vi.fn().mockResolvedValue({ ok: true as const, value: { accepted: true as const } })
    const discardProposalItem = vi.fn().mockRejectedValue(new Error('discard rejected'))
    const applyProposal = vi.fn()
    const workbench = controller({ listProposals, prompt, discardProposalItem, applyProposal })
    workbench.setWorkspace(WORKSPACE_ID)
    workbench.setSession(SESSION_ID)
    await workbench.open()

    await workbench.startDraft('draft', 1)
    workbench.authoringTurnSettled()
    await workbench.refreshAfterSessionActivity()
    workbench.updateAuthoringInput({ kind: 'prose', content: '即使放弃失败也必须保留的人工初稿。' })

    await workbench.reproposeManualDraft()

    expect(discardProposalItem).toHaveBeenCalledWith(
      WORKSPACE_ID,
      pendingDraftProposal.proposalId,
      pendingDraftProposal.items[0].itemId,
      expect.any(AbortSignal),
    )
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(applyProposal).not.toHaveBeenCalled()
    expect(workbench.getSnapshot()).toMatchObject({
      authoring: {
        phase: 'error',
        input: { kind: 'prose', content: '即使放弃失败也必须保留的人工初稿。' },
        pendingProposalItem: {
          proposalId: pendingDraftProposal.proposalId,
          itemId: pendingDraftProposal.items[0].itemId,
        },
      },
    })
  })

  it('does not settle a same-stage retry from an earlier readable request', async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: true as const, value: { accepted: true as const } })
    const workbench = controller({ prompt })
    const sessions = source({
      current: SESSION_ID as SessionId | undefined,
      byId: { [SESSION_ID]: { agentPreset: 'ai-novel-writer-v2' } },
    })
    const workspaces = source({ items: [{ workspaceId: WORKSPACE_ID, sessionIds: [SESSION_ID] }] })
    const conversation = source({
      nodes: [] as Array<{ readonly kind: string; readonly seq: number; readonly content?: readonly { readonly type: string; readonly text?: string }[] }>,
      turnEnds: new Map<number, number>(),
      queue: [] as Array<{ readonly text: string | null; readonly content: readonly { readonly type: string; readonly text?: string }[] }>,
      running: false,
    })
    const route = new NovelWorkbenchRouteController()
    const stop = observeNovelV2Workspace({
      sessions: { list: sessions, binding: sessionId => sessionId === SESSION_ID ? { session: conversation } : undefined },
      workspaces: { list: workspaces },
    }, workbench, route)
    await workbench.open()

    await workbench.startDraft('architecture')
    const first = workbench.currentAuthoringRequestText()
    expect(first).toContain('这是第 1 次 AI 起草请求。')
    workbench.authoringPromptLost()

    await workbench.startDraft('architecture')
    const second = workbench.currentAuthoringRequestText()
    expect(second).toContain('这是第 2 次 AI 起草请求。')
    expect(second).not.toBe(first)

    conversation.set({
      nodes: [{ kind: 'user', seq: 11, content: [{ type: 'text', text: first }] }],
      turnEnds: new Map([[1, 12]]), queue: [], running: false,
    })
    expect(workbench.getSnapshot()).toMatchObject({ authoring: { phase: 'submitted' } })

    conversation.set({
      nodes: [
        { kind: 'user', seq: 11, content: [{ type: 'text', text: first }] },
        { kind: 'user', seq: 13, content: [{ type: 'text', text: second }] },
      ],
      turnEnds: new Map([[1, 12], [2, 14]]), queue: [], running: false,
    })
    expect(workbench.getSnapshot()).toMatchObject({ authoring: { phase: 'reconciling' } })
    await workbench.whenIdle()
    expect(workbench.getSnapshot()).toMatchObject({ authoring: { phase: 'idle' } })
    stop()
    route.dispose()
  })

  it('allows a completed historical request with no queued match without settling before its user-sequence baseline', async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: true as const, value: { accepted: true as const } })
    const historicalRequest = v2AuthoringPrompt({
      stage: 'architecture', mode: 'ai-draft', requestNumber: 1,
      brief: '', input: undefined, chapter: undefined,
    })
    const hasQueuedAuthoringRequest = vi.fn(() => false)
    const workbench = controller({
      prompt,
      hasQueuedAuthoringRequest,
    } as Partial<NovelV2WorkbenchPort>)
    const sessions = source({
      current: SESSION_ID as SessionId | undefined,
      byId: { [SESSION_ID]: { agentPreset: 'ai-novel-writer-v2' } },
    })
    const workspaces = source({ items: [{ workspaceId: WORKSPACE_ID, sessionIds: [SESSION_ID] }] })
    const history = { kind: 'user', seq: 11, content: [{ type: 'text', text: historicalRequest }] } as const
    const conversation = source({
      nodes: [history] as Array<{ readonly kind: string; readonly seq: number; readonly content?: readonly { readonly type: string; readonly text?: string }[] }>,
      turnEnds: new Map<number, number>([[1, 12]]),
      queue: [] as Array<{ readonly text: string | null; readonly content: readonly { readonly type: string; readonly text?: string }[] }>,
      running: false,
    })
    const route = new NovelWorkbenchRouteController()
    const stop = observeNovelV2Workspace({
      sessions: { list: sessions, binding: sessionId => sessionId === SESSION_ID ? { session: conversation } : undefined },
      workspaces: { list: workspaces },
    }, workbench, route)
    await workbench.open()

    await workbench.startDraft('architecture')
    expect(workbench.currentAuthoringRequestText()).toBe(historicalRequest)
    expect(hasQueuedAuthoringRequest).toHaveBeenCalledWith(SESSION_ID, historicalRequest)
    expect(prompt).toHaveBeenCalledWith(SESSION_ID, historicalRequest)

    conversation.set({ nodes: [history], turnEnds: new Map([[1, 12]]), queue: [], running: false })
    expect(workbench.getSnapshot()).toMatchObject({ authoring: { phase: 'submitted' } })

    conversation.set({
      nodes: [history, { kind: 'user', seq: 13, content: [{ type: 'text', text: historicalRequest }] }],
      turnEnds: new Map([[1, 12], [2, 14]]), queue: [], running: false,
    })
    expect(workbench.getSnapshot()).toMatchObject({ authoring: { phase: 'reconciling' } })
    await workbench.whenIdle()
    expect(workbench.getSnapshot()).toMatchObject({ authoring: { phase: 'idle' } })
    stop()
    route.dispose()
  })

  it('does not settle a new action from an older queued request that only contains its text', async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: true as const, value: { accepted: true as const } })
    const workbench = controller({ prompt })
    const sessions = source({
      current: SESSION_ID as SessionId | undefined,
      byId: { [SESSION_ID]: { agentPreset: 'ai-novel-writer-v2' } },
    })
    const workspaces = source({ items: [{ workspaceId: WORKSPACE_ID, sessionIds: [SESSION_ID] }] })
    const conversation = source({
      nodes: [] as Array<{ readonly kind: string; readonly seq: number; readonly content?: readonly { readonly type: string; readonly text?: string }[] }>,
      turnEnds: new Map<number, number>(),
      queue: [] as Array<{ readonly text: string | null; readonly content: readonly { readonly type: string; readonly text?: string }[] }>,
      running: false,
    })
    const route = new NovelWorkbenchRouteController()
    const stop = observeNovelV2Workspace({
      sessions: { list: sessions, binding: sessionId => sessionId === SESSION_ID ? { session: conversation } : undefined },
      workspaces: { list: workspaces },
    }, workbench, route)
    await workbench.open()
    await workbench.startDraft('architecture')
    const requestText = workbench.currentAuthoringRequestText()
    if (requestText === undefined) throw new Error('expected an active authoring request')
    const oldSuperstring = `先前排队的内容：\n${requestText}\n（附加说明）`

    conversation.set({
      nodes: [], turnEnds: new Map(),
      queue: [{ text: oldSuperstring, content: [{ type: 'text', text: oldSuperstring }] }], running: false,
    })
    expect(workbench.getSnapshot()).toMatchObject({ authoring: { phase: 'submitted' } })

    conversation.set({
      nodes: [{ kind: 'user', seq: 11, content: [{ type: 'text', text: oldSuperstring }] }],
      turnEnds: new Map([[1, 12]]), queue: [], running: false,
    })
    expect(workbench.getSnapshot()).toMatchObject({ authoring: { phase: 'submitted' } })

    conversation.set({
      nodes: [
        { kind: 'user', seq: 11, content: [{ type: 'text', text: oldSuperstring }] },
        { kind: 'user', seq: 13, content: [{ type: 'text', text: requestText }] },
      ],
      turnEnds: new Map([[1, 12], [2, 14]]), queue: [], running: false,
    })
    expect(workbench.getSnapshot()).toMatchObject({ authoring: { phase: 'reconciling' } })
    await workbench.whenIdle()
    expect(workbench.getSnapshot()).toMatchObject({ authoring: { phase: 'idle' } })
    stop()
    route.dispose()
  })

  it('does not revive a disconnected authoring action from a later Session turn', async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: true as const, value: { accepted: true as const } })
    const workbench = controller({ prompt })
    const sessions = source({
      current: SESSION_ID as SessionId | undefined,
      byId: { [SESSION_ID]: { agentPreset: 'ai-novel-writer-v2' } },
    })
    const workspaces = source({ items: [{ workspaceId: WORKSPACE_ID, sessionIds: [SESSION_ID] }] })
    const conversation = source({
      nodes: [] as Array<{ readonly kind: string; readonly seq: number; readonly content?: readonly { readonly type: string; readonly text?: string }[] }>,
      turnEnds: new Map<number, number>(),
      queue: [] as Array<{ readonly text: string | null; readonly content: readonly { readonly type: string; readonly text?: string }[] }>,
      running: false,
    })
    const route = new NovelWorkbenchRouteController()
    const stop = observeNovelV2Workspace({
      sessions: { list: sessions, binding: sessionId => sessionId === SESSION_ID ? { session: conversation } : undefined },
      workspaces: { list: workspaces },
    }, workbench, route)
    await workbench.open()
    await workbench.startDraft('architecture')
    const requestText = workbench.currentAuthoringRequestText()

    workbench.disconnected()
    conversation.set({
      nodes: [{ kind: 'user', seq: 11, content: [{ type: 'text', text: requestText }] }],
      turnEnds: new Map([[1, 12]]), queue: [], running: false,
    })

    expect(workbench.getSnapshot()).toMatchObject({ status: 'error', authoring: { phase: 'error' } })
    expect(workbench.currentAuthoringRequestText()).toBeUndefined()
    stop()
    route.dispose()
  })

  it.each(['submitting', 'submitted', 'reconciling'] as const)(
    'keeps a disconnected %s author draft retryable after reconnect refresh',
    async phase => {
      const accepted = { ok: true as const, value: { accepted: true as const } }
      let releaseInitial!: (value: typeof accepted) => void
      const initialPrompt = new Promise<typeof accepted>(resolve => { releaseInitial = resolve })
      const prompt = vi.fn()
        .mockReturnValueOnce(initialPrompt)
        .mockResolvedValue(accepted)
      const workbench = controller({ prompt })
      workbench.setWorkspace(WORKSPACE_ID)
      workbench.setSession(SESSION_ID)
      await workbench.open()

      workbench.prepareAuthoring('architecture')
      workbench.updateAuthoringInput({
        kind: 'structured', stage: 'architecture', chapter: undefined,
        values: { premise: '断线后仍应保留的作者设想。' },
      })
      const request = workbench.reproposeManualDraft()
      await Promise.resolve()
      expect(workbench.getSnapshot()).toMatchObject({ authoring: { phase: 'submitting' } })

      if (phase !== 'submitting') {
        releaseInitial(accepted)
        await request
      }
      if (phase === 'reconciling') workbench.authoringTurnSettled()
      expect(workbench.getSnapshot()).toMatchObject({ authoring: { phase } })

      workbench.disconnected()
      expect(workbench.getSnapshot()).toMatchObject({
        status: 'error',
        authoring: {
          stage: 'architecture', phase: 'error',
          input: { kind: 'structured', values: { premise: '断线后仍应保留的作者设想。' } },
          message: '连接已断开，创作请求未完成；你的本地创作要求仍已保留，可以重新提交。',
        },
      })
      expect(workbench.currentAuthoringRequestText()).toBeUndefined()

      if (phase === 'submitting') {
        releaseInitial(accepted)
        await request
      }
      await workbench.refresh()

      expect(workbench.getSnapshot()).toMatchObject({
        status: 'ready',
        authoring: {
          phase: 'error',
          input: { kind: 'structured', values: { premise: '断线后仍应保留的作者设想。' } },
        },
      })
      expect(workbench.authoringBlocker('architecture')).toBeUndefined()
      await workbench.reproposeManualDraft()
      expect(prompt).toHaveBeenCalledTimes(2)
      expect(workbench.getSnapshot()).toMatchObject({ authoring: { phase: 'submitted' } })
    },
  )

  it('refreshes only the authoritative snapshot and proposal queue after correlated Session activity', async () => {
    const readWorkspaceState = vi.fn().mockResolvedValue({ status: 'ready' as const, workspaceId: WORKSPACE_ID, state: snapshot })
    const listProposals = vi.fn().mockResolvedValue([])
    const readChapterContext = vi.fn()
    const workbench = controller({ readWorkspaceState, listProposals, readChapterContext })
    workbench.setWorkspace(WORKSPACE_ID)
    await workbench.open()
    await workbench.whenIdle()
    readWorkspaceState.mockClear()
    listProposals.mockClear()
    readChapterContext.mockClear()

    await workbench.refreshAfterSessionActivity()

    expect(readWorkspaceState).toHaveBeenCalledWith(WORKSPACE_ID, expect.any(AbortSignal))
    expect(listProposals).toHaveBeenCalledWith(WORKSPACE_ID, expect.any(AbortSignal))
    expect(readChapterContext).not.toHaveBeenCalled()
  })

  it('retains local drafts by authoring stage and chapter, then clears them when Session or Workspace changes', async () => {
    const workbench = controller()
    workbench.setWorkspace(WORKSPACE_ID)
    await workbench.open()

    workbench.prepareAuthoring('project-refine')
    workbench.updateDraftBrief('项目设置需要保留海港线索。')
    workbench.updateAuthoringInput({ kind: 'structured', stage: 'project-refine', chapter: undefined, values: { title: '人工标题' } })

    workbench.prepareAuthoring('outline')
    expect(workbench.getSnapshot()).toMatchObject({ authoring: { stage: 'outline', brief: '', input: undefined } })
    workbench.updateDraftBrief('全书大纲要先埋下寄信人的身份。')
    workbench.updateAuthoringInput({ kind: 'structured', stage: 'outline', chapter: undefined, values: { plotOutline: '第一章收到信，第二章追查。' } })

    workbench.prepareAuthoring('project-refine')
    expect(workbench.getSnapshot()).toMatchObject({
      authoring: {
        stage: 'project-refine',
        brief: '项目设置需要保留海港线索。',
        input: { kind: 'structured', stage: 'project-refine', chapter: undefined, values: { title: '人工标题' } },
      },
    })

    workbench.prepareAuthoring('outline')
    expect(workbench.getSnapshot()).toMatchObject({
      authoring: {
        stage: 'outline',
        brief: '全书大纲要先埋下寄信人的身份。',
        input: { kind: 'structured', stage: 'outline', chapter: undefined, values: { plotOutline: '第一章收到信，第二章追查。' } },
      },
    })

    workbench.setSession('different-session' as SessionId)
    workbench.prepareAuthoring('project-refine')
    expect(workbench.getSnapshot()).toMatchObject({ authoring: { stage: 'project-refine', brief: '', input: undefined } })

    workbench.updateDraftBrief('仅用于验证工作区切换。')
    workbench.updateAuthoringInput({ kind: 'structured', stage: 'project-refine', chapter: undefined, values: { title: '不会跨工作区' } })
    const secondWorkspace = '123e4567-e89b-42d3-a456-426614174202' as WorkspaceId
    workbench.setWorkspace(secondWorkspace)
    await workbench.whenIdle()
    workbench.prepareAuthoring('project-refine')
    expect(workbench.getSnapshot()).toMatchObject({ authoring: { stage: 'project-refine', brief: '', input: undefined } })

    workbench.prepareAuthoring('chapter-blueprint', 1)
    workbench.updateDraftBrief('第一章要先出现录音。')
    workbench.updateAuthoringInput({ kind: 'structured', stage: 'chapter-blueprint', chapter: 1, values: { title: '第一章' } })
    workbench.prepareAuthoring('chapter-blueprint', 2)
    expect(workbench.getSnapshot()).toMatchObject({ authoring: { stage: 'chapter-blueprint', chapter: 2, brief: '', input: undefined } })
    workbench.prepareAuthoring('chapter-blueprint', 1)
    expect(workbench.getSnapshot()).toMatchObject({
      authoring: {
        stage: 'chapter-blueprint',
        chapter: 1,
        brief: '第一章要先出现录音。',
        input: { kind: 'structured', stage: 'chapter-blueprint', chapter: 1, values: { title: '第一章' } },
      },
    })
  })

  it.each(STRUCTURED_AUTHORING_STAGE_SCOPES)('keeps the structured manual request for stage %s scoped and readable to an author while relying on the preset tool surface', (stage, scope) => {
    const input = {
      stage, mode: 'manual-reproposal' as const, brief: '保留事实。',
      requestNumber: 1,
      input: { kind: 'structured' as const, stage, chapter: stage === 'chapter-blueprint' ? 1 : undefined, values: { title: '作者完整人工值' } },
      chapter: stage === 'chapter-blueprint' ? 1 : undefined,
      selectedArtifactId: 'draft-1', selectedFinalArtifactId: 'revision-1',
    }
    const text = v2AuthoringPrompt(input)
    expect(v2AuthoringPrompt(input)).toBe(text)
    expect(text).toContain('作者完整人工值')
    expect(text).toContain('这是第 1 次人工修改提交请求。')
    expect(text).toContain(scope)
    expect(text).not.toMatch(/JSON|revision|artifactId|characterId|Host|command|tool|工具|命令|Proposal Bundle|baseAggregate|nextValue|AI_NOVEL|novel_(?:read|propose_change|apply_change)/i)
  })

  it('keeps manual prose scoped to the selected revision version', () => {
    const text = v2AuthoringPrompt({
      stage: 'revision', mode: 'manual-reproposal', brief: '保留事实。', requestNumber: 1,
      input: { kind: 'prose', content: '作者完整人工修订值' }, chapter: 1,
      selectedVersion: { ordinal: 2, label: '第 1 章修订稿' },
    })

    expect(text).toContain('作者完整人工修订值')
    expect(text).toContain('本次只处理本章正文修订。')
    expect(text).toContain('第 2 个版本（第 1 章修订稿）')
  })

  it.each(AUTHORING_STAGE_SCOPES)('keeps the AI drafting request for stage %s scoped and readable to an author while relying on the preset tool surface', (stage, scope) => {
    const input = {
      stage, mode: 'ai-draft' as const, brief: '让悬念更有层次。',
      requestNumber: 1,
      input: undefined, chapter: 1, selectedArtifactId: 'draft-1', selectedFinalArtifactId: 'revision-1',
    }
    const text = v2AuthoringPrompt(input)

    expect(text).toContain('让悬念更有层次。')
    expect(text).toContain('这是第 1 次 AI 起草请求。')
    expect(text).toContain(scope)
    expect(text).toContain('当前请求信息已足够。')
    expect(text).toContain('请在本回合直接完成一份完整、待审核的创作建议。')
    expect(text).toContain('将建议提交到审核队列。')
    expect(text).toContain('不要追问、给出选项或要求作者确认。')
    expect(text).toContain('不要只在对话文字中写出建议。')
    expect(text).not.toMatch(/JSON|revision|artifactId|characterId|Host|command|tool|工具|命令|Proposal Bundle|baseAggregate|nextValue|AI_NOVEL|novel_(?:read|propose_change|apply_change)/i)
  })
})

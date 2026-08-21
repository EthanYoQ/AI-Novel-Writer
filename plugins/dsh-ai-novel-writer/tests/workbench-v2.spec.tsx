// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import {
  NovelV2WorkbenchController,
  type NovelV2WorkbenchPort,
} from '../src/client/workbench-store.ts'
import { NovelV2WorkbenchBody } from '../src/client/workbench-view.tsx'
import {
  AI_NOVEL_V2_PRESET_ID,
  NovelWorkbenchRouteController,
  observeNovelV2Workspace,
} from '../src/client/workbench-v2-observer.ts'
import type { NovelProjectId } from '../src/types.ts'
import type { NovelProposalSummary, NovelTaskAggregate } from '../src/novel-store.ts'

const WORKSPACE_ID = WorkspaceId('123e4567-e89b-42d3-a456-426614174124')
const SECOND_WORKSPACE_ID = WorkspaceId('123e4567-e89b-42d3-a456-426614174125')
const SESSION_ID = 'session-1' as SessionId

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const snapshot = {
  projectId: '123e4567-e89b-42d3-a456-426614174000' as NovelProjectId,
  workspaceId: WORKSPACE_ID,
  globalRevision: 7,
  readOnly: false,
  storage: {
    applicationId: 0x41_4e_4f_56, userVersion: 2, foreignKeys: true,
    journalMode: 'wal', synchronous: 'full', lockingMode: 'normal',
  },
  project: {
    revision: 2, title: '潮汐来信', language: 'zh-CN', genre: '奇幻悬疑',
    plannedChapters: 12, targetWordsPerChapter: 3000, creativeStrategy: 'consistency-first',
    structureMode: 'three-act', narrativePov: 'third-limited', globalGuidance: '保持克制。',
    createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z',
  },
  architecture: {
    revision: 3, premise: '一封迟到的信', characterGraph: '林澈 -> 周遥', world: '海港城',
    plotOutline: '追查旧案', styleConstraints: '克制', referenceWorks: [],
  },
  characters: { revision: 4, items: [], relationships: [] },
  chapters: [{
    revision: 5, chapter: 1, title: '潮汐站', purpose: '交换证据', plotBeats: ['抵达'],
    characters: [], keyEvents: [], suspense: '录音带缺失', status: 'drafting',
  }],
  tasks: [{
    revision: 6, taskId: 'chapter-1', kind: 'chapter', stage: 'draft', status: 'failed',
    failure: '上下文不足', resumeCursor: 'chapter-1:beat-2',
    createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z',
  }],
  changes: [],
  proposals: [],
  migration: undefined,
} as const

const proposal = {
  proposalId: 'proposal-1', sessionId: 'session-1', callId: 'call-1', argsHash: 'a'.repeat(64),
  status: 'pending', createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z',
  items: [{
    itemId: 'proposal-1-item-project', itemOrder: 1, status: 'pending', attemptCount: 0,
    change: {
      changeSetId: 'proposal-1-project', operation: 'replace', aggregate: { kind: 'project' },
      baseAggregateRevision: 2, baseGlobalRevision: 7,
      nextValue: {
        title: '潮汐来信（修订）', language: 'zh-CN', genre: '奇幻悬疑', plannedChapters: 12,
        targetWordsPerChapter: 3000, creativeStrategy: 'consistency-first', structureMode: 'three-act',
        narrativePov: 'third-limited', globalGuidance: '保持克制。',
        createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T01:00:00.000Z',
      },
      provenance: { origin: 'model', sessionId: 'session-1', callId: 'call-1', argsHash: 'a'.repeat(64) },
    },
  }],
} as const

describe('V2 sidebar workbench shell', () => {
  it('delegates ordered apply and partial recovery to the Host bundle command, then refreshes its item state', async () => {
    const recovered = {
      ...proposal,
      status: 'failed' as const,
      items: [{
        ...proposal.items[0], status: 'applied' as const, attemptCount: 1,
        receipt: {
          changeSetId: proposal.items[0].change.changeSetId, projectId: snapshot.projectId,
          aggregate: { kind: 'project' as const }, aggregateRevision: 3, globalRevision: 8,
        },
      }],
    }
    const port = {
      readState: vi.fn().mockResolvedValue(snapshot),
      listProposals: vi.fn().mockResolvedValueOnce([proposal]).mockResolvedValueOnce([recovered]),
      readTask: vi.fn(),
      applyProposal: vi.fn().mockResolvedValue({
        proposal: recovered, appliedItemIds: [proposal.items[0].itemId], stoppedItemId: undefined,
      }),
    } satisfies NovelV2WorkbenchPort
    const controller = new NovelV2WorkbenchController(port)

    controller.setWorkspace(WORKSPACE_ID)
    await controller.open()
    await controller.applySelectedProposal()

    expect(port.applyProposal).toHaveBeenCalledWith(WORKSPACE_ID, 'proposal-1', expect.any(AbortSignal))
    expect(port.listProposals).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready', proposals: { items: [{ status: 'failed', items: [{
        itemId: 'proposal-1-item-project', status: 'applied', attemptCount: 1,
      }] }] },
    })
  })

  it('projects a preceding same-aggregate item as the base of a later proposal diff', async () => {
    const firstNextValue = { ...proposal.items[0].change.nextValue, title: '潮汐来信（第一项）' }
    const sequenced = {
      ...proposal,
      items: [
        { ...proposal.items[0], itemOrder: 1, change: { ...proposal.items[0].change, nextValue: firstNextValue } },
        {
          ...proposal.items[0], itemId: 'proposal-1-item-project-second', itemOrder: 2, status: 'pending' as const,
          change: {
            ...proposal.items[0].change, changeSetId: 'proposal-1-project-second',
            baseAggregateRevision: 3, baseGlobalRevision: 8,
            nextValue: { ...firstNextValue, title: '潮汐来信（第二项）' },
          },
        },
      ],
    }
    const port = {
      readState: vi.fn().mockResolvedValue(snapshot), listProposals: vi.fn().mockResolvedValue([sequenced]), readTask: vi.fn(),
    } satisfies NovelV2WorkbenchPort
    const controller = new NovelV2WorkbenchController(port)

    controller.setWorkspace(WORKSPACE_ID)
    await controller.open()
    controller.openProposalChange(1)

    const opened = controller.getSnapshot()
    expect(opened.status).toBe('ready')
    if (opened.status !== 'ready') throw new Error('expected ready workbench state')
    expect(JSON.parse(opened.editor.current)).toMatchObject({ title: '潮汐来信（第一项）' })
    expect(JSON.parse(opened.editor.next ?? '')).toMatchObject({ title: '潮汐来信（第二项）' })
    expect(opened.editor.baseAggregateRevision).toBe(3)
    expect(opened.editor.baseGlobalRevision).toBe(8)
  })

  it('uses the authoritative baseline when same-aggregate items share a base revision', async () => {
    const firstNextValue = { ...proposal.items[0].change.nextValue, title: '潮汐来信（同基准第一项）' }
    const sameBase = {
      ...proposal,
      items: [
        { ...proposal.items[0], itemOrder: 1, change: { ...proposal.items[0].change, nextValue: firstNextValue } },
        {
          ...proposal.items[0], itemId: 'proposal-1-item-project-same-base', itemOrder: 2, status: 'pending' as const,
          change: {
            ...proposal.items[0].change, changeSetId: 'proposal-1-project-same-base',
            nextValue: { ...firstNextValue, title: '潮汐来信（同基准第二项）' },
          },
        },
      ],
    }
    const port = {
      readState: vi.fn().mockResolvedValue(snapshot), listProposals: vi.fn().mockResolvedValue([sameBase]), readTask: vi.fn(),
    } satisfies NovelV2WorkbenchPort
    const controller = new NovelV2WorkbenchController(port)

    controller.setWorkspace(WORKSPACE_ID)
    await controller.open()
    controller.openProposalChange(1)

    const opened = controller.getSnapshot()
    expect(opened.status).toBe('ready')
    if (opened.status !== 'ready') throw new Error('expected ready workbench state')
    expect(JSON.parse(opened.editor.current)).toMatchObject({ title: '潮汐来信' })
    expect(JSON.parse(opened.editor.next ?? '')).toMatchObject({ title: '潮汐来信（同基准第二项）' })
    expect(opened.editor.message).toContain('stale')
  })

  it('uses the authoritative baseline when aggregate revisions are continuous but global revisions are not', async () => {
    const firstNextValue = { ...proposal.items[0].change.nextValue, title: '潮汐来信（global 链第一项）' }
    const globalBroken = {
      ...proposal,
      items: [
        { ...proposal.items[0], itemOrder: 1, change: { ...proposal.items[0].change, nextValue: firstNextValue } },
        {
          ...proposal.items[0], itemId: 'proposal-1-item-project-global-broken', itemOrder: 2, status: 'pending' as const,
          change: {
            ...proposal.items[0].change, changeSetId: 'proposal-1-project-global-broken',
            baseAggregateRevision: 3, baseGlobalRevision: 7,
            nextValue: { ...firstNextValue, title: '潮汐来信（global 链第二项）' },
          },
        },
      ],
    }
    const port = {
      readState: vi.fn().mockResolvedValue(snapshot), listProposals: vi.fn().mockResolvedValue([globalBroken]), readTask: vi.fn(),
    } satisfies NovelV2WorkbenchPort
    const controller = new NovelV2WorkbenchController(port)

    controller.setWorkspace(WORKSPACE_ID)
    await controller.open()
    controller.openProposalChange(1)

    const opened = controller.getSnapshot()
    expect(opened.status).toBe('ready')
    if (opened.status !== 'ready') throw new Error('expected ready workbench state')
    expect(JSON.parse(opened.editor.current)).toMatchObject({ title: '潮汐来信' })
    expect(opened.editor.message).toContain('stale')
  })

  it('projects a complete global revision chain across interleaved aggregates', async () => {
    const projectFirst = { ...proposal.items[0], itemOrder: 1, change: {
      ...proposal.items[0].change, nextValue: { ...proposal.items[0].change.nextValue, title: '潮汐来信（项目第一项）' },
    } }
    const architecture = {
      itemId: 'proposal-1-item-architecture', itemOrder: 2, status: 'pending' as const, attemptCount: 0,
      change: {
        changeSetId: 'proposal-1-architecture', operation: 'replace' as const, aggregate: { kind: 'architecture' as const },
        baseAggregateRevision: 3, baseGlobalRevision: 8,
        nextValue: {
          premise: '一封迟到的信（修订）', characterGraph: '林澈 -> 周遥', world: '海港城',
          plotOutline: '追查旧案', styleConstraints: '克制', referenceWorks: [],
        },
        provenance: { origin: 'model' as const, sessionId: 'session-1', callId: 'call-1', argsHash: 'a'.repeat(64) },
      },
    }
    const projectSecond = {
      ...proposal.items[0], itemId: 'proposal-1-item-project-after-architecture', itemOrder: 3, status: 'pending' as const,
      change: {
        ...proposal.items[0].change, changeSetId: 'proposal-1-project-after-architecture',
        baseAggregateRevision: 3, baseGlobalRevision: 9,
        nextValue: { ...projectFirst.change.nextValue, title: '潮汐来信（项目第二项）' },
      },
    }
    const interleaved = { ...proposal, items: [projectFirst, architecture, projectSecond] }
    const port = {
      readState: vi.fn().mockResolvedValue(snapshot), listProposals: vi.fn().mockResolvedValue([interleaved]), readTask: vi.fn(),
    } satisfies NovelV2WorkbenchPort
    const controller = new NovelV2WorkbenchController(port)

    controller.setWorkspace(WORKSPACE_ID)
    await controller.open()
    controller.openProposalChange(2)

    const opened = controller.getSnapshot()
    expect(opened.status).toBe('ready')
    if (opened.status !== 'ready') throw new Error('expected ready workbench state')
    expect(JSON.parse(opened.editor.current)).toMatchObject({ title: '潮汐来信（项目第一项）' })
    expect(JSON.parse(opened.editor.next ?? '')).toMatchObject({ title: '潮汐来信（项目第二项）' })
  })

  it('projects revision-zero new aggregates through an interleaved pending bundle chain', async () => {
    const projectFirst = {
      ...proposal.items[0], itemOrder: 1,
      change: {
        ...proposal.items[0].change,
        nextValue: { ...proposal.items[0].change.nextValue, title: '潮汐来信（创建章节前）' },
      },
    }
    const newChapter = {
      itemId: 'proposal-1-item-new-chapter', itemOrder: 2, status: 'pending' as const, attemptCount: 0,
      change: {
        changeSetId: 'proposal-1-new-chapter', operation: 'replace' as const, aggregate: { kind: 'chapter' as const, chapter: 2 },
        baseAggregateRevision: 0, baseGlobalRevision: 8,
        nextValue: {
          chapter: 2, title: '第二章', purpose: '建立新的线索', plotBeats: ['收到回信'],
          characters: [], keyEvents: [], suspense: '署名被涂改', status: 'planned' as const,
        },
        provenance: { origin: 'model' as const, sessionId: 'session-1', callId: 'call-1', argsHash: 'a'.repeat(64) },
      },
    }
    const projectAfterChapter = {
      ...proposal.items[0], itemId: 'proposal-1-item-project-after-new-chapter', itemOrder: 3, status: 'pending' as const,
      change: {
        ...proposal.items[0].change, changeSetId: 'proposal-1-project-after-new-chapter',
        baseAggregateRevision: 3, baseGlobalRevision: 9,
        nextValue: { ...projectFirst.change.nextValue, title: '潮汐来信（创建章节后）' },
      },
    }
    const chained = { ...proposal, items: [projectFirst, newChapter, projectAfterChapter] }
    const port = {
      readState: vi.fn().mockResolvedValue(snapshot), listProposals: vi.fn().mockResolvedValue([chained]), readTask: vi.fn(),
    } satisfies NovelV2WorkbenchPort
    const controller = new NovelV2WorkbenchController(port)

    controller.setWorkspace(WORKSPACE_ID)
    await controller.open()
    controller.openProposalChange(1)

    let opened = controller.getSnapshot()
    expect(opened.status).toBe('ready')
    if (opened.status !== 'ready') throw new Error('expected ready workbench state')
    expect(opened.editor.current).toBeUndefined()
    expect(opened.editor.message).not.toContain('stale')

    controller.openProposalChange(2)
    opened = controller.getSnapshot()
    expect(opened.status).toBe('ready')
    if (opened.status !== 'ready') throw new Error('expected ready workbench state')
    expect(JSON.parse(opened.editor.current)).toMatchObject({ title: '潮汐来信（创建章节前）' })
    expect(opened.editor.message).not.toContain('stale')
  })

  it('does not let discarded or superseded predecessors contaminate a later pending item baseline', async () => {
    for (const skippedStatus of ['discarded', 'superseded'] as const) {
      const skipped = {
        ...proposal,
        items: [
          {
            ...proposal.items[0], itemOrder: 1, status: skippedStatus,
            change: {
              ...proposal.items[0].change,
              nextValue: { ...proposal.items[0].change.nextValue, title: `潮汐来信（${skippedStatus} 项）` },
            },
          },
          {
            ...proposal.items[0], itemId: `proposal-1-item-after-${skippedStatus}`, itemOrder: 2, status: 'pending' as const,
            change: {
              ...proposal.items[0].change, changeSetId: `proposal-1-project-after-${skippedStatus}`,
              nextValue: { ...proposal.items[0].change.nextValue, title: `潮汐来信（${skippedStatus} 后的待应用项）` },
            },
          },
        ],
      }
      const port = {
        readState: vi.fn().mockResolvedValue(snapshot), listProposals: vi.fn().mockResolvedValue([skipped]), readTask: vi.fn(),
      } satisfies NovelV2WorkbenchPort
      const controller = new NovelV2WorkbenchController(port)

      controller.setWorkspace(WORKSPACE_ID)
      await controller.open()
      controller.openProposalChange(1)

      const opened = controller.getSnapshot()
      expect(opened.status).toBe('ready')
      if (opened.status !== 'ready') throw new Error('expected ready workbench state')
      expect(JSON.parse(opened.editor.current)).toMatchObject({ title: '潮汐来信' })
      expect(opened.editor.message).not.toContain('stale')
    }
  })

  it('does not double-count an applied predecessor already reflected by the authoritative snapshot', async () => {
    const appliedSnapshot = {
      ...snapshot,
      globalRevision: 8,
      project: { ...snapshot.project, revision: 3, title: '潮汐来信（已应用）' },
    }
    const resumed = {
      ...proposal,
      status: 'partial' as const,
      items: [
        {
          ...proposal.items[0], itemOrder: 1, status: 'applied' as const, attemptCount: 1,
          change: {
            ...proposal.items[0].change,
            nextValue: { ...proposal.items[0].change.nextValue, title: '潮汐来信（已应用）' },
          },
        },
        {
          ...proposal.items[0], itemId: 'proposal-1-item-after-applied', itemOrder: 2, status: 'pending' as const,
          change: {
            ...proposal.items[0].change, changeSetId: 'proposal-1-project-after-applied',
            baseAggregateRevision: 3, baseGlobalRevision: 8,
            nextValue: { ...proposal.items[0].change.nextValue, title: '潮汐来信（恢复后的待应用项）' },
          },
        },
      ],
    }
    const port = {
      readState: vi.fn().mockResolvedValue(appliedSnapshot), listProposals: vi.fn().mockResolvedValue([resumed]), readTask: vi.fn(),
    } satisfies NovelV2WorkbenchPort
    const controller = new NovelV2WorkbenchController(port)

    controller.setWorkspace(WORKSPACE_ID)
    await controller.open()
    controller.openProposalChange(1)

    const opened = controller.getSnapshot()
    expect(opened.status).toBe('ready')
    if (opened.status !== 'ready') throw new Error('expected ready workbench state')
    expect(JSON.parse(opened.editor.current)).toMatchObject({ title: '潮汐来信（已应用）' })
    expect(opened.editor.message).not.toContain('stale')
  })

  it('refreshes Host-persisted proposal state after a pending apply even when the user selects another bundle', async () => {
    const otherProposal = {
      ...proposal, proposalId: 'proposal-2', callId: 'call-2',
      items: [{ ...proposal.items[0], itemId: 'proposal-2-item-project', change: {
        ...proposal.items[0].change, changeSetId: 'proposal-2-project',
      } }],
    }
    const persisted = {
      ...proposal, status: 'partial' as const, items: [{
        ...proposal.items[0], status: 'applied' as const, attemptCount: 1,
        receipt: {
          changeSetId: proposal.items[0].change.changeSetId, projectId: snapshot.projectId,
          aggregate: { kind: 'project' as const }, aggregateRevision: 3, globalRevision: 8,
        },
      }],
    }
    const applied = deferred<{ readonly proposal: typeof persisted; readonly appliedItemIds: readonly string[] }>()
    const port = {
      readState: vi.fn().mockResolvedValue(snapshot),
      listProposals: vi.fn().mockResolvedValueOnce([proposal, otherProposal]).mockResolvedValueOnce([persisted, otherProposal]),
      readTask: vi.fn(),
      applyProposal: vi.fn(() => applied.promise),
    } satisfies NovelV2WorkbenchPort
    const controller = new NovelV2WorkbenchController(port)

    controller.setWorkspace(WORKSPACE_ID)
    await controller.open()
    const pending = controller.applySelectedProposal()
    await Promise.resolve()
    controller.selectProposal('proposal-2')
    applied.resolve({ proposal: persisted, appliedItemIds: [proposal.items[0].itemId] })
    await pending

    expect(port.listProposals).toHaveBeenCalledTimes(2)
    const refreshed = controller.getSnapshot()
    expect(refreshed.status).toBe('ready')
    if (refreshed.status !== 'ready') throw new Error('expected ready workbench state')
    expect(refreshed.proposals.selectedId).toBe('proposal-2')
    expect(refreshed.proposals.items.find(item => item.proposalId === 'proposal-1')).toMatchObject({
      status: 'partial', items: [{ status: 'applied', attemptCount: 1 }],
    })
  })

  it('does not blindly send a Host-stale bundle to apply', async () => {
    const stale = { ...proposal, status: 'stale' as const, items: [{
      ...proposal.items[0], status: 'stale' as const, attemptCount: 1, failure: 'STALE_REVISION' as const,
    }] }
    const port = {
      readState: vi.fn().mockResolvedValue(snapshot), listProposals: vi.fn().mockResolvedValue([stale]), readTask: vi.fn(),
      applyProposal: vi.fn(),
    } satisfies NovelV2WorkbenchPort
    const controller = new NovelV2WorkbenchController(port)

    controller.setWorkspace(WORKSPACE_ID)
    await controller.open()
    await controller.applySelectedProposal()

    expect(port.applyProposal).not.toHaveBeenCalled()
    expect(controller.getSnapshot().proposals.message).toContain('冲突')
  })

  it('keeps a Host partial bundle resumable and labels it as partially applied', async () => {
    const partial = { ...proposal, status: 'partial' as const }
    const port = {
      readState: vi.fn().mockResolvedValue(snapshot), listProposals: vi.fn().mockResolvedValue([partial]), readTask: vi.fn(),
      applyProposal: vi.fn().mockResolvedValue({ proposal: partial, appliedItemIds: [] }),
    } satisfies NovelV2WorkbenchPort
    const controller = new NovelV2WorkbenchController(port)

    controller.setWorkspace(WORKSPACE_ID)
    await controller.open()
    await controller.applySelectedProposal()

    expect(port.applyProposal).toHaveBeenCalledWith(WORKSPACE_ID, 'proposal-1', expect.any(AbortSignal))
    expect(renderToStaticMarkup(<NovelV2WorkbenchBody
      state={controller.getSnapshot()}
      refresh={() => { void controller.refresh() }} selectProposal={proposalId => { controller.selectProposal(proposalId) }}
      openProposalChange={index => { controller.openProposalChange(index) }} applySelectedProposal={() => { void controller.applySelectedProposal() }}
      retryProposalItem={index => { void controller.retryProposalItem(index) }} discardProposalItem={index => { void controller.discardProposalItem(index) }}
      regenerateProposalItem={index => { void controller.regenerateProposalItem(index) }} proposalLifecycleAvailable={controller.proposalLifecycleAvailable()}
      selectTask={taskId => { void controller.selectTask(taskId) }} selectChapter={chapter => { controller.selectChapter(chapter) }}
      openAsset={target => { controller.openAsset(target) }} updateEditor={draft => { controller.updateEditor(draft) }} discardEditor={() => { controller.discardEditor() }}
    />)).toContain('部分已应用')
  })

  it('uses only opaque proposal and item IDs for retry, discard, and regeneration', async () => {
    const failed = { ...proposal, items: [{ ...proposal.items[0], status: 'failed' as const, attemptCount: 1, failure: 'WRITE_FAILED' as const }] }
    const port = {
      readState: vi.fn().mockResolvedValue(snapshot), listProposals: vi.fn().mockResolvedValue([failed]), readTask: vi.fn(),
      retryProposalItem: vi.fn().mockResolvedValue({ proposal: failed, appliedItemIds: [], stoppedItemId: 'proposal-1-item-project' }),
      discardProposalItem: vi.fn().mockResolvedValue({ proposal: failed, item: failed.items[0] }),
      regenerateProposalItem: vi.fn().mockResolvedValue({ proposal: failed, item: failed.items[0], regenerationTicket: 'ticket-1' }),
    } satisfies NovelV2WorkbenchPort
    const controller = new NovelV2WorkbenchController(port)

    controller.setWorkspace(WORKSPACE_ID)
    await controller.open()
    await controller.retryProposalItem(0)
    await controller.discardProposalItem(0)
    await controller.regenerateProposalItem(0)

    for (const operation of [port.retryProposalItem, port.discardProposalItem, port.regenerateProposalItem]) {
      expect(operation).toHaveBeenCalledWith(WORKSPACE_ID, 'proposal-1', 'proposal-1-item-project', expect.any(AbortSignal))
    }
  })

  it('loads the path-free workspace projection into a one-column overview, proposal, task, and asset workbench', async () => {
    const port = {
      readState: vi.fn().mockResolvedValue(snapshot),
      listProposals: vi.fn().mockResolvedValue([proposal]),
      readTask: vi.fn(),
    } satisfies NovelV2WorkbenchPort
    const controller = new NovelV2WorkbenchController(port)

    controller.setWorkspace(WORKSPACE_ID)
    await controller.open()
    await controller.whenIdle()
    controller.selectProposal('proposal-1')

    expect(port.readState).toHaveBeenCalledWith(WORKSPACE_ID, expect.any(AbortSignal))
    expect(port.listProposals).toHaveBeenCalledWith(WORKSPACE_ID, expect.any(AbortSignal))
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      workspace: { globalRevision: 7, project: { title: '潮汐来信' } },
      proposals: { selectedId: 'proposal-1', items: [{ status: 'pending' }] },
      tasks: { items: [{ taskId: 'chapter-1', status: 'failed', resumeCursor: 'chapter-1:beat-2' }] },
      chapters: { selected: 1 },
    })

    const html = renderToStaticMarkup(<NovelV2WorkbenchBody
      state={controller.getSnapshot()}
      refresh={() => { void controller.refresh() }}
      selectProposal={proposalId => { controller.selectProposal(proposalId) }}
      openProposalChange={index => { controller.openProposalChange(index) }}
      applySelectedProposal={() => { void controller.applySelectedProposal() }}
      retryProposalItem={index => { void controller.retryProposalItem(index) }}
      discardProposalItem={index => { void controller.discardProposalItem(index) }}
      regenerateProposalItem={index => { void controller.regenerateProposalItem(index) }}
      proposalLifecycleAvailable={controller.proposalLifecycleAvailable()}
      selectTask={taskId => { void controller.selectTask(taskId) }}
      selectChapter={chapter => { controller.selectChapter(chapter) }}
      openAsset={target => { controller.openAsset(target) }}
      updateEditor={patch => { controller.updateEditor(patch) }}
      discardEditor={() => { controller.discardEditor() }}
    />)

    for (const text of ['项目概览', '提案队列', '任务', '资产导航', '潮汐来信', '待处理', '第 1 章']) {
      expect(html).toContain(text)
    }
    expect(html).toContain('全局版本 7')
    expect(html).toContain('可恢复')
    expect(html).toContain('data-ai-novel-v2-workbench')
  })

  it('refreshes a selected task through the existing path-free task/read contract without inventing a retry command', async () => {
    const refreshedTask = {
      ...snapshot.tasks[0], status: 'blocked' as const, failure: '等待用户补充上下文',
      updatedAt: '2026-08-21T02:00:00.000Z',
    }
    const port = {
      readState: vi.fn().mockResolvedValue(snapshot),
      listProposals: vi.fn().mockResolvedValue([proposal]),
      readTask: vi.fn().mockResolvedValue(refreshedTask),
    } satisfies NovelV2WorkbenchPort
    const controller = new NovelV2WorkbenchController(port)

    controller.setWorkspace(WORKSPACE_ID)
    await controller.open()
    await controller.whenIdle()
    await controller.selectTask('chapter-1')

    expect(port.readTask).toHaveBeenCalledWith(WORKSPACE_ID, 'chapter-1', expect.any(AbortSignal))
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      tasks: {
        selectedId: 'chapter-1',
        items: [{ taskId: 'chapter-1', status: 'blocked', failure: '等待用户补充上下文' }],
      },
    })
  })

  it('ignores a delayed task/read result after the user selects another task', async () => {
    const taskA = deferred<NovelTaskAggregate>()
    const taskB = deferred<NovelTaskAggregate>()
    const secondTask: NovelTaskAggregate = {
      ...snapshot.tasks[0], taskId: 'chapter-2', failure: '', resumeCursor: '', status: 'running' as const,
    }
    const stateWithTwoTasks = { ...snapshot, tasks: [snapshot.tasks[0], secondTask] }
    const port = {
      readState: vi.fn().mockResolvedValue(stateWithTwoTasks),
      listProposals: vi.fn().mockResolvedValue([]),
      readTask: vi.fn((_workspaceId, taskId: string) => taskId === 'chapter-1' ? taskA.promise : taskB.promise),
    } satisfies NovelV2WorkbenchPort
    const controller = new NovelV2WorkbenchController(port)

    controller.setWorkspace(WORKSPACE_ID)
    await controller.open()
    const readingA = controller.selectTask('chapter-1')
    const readingB = controller.selectTask('chapter-2')
    taskB.resolve({ ...secondTask, status: 'blocked', failure: '等待确认' })
    await readingB
    taskA.resolve({ ...snapshot.tasks[0], status: 'succeeded', failure: '' })
    await readingA

    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      tasks: {
        selectedId: 'chapter-2',
        items: [
          { taskId: 'chapter-1', status: 'failed', failure: '上下文不足' },
          { taskId: 'chapter-2', status: 'blocked', failure: '等待确认' },
        ],
      },
    })
  })

  it('recovers a refresh without losing surviving proposal, task, chapter, or local editor selection', async () => {
    const secondChapter = {
      ...snapshot.chapters[0], chapter: 2, revision: 8, title: '港口回声', purpose: '追查录音带',
    }
    const secondTask: NovelTaskAggregate = {
      ...snapshot.tasks[0], taskId: 'chapter-2', revision: 9, status: 'blocked', failure: '等待确认', resumeCursor: 'chapter-2:beat-1',
    }
    const selectedState = { ...snapshot, chapters: [snapshot.chapters[0], secondChapter], tasks: [snapshot.tasks[0], secondTask] }
    const selectedProposal = { ...proposal, proposalId: 'proposal-2' }
    const port = {
      readState: vi.fn().mockResolvedValue(selectedState),
      listProposals: vi.fn().mockResolvedValue([proposal, selectedProposal]),
      readTask: vi.fn().mockResolvedValue(secondTask),
    } satisfies NovelV2WorkbenchPort
    const controller = new NovelV2WorkbenchController(port)

    controller.setWorkspace(WORKSPACE_ID)
    await controller.open()
    controller.selectProposal('proposal-2')
    controller.openProposalChange(0)
    controller.updateEditor('{\n  "title": "本地未保存的修订"\n}')
    controller.selectChapter(2)
    await controller.selectTask('chapter-2')
    await controller.refresh()

    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      proposals: { selectedId: 'proposal-2', selectedChange: 0 },
      tasks: { selectedId: 'chapter-2' },
      chapters: { selected: 2 },
      editor: { target: { kind: 'project' }, draft: expect.stringContaining('本地未保存的修订') },
    })
  })

  it('rederives an open proposal detail from the refreshed authoritative state and proposal', async () => {
    const refreshedState = {
      ...snapshot,
      globalRevision: 8,
      project: { ...snapshot.project, revision: 3, title: '潮汐来信（当前）' },
    }
    const refreshedProposal = {
      ...proposal,
      items: [{
        ...proposal.items[0],
        change: {
          ...proposal.items[0].change, baseAggregateRevision: 3, baseGlobalRevision: 8,
          nextValue: { ...proposal.items[0].change.nextValue, title: '潮汐来信（提案新版）' },
        },
      }],
    }
    const port = {
      readState: vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValueOnce(refreshedState),
      listProposals: vi.fn().mockResolvedValueOnce([proposal]).mockResolvedValueOnce([refreshedProposal]),
      readTask: vi.fn(),
    } satisfies NovelV2WorkbenchPort
    const controller = new NovelV2WorkbenchController(port)

    controller.setWorkspace(WORKSPACE_ID)
    await controller.open()
    controller.openProposalChange(0)
    await controller.refresh()

    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready', workspace: { globalRevision: 8 },
      editor: {
        current: expect.stringContaining('潮汐来信（当前）'), next: expect.stringContaining('潮汐来信（提案新版）'),
        aggregateRevision: 3, baseGlobalRevision: 8,
      },
    })
  })

  it('keeps an asset local draft but marks it stale when refresh reads a new authoritative aggregate', async () => {
    const refreshedState = {
      ...snapshot,
      globalRevision: 8,
      architecture: { ...snapshot.architecture, revision: 4, premise: '刷新后的权威架构' },
    }
    const port = {
      readState: vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValueOnce(refreshedState),
      listProposals: vi.fn().mockResolvedValue([]),
      readTask: vi.fn(),
    } satisfies NovelV2WorkbenchPort
    const controller = new NovelV2WorkbenchController(port)

    controller.setWorkspace(WORKSPACE_ID)
    await controller.open()
    controller.openAsset({ kind: 'architecture' })
    controller.updateEditor('{\n  "premise": "本地未保存草稿"\n}')
    await controller.refresh()

    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready', workspace: { globalRevision: 8 },
      editor: {
        current: expect.stringContaining('刷新后的权威架构'), draft: expect.stringContaining('本地未保存草稿'), stale: true,
        message: expect.stringContaining('权威值已更新'),
      },
    })
  })

  it('uses the retained ready snapshot when refresh B overlaps and supersedes refresh A', async () => {
    const secondChapter = { ...snapshot.chapters[0], chapter: 2, revision: 8, title: '港口回声' }
    const secondTask: NovelTaskAggregate = {
      ...snapshot.tasks[0], taskId: 'chapter-2', revision: 9, status: 'blocked', failure: '等待确认', resumeCursor: 'chapter-2:beat-1',
    }
    const selectedState = { ...snapshot, chapters: [snapshot.chapters[0], secondChapter], tasks: [snapshot.tasks[0], secondTask] }
    const selectedProposal = { ...proposal, proposalId: 'proposal-2' }
    const stateA = deferred<typeof selectedState>()
    const proposalsA = deferred<readonly NovelProposalSummary[]>()
    const stateB = deferred<typeof selectedState>()
    const proposalsB = deferred<readonly NovelProposalSummary[]>()
    const port = {
      readState: vi.fn()
        .mockResolvedValueOnce(selectedState)
        .mockImplementationOnce(() => stateA.promise)
        .mockImplementationOnce(() => stateB.promise),
      listProposals: vi.fn()
        .mockResolvedValueOnce([proposal, selectedProposal])
        .mockImplementationOnce(() => proposalsA.promise)
        .mockImplementationOnce(() => proposalsB.promise),
      readTask: vi.fn().mockResolvedValue(secondTask),
    } satisfies NovelV2WorkbenchPort
    const controller = new NovelV2WorkbenchController(port)

    controller.setWorkspace(WORKSPACE_ID)
    await controller.open()
    controller.selectProposal('proposal-2')
    controller.openProposalChange(0)
    controller.updateEditor('{\n  "title": "B 仍应保留的草稿"\n}')
    controller.selectChapter(2)
    await controller.selectTask('chapter-2')
    const refreshA = controller.refresh()
    const refreshB = controller.refresh()
    stateB.resolve(selectedState)
    proposalsB.resolve([proposal, selectedProposal])
    await refreshB
    stateA.resolve(selectedState)
    proposalsA.resolve([proposal, selectedProposal])
    await refreshA

    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      proposals: { selectedId: 'proposal-2', selectedChange: 0 },
      tasks: { selectedId: 'chapter-2' },
      chapters: { selected: 2 },
      editor: { draft: expect.stringContaining('B 仍应保留的草稿') },
    })
  })

  it('aborts an in-flight task/read before a Workspace switch and ignores its later failure', async () => {
    const pendingTask = deferred<NovelTaskAggregate>()
    const nextWorkspaceState = { ...snapshot, workspaceId: SECOND_WORKSPACE_ID, globalRevision: 8 }
    const port = {
      readState: vi.fn((workspaceId: typeof WORKSPACE_ID) => Promise.resolve(
        workspaceId === WORKSPACE_ID ? snapshot : nextWorkspaceState,
      )),
      listProposals: vi.fn().mockResolvedValue([]),
      readTask: vi.fn((_workspaceId: typeof WORKSPACE_ID, _taskId: string, _signal: AbortSignal) => pendingTask.promise),
    } satisfies NovelV2WorkbenchPort
    const controller = new NovelV2WorkbenchController(port)

    controller.setWorkspace(WORKSPACE_ID)
    await controller.open()
    const reading = controller.selectTask('chapter-1')
    const taskSignal = port.readTask.mock.calls[0]![2] as AbortSignal
    controller.setWorkspace(SECOND_WORKSPACE_ID)
    expect(taskSignal.aborted).toBe(true)
    pendingTask.reject(new Error('late task failure'))
    await reading
    await controller.whenIdle()

    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      workspace: { workspaceId: SECOND_WORKSPACE_ID, globalRevision: 8 },
      tasks: { message: undefined },
    })
  })

  it('aborts an in-flight task/read during disposal and ignores its later failure', async () => {
    const pendingTask = deferred<NovelTaskAggregate>()
    const port = {
      readState: vi.fn().mockResolvedValue(snapshot),
      listProposals: vi.fn().mockResolvedValue([]),
      readTask: vi.fn((_workspaceId: typeof WORKSPACE_ID, _taskId: string, _signal: AbortSignal) => pendingTask.promise),
    } satisfies NovelV2WorkbenchPort
    const controller = new NovelV2WorkbenchController(port)

    controller.setWorkspace(WORKSPACE_ID)
    await controller.open()
    const reading = controller.selectTask('chapter-1')
    const taskSignal = port.readTask.mock.calls[0]![2]
    const disposing = controller.dispose()
    expect(taskSignal.aborted).toBe(true)
    pendingTask.reject(new Error('late disposal failure'))
    await Promise.all([reading, disposing])

    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', tasks: { message: undefined } })
  })

  it('waits for every overlapping refresh and task read to settle during disposal', async () => {
    const stateA = deferred<typeof snapshot>()
    const proposalsA = deferred<readonly NovelProposalSummary[]>()
    const stateB = deferred<typeof snapshot>()
    const proposalsB = deferred<readonly NovelProposalSummary[]>()
    const taskRead = deferred<NovelTaskAggregate>()
    const port = {
      readState: vi.fn().mockResolvedValueOnce(snapshot)
        .mockImplementationOnce(() => stateA.promise)
        .mockImplementationOnce(() => stateB.promise),
      listProposals: vi.fn().mockResolvedValueOnce([])
        .mockImplementationOnce(() => proposalsA.promise)
        .mockImplementationOnce(() => proposalsB.promise),
      readTask: vi.fn(() => taskRead.promise),
    } satisfies NovelV2WorkbenchPort
    const controller = new NovelV2WorkbenchController(port)

    controller.setWorkspace(WORKSPACE_ID)
    await controller.open()
    const readingTask = controller.selectTask('chapter-1')
    const refreshA = controller.refresh()
    const refreshB = controller.refresh()
    let disposed = false
    const disposing = controller.dispose().then(() => { disposed = true })

    stateB.resolve(snapshot)
    proposalsB.resolve([])
    taskRead.resolve(snapshot.tasks[0])
    await Promise.all([refreshB, readingTask])
    await Promise.resolve()
    await Promise.resolve()
    expect(disposed).toBe(false)
    stateA.resolve(snapshot)
    proposalsA.resolve([])
    await Promise.all([refreshA, disposing])
    expect(disposed).toBe(true)
  })

  it.each(['success', 'failure'] as const)(
    'keeps a failed refresh tracked until its delayed proposal sibling settles during dispose (%s)',
    async outcome => {
      const delayedState = deferred<typeof snapshot>()
      const delayedProposals = deferred<readonly NovelProposalSummary[]>()
      const port = {
        readState: vi.fn().mockResolvedValueOnce(snapshot).mockImplementationOnce(() => delayedState.promise),
        listProposals: vi.fn().mockResolvedValueOnce([]).mockImplementationOnce(() => delayedProposals.promise),
        readTask: vi.fn(),
      } satisfies NovelV2WorkbenchPort
      const controller = new NovelV2WorkbenchController(port)

      controller.setWorkspace(WORKSPACE_ID)
      await controller.open()
      let refreshSettled = false
      const refreshing = controller.refresh().then(() => { refreshSettled = true })
      delayedState.reject(new Error('state/read failed first'))
      let idle = false
      const waiting = controller.whenIdle().then(() => { idle = true })
      let disposed = false
      const disposing = controller.dispose().then(() => { disposed = true })

      for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
      expect(refreshSettled).toBe(false)
      expect(idle).toBe(false)
      expect(disposed).toBe(false)

      if (outcome === 'success') delayedProposals.resolve([])
      else delayedProposals.reject(new Error('proposal/list failed later'))
      await Promise.all([refreshing, waiting, disposing])
      expect(refreshSettled).toBe(true)
      expect(idle).toBe(true)
      expect(disposed).toBe(true)
    },
  )

  it('retains the ready view on refresh failure and restores it when the Host read recovers', async () => {
    const port = {
      readState: vi.fn()
        .mockResolvedValueOnce(snapshot)
        .mockRejectedValueOnce(new Error('connection interrupted'))
        .mockResolvedValueOnce(snapshot),
      listProposals: vi.fn()
        .mockResolvedValueOnce([proposal])
        .mockRejectedValueOnce(new Error('connection interrupted'))
        .mockResolvedValueOnce([proposal]),
      readTask: vi.fn(),
    } satisfies NovelV2WorkbenchPort
    const controller = new NovelV2WorkbenchController(port)

    controller.setWorkspace(WORKSPACE_ID)
    await controller.open()
    controller.openAsset({ kind: 'project' })
    controller.updateEditor('{\n  "title": "等待恢复"\n}')
    await controller.refresh()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      proposals: { phase: 'failed', message: 'connection interrupted' },
      editor: { draft: expect.stringContaining('等待恢复') },
    })
    await controller.refresh()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      proposals: { phase: 'ready', message: undefined },
      editor: { draft: expect.stringContaining('等待恢复') },
    })
  })

  it('disconnects an active V2 workbench, aborts its loopback reads, and requires a refresh to recover', async () => {
    const pendingState = deferred<typeof snapshot>()
    const pendingProposals = deferred<readonly NovelProposalSummary[]>()
    const port = {
      readState: vi.fn().mockResolvedValueOnce(snapshot).mockImplementationOnce((_workspaceId, _signal) => pendingState.promise),
      listProposals: vi.fn().mockResolvedValueOnce([proposal]).mockImplementationOnce((_workspaceId, _signal) => pendingProposals.promise),
      readTask: vi.fn(),
    } satisfies NovelV2WorkbenchPort
    const controller = new NovelV2WorkbenchController(port)

    controller.setWorkspace(WORKSPACE_ID)
    await controller.open()
    const refreshing = controller.refresh()
    const stateSignal = port.readState.mock.calls[1]![1] as AbortSignal
    const proposalSignal = port.listProposals.mock.calls[1]![1] as AbortSignal

    controller.disconnected()

    expect(stateSignal.aborted).toBe(true)
    expect(proposalSignal.aborted).toBe(true)
    expect(controller.getSnapshot()).toMatchObject({
      status: 'error', open: true, message: expect.stringContaining('Harness 连接已断开'),
    })
    pendingState.reject(new Error('late read error'))
    pendingProposals.reject(new Error('late proposal error'))
    await refreshing
  })

  it('opens an asset with its authoritative current aggregate instead of a blank editor', async () => {
    const port = {
      readState: vi.fn().mockResolvedValue(snapshot),
      listProposals: vi.fn().mockResolvedValue([proposal]),
      readTask: vi.fn(),
    } satisfies NovelV2WorkbenchPort
    const controller = new NovelV2WorkbenchController(port)

    controller.setWorkspace(WORKSPACE_ID)
    await controller.open()
    controller.openAsset({ kind: 'architecture' })
    const state = controller.getSnapshot()
    expect(state).toMatchObject({
      status: 'ready',
      editor: { target: { kind: 'architecture' }, draft: expect.stringContaining('一封迟到的信') },
    })
    const html = renderToStaticMarkup(<NovelV2WorkbenchBody
      state={state}
      refresh={() => { void controller.refresh() }}
      selectProposal={proposalId => { controller.selectProposal(proposalId) }}
      openProposalChange={index => { controller.openProposalChange(index) }}
      applySelectedProposal={() => { void controller.applySelectedProposal() }}
      retryProposalItem={index => { void controller.retryProposalItem(index) }}
      discardProposalItem={index => { void controller.discardProposalItem(index) }}
      regenerateProposalItem={index => { void controller.regenerateProposalItem(index) }}
      proposalLifecycleAvailable={controller.proposalLifecycleAvailable()}
      selectTask={taskId => { void controller.selectTask(taskId) }}
      selectChapter={chapter => { controller.selectChapter(chapter) }}
      openAsset={target => { controller.openAsset(target) }}
      updateEditor={draft => { controller.updateEditor(draft) }}
      discardEditor={() => { controller.discardEditor() }}
    />)

    expect(html).toContain('当前值')
    expect(html).toContain('一封迟到的信')
    expect(html).toContain('聚合版本 3')
  })

  it('follows only the V2 Harness preset to its opaque Workspace without receiving a filesystem path', () => {
    let current: SessionId | undefined = SESSION_ID
    const listeners = new Set<() => void>()
    const sources = {
      sessions: { list: {
        getSnapshot: () => ({ current, byId: { [SESSION_ID]: { agentPreset: AI_NOVEL_V2_PRESET_ID } } }),
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      } },
      workspaces: { list: {
        getSnapshot: () => ({ items: [{ workspaceId: WORKSPACE_ID, sessionIds: [SESSION_ID] }] }),
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      } },
    }
    const controller = new NovelV2WorkbenchController({ readState: vi.fn(), listProposals: vi.fn(), readTask: vi.fn() })
    const setWorkspace = vi.spyOn(controller, 'setWorkspace')

    const route = new NovelWorkbenchRouteController()
    const stop = observeNovelV2Workspace(sources, controller, route)
    expect(setWorkspace).toHaveBeenLastCalledWith(WORKSPACE_ID)
    expect(route.getSnapshot()).toBe('v2')
    current = undefined
    for (const listener of listeners) listener()
    expect(setWorkspace).toHaveBeenLastCalledWith(undefined)
    stop()
  })
})

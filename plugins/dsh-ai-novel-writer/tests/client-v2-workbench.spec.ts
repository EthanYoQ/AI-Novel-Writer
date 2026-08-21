// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronLeftOutline14: () => null,
  IconListPenOutline16: () => null,
}))
import { createNovelV2WorkbenchPort } from '../src/client/index.ts'

const WORKSPACE_ID = WorkspaceId('123e4567-e89b-42d3-a456-426614174124')
const TIMESTAMP = '2026-08-21T00:00:00.000Z'

const validState = {
  projectId: '123e4567-e89b-42d3-a456-426614174000', workspaceId: WORKSPACE_ID, globalRevision: 1, readOnly: false,
  storage: { applicationId: 1, userVersion: 2, foreignKeys: true, journalMode: 'wal', synchronous: 'full', lockingMode: 'normal' },
  project: {
    revision: 1, title: '潮汐来信', language: 'zh-CN', genre: '悬疑', plannedChapters: 12, targetWordsPerChapter: 3000,
    creativeStrategy: 'auto', structureMode: 'three-act', narrativePov: 'third-limited', globalGuidance: '', createdAt: TIMESTAMP, updatedAt: TIMESTAMP,
  },
  architecture: { revision: 1, premise: '', characterGraph: '', world: '', plotOutline: '', styleConstraints: '', referenceWorks: [] },
  characters: { revision: 1, items: [], relationships: [] },
  chapters: [], tasks: [], changes: [], proposals: [], migration: undefined,
}

const validProposal = {
  proposalId: 'proposal-1', sessionId: 'session-1', callId: 'call-1', argsHash: 'hash-1', status: 'pending',
  createdAt: TIMESTAMP, updatedAt: TIMESTAMP, changes: [],
}

describe('V2 workbench client port', () => {
  it('uses only the existing path-free state, proposal, and task loopback reads', async () => {
    const state = validState
    const proposals = [validProposal]
    const task = {
      revision: 1, taskId: 'chapter-1', kind: 'chapter', stage: 'draft', status: 'failed', failure: '上下文不足',
      resumeCursor: 'chapter-1:beat-2', createdAt: TIMESTAMP, updatedAt: TIMESTAMP,
    }
    const rpc = {
      call: vi.fn((_channel: string, endpoint: string) => Promise.resolve({
        ok: true as const,
        value: endpoint === 'state/read' ? state : endpoint === 'proposal/list' ? { proposals } : task,
      })),
    }
    const port = createNovelV2WorkbenchPort(rpc)
    const signal = new AbortController().signal

    await expect(port.readState(WORKSPACE_ID, signal)).resolves.toBe(state)
    await expect(port.listProposals(WORKSPACE_ID, signal)).resolves.toEqual(proposals)
    await expect(port.readTask(WORKSPACE_ID, 'chapter-1', signal)).resolves.toBe(task)

    expect(rpc.call).toHaveBeenNthCalledWith(1, '/ai-novel', 'state/read', { workspaceId: WORKSPACE_ID }, signal)
    expect(rpc.call).toHaveBeenNthCalledWith(2, '/ai-novel', 'proposal/list', { workspaceId: WORKSPACE_ID }, signal)
    expect(rpc.call).toHaveBeenNthCalledWith(3, '/ai-novel', 'task/read', { workspaceId: WORKSPACE_ID, taskId: 'chapter-1' }, signal)
    expect(rpc.call.mock.calls.map(call => call[1])).not.toContain('command/commit')
  })

  it('rejects a migration archivePath because no local path may cross into the browser', async () => {
    const state = { migration: { archivePath: '.ai-novel/v1-archive/fingerprint' } }
    const rpc = { call: vi.fn(() => Promise.resolve({ ok: true as const, value: state })) }
    const port = createNovelV2WorkbenchPort(rpc)

    await expect(port.readState(WORKSPACE_ID, new AbortController().signal))
      .rejects.toThrow('AI novel V2 response must not contain a local path')
  })

  it('turns malformed successful state, proposal, and task envelopes into controlled errors', async () => {
    const malformed = [
      { endpoint: 'state/read', value: { projectId: 'only-a-project-id' }, method: 'readState' },
      { endpoint: 'proposal/list', value: { proposals: [{}] }, method: 'listProposals' },
      { endpoint: 'task/read', value: { taskId: 'chapter-1' }, method: 'readTask' },
    ] as const
    for (const item of malformed) {
      const rpc = { call: vi.fn(() => Promise.resolve({ ok: true as const, value: item.value })) }
      const port = createNovelV2WorkbenchPort(rpc)
      const signal = new AbortController().signal
      const operation = item.method === 'readState'
        ? port.readState(WORKSPACE_ID, signal)
        : item.method === 'listProposals'
          ? port.listProposals(WORKSPACE_ID, signal)
          : port.readTask(WORKSPACE_ID, 'chapter-1', signal)
      await expect(operation).rejects.toThrow('AI novel V2')
    }
  })

  it('rejects successful V2 reads whose workspace or task identity does not match the request', async () => {
    const rpc = {
      call: vi.fn((_channel: string, endpoint: string) => Promise.resolve({
        ok: true as const,
        value: endpoint === 'state/read'
          ? { ...validState, workspaceId: WorkspaceId('123e4567-e89b-42d3-a456-426614174125') }
          : {
            revision: 1, taskId: 'chapter-2', kind: 'chapter', stage: 'draft', status: 'pending', failure: '',
            resumeCursor: '', createdAt: TIMESTAMP, updatedAt: TIMESTAMP,
          },
      })),
    }
    const port = createNovelV2WorkbenchPort(rpc)
    const signal = new AbortController().signal

    await expect(port.readState(WORKSPACE_ID, signal)).rejects.toThrow('AI novel V2 state response is invalid')
    await expect(port.readTask(WORKSPACE_ID, 'chapter-1', signal)).rejects.toThrow('AI novel V2 task response is invalid')
  })

  it('rejects incomplete nested V2 aggregates and proposal change envelopes', async () => {
    const rpc = {
      call: vi.fn((_channel: string, endpoint: string) => Promise.resolve({
        ok: true as const,
        value: endpoint === 'state/read'
          ? { ...validState, architecture: { ...validState.architecture, world: undefined } }
          : endpoint === 'proposal/list'
            ? { proposals: [{ ...validProposal, changes: [{
              changeSetId: 'change-1', operation: 'replace', aggregate: { kind: 'project' },
              baseAggregateRevision: 1, baseGlobalRevision: 1, nextValue: {}, provenance: { origin: 'manual' },
            }] }] }
            : { revision: 1, taskId: 'chapter-1', kind: 'chapter', stage: 'draft', status: 'unknown', failure: '', resumeCursor: '', createdAt: TIMESTAMP, updatedAt: TIMESTAMP },
      })),
    }
    const port = createNovelV2WorkbenchPort(rpc)
    const signal = new AbortController().signal

    await expect(port.readState(WORKSPACE_ID, signal)).rejects.toThrow('AI novel V2 state response is invalid')
    await expect(port.listProposals(WORKSPACE_ID, signal)).rejects.toThrow('AI novel V2 proposal response is invalid')
    await expect(port.readTask(WORKSPACE_ID, 'chapter-1', signal)).rejects.toThrow('AI novel V2 task response is invalid')
  })

  it('rejects a task proposal whose nested next value changes the requested aggregate identity', async () => {
    const taskChange = {
      changeSetId: 'change-1', operation: 'replace', aggregate: { kind: 'task', taskId: 'chapter-1' },
      baseAggregateRevision: 1, baseGlobalRevision: 1,
      nextValue: {
        taskId: 'chapter-2', kind: 'chapter', stage: 'draft', status: 'pending', failure: '', resumeCursor: '',
        createdAt: TIMESTAMP, updatedAt: TIMESTAMP,
      },
      provenance: { origin: 'manual' },
    }
    const rpc = { call: vi.fn(() => Promise.resolve({ ok: true as const, value: { proposals: [{ ...validProposal, changes: [taskChange] }] } })) }
    const port = createNovelV2WorkbenchPort(rpc)

    await expect(port.listProposals(WORKSPACE_ID, new AbortController().signal))
      .rejects.toThrow('AI novel V2 proposal response is invalid')
  })

  it('rejects a chapter proposal whose nested next value changes the requested aggregate identity', async () => {
    const chapterChange = {
      changeSetId: 'change-1', operation: 'replace', aggregate: { kind: 'chapter', chapter: 1 },
      baseAggregateRevision: 1, baseGlobalRevision: 1,
      nextValue: {
        chapter: 2, title: '错误章节', purpose: '', plotBeats: [], characters: [], keyEvents: [], suspense: '', status: 'planned',
      },
      provenance: { origin: 'manual' },
    }
    const rpc = { call: vi.fn(() => Promise.resolve({ ok: true as const, value: { proposals: [{ ...validProposal, changes: [chapterChange] }] } })) }
    const port = createNovelV2WorkbenchPort(rpc)

    await expect(port.listProposals(WORKSPACE_ID, new AbortController().signal))
      .rejects.toThrow('AI novel V2 proposal response is invalid')
  })
})

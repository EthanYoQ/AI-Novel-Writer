import { describe, expect, it, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { openNovelStore } from '../src/novel-store.ts'
import type { NovelStore, NovelStoreInitializeRequest, NovelProposalRequest } from '../src/novel-store.ts'
import { makeTestWorkspace } from './test-workspace.ts'

const signal = new AbortController().signal
const WORKSPACE_ID = WorkspaceId('workspace-proposals')

const initialization: NovelStoreInitializeRequest = {
  workspaceId: WORKSPACE_ID,
  title: '潮汐来信',
  language: 'zh-CN',
  genre: '奇幻悬疑',
  plannedChapters: 12,
  targetWordsPerChapter: 3_000,
  creativeStrategy: 'consistency-first',
  structureMode: 'three-act',
  narrativePov: 'third-limited',
  globalGuidance: '保持冷峻而温柔的语气。',
}

const baseChange = {
  changeSetId: 'proposal-change-1',
  aggregate: { kind: 'architecture' as const },
  baseAggregateRevision: 0,
  baseGlobalRevision: 0,
  nextValue: {
    premise: '信件来自明天',
    characterGraph: '',
    world: '浮岛群',
    plotOutline: '',
    styleConstraints: '',
    referenceWorks: [],
  },
}

function proposalRequest(payload: unknown = { changes: [baseChange] }): NovelProposalRequest {
  const canonicalPayload = canonicalJson(payload)
  return {
    sessionId: 'session-alpha',
    callId: 'call-0001',
    argsHash: createHash('sha256').update(canonicalPayload, 'utf8').digest('hex'),
    payload,
  }
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

const openStores: NovelStore[] = []

async function initializedStore(prefix = 'novel-proposals-'): Promise<{ root: string; store: NovelStore }> {
  const root = await makeTestWorkspace(prefix)
  const store = await openNovelStore(root, WORKSPACE_ID)
  openStores.push(store)
  await store.initialize(initialization, signal)
  return { root, store }
}

describe('NovelStore proposal inbox', () => {
  afterEach(async () => {
    await Promise.all(openStores.splice(0).map(store => store.dispose()))
  })

  it('persists one non-authoritative proposal without changing authoritative aggregates', async () => {
    const { store } = await initializedStore()
    const before = await store.read(signal)

    const submitted = await store.submitProposal(proposalRequest(), signal)

    expect(submitted.duplicate).toBe(false)
    expect(submitted.proposal).toMatchObject({
      sessionId: 'session-alpha',
      callId: 'call-0001',
      argsHash: proposalRequest().argsHash,
      status: 'pending',
      changes: [{
        ...baseChange,
        operation: 'replace',
        provenance: { origin: 'manual' },
      }],
    })
    expect(submitted.proposal.proposalId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(submitted.proposal.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

    const after = await store.read(signal)
    expect(after.globalRevision).toBe(before.globalRevision)
    expect(after.changes).toEqual(before.changes)
    expect(after.architecture).toEqual(before.architecture)
    expect(after.proposals).toHaveLength(1)
    expect(after.proposals[0]).toMatchObject({ proposalId: submitted.proposal.proposalId, status: 'pending' })
  })

  it('deduplicates identical canonical args hashes and never drops the existing proposal', async () => {
    const { store } = await initializedStore()
    const first = await store.submitProposal(proposalRequest(), signal)

    const replay = await store.submitProposal(proposalRequest(), signal)

    expect(replay.duplicate).toBe(true)
    expect(replay.proposal.proposalId).toBe(first.proposal.proposalId)
    const proposals = await store.listProposals(signal)
    expect(proposals).toHaveLength(1)
  })

  it('rejects an args hash that is not the canonical payload digest', async () => {
    const { store } = await initializedStore()

    await expect(store.submitProposal({
      ...proposalRequest(),
      argsHash: 'a'.repeat(64),
    }, signal)).rejects.toMatchObject({ code: 'INVALID_CONTENT' })
    expect(await store.listProposals(signal)).toEqual([])
  })

  it('rejects a malformed proposal payload at the durable store boundary', async () => {
    const { store } = await initializedStore()
    const malformed = {
      changes: [{
        ...baseChange,
        unexpected: 'forbidden field',
      }],
    }

    await expect(store.submitProposal(proposalRequest(malformed), signal))
      .rejects.toMatchObject({ code: 'INVALID_CONTENT' })
    await expect(store.submitProposal(proposalRequest({
      changes: [baseChange, baseChange],
    }), signal)).rejects.toMatchObject({ code: 'INVALID_CONTENT' })
    expect(await store.listProposals(signal)).toEqual([])
  })

  it('rejects a proposal submitted to an uninitialized authoritative store', async () => {
    const root = await makeTestWorkspace('novel-proposals-uninitialized-')
    const store = await openNovelStore(root, WORKSPACE_ID)
    openStores.push(store)

    await expect(store.submitProposal(proposalRequest(), signal))
      .rejects.toMatchObject({ code: 'NOT_INITIALIZED' })
    await store.initialize(initialization, signal)
    await expect(await store.listProposals(signal)).toEqual([])
  })

  it.each([
    { maxProposalBytes: 0 },
    { maxPendingProposals: 0 },
  ])('rejects invalid proposal limits before opening a store %#', async options => {
    const root = await makeTestWorkspace('novel-proposals-invalid-options-')

    await expect(openNovelStore(root, WORKSPACE_ID, options))
      .rejects.toMatchObject({ code: 'INVALID_CONTENT' })
  })

  it('deduplicates proposal args regardless of JSON key order', async () => {
    const { store } = await initializedStore()
    const first = await store.submitProposal(proposalRequest({
      changes: [{
        nextValue: baseChange.nextValue,
        baseGlobalRevision: baseChange.baseGlobalRevision,
        baseAggregateRevision: baseChange.baseAggregateRevision,
        aggregate: baseChange.aggregate,
        changeSetId: baseChange.changeSetId,
      }],
    }), signal)

    const reorderedPayload = {
      changes: [{
        aggregate: baseChange.aggregate,
        baseAggregateRevision: baseChange.baseAggregateRevision,
        baseGlobalRevision: baseChange.baseGlobalRevision,
        nextValue: baseChange.nextValue,
        changeSetId: baseChange.changeSetId,
      }],
    }
    const replay = await store.submitProposal(proposalRequest(reorderedPayload), signal)

    expect(replay.duplicate).toBe(true)
    expect(replay.proposal.proposalId).toBe(first.proposal.proposalId)
    expect(await store.listProposals(signal)).toHaveLength(1)
  })

  it('rejects a proposal bundle larger than the configured byte limit', async () => {
    const root = await makeTestWorkspace('novel-proposals-bytes-')
    const store = await openNovelStore(root, WORKSPACE_ID, { maxProposalBytes: 1024 })
    openStores.push(store)
    await store.initialize(initialization, signal)
    const oversized = 'x'.repeat(64 * 1024)

    await expect(store.submitProposal(
      proposalRequest({ changes: [{ ...baseChange, note: oversized }] }),
      signal,
    )).rejects.toMatchObject({ code: 'PROPOSAL_TOO_LARGE' })
    expect(await store.listProposals(signal)).toEqual([])
  })

  it('rejects new proposals past the pending cap without discarding existing ones', async () => {
    const { store } = await initializedStore()
    for (let index = 0; index < 20; index += 1) {
      await store.submitProposal(
        proposalRequest({ changes: [{ ...baseChange, changeSetId: `seed-${index}` }] }),
        signal,
      )
    }

    await expect(store.submitProposal(
      proposalRequest({ changes: [{ ...baseChange, changeSetId: 'overflow' }] }),
      signal,
    )).rejects.toMatchObject({ code: 'PROPOSAL_LIMIT_REACHED' })

    const proposals = await store.listProposals(signal)
    expect(proposals).toHaveLength(20)
    expect(proposals.every(proposal => proposal.status === 'pending')).toBe(true)
  })

  it('restores the persisted inbox after a store restart', async () => {
    const { root, store } = await initializedStore()
    await store.submitProposal(proposalRequest(), signal)
    await store.dispose()
    openStores.length = 0

    const reopened = await openNovelStore(root, WORKSPACE_ID)
    openStores.push(reopened)
    const proposals = await reopened.listProposals(signal)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({
      sessionId: 'session-alpha',
      callId: 'call-0001',
      status: 'pending',
      changes: [{
        ...baseChange,
        operation: 'replace',
        provenance: { origin: 'manual' },
      }],
    })
  })

  it('rejects a persisted proposal whose durable payload bytes were corrupted', async () => {
    const { root, store } = await initializedStore('novel-proposals-corrupt-')
    await store.submitProposal(proposalRequest(), signal)
    await store.dispose()
    openStores.length = 0

    const database = new DatabaseSync(join(root, '.ai-novel', 'novel.db'))
    try {
      database.prepare("UPDATE proposals SET payload = '{}'").run()
    } finally {
      database.close()
    }

    const reopened = await openNovelStore(root, WORKSPACE_ID)
    openStores.push(reopened)
    await expect(reopened.listProposals(signal)).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' })
  })
})

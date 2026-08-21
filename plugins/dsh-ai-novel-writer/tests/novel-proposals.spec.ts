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
      items: [{
        itemOrder: 0,
        status: 'pending',
        attemptCount: 0,
        change: baseChange,
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

  it('applies a persisted bundle in item order and records each item receipt with its audit transaction', async () => {
    const { store } = await initializedStore('novel-proposals-apply-')
    const before = await store.read(signal)
    const { revision: _architectureRevision, ...architecture } = before.architecture
    const { revision: _projectRevision, ...project } = before.project
    const submitted = await store.submitProposal(proposalRequest({
      changes: [
        {
          ...baseChange,
          changeSetId: 'bundle-architecture',
          aggregate: { kind: 'architecture' },
          baseAggregateRevision: before.architecture.revision,
          baseGlobalRevision: before.globalRevision,
          nextValue: { ...architecture, premise: '潮水会递送尚未写出的信。' },
        },
        {
          changeSetId: 'bundle-project',
          aggregate: { kind: 'project' },
          baseAggregateRevision: before.project.revision,
          baseGlobalRevision: before.globalRevision + 1,
          nextValue: { ...project, title: '潮汐来信：修订版' },
        },
      ],
    }), signal)
    const lifecycle = store as NovelStore & {
      applyProposal(proposalId: string, signal: AbortSignal): Promise<{
        readonly proposal: { readonly items: readonly { readonly itemOrder: number; readonly status: string; readonly receipt?: { readonly changeSetId: string } }[] }
        readonly appliedItemIds: readonly string[]
      }>
    }

    const result = await lifecycle.applyProposal(submitted.proposal.proposalId, signal)

    expect(result.appliedItemIds).toHaveLength(2)
    expect(result.proposal.items).toMatchObject([
      { itemOrder: 0, status: 'applied', receipt: { changeSetId: 'bundle-architecture' } },
      { itemOrder: 1, status: 'applied', receipt: { changeSetId: 'bundle-project' } },
    ])
    const after = await store.read(signal)
    expect(after.globalRevision).toBe(before.globalRevision + 2)
    expect(after.architecture.premise).toBe('潮水会递送尚未写出的信。')
    expect(after.project.title).toBe('潮汐来信：修订版')
    expect(after.changes.map(change => change.changeSetId)).toEqual(['bundle-architecture', 'bundle-project'])
    expect(after.proposals[0]).toMatchObject({
      proposalId: submitted.proposal.proposalId,
      status: 'applied',
      items: [
        { itemOrder: 0, status: 'applied' },
        { itemOrder: 1, status: 'applied' },
      ],
    })
  })

  it('projects a persisted partial bundle when a stale item follows an applied item, never force-applies it, and skips already applied items on recovery', async () => {
    const { store } = await initializedStore('novel-proposals-stale-')
    const before = await store.read(signal)
    const { revision: _architectureRevision, ...architecture } = before.architecture
    const { revision: _projectRevision, ...project } = before.project
    const submitted = await store.submitProposal(proposalRequest({
      changes: [
        {
          ...baseChange,
          changeSetId: 'stale-prefix-architecture',
          baseAggregateRevision: before.architecture.revision,
          baseGlobalRevision: before.globalRevision,
          nextValue: { ...architecture, premise: '第一项必须先提交。' },
        },
        {
          changeSetId: 'stale-stop-project',
          aggregate: { kind: 'project' },
          baseAggregateRevision: before.project.revision,
          baseGlobalRevision: before.globalRevision,
          nextValue: { ...project, title: '不得强推的过期标题' },
        },
      ],
    }), signal)

    const first = await store.applyProposal(submitted.proposal.proposalId, signal)
    expect(first.appliedItemIds).toHaveLength(1)
    expect(first.stoppedItemId).toBe(submitted.proposal.items[1]?.itemId)
    expect(first.proposal).toMatchObject({
      status: 'partial',
      items: [{ status: 'applied' }, { status: 'stale', failure: 'STALE_REVISION' }],
    })
    await expect(store.discardProposalItem(submitted.proposal.proposalId, submitted.proposal.items[0]!.itemId, signal))
      .rejects.toMatchObject({ code: 'PROPOSAL_ITEM_APPLIED' })

    const recovered = await store.applyProposal(submitted.proposal.proposalId, signal)
    expect(recovered).toMatchObject({ appliedItemIds: [], stoppedItemId: submitted.proposal.items[1]?.itemId })
    const after = await store.read(signal)
    expect(after.globalRevision).toBe(before.globalRevision + 1)
    expect(after.project.title).toBe(before.project.title)
    expect(after.changes.map(change => change.changeSetId)).toEqual(['stale-prefix-architecture'])
  })

  it('rejects retry for a non-retryable failed item and consumes a persisted regeneration ticket into one linked child bundle', async () => {
    const { store } = await initializedStore('novel-proposals-regenerate-')
    const before = await store.read(signal)
    const { revision: _projectRevision, ...project } = before.project
    await store.applyChange({
      changeSetId: 'conflicting-item-id',
      operation: 'replace',
      aggregate: { kind: 'project' },
      baseAggregateRevision: before.project.revision,
      baseGlobalRevision: before.globalRevision,
      nextValue: { ...project, title: '人工先占用这个变更 ID' },
      provenance: { origin: 'manual' },
    }, signal)
    const changed = await store.read(signal)
    const failed = await store.submitProposal(proposalRequest({
      changes: [{
        changeSetId: 'conflicting-item-id',
        aggregate: { kind: 'project' },
        baseAggregateRevision: changed.project.revision,
        baseGlobalRevision: changed.globalRevision,
        nextValue: { ...project, title: '模型不能重放这个 ID' },
      }],
    }), signal)
    const failedResult = await store.applyProposal(failed.proposal.proposalId, signal)
    expect(failedResult.proposal.items[0]).toMatchObject({ status: 'failed', failure: 'IDEMPOTENCY_CONFLICT' })
    await expect(store.retryProposalItem(failed.proposal.proposalId, failed.proposal.items[0]!.itemId, signal))
      .rejects.toMatchObject({ code: 'PROPOSAL_ITEM_NOT_RETRYABLE' })

    const ticketed = await store.submitProposal(proposalRequest({ changes: [{
      ...baseChange,
      changeSetId: 'regenerate-source',
      baseAggregateRevision: changed.architecture.revision,
      baseGlobalRevision: changed.globalRevision,
    }] }), signal)
    const ticket = await store.requestProposalRegeneration(ticketed.proposal.proposalId, ticketed.proposal.items[0]!.itemId, signal)
    expect(ticket.regenerationTicket).toMatch(/^[0-9a-f-]{36}$/i)
    expect(ticket.item).toMatchObject({ status: 'pending', regenerationTicket: ticket.regenerationTicket })

    const child = await store.submitProposal(proposalRequest({
      regenerationTicket: ticket.regenerationTicket,
      changes: [{
        ...baseChange,
        changeSetId: 'regenerated-child',
        baseAggregateRevision: changed.architecture.revision,
        baseGlobalRevision: changed.globalRevision,
        nextValue: { ...baseChange.nextValue, premise: '重新生成后才保留的方案' },
      }],
    }), signal)
    expect(child.proposal).toMatchObject({
      parentProposalId: ticketed.proposal.proposalId,
      parentItemId: ticketed.proposal.items[0]?.itemId,
      items: [{ itemOrder: 0, status: 'pending', change: { changeSetId: 'regenerated-child' } }],
    })
    const source = (await store.listProposals(signal)).find(proposal => proposal.proposalId === ticketed.proposal.proposalId)
    expect(source).toMatchObject({
      status: 'superseded',
      items: [{ status: 'superseded', supersededByProposalId: child.proposal.proposalId }],
    })
  })

  it('skips superseded and discarded items so a later pending bundle item remains reachable', async () => {
    const { store } = await initializedStore('novel-proposals-regeneration-resume-')
    const before = await store.read(signal)
    const { revision: _architectureRevision, ...architecture } = before.architecture
    const { revision: _projectRevision, ...project } = before.project
    const source = await store.submitProposal(proposalRequest({
      changes: [
        {
          ...baseChange,
          changeSetId: 'superseded-first-item',
          baseAggregateRevision: before.architecture.revision,
          baseGlobalRevision: before.globalRevision,
          nextValue: { ...architecture, premise: '此项将重新生成。' },
        },
        {
          ...baseChange,
          changeSetId: 'discarded-middle-item',
          baseAggregateRevision: before.architecture.revision,
          baseGlobalRevision: before.globalRevision,
          nextValue: { ...architecture, premise: '此项由用户丢弃。' },
        },
        {
          changeSetId: 'reachable-later-project-item',
          aggregate: { kind: 'project' },
          baseAggregateRevision: before.project.revision,
          baseGlobalRevision: before.globalRevision,
          nextValue: { ...project, title: '后续项目项仍可提交' },
        },
      ],
    }), signal)
    const ticket = await store.requestProposalRegeneration(source.proposal.proposalId, source.proposal.items[0]!.itemId, signal)
    await store.discardProposalItem(source.proposal.proposalId, source.proposal.items[1]!.itemId, signal)
    const child = await store.submitProposal(proposalRequest({
      regenerationTicket: ticket.regenerationTicket,
      changes: [{
        ...baseChange,
        changeSetId: 'regenerated-first-item',
        baseAggregateRevision: before.architecture.revision,
        baseGlobalRevision: before.globalRevision,
        nextValue: { ...architecture, premise: '子 proposal 的替代项。' },
      }],
    }), signal)

    const recoverable = (await store.listProposals(signal)).find(proposal => proposal.proposalId === source.proposal.proposalId)
    expect(recoverable).toMatchObject({
      status: 'pending',
      items: [{ status: 'superseded' }, { status: 'discarded' }, { status: 'pending' }],
    })
    const resumed = await store.applyProposal(source.proposal.proposalId, signal)
    expect(resumed.appliedItemIds).toEqual([source.proposal.items[2]!.itemId])
    expect(resumed.proposal.items).toMatchObject([{ status: 'superseded' }, { status: 'discarded' }, {
      status: 'applied', receipt: { changeSetId: 'reachable-later-project-item' },
    }])
    expect(child.proposal.status).toBe('pending')
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
      items: [{
        itemOrder: 0,
        status: 'pending',
        attemptCount: 0,
        change: baseChange,
      }],
    })
  })

  it('migrates a V2 proposal payload into ordered V3 items before any lifecycle operation', async () => {
    const { root, store } = await initializedStore('novel-proposals-v2-migration-')
    const submitted = await store.submitProposal(proposalRequest(), signal)
    await store.dispose()
    openStores.length = 0

    const database = new DatabaseSync(join(root, '.ai-novel', 'novel.db'))
    try {
      database.exec('DROP TABLE chapter_finals')
      database.exec('ALTER TABLE artifacts DROP COLUMN summary')
      database.exec('DROP TABLE proposal_items')
      database.exec('ALTER TABLE proposals DROP COLUMN parent_proposal_id')
      database.exec('ALTER TABLE proposals DROP COLUMN parent_item_id')
      database.exec('PRAGMA user_version = 2')
      database.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run()
    } finally {
      database.close()
    }

    const migrated = await openNovelStore(root, WORKSPACE_ID)
    openStores.push(migrated)
    const proposal = (await migrated.listProposals(signal))[0]
    expect((await migrated.read(signal)).storage.userVersion).toBe(4)
    expect(proposal).toMatchObject({
      proposalId: submitted.proposal.proposalId,
      status: 'pending',
      items: [{ itemOrder: 0, status: 'pending', attemptCount: 0, change: { changeSetId: baseChange.changeSetId } }],
    })
    await expect(migrated.applyProposal(proposal!.proposalId, signal)).resolves.toMatchObject({
      proposal: { status: 'applied', items: [{ status: 'applied' }] },
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

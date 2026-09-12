import { describe, expect, it } from 'vitest'
import { hashAuthorText, validateSourceRef, mayUseCandidate, type FrozenInputFingerprint, type CandidateSource } from '../source-ref'
import { assertReservation, assertAttemptTransition, assertVisibleSnapshot, rootActionIdempotencyKey, tokenLiability, type PhysicalAttempt, type RootAction } from '../generation-contract'
import { resolveCharacterIdentity, assertCharacterResolution, decideDerivedPatch, rejectedCharacterProposalKey, type CharacterFieldSnapshot, type DerivedCharacterPatch } from '../character-identity'
import { isNoopRevision, decideFindingStatus, assertSingleRecheck, findingAnchorKey, type ReviewFinding } from '../review-cycle'
import { MIGRATION_IDS, assertDistinctStorageRoots, mayHydrateAppearance, mayReadTransferredAuthority, mayReplayTransferredExecution, type TransferReadableAuthority } from '../project-storage'

const h = 'a'.repeat(64)
const identity = { projectId: '合成项目', epoch: '本次会话' }
const fingerprint: FrozenInputFingerprint = { chapterBriefHash: h, authorGuidanceHash: h, dependencyHash: h, contextSnapshotHash: h, templateHash: h, skillSnapshotHash: h, modelLeaseRevision: '模型版本', policyHash: h, outputContractHash: h }
const root: RootAction = { ...identity, rootActionId: '根动作', operation: '正文', uiActionNonce: '点击一次', frozenInputHash: h, status: 'active' }
const attempt = (id: string): PhysicalAttempt => ({ attemptId: id, reservationId: id, rootActionId: root.rootActionId, status: 'reserved', reservedTokens: 100, requestedOutputTokens: 80 })
const budget = { maxPhysicalRequests: 2, maxTokenLiability: 200, maxOutputPerRequest: 80, maxActiveElapsedMs: 1000 }

describe('S01共享契约（纯合成，不是生产持久化资格）', () => {
  it('原文UTF8哈希不规范化，UTF16范围不会误用码点长度', async () => {
    const text = '甲𠀀乙'
    const ref = { ...identity, sourceId: '定稿一', revision: 1, contentHash: await hashAuthorText(text), span: { start: 1, end: 3, unit: 'utf16-code-unit' as const } }
    expect(text.slice(1, 3)).toBe('𠀀')
    expect(await validateSourceRef(ref, identity, text)).toBe(true)
    expect(await validateSourceRef({ ...ref, span: { ...ref.span, end: 5 } }, identity, text)).toBe(false)
    expect(await validateSourceRef(ref, { ...identity, epoch: '重开' }, text)).toBe(false)
    expect(await hashAuthorText('甲\r\n乙')).not.toBe(await hashAuthorText('甲\n乙'))
    expect(await validateSourceRef(ref, identity, text + '。')).toBe(false)
  })
  it('只有选中当前草稿或本批直接前驱能入上下文，坏状态全拒绝', () => {
    const candidate: CandidateSource = { ...identity, artifactId: '候选一', revision: 1, state: 'draft', saved: true, batchLineage: '批次一', fingerprint }
    const admission = { ...identity, batchLineage: '批次一', directPredecessorId: '候选一' }
    expect(mayUseCandidate(candidate, admission)).toBe(true)
    for (const state of ['partial', 'recovery', 'source-conflict', 'discarded', 'stale', 'replaced'] as const) expect(mayUseCandidate({ ...candidate, state }, admission)).toBe(false)
    expect(mayUseCandidate({ ...candidate, saved: false }, admission)).toBe(false)
    expect(mayUseCandidate({ ...candidate, batchLineage: '别批' }, admission)).toBe(false)
    expect(mayUseCandidate({ ...candidate, epoch: '旧会话' }, admission)).toBe(false)
    expect(mayUseCandidate(candidate, { ...admission, directPredecessorId: '别章' })).toBe(false)
  })
  it('重复点击根key稳定、改冻结目标不能复用同key', () => {
    expect(rootActionIdempotencyKey(root)).toBe(rootActionIdempotencyKey({ ...root }))
    expect(rootActionIdempotencyKey({ ...root, epoch: '重开会话' })).toBe(rootActionIdempotencyKey(root))
    expect(rootActionIdempotencyKey({ ...root, frozenInputHash: 'b'.repeat(64) })).not.toBe(rootActionIdempotencyKey(root))
  })
  it('重复reservation、根漂移、已发未知、输出上限和elapsed拒绝', () => {
    expect(() => assertReservation(root, budget, [], attempt('一'), 0)).not.toThrow()
    expect(() => assertReservation(root, budget, [attempt('一')], attempt('一'), 0)).toThrow('RESERVATION_CONFLICT')
    expect(() => assertReservation(root, budget, [], { ...attempt('一'), rootActionId: '别根' }, 0)).toThrow()
    expect(() => assertReservation({ ...root, rootActionId: '' }, budget, [], { ...attempt('一'), rootActionId: '' }, 0)).toThrow('INVALID_ROOT_ACTION')
    expect(() => assertReservation(root, budget, [{ ...attempt('一'), status: 'unknown' }, attempt('二')], attempt('三'), 0)).toThrow('ROOT_BUDGET_EXHAUSTED')
    expect(() => assertReservation(root, budget, [], { ...attempt('一'), requestedOutputTokens: 81 }, 0)).toThrow('INVALID_OUTPUT_RESERVATION')
    expect(() => assertReservation(root, budget, [], attempt('一'), 1000)).toThrow('ROOT_BUDGET_EXHAUSTED')
    expect(() => assertAttemptTransition('unknown', 'reserved')).toThrow()
    expect(() => assertAttemptTransition('dispatch-marked', 'cancelled-before-dispatch')).toThrow()
  })
  it('未知usage保守占用，超估实记且停止下一请求', () => {
    expect(tokenLiability({ ...attempt('一'), status: 'unknown' })).toBe(100)
    expect(tokenLiability({ ...attempt('一'), status: 'settled', actualTokens: 150 })).toBe(150)
    expect(() => assertReservation(root, { ...budget, maxTokenLiability: 1000 }, [{ ...attempt('一'), status: 'settled', actualTokens: 150 }], attempt('二'), 0)).toThrow('USAGE_EXCEEDED_RESERVATION')
    expect(tokenLiability({ ...attempt('一'), status: 'cancelled-before-dispatch' })).toBe(0)
  })
  it('可见快照只接受同attempt同epoch单调前缀及真实文本hash', async () => {
    const before = { ...identity, artifactId: '候选', attemptId: '尝试', rootActionId: '根', revision: 1, text: '甲', textHash: await hashAuthorText('甲'), fingerprint }
    const after = { ...before, revision: 2, text: '甲乙', textHash: await hashAuthorText('甲乙') }
    await expect(assertVisibleSnapshot(before, after, 1)).resolves.toBeUndefined()
    for (const changed of [{ ...after, textHash: h }, { ...after, attemptId: '新尝试' }, { ...after, epoch: '旧epoch' }, { ...after, revision: 1 }, { ...after, text: '乙甲' }, { ...after, fingerprint: { ...fingerprint, templateHash: 'b'.repeat(64) } }]) await expect(assertVisibleSnapshot(before, changed, 1)).rejects.toThrow('ARTIFACT_SNAPSHOT_CONFLICT')
    await expect(assertVisibleSnapshot({ ...before, revision: -1 }, { ...after, revision: 0 }, -1)).rejects.toThrow()
    await expect(assertVisibleSnapshot({ ...before, artifactId: '' }, { ...after, artifactId: '' }, 1)).rejects.toThrow()
  })
  it('同名与未知身份不first-match，伪resolved拒绝', () => {
    expect(resolveCharacterIdentity('陆青', ['药师', '驿卒']).status).toBe('ambiguous')
    expect(resolveCharacterIdentity('陌生人', []).status).toBe('unresolved')
    expect(resolveCharacterIdentity('药师', ['药师']).status).toBe('resolved')
    expect(() => assertCharacterResolution({ status: 'resolved', characterId: '药师' }, ['药师', '驿卒'])).toThrow()
    expect(() => assertCharacterResolution({ status: 'ambiguous', originalText: '陆青', candidateIds: ['药师', '药师'] }, ['药师', '驿卒'])).toThrow()
  })
  function characterCase() {
    const source = { draftId: 3, finalizationId: '定稿三', chapterNumber: 3, contentHash: h }
    const order = { continuityEpoch: '连续性一', chapterNumber: 3, authoritativeFinalizationRevision: 1 }
    const current: CharacterFieldSnapshot = { ...identity, characterId: '药师ID', field: 'location', revision: 1, value: '', valueHash: h, provenance: { kind: 'legacy' } }
    const patch: DerivedCharacterPatch = { ...identity, characterId: current.characterId, field: current.field, value: '药铺', valueHash: 'b'.repeat(64), baseFieldRevision: 1, baseValueHash: h, baseProvenance: current.provenance, source, sourceOrder: order }
    return { current, patch, authority: { source, order } }
  }
  it('空字段非冲突自动derived，author/legacy冲突提议，提交时作者修改拒绝', () => {
    const { current, patch, authority } = characterCase()
    expect(decideDerivedPatch(current, patch, authority)).toBe('apply-derived')
    const authored = { ...current, value: '作者指定', provenance: { kind: 'author' as const, chapterNumber: 1 } }
    expect(decideDerivedPatch(authored, { ...patch, baseProvenance: authored.provenance }, authority)).toBe('proposal-required')
    expect(decideDerivedPatch({ ...current, revision: 2 }, patch, authority)).toBe('field-conflict')
    expect(decideDerivedPatch({ ...current, value: '旧值' }, patch, authority)).toBe('proposal-required')
  })
  it('晚到第3章不覆盖第4章derived，同章旧回包与epoch过期拒绝', () => {
    const { current, patch, authority } = characterCase()
    expect(decideDerivedPatch({ ...current, sourceOrder: { ...authority.order, chapterNumber: 4 } }, patch, authority)).toBe('source-conflict')
    expect(decideDerivedPatch(current, patch, { ...authority, order: { ...authority.order, authoritativeFinalizationRevision: 2 } })).toBe('source-conflict')
    expect(decideDerivedPatch(current, { ...patch, epoch: '旧' }, authority)).toBe('source-conflict')
    expect(decideDerivedPatch(current, { ...patch, characterId: '另一陆青' }, authority)).toBe('field-conflict')
    const invalidSource = { ...patch.source, finalizationId: '', draftId: 0 }
    expect(decideDerivedPatch(current, { ...patch, source: invalidSource }, { ...authority, source: invalidSource })).toBe('source-conflict')
    expect(decideDerivedPatch({ ...current, provenance: { kind: 'derived', source: { ...patch.source, chapterNumber: 4 } } }, { ...patch, baseProvenance: { kind: 'derived', source: { ...patch.source, chapterNumber: 4 } } }, authority)).toBe('source-conflict')
  })
  it('同源同值幂等，拒绝去重按来源变化重新判定', () => {
    const { current, patch, authority } = characterCase()
    expect(decideDerivedPatch({ ...current, valueHash: patch.valueHash, sourceOrder: authority.order, provenance: { kind: 'derived', source: patch.source } }, patch, authority)).toBe('already-applied')
    expect(rejectedCharacterProposalKey(patch)).toBe(rejectedCharacterProposalKey({ ...patch }))
    expect(rejectedCharacterProposalKey({ ...patch, source: { ...patch.source, contentHash: 'c'.repeat(64) } })).not.toBe(rejectedCharacterProposalKey(patch))
  })
  it('no-op与无关改动不假绿，复核绑定合并稿与finding集合', () => {
    expect(isNoopRevision('甲\n乙', '甲 \u200b乙')).toBe(true)
    expect(isNoopRevision('甲。', '甲！')).toBe(false)
    const input = { uniqueAnchor: true, relevantHunkChanged: true, noop: false, authorWaived: false, mergedHash: h, findingSetHash: h, targetId: '事实一' }
    expect(decideFindingStatus({ ...input, noop: true })).toBe('unresolved')
    expect(decideFindingStatus({ ...input, relevantHunkChanged: false })).toBe('unresolved')
    expect(decideFindingStatus(input)).toBe('unknown')
    const recheck = { mergedHash: h, findingSetHash: h, newEvidenceHash: h, targetId: '事实一', resolved: true }
    expect(decideFindingStatus({ ...input, recheck })).toBe('resolved')
    expect(decideFindingStatus({ ...input, recheck: { ...recheck, mergedHash: 'b'.repeat(64) } })).toBe('unknown')
    expect(decideFindingStatus({ ...input, authorWaived: true })).toBe('author-waived')
    expect(decideFindingStatus({ ...input, mergedHash: '', findingSetHash: '', targetId: '', recheck: { ...recheck, mergedHash: '', findingSetHash: '', targetId: '' } })).toBe('unknown')
    expect(() => assertSingleRecheck({ cycleId: '审修', rootActionId: '根', sourceHash: h, findingSetHash: h, revisionStatus: 'merge-committed', mergedHash: h, recheckCount: 1 })).toThrow()
  })
  it('负数反向span和伪byte单位不能形成finding锚点', () => {
    const finding: ReviewFinding = { findingId: '意见', source: { ...identity, sourceId: '章节', revision: 1, contentHash: h, span: { start: 0, end: 1, unit: 'utf16-code-unit' } }, excerptHash: h, occurrence: 1, category: '连续性', targetId: '事实', kind: 'objective', status: 'unverified' }
    expect(() => findingAnchorKey(finding)).not.toThrow()
    for (const span of [{ start: -9, end: -1, unit: 'utf16-code-unit' }, { start: 2, end: 1, unit: 'utf16-code-unit' }, { start: 0, end: 1, unit: 'bytes' }]) expect(() => findingAnchorKey({ ...finding, source: { ...finding.source, span } } as ReviewFinding)).toThrow('UNVERIFIED_FINDING')
  })
  it('存储业务lane仅ID，不允许根相交或未证明reparse；mainReady先于appearance', () => {
    expect(MIGRATION_IDS).toEqual(['M00', 'M01', 'M02', 'M03', 'M04', 'M05'])
    const proof = { canonicalRealPath: 'C:\\合成\\来源', platform: 'win32' as const, authorized: true, reparseFree: true }
    expect(() => assertDistinctStorageRoots([proof, { ...proof, canonicalRealPath: 'c:\\合成\\来源\\子目录' }])).toThrow()
    expect(() => assertDistinctStorageRoots([{ ...proof, reparseFree: false }])).toThrow()
    expect(mayHydrateAppearance({ state: 'blocked' })).toBe(false)
    expect(mayHydrateAppearance({ state: 'ready', globalGeneration: '全局代一', skinRevision: 2 })).toBe(true)
  })
  it('恢复承接当前可读事实但绝不旧执行重放，失效来源不可读', () => {
    const receipt: TransferReadableAuthority = { transferId: '转移', origin: { projectId: '旧', epoch: '旧' }, target: identity, snapshotGeneration: '快照', domainId: '人物一', source: { draftId: 1, finalizationId: '定稿一', chapterNumber: 1, contentHash: h }, provenance: 'derived', sourceCurrent: true, sourceUnambiguous: true, restoredContentHash: h, nonReplayable: true }
    expect(mayReadTransferredAuthority(receipt, identity)).toBe(true)
    for (const changed of [{ ...receipt, sourceCurrent: false }, { ...receipt, sourceUnambiguous: false }, { ...receipt, restoredContentHash: 'b'.repeat(64) }, { ...receipt, target: receipt.origin }, { ...receipt, origin: { projectId: '', epoch: '' } }, { ...receipt, source: { ...receipt.source, finalizationId: '' } }]) expect(mayReadTransferredAuthority(changed, identity)).toBe(false)
    expect(mayReplayTransferredExecution({ nonReplayable: true, originalRootActionId: '旧根', status: 'unknown', presentation: 'visible-history', reservedTokens: 100 })).toBe(false)
  })
})

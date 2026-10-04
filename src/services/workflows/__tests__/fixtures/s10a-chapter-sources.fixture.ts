import type { FrozenInputFingerprint } from '../../../../shared/source-ref'
import type { MaterialCandidate } from '../../source-selection'

const hashOf = (seed: string) => seed.repeat(64).slice(0, 64)
const fingerprint = (): FrozenInputFingerprint => ({
  chapterBriefHash: hashOf('1'), authorGuidanceHash: hashOf('2'), dependencyHash: hashOf('3'),
  contextSnapshotHash: hashOf('4'), templateHash: hashOf('5'), skillSnapshotHash: hashOf('6'),
  modelLeaseRevision: hashOf('7'), policyHash: hashOf('8'), outputContractHash: hashOf('9'),
})
const current = { projectId: '项目', epoch: '会话' }
const capacity = { maxInputUnits: 40_000, methodVersion: 'utf8-bytes-v1' }
const LINEAGE = '批次-1'

/** 已保存且在冻结 lineage 内的候选；是否入选完全由准入决定。 */
function savedDraft(artifactId: string, admission: { selectedCurrentDraftId?: string; directPredecessorId?: string }) {
  return { source: { ...current, artifactId, revision: 1, state: 'draft' as const, saved: true,
    batchLineage: LINEAGE, fingerprint: fingerprint() },
  admission: { ...current, batchLineage: LINEAGE, ...admission } }
}

/**
 * 同一中文语义源构造的材料集，同时供 source-selection 与 context-snapshot 两个套件
 * 使用：同章两稿、已替换来源、合法直接前驱、未来秘密、重复定位、超容量长设定。
 */
export function s10aFixture(): { current: typeof current; capacity: typeof capacity; materials: MaterialCandidate[] } {
  const materials: MaterialCandidate[] = [
    { ref: { ...current, sourceId: 'finalized:1', revision: 3, contentHash: hashOf('a') },
      category: 'finalized-history', provenance: 'finalized', required: true, text: '第一章定稿原文' },
    // 第二个定位索引指向同一份不可变内容，用来验证重复材料只进一次。
    { ref: { ...current, sourceId: 'finalized:1-mirror', revision: 3, contentHash: hashOf('a') },
      category: 'finalized-history', provenance: 'finalized', required: false, text: '第一章定稿原文' },
    // 同章两稿：作者显式选中的当前草稿可以进入，另一稿不可以。
    { ref: { ...current, sourceId: 'candidate:selected', revision: 1, contentHash: hashOf('b') },
      category: 'finalized-history', provenance: 'author', required: false, text: '作者选中的本章草稿',
      candidate: savedDraft('草稿-选中', { selectedCurrentDraftId: '草稿-选中' }) },
    { ref: { ...current, sourceId: 'candidate:unselected', revision: 1, contentHash: hashOf('c') },
      category: 'finalized-history', provenance: 'author', required: false, text: '同章未被选中的另一稿',
      candidate: savedDraft('草稿-未选', {}) },
    // 同一冻结 lineage、被采纳为前一章直接前驱的候选是唯一合法的未定稿材料。
    { ref: { ...current, sourceId: 'candidate:predecessor', revision: 1, contentHash: hashOf('d') },
      category: 'finalized-history', provenance: 'author', required: false, text: '上一章已保存草稿结尾',
      candidate: savedDraft('草稿-前驱', { directPredecessorId: '草稿-前驱' }) },
    // 已被替换的来源不能按相关性混入。
    { ref: { ...current, sourceId: 'candidate:replaced', revision: 2, contentHash: hashOf('e') },
      category: 'finalized-history', provenance: 'author', required: false, text: '已被替换的旧候选',
      candidate: { source: { ...savedDraft('草稿-旧', {}).source, state: 'replaced' as const }, admission: { ...current, batchLineage: LINEAGE } } },
    // 未来秘密：来源未知，不洗白、也不提前进入本章。
    { ref: { ...current, sourceId: 'future:secret-7', revision: 1, contentHash: hashOf('f') },
      category: 'future-plan', provenance: 'unknown', required: false, text: '第七章才揭晓的真相' },
    // 超容量长设定：必需材料，装不下时只能显式失败。
    { ref: { ...current, sourceId: 'setting:long', revision: 1, contentHash: hashOf('0') },
      category: 'author', provenance: 'author', required: true, text: '长设定'.repeat(2_000) },
  ]
  return { current, capacity, materials }
}

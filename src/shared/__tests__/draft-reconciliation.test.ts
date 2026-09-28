import { describe, expect, it } from 'vitest'
import { parseDraftReconciliation, renderDraftReconciliationBlock, stripDraftReconciliationBlock, withoutDraftReconciliationArtifacts } from '../draft-reconciliation'

const valid = { finalState: ['林澄已撤回核查安排。'], events: [{ event: '核查遇阻', conflict: true, realization: '许可被驳回。' }] }

describe('draft reconciliation contract', () => {
  it('parses fenced JSON after hidden reasoning and normalizes whitespace', () => {
    expect(parseDraftReconciliation(`<think>分析</think>\`\`\`json\n${JSON.stringify({ ...valid, finalState: ['林澄\n已撤回核查安排。'] })}\n\`\`\``))
      .toEqual({ finalState: ['林澄 已撤回核查安排。'], events: valid.events })
  })

  it('expands an object-shaped final state in order', () => {
    expect(parseDraftReconciliation(JSON.stringify({ finalState: { 计划状态: '撤回，等待新许可', 关键物品: '铜钥匙在林澄手中' }, events: [] }))?.finalState)
      .toEqual(['计划状态：撤回，等待新许可', '关键物品：铜钥匙在林澄手中'])
  })

  it.each([
    ['prose', '没有冲突。'],
    ['a non-string final-state value', JSON.stringify({ finalState: { 计划状态: 1 }, events: [] })],
    ['empty arrays', JSON.stringify({ finalState: [], events: [] })],
    ['a conflict without a realization', JSON.stringify({ finalState: [], events: [{ event: '核查遇阻', conflict: true, realization: '' }] })],
    ['a non-boolean conflict', JSON.stringify({ finalState: [], events: [{ event: '核查遇阻', conflict: 'yes', realization: 'x' }] })],
    ['too many items', JSON.stringify({ finalState: Array.from({ length: 9 }, (_, index) => `状态${index}`), events: [] })],
  ])('rejects %s', (_label, output) => {
    expect(parseDraftReconciliation(output)).toBeNull()
  })

  it('reports no conflict explicitly and keeps concrete non-conflict realizations', () => {
    const block = renderDraftReconciliationBlock('zh-CN', { finalState: [], events: [{ event: '承担代价', conflict: false, realization: '按原文' }] })
    expect(block).toContain('- 承担代价：按原文落实，不得与上述状态矛盾。')
    expect(block.endsWith('对账结论：蓝图与定稿不冲突；按上述状态与落实方式写，已撤回、暂停或仍在等待条件的计划不得写成已执行。')).toBe(true)
    expect(renderDraftReconciliationBlock('zh-CN', { finalState: [], events: [{ event: '核查遇阻', conflict: false, realization: '雨未停，林澄留在档案室等待。' }] }))
      .toContain('- 核查遇阻：雨未停，林澄留在档案室等待。')
  })

  it.each(['zh-CN', 'en-US'] as const)('strips exactly one recomputed %s block', language => {
    const output = JSON.stringify(valid)
    const block = renderDraftReconciliationBlock(language, parseDraftReconciliation(output)!)
    expect(stripDraftReconciliationBlock(`甲\n\n${block}\n\n乙`, output)).toBe('甲\n\n乙')
    expect(stripDraftReconciliationBlock(`甲\n\n${block}\n\n${block}`, output)).toBeNull()
    expect(stripDraftReconciliationBlock('甲\n\n乙', output)).toBeNull()
    expect(stripDraftReconciliationBlock(`甲\n\n${block}`, '无效')).toBeNull()
  })
})

describe('draft candidate listing', () => {
  it('drops reconciliation artifacts from chapter-draft candidate rows', () => {
    const artifacts = [{ artifactId: '对账片', text: '{"finalState":[]}' }, { artifactId: '正文片', text: '正文。' }]
    expect(withoutDraftReconciliationArtifacts(artifacts, { draftReconciliation: { artifactIds: ['对账片'] } })).toEqual([artifacts[1]])
    expect(withoutDraftReconciliationArtifacts(artifacts, {})).toEqual(artifacts)
  })
})

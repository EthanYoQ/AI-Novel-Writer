import { describe, expect, it } from 'vitest'
import { appErrorMessage, knownAppErrorMessage } from '../app-errors'

describe('localized application errors', () => {
  it('maps stable error codes to localized messages', () => {
    expect(appErrorMessage('en-US', { code: 'KNOWLEDGE_BASE_NATIVE_UNAVAILABLE' }))
      .toContain('Windows native component')
    expect(appErrorMessage('zh-CN', { code: 'PROJECT_NOT_OPEN' }))
      .toBe('请先打开项目。')
    expect(appErrorMessage('en-US', { errorCode: 'PROJECT_NOT_OPEN' }))
      .toBe('Open a project first.')
    expect(appErrorMessage('zh-CN', { errorCode: 'PROJECT_ROOT_REQUIRED' }))
      .toContain('请选择项目根目录')
    expect(appErrorMessage('en-US', { errorCode: 'PROJECT_ROOT_REQUIRED' }))
      .toContain('Select the project root folder')
  })

  it('preserves an unknown error as localized diagnostic text', () => {
    expect(appErrorMessage('en-US', new Error('disk full'))).toBe('Something went wrong: disk full')
  })
})

it.each(['KNOWLEDGE_BASE_NATIVE_UNAVAILABLE','LEGACY_VECTOR_MIGRATION_BLOCKED'])('maps knowledge preparation IPC error %s without exposing internal details', code => {
 expect(appErrorMessage('en-US',new Error(`Error invoking remote method 'generation:prepare-draft-context': Error: ${code}`)))
   .toBe(appErrorMessage('en-US',{errorCode:code}))
})

describe('generation error codes from the main process', () => {
  it.each([
    ["Error invoking remote method 'generation:commit-draft': Error: GENERATION_DRAFT_DEPENDENCY_STALE", '前一章'],
    ["Error invoking remote method 'generation:begin': Error: GENERATION_DRAFT_NOT_CURRENT", '当前稿'],
    ["Error invoking remote method 'review-revision:prepare': Error: GENERATION_REVIEW_LINEAGE_UNPROVEN", '重新审稿'],
    ["Error invoking remote method 'character-proposal:list-pending-finalized': Error: GENERATION_PROJECT_SESSION_STALE", '重新打开'],
    ['Error: GENERATION_REQUEST_FAILED', '重试'],
  ])('turns %s into a full sentence without the IPC wrapper', (raw, hint) => {
    for (const error of [raw, new Error(raw)]) {
      const zh = knownAppErrorMessage('zh-CN', error)
      expect(zh).toContain(hint)
      expect(zh).not.toMatch(/Error invoking|GENERATION_/u)
      expect(knownAppErrorMessage('en-US', error)).toMatch(/^[A-Z][^_]+\.$/u)
    }
  })

  it('leaves unregistered codes and prose to the caller', () => {
    expect(knownAppErrorMessage('zh-CN', "Error invoking remote method 'generation:begin': Error: GENERATION_SOMETHING_NEW")).toBeUndefined()
    expect(knownAppErrorMessage('zh-CN', '模型服务返回 HTTP 429')).toBeUndefined()
  })
})

it('does not promise that a stale-session action never ran', () => {
  // 主进程可能已经处理完，只是结果因会话失效被拒；文案只能说结果不可用。
  const raw = "Error invoking remote method 'generation:begin': Error: GENERATION_PROJECT_SESSION_STALE"
  const zh = knownAppErrorMessage('zh-CN', raw)!, en = knownAppErrorMessage('en-US', raw)!
  expect(zh).toContain('结果不可用')
  expect(zh).not.toMatch(/没有执行|未执行/u)
  expect(en).toContain('result')
  expect(en).not.toMatch(/did not run|was not run/iu)
})

// GENERATION_MODEL_CHANGED 由主进程续跑情节大纲时抛出，GENERATION_IMPORT_MODEL_CHANGED 由导入生成抛出；GENERATION_SOURCE_CHANGED_MODEL 由 #453 抛出。
it.each(['GENERATION_MODEL_CHANGED', 'GENERATION_IMPORT_MODEL_CHANGED', 'GENERATION_SOURCE_CHANGED_MODEL'])('explains %s mid-generation instead of falling back to the raw code', code => {
  const wrapped = `Error invoking remote method 'generation:execute': Error: ${code}`
  expect(knownAppErrorMessage('zh-CN', wrapped)).toContain('模型设置被修改')
  expect(knownAppErrorMessage('en-US', wrapped)).toContain('model settings changed')
})

// GENERATION_SKILL_BUNDLE_DAMAGED 由 #443 抛出，GENERATION_FINALIZATION_RECOVERY_UNAVAILABLE 由 #447 抛出；无论哪个 PR 先合入都已登记。
it.each([
  ['GENERATION_SKILL_BUNDLE_DAMAGED', '重新导入', 'import'],
  ['GENERATION_FINALIZATION_RECOVERY_UNAVAILABLE', '生成记录已变化', 'generation record changed'],
])('explains %s instead of falling back to the raw code', (code, zh, en) => {
  const wrapped = `Error invoking remote method 'generation:execute': Error: ${code}`
  expect(knownAppErrorMessage('zh-CN', wrapped)).toContain(zh)
  expect(knownAppErrorMessage('en-US', wrapped)).toContain(en)
})

// 这两个码在保存时的来源复核里也会抛出，那时模型已经回答过。
it.each(['GENERATION_DRAFT_NOT_CURRENT', 'GENERATION_FINALIZED_SOURCE_NOT_CURRENT'])('does not promise that %s happened before any model request', code => {
  const raw = `Error invoking remote method 'generation:commit-draft': Error: ${code}`
  expect(knownAppErrorMessage('zh-CN', raw)).not.toMatch(/没有调用模型|未调用模型/u)
  expect(knownAppErrorMessage('en-US', raw)).not.toMatch(/no model request/iu)
})

it('does not blame a book switch when the request carried no session at all', () => {
  const raw = "Error invoking remote method 'generation:begin': Error: GENERATION_PROJECT_SESSION_REQUIRED"
  const zh = knownAppErrorMessage('zh-CN', raw)!, en = knownAppErrorMessage('en-US', raw)!
  expect(zh).toContain('重新打开')
  expect(zh).not.toContain('已切换')
  expect(en).not.toMatch(/switched/iu)
})

// 审计点名的四个码与已登记的 GENERATION_SOURCE_CHANGED 走同一条转发路径、同一种作者情境（生成途中依据变了）。
it.each([
  'GENERATION_SOURCE_CHANGED_DURING_SNAPSHOT',
  'GENERATION_ASSET_CHANGED_DURING_SNAPSHOT',
  'GENERATION_REVIEW_CONTEXT_CHANGED',
  'GENERATION_AUTHOR_DRAFT_CHANGED',
])('explains %s as a mid-run source change', code => {
  const wrapped = `Error invoking remote method 'generation:begin': Error: ${code}`
  expect(knownAppErrorMessage('zh-CN', wrapped)).toBe(knownAppErrorMessage('zh-CN', 'GENERATION_SOURCE_CHANGED'))
  expect(knownAppErrorMessage('en-US', wrapped)).toBe(knownAppErrorMessage('en-US', 'GENERATION_SOURCE_CHANGED'))
})

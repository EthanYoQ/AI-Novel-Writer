import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * 外部 AI 修稿的产物必须走**差异对比**，不许直接覆盖原稿。
 *
 * 先生的原话：「应用编辑器这个功能是不对的，应该就直接打开我们的改稿差异对比」。
 * 这条契约用源码级断言守住它 —— 覆盖式写回一旦被人加回来，这里就会红。
 * （行为层面的验证在 ExternalAiAuditBoard.browser.tsx：板块交出的只是文本，
 *   真正的对比与合并由草稿编辑器打开。）
 */
const draftEditor = readFileSync(
  resolve(process.cwd(), 'src/components/editor/DraftEditor.tsx'),
  'utf8',
)
const handoffConfig = readFileSync(
  resolve(process.cwd(), 'src/components/editor/external-ai-handoff-config.ts'),
  'utf8',
)

describe('external AI revision merge contract', () => {
  it('opens the comparison view instead of writing the text straight into the editor', () => {
    // 收到网页版的正文后，做的是「打开对比」这件事
    expect(draftEditor).toContain('openExternalRefineComparison')
    expect(draftEditor).toContain('external: true')
    // 外部来源的产物不再经由「直接写回编辑器」的那条捷径
    expect(draftEditor).not.toContain('onApplyResult={writeTextToEditor}')
  })

  it('lets the comparison finish write back to the editor, not to a revision record', () => {
    // 合并完成先分流：外部来源只写回编辑器（先生自己保存），不提交修订记录
    expect(draftEditor).toContain('if (mergeData?.external) {')
    expect(draftEditor).toContain('writeTextToEditor(mergedText)')
  })

  it('names the comparison view so the author knows where the text came from', () => {
    expect(draftEditor).toContain('外部 AI 修稿 · 差异对比')
  })

  it('labels the handoff button as compare-and-merge', () => {
    expect(handoffConfig).toContain("apply: ['对比并合并', 'Compare & merge']")
  })
})
